import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

import '../../core/config.dart';
import '../../core/errors.dart';
import '../../core/models.dart';
import '../../core/providers.dart';
import '../../core/realtime/reliable_web_socket.dart';
import '../auth/auth_controller.dart';

final socialRealtimeProvider = StateNotifierProvider.autoDispose<
    SocialRealtimeController, SocialRealtimeState>((ref) {
  final session = ref.watch(authControllerProvider).valueOrNull;
  final controller = SocialRealtimeController(
    accessToken: ref.watch(secureTokenStoreProvider).readAccessToken,
    recoverAuthentication: ref.watch(apiClientProvider).ensureAuthenticated,
    authenticationLost: ref.read(authControllerProvider.notifier).logout,
  );
  if (session != null && session.role != UserRole.guest) {
    controller.connect();
  }
  return controller;
});

final class FriendCallTranslationEvent {
  const FriendCallTranslationEvent({
    required this.callId,
    required this.type,
    this.speakerId,
    this.text,
    this.language,
    this.audio,
    this.sampleRate,
    this.code,
    this.message,
    this.outputAudio,
    this.sourceLanguage,
    this.targetLanguage,
  });

  final String callId;
  final String type;
  final String? speakerId;
  final String? text;
  final String? language;
  final String? audio;
  final int? sampleRate;
  final String? code;
  final String? message;
  final bool? outputAudio;
  final String? sourceLanguage;
  final String? targetLanguage;

  factory FriendCallTranslationEvent.fromPayload(
    String type,
    dynamic payload,
  ) {
    final data = SocialRealtimeController._json(payload);
    return FriendCallTranslationEvent(
      callId: data['callId']?.toString() ?? '',
      type: data['kind']?.toString() ?? type,
      speakerId: data['speakerId']?.toString(),
      text: data['text']?.toString(),
      language: data['language']?.toString(),
      audio: data['audio']?.toString(),
      sampleRate: (data['sampleRate'] as num?)?.toInt(),
      code: data['code']?.toString(),
      message: data['message']?.toString(),
      outputAudio: data['outputAudio'] as bool?,
      sourceLanguage: data['sourceLanguage']?.toString(),
      targetLanguage: data['targetLanguage']?.toString(),
    );
  }
}

final class SocialRealtimeState {
  const SocialRealtimeState({
    this.connected = false,
    this.revision = 0,
    this.latestInvitation,
    this.lastEvent,
    this.latestDirectConversationId,
    this.unreadDirectChatIds = const {},
    this.latestCall,
    this.lastCallId,
  });

  final bool connected;
  final int revision;
  final MeetingInvitationModel? latestInvitation;
  final String? lastEvent;
  final String? latestDirectConversationId;
  final Set<String> unreadDirectChatIds;
  final FriendCallModel? latestCall;
  final String? lastCallId;

  SocialRealtimeState copyWith({
    bool? connected,
    int? revision,
    MeetingInvitationModel? latestInvitation,
    String? lastEvent,
    String? latestDirectConversationId,
    Set<String>? unreadDirectChatIds,
    bool clearInvitation = false,
    FriendCallModel? latestCall,
    bool clearCall = false,
    String? lastCallId,
    bool clearLastCallId = false,
  }) =>
      SocialRealtimeState(
        connected: connected ?? this.connected,
        revision: revision ?? this.revision,
        latestInvitation:
            clearInvitation ? null : latestInvitation ?? this.latestInvitation,
        lastEvent: lastEvent ?? this.lastEvent,
        latestDirectConversationId:
            latestDirectConversationId ?? this.latestDirectConversationId,
        unreadDirectChatIds: unreadDirectChatIds ?? this.unreadDirectChatIds,
        latestCall: clearCall ? null : latestCall ?? this.latestCall,
        lastCallId: clearLastCallId ? null : lastCallId ?? this.lastCallId,
      );
}

String? friendCallIdFromRealtimePayload(dynamic payload) {
  Map<String, dynamic>? data;
  if (payload is Map) {
    data = payload.cast<String, dynamic>();
  } else if (payload is List && payload.isNotEmpty && payload.first is Map) {
    data = (payload.first as Map).cast<String, dynamic>();
  } else {
    try {
      final nested = (payload as dynamic)?.data;
      if (nested is Map) data = nested.cast<String, dynamic>();
    } catch (_) {
      // Socket payload wrappers do not have to expose a data property.
    }
  }
  if (data == null) return null;
  final direct = data['callId']?.toString().trim();
  if (direct != null && direct.isNotEmpty) return direct;
  final call = data['call'];
  if (call is! Map) return null;
  final nested = call['id']?.toString().trim();
  return nested == null || nested.isEmpty ? null : nested;
}

bool friendCallEventMatches({
  required String currentCallId,
  required String? eventCallId,
}) =>
    eventCallId != null &&
    eventCallId.isNotEmpty &&
    eventCallId == currentCallId;

final class SocialRealtimeController
    extends StateNotifier<SocialRealtimeState> {
  SocialRealtimeController({
    required Future<String?> Function() accessToken,
    required Future<void> Function() recoverAuthentication,
    required Future<void> Function() authenticationLost,
  })  : _accessToken = accessToken,
        _recoverAuthentication = recoverAuthentication,
        _authenticationLost = authenticationLost,
        super(const SocialRealtimeState());

  final Future<String?> Function() _accessToken;
  final Future<void> Function() _recoverAuthentication;
  final Future<void> Function() _authenticationLost;
  io.Socket? _socket;
  final _callTranslationEvents =
      StreamController<FriendCallTranslationEvent>.broadcast();
  bool _recovering = false;
  bool _disposed = false;

  Stream<FriendCallTranslationEvent> get callTranslationEvents =>
      _callTranslationEvents.stream;

  void connect() {
    if (_disposed || _socket != null) return;
    final socket = io.io(
      AppConfig.socketUrl,
      io.OptionBuilder()
          .setTransports(['websocket'])
          .setWebSocketConnector(connectReliableWebSocket)
          .setPath('/socket.io')
          .setAuthFn((callback) {
            unawaited(
              _accessToken().then(
                (token) => callback({if (token != null) 'token': token}),
              ),
            );
          })
          .disableAutoConnect()
          .enableReconnection()
          .setReconnectionAttempts(20)
          .setReconnectionDelay(1000)
          .setReconnectionDelayMax(10000)
          .build(),
    );
    _socket = socket;
    socket.onConnect((_) {
      if (_socket == socket && !_disposed) {
        state = state.copyWith(connected: true);
      }
    });
    socket.onDisconnect((reason) {
      if (_socket != socket || _disposed) return;
      state = state.copyWith(connected: false);
      if (reason?.toString() == 'io server disconnect') {
        unawaited(_recoverAndReconnect(socket));
      }
    });
    socket.onConnectError((error) {
      if (_socket != socket || _disposed) return;
      state = state.copyWith(connected: false);
      final code = _json(error)['code']?.toString();
      if (_authenticationCode(code)) {
        unawaited(_recoverAndReconnect(socket));
      }
    });
    for (final event in const [
      'friend.request.created',
      'friend.request.responded',
      'friend.removed',
      'friend.presence',
      'meeting.invitation.responded',
    ]) {
      socket.on(event, (_) => _markEvent(event));
    }
    socket.on('meeting.invitation.created', (payload) {
      final invitation = _json(payload)['invitation'];
      MeetingInvitationModel? parsed;
      if (invitation is Map) {
        try {
          parsed = MeetingInvitationModel.fromJson(
            invitation.cast<String, dynamic>(),
          );
        } catch (_) {
          // A malformed notification still invalidates REST list caches.
        }
      }
      _markEvent('meeting.invitation.created', invitation: parsed);
    });
    socket.on('direct.chat.ready', (payload) {
      final conversationId = _json(payload)['conversationId']?.toString();
      _markDirectEvent('direct.chat.ready', conversationId, unread: false);
    });
    socket.on('direct.message.created', (payload) {
      final conversationId = _json(payload)['conversationId']?.toString();
      _markDirectEvent('direct.message.created', conversationId, unread: true);
    });
    socket.on('friend.call.incoming',
        (payload) => _markCallEvent('friend.call.incoming', payload));
    socket.on('friend.call.accepted',
        (payload) => _markCallEvent('friend.call.accepted', payload));
    socket.on(
      'friend.call.declined',
      (payload) => _markCallClosed('friend.call.declined', payload),
    );
    socket.on(
      'friend.call.ended',
      (payload) => _markCallClosed('friend.call.ended', payload),
    );
    for (final event in const [
      'friend.call.translation.ready',
      'friend.call.translation.text',
      'friend.call.translation.audio',
      'friend.call.translation.error',
      'friend.call.translation.finished',
    ]) {
      socket.on(event, (payload) {
        if (_disposed) return;
        _callTranslationEvents.add(
          FriendCallTranslationEvent.fromPayload(event, payload),
        );
      });
    }
    socket.connect();
  }

  Future<FriendCallTranslationEvent> startCallTranslation(
    String callId,
  ) async {
    final socket = _socket;
    if (socket == null || !socket.connected) {
      throw const AppException('实时连接尚未就绪');
    }
    final response = await socket
        .timeout(15000)
        .emitWithAckAsync('friend.call.translation.start', {'callId': callId});
    final payload = _json(response);
    if (payload['ok'] != true) {
      final error = _json(payload['error']);
      throw AppException(
        error['message']?.toString() ?? '实时翻译服务暂时不可用',
      );
    }
    return FriendCallTranslationEvent.fromPayload(
      'friend.call.translation.ready',
      payload['data'],
    );
  }

  void sendCallTranslationAudio(
    String callId,
    String audio,
    int sequence,
  ) {
    final socket = _socket;
    if (socket == null || !socket.connected || audio.isEmpty) return;
    socket.volatile.emit('friend.call.translation.audio', {
      'callId': callId,
      'audio': audio,
      'sequence': sequence,
    });
  }

  void finishCallTranslation(String callId) {
    final socket = _socket;
    if (socket != null && socket.connected) {
      socket.emit('friend.call.translation.finish', {'callId': callId});
    }
  }

  void consumeInvitation(String invitationId) {
    if (state.latestInvitation?.id != invitationId) return;
    state = state.copyWith(clearInvitation: true);
  }

  void consumeCall(String callId) {
    if (state.latestCall?.id != callId) return;
    state = state.copyWith(clearCall: true);
  }

  void _markCallEvent(String event, dynamic payload) {
    final raw = _json(payload)['call'];
    FriendCallModel? parsed;
    if (raw is Map) {
      try {
        parsed = FriendCallModel.fromJson(raw.cast<String, dynamic>());
      } catch (_) {
        // REST recovery below remains authoritative if a push is malformed.
      }
    }
    if (_disposed) return;
    final callId = parsed?.id.isNotEmpty == true
        ? parsed!.id
        : friendCallIdFromRealtimePayload(payload);
    state = state.copyWith(
      revision: state.revision + 1,
      lastEvent: event,
      latestCall: parsed,
      lastCallId: callId,
      clearLastCallId: callId == null,
    );
  }

  void _markCallClosed(String event, dynamic payload) {
    if (_disposed) return;
    final callId = friendCallIdFromRealtimePayload(payload);
    state = state.copyWith(
      revision: state.revision + 1,
      lastEvent: event,
      clearCall: true,
      lastCallId: callId,
      clearLastCallId: callId == null,
    );
  }

  void markDirectChatRead(String conversationId) {
    if (!state.unreadDirectChatIds.contains(conversationId)) return;
    final unread = {...state.unreadDirectChatIds}..remove(conversationId);
    state = state.copyWith(unreadDirectChatIds: unread);
  }

  void _markDirectEvent(
    String event,
    String? conversationId, {
    required bool unread,
  }) {
    if (_disposed || conversationId == null || conversationId.isEmpty) return;
    final unreadIds = unread
        ? ({...state.unreadDirectChatIds}..add(conversationId))
        : state.unreadDirectChatIds;
    state = state.copyWith(
      revision: state.revision + 1,
      lastEvent: event,
      latestDirectConversationId: conversationId,
      unreadDirectChatIds: unreadIds,
      clearLastCallId: true,
    );
  }

  void _markEvent(String event, {MeetingInvitationModel? invitation}) {
    if (_disposed) return;
    state = state.copyWith(
      revision: state.revision + 1,
      lastEvent: event,
      latestInvitation: invitation,
      clearLastCallId: true,
    );
  }

  Future<void> _recoverAndReconnect(io.Socket socket) async {
    if (_recovering || _disposed || _socket != socket) return;
    _recovering = true;
    try {
      await _recoverAuthentication();
      if (_disposed || _socket != socket) return;
      socket.connect();
    } catch (_) {
      if (!_disposed) await _authenticationLost();
    } finally {
      _recovering = false;
    }
  }

  static bool _authenticationCode(String? code) => switch (code) {
        'UNAUTHORIZED' ||
        'TOKEN_INVALID' ||
        'TOKEN_EXPIRED' ||
        'SESSION_REVOKED' =>
          true,
        _ => false,
      };

  static Map<String, dynamic> _json(dynamic payload) {
    if (payload is Map) return payload.cast<String, dynamic>();
    if (payload is List && payload.isNotEmpty && payload.first is Map) {
      return (payload.first as Map).cast<String, dynamic>();
    }
    try {
      final data = (payload as dynamic)?.data;
      if (data is Map) return data.cast<String, dynamic>();
    } catch (_) {
      // Socket errors are not required to expose a structured data payload.
    }
    return const {};
  }

  @override
  void dispose() {
    _disposed = true;
    final socket = _socket;
    _socket = null;
    socket?.dispose();
    unawaited(_callTranslationEvents.close());
    super.dispose();
  }
}
