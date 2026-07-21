import 'dart:async';

import 'package:socket_io_client/socket_io_client.dart' as io;

import '../models.dart';
import 'reliable_web_socket.dart';

enum RoomSocketStatus {
  connecting,
  connected,
  reconnecting,
  reconnectFailed,
  disconnected,
  ended,
}

sealed class RoomEvent {
  const RoomEvent();
}

final class SocketStatusChanged extends RoomEvent {
  const SocketStatusChanged(this.status, {this.reason});

  final RoomSocketStatus status;
  final String? reason;
}

final class MessageReceived extends RoomEvent {
  const MessageReceived(this.message, {this.replayed = false});

  final TranslationMessage message;
  final bool replayed;
}

final class ParticipantJoined extends RoomEvent {
  const ParticipantJoined(this.participant);

  final Participant participant;
}

final class ParticipantChanged extends RoomEvent {
  const ParticipantChanged(this.participant);

  final Participant participant;
}

final class ParticipantsSnapshot extends RoomEvent {
  const ParticipantsSnapshot({
    required this.participants,
    required this.status,
    this.selfParticipantId,
  });

  final List<Participant> participants;
  final ConversationStatus status;
  final String? selfParticipantId;
}

final class RoomJoined extends RoomEvent {
  const RoomJoined({
    required this.status,
    required this.latestSequence,
    required this.hasMore,
  });

  final ConversationStatus status;
  final int latestSequence;
  final bool hasMore;
}

final class ParticipantRemoved extends RoomEvent {
  const ParticipantRemoved({required this.participantId, this.removedAt});

  final String participantId;
  final DateTime? removedAt;
}

final class DirectChatFriendshipEnded extends RoomEvent {
  const DirectChatFriendshipEnded();
}

final class RoomEnded extends RoomEvent {
  const RoomEnded(this.endedAt);

  final DateTime endedAt;
}

final class RoomFailure extends RoomEvent {
  const RoomFailure({
    required this.message,
    this.code,
    this.authentication = false,
  });

  final String message;
  final String? code;
  final bool authentication;
}

final class RoomRealtimeClient {
  RoomRealtimeClient({required this.socketUrl});

  final String socketUrl;
  final _events = StreamController<RoomEvent>.broadcast();
  io.Socket? _socket;
  String? _conversationId;
  Future<int> Function()? _lastSequence;
  Timer? _roomJoinTimer;
  int _roomJoinAttempts = 0;

  Stream<RoomEvent> get events => _events.stream;

  void connect({
    required String conversationId,
    required Future<String?> Function() accessToken,
    required Future<int> Function() lastSequence,
  }) {
    disconnect();
    _conversationId = conversationId;
    _lastSequence = lastSequence;
    _events.add(const SocketStatusChanged(RoomSocketStatus.connecting));

    final socket = io.io(
      socketUrl,
      io.OptionBuilder()
          .setTransports(['websocket'])
          .setWebSocketConnector(connectReliableWebSocket)
          .setPath('/socket.io')
          .setAuthFn((callback) {
            unawaited(
              accessToken().then(
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

    socket.onConnect((_) async {
      if (_socket != socket) return;
      // A transport connection is not yet an authorized room membership.
      _events.add(const SocketStatusChanged(RoomSocketStatus.connecting));
      _roomJoinAttempts = 0;
      await _emitJoin(socket);
    });
    socket.onDisconnect((reason) {
      if (_socket != socket) return;
      _roomJoinTimer?.cancel();
      final serverForced = reason?.toString() == 'io server disconnect';
      _events.add(
        SocketStatusChanged(
          serverForced
              ? RoomSocketStatus.disconnected
              : RoomSocketStatus.reconnecting,
          reason: reason?.toString(),
        ),
      );
    });
    socket.onConnectError((error) {
      if (_socket != socket) return;
      final failure = _failure(error);
      _events.add(
        SocketStatusChanged(
          RoomSocketStatus.reconnecting,
          reason: error?.toString(),
        ),
      );
      if (failure.authentication) _events.add(failure);
    });
    socket.onReconnectAttempt((_) {
      if (_socket == socket) {
        _events.add(const SocketStatusChanged(RoomSocketStatus.reconnecting));
      }
    });
    socket.onReconnectFailed((_) {
      if (_socket == socket) {
        _events.add(
          const SocketStatusChanged(RoomSocketStatus.reconnectFailed),
        );
      }
    });
    socket.on('room.joined', (payload) {
      if (_socket != socket) return;
      _roomJoinTimer?.cancel();
      _roomJoinAttempts = 0;
      final json = _json(payload);
      final eventConversation = json['conversationId']?.toString();
      if (eventConversation != null && eventConversation != conversationId) {
        return;
      }
      final snapshot = json['participants'];
      if (snapshot is List) {
        final participants = snapshot
            .whereType<Map>()
            .map((item) => Participant.fromJson(item.cast<String, dynamic>()))
            .where((participant) => participant.id.isNotEmpty)
            .toList(growable: false);
        _events.add(
          ParticipantsSnapshot(
            participants: participants,
            status: _conversationStatus(json['status']),
            selfParticipantId: json['participantId']?.toString(),
          ),
        );
      }
      final missing = json['missingMessages'];
      if (missing is List) {
        for (final item in missing.whereType<Map>()) {
          final messageJson = item.cast<String, dynamic>();
          if (messageJson['conversationId']?.toString() == conversationId) {
            _events.add(
              MessageReceived(
                TranslationMessage.fromJson(messageJson),
                replayed: true,
              ),
            );
          }
        }
      }
      // REST pagination and short-lived audio URL refresh still have to finish
      // before the controller is allowed to expose a LIVE room.
      _events.add(
        RoomJoined(
          status: _conversationStatus(json['status']),
          latestSequence: (json['latestSequence'] as num?)?.toInt() ?? 0,
          hasMore: json['hasMore'] == true,
        ),
      );
    });
    for (final eventName in const [
      'translation.processing',
      'translation.final',
      'translation.failed',
      'translation.review.updated',
    ]) {
      socket.on(eventName, (payload) {
        final json = _json(payload)..['type'] = eventName;
        if (json['conversationId']?.toString() != conversationId) return;
        _events.add(MessageReceived(TranslationMessage.fromJson(json)));
      });
    }
    socket.on('participant.joined', (payload) {
      final json = _json(payload);
      final eventConversation = json['conversationId']?.toString();
      if (eventConversation != null && eventConversation != conversationId) {
        return;
      }
      final participant = _participant(json);
      if (participant != null) _events.add(ParticipantJoined(participant));
    });
    for (final eventName in const [
      'participant.updated',
      'participant.presence',
    ]) {
      socket.on(eventName, (payload) {
        final json = _json(payload);
        final eventConversation = json['conversationId']?.toString();
        if (eventConversation != null && eventConversation != conversationId) {
          return;
        }
        final participant = _participant(json);
        if (participant != null) _events.add(ParticipantChanged(participant));
      });
    }
    socket.on('participant.removed', (payload) {
      final json = _json(payload);
      final eventConversation = json['conversationId']?.toString();
      if (eventConversation != null && eventConversation != conversationId) {
        return;
      }
      final participantId = json['participantId']?.toString();
      if (participantId == null || participantId.isEmpty) return;
      _events.add(
        ParticipantRemoved(
          participantId: participantId,
          removedAt: DateTime.tryParse(
            json['removedAt']?.toString() ?? '',
          )?.toLocal(),
        ),
      );
    });
    socket.on('direct.chat.friendship-ended', (payload) {
      final json = _json(payload);
      if (json['conversationId']?.toString() != conversationId) return;
      _events.add(const DirectChatFriendshipEnded());
    });
    socket.on('room.ended', (payload) {
      final json = _json(payload);
      if (json['conversationId']?.toString() != conversationId) return;
      _events
        ..add(
          RoomEnded(
            DateTime.tryParse(json['endedAt']?.toString() ?? '')?.toLocal() ??
                DateTime.now(),
          ),
        )
        ..add(const SocketStatusChanged(RoomSocketStatus.ended));
    });
    socket.on('room.error', (payload) {
      if (_socket == socket) {
        _roomJoinTimer?.cancel();
        _events.add(_failure(payload));
      }
    });
    socket.connect();
  }

  Future<void> _emitJoin(io.Socket socket) async {
    _roomJoinTimer?.cancel();
    final conversationId = _conversationId;
    final sequence = await _lastSequence?.call() ?? 0;
    if (_socket != socket || conversationId == null) return;
    socket.emit('room.join', {
      'conversationId': conversationId,
      'lastSequence': sequence,
    });
    _roomJoinTimer = Timer(const Duration(seconds: 12), () {
      if (_socket != socket || _conversationId != conversationId) return;
      _roomJoinAttempts += 1;
      if (_roomJoinAttempts < 3 && socket.connected) {
        _events.add(
          const SocketStatusChanged(
            RoomSocketStatus.reconnecting,
            reason: 'room join timeout',
          ),
        );
        unawaited(_emitJoin(socket));
        return;
      }
      _events
        ..add(
          const SocketStatusChanged(
            RoomSocketStatus.reconnectFailed,
            reason: 'room join timeout',
          ),
        )
        ..add(
          const RoomFailure(
            message: '实时同步连接超时，但仍可录音翻译；请点击重试连接',
            code: 'ROOM_JOIN_TIMEOUT',
          ),
        );
    });
  }

  void disconnect() {
    _roomJoinTimer?.cancel();
    _roomJoinTimer = null;
    _roomJoinAttempts = 0;
    final socket = _socket;
    final conversationId = _conversationId;
    _socket = null;
    _conversationId = null;
    _lastSequence = null;
    if (socket != null) {
      if (conversationId != null) {
        socket.emit('room.leave', {'conversationId': conversationId});
      }
      socket.dispose();
    }
  }

  Future<void> dispose() async {
    disconnect();
    await _events.close();
  }

  void reconnectNow() {
    final socket = _socket;
    if (socket == null) return;
    socket
      ..disconnect()
      ..connect();
  }

  static Map<String, dynamic> _json(dynamic payload) {
    if (payload is Map) return payload.cast<String, dynamic>();
    return <String, dynamic>{};
  }

  static Participant? _participant(Map<String, dynamic> json) {
    final nested = json['participant'];
    final participantJson =
        nested is Map ? nested.cast<String, dynamic>() : json;
    final participant = Participant.fromJson(participantJson);
    return participant.id.isEmpty ? null : participant;
  }

  static ConversationStatus _conversationStatus(dynamic value) =>
      switch (value?.toString().toUpperCase()) {
        'ACTIVE' => ConversationStatus.active,
        'ENDED' => ConversationStatus.ended,
        'EXPIRED' => ConversationStatus.expired,
        _ => ConversationStatus.waiting,
      };

  static RoomFailure _failure(dynamic payload) {
    final json = _json(payload);
    final nested = json['data'];
    final data = nested is Map ? nested.cast<String, dynamic>() : json;
    final code = (data['code'] ?? json['code'])?.toString();
    final message =
        (json['message'] ?? data['message'] ?? payload ?? '房间连接失败').toString();
    final diagnostic = '$code $message'.toUpperCase();
    return RoomFailure(
      message: message,
      code: code,
      authentication: code == 'TOKEN_INVALID' ||
          code == 'UNAUTHORIZED' ||
          code == 'DEVICE_REVOKED' ||
          code == 'ACCOUNT_DISABLED' ||
          code == 'GUEST_TOKEN_REVOKED' ||
          code == 'REFRESH_TOKEN_REUSED' ||
          diagnostic.contains('TOKEN_INVALID') ||
          diagnostic.contains('UNAUTHORIZED') ||
          diagnostic.contains('DEVICE_REVOKED') ||
          diagnostic.contains('ACCOUNT_DISABLED') ||
          diagnostic.contains('GUEST_TOKEN_REVOKED') ||
          diagnostic.contains('REFRESH_TOKEN_REUSED') ||
          diagnostic.contains('登录凭证') ||
          diagnostic.contains('认证失败') ||
          diagnostic.contains('身份已失效') ||
          diagnostic.contains('登录已被撤销') ||
          diagnostic.contains('账号不存在') ||
          diagnostic.contains('账号已停用') ||
          diagnostic.contains(' 401'),
    );
  }
}
