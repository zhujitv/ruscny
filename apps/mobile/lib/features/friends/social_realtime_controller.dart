import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

import '../../core/config.dart';
import '../../core/models.dart';
import '../../core/providers.dart';
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

final class SocialRealtimeState {
  const SocialRealtimeState({
    this.connected = false,
    this.revision = 0,
    this.latestInvitation,
    this.lastEvent,
    this.latestDirectConversationId,
    this.unreadDirectChatIds = const {},
  });

  final bool connected;
  final int revision;
  final MeetingInvitationModel? latestInvitation;
  final String? lastEvent;
  final String? latestDirectConversationId;
  final Set<String> unreadDirectChatIds;

  SocialRealtimeState copyWith({
    bool? connected,
    int? revision,
    MeetingInvitationModel? latestInvitation,
    String? lastEvent,
    String? latestDirectConversationId,
    Set<String>? unreadDirectChatIds,
    bool clearInvitation = false,
  }) =>
      SocialRealtimeState(
        connected: connected ?? this.connected,
        revision: revision ?? this.revision,
        latestInvitation:
            clearInvitation ? null : latestInvitation ?? this.latestInvitation,
        lastEvent: lastEvent ?? this.lastEvent,
        latestDirectConversationId:
            latestDirectConversationId ?? this.latestDirectConversationId,
        unreadDirectChatIds:
            unreadDirectChatIds ?? this.unreadDirectChatIds,
      );
}

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
  bool _recovering = false;
  bool _disposed = false;

  void connect() {
    if (_disposed || _socket != null) return;
    final socket = io.io(
      AppConfig.socketUrl,
      io.OptionBuilder()
          .setTransports(['websocket'])
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
    socket.connect();
  }

  void consumeInvitation(String invitationId) {
    if (state.latestInvitation?.id != invitationId) return;
    state = state.copyWith(clearInvitation: true);
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
    );
  }

  void _markEvent(String event, {MeetingInvitationModel? invitation}) {
    if (_disposed) return;
    state = state.copyWith(
      revision: state.revision + 1,
      lastEvent: event,
      latestInvitation: invitation,
    );
  }

  Future<void> _recoverAndReconnect(io.Socket socket) async {
    if (_recovering || _disposed || _socket != socket) return;
    _recovering = true;
    try {
      await _recoverAuthentication();
      if (_disposed || _socket != socket) return;
      socket
        ..disconnect()
        ..connect();
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
    socket
      ?..clearListeners()
      ..disconnect()
      ..dispose();
    super.dispose();
  }
}
