import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../core/audio/audio_capture.dart';
import '../../core/audio/audio_playback_queue.dart';
import '../../core/audio/pending_audio_registry.dart';
import '../../core/auth/secure_token_store.dart';
import '../../core/cache/app_preferences.dart';
import '../../core/cache/local_database.dart';
import '../../core/config.dart';
import '../../core/errors.dart';
import '../../core/models.dart';
import '../../core/providers.dart';
import '../../core/realtime/message_ledger.dart';
import '../../core/realtime/room_realtime_client.dart';
import '../auth/auth_controller.dart';
import '../conversations/conversation_repository.dart';

enum RoomAction { idle, recording, uploading, processing, sendFailed }

enum _RecordingRelease { send, cancel }

final class _PendingAudio {
  const _PendingAudio({
    required this.path,
    required this.sourceLanguage,
    required this.idempotencyKey,
  });

  final String path;
  final Language sourceLanguage;
  final String idempotencyKey;
}

final class RoomState {
  const RoomState({
    this.conversation,
    this.messages = const [],
    this.participants = const [],
    this.connection = RoomSocketStatus.connecting,
    this.action = RoomAction.idle,
    this.inputLanguage = Language.zh,
    this.selfParticipantId,
    this.directChatClosed = false,
    this.error,
  });

  final Conversation? conversation;
  final List<TranslationMessage> messages;
  final List<Participant> participants;
  final RoomSocketStatus connection;
  final RoomAction action;
  final Language inputLanguage;
  final String? selfParticipantId;
  final bool directChatClosed;
  final String? error;

  RoomState copyWith({
    Conversation? conversation,
    List<TranslationMessage>? messages,
    List<Participant>? participants,
    RoomSocketStatus? connection,
    RoomAction? action,
    Language? inputLanguage,
    String? selfParticipantId,
    bool? directChatClosed,
    String? error,
    bool clearError = false,
  }) =>
      RoomState(
        conversation: conversation ?? this.conversation,
        messages: messages ?? this.messages,
        participants: participants ?? this.participants,
        connection: connection ?? this.connection,
        action: action ?? this.action,
        inputLanguage: inputLanguage ?? this.inputLanguage,
        selfParticipantId: selfParticipantId ?? this.selfParticipantId,
        directChatClosed: directChatClosed ?? this.directChatClosed,
        error: clearError ? null : error ?? this.error,
      );
}

final roomControllerProvider = StateNotifierProvider.autoDispose
    .family<RoomController, RoomState, String>((ref, conversationId) {
  final session = ref.watch(authControllerProvider).valueOrNull;
  final controller = RoomController(
    conversationId: conversationId,
    repository: ref.watch(conversationRepositoryProvider),
    database: ref.watch(localDatabaseProvider),
    tokens: ref.watch(secureTokenStoreProvider),
    playback: ref.watch(audioPlaybackProvider),
    pendingAudioRegistry: ref.watch(pendingAudioRegistryProvider),
    settings: () => ref.read(appPreferencesProvider).load(),
    recoverAuthentication: ref.read(apiClientProvider).ensureAuthenticated,
    authenticationLost: ref.read(authControllerProvider.notifier).logout,
    scopedGuest: session?.role == UserRole.guest,
    currentUserId: session?.userId,
    initialLanguage: session?.preferredLanguage ?? Language.zh,
  );
  return controller;
});

final class RoomController extends StateNotifier<RoomState> {
  RoomController({
    required this.conversationId,
    required ConversationRepository repository,
    required LocalDatabase database,
    required SecureTokenStore tokens,
    required AudioPlaybackQueue playback,
    required PendingAudioRegistry pendingAudioRegistry,
    required Future<AppSettings> Function() settings,
    required Future<void> Function() recoverAuthentication,
    required Future<void> Function() authenticationLost,
    required bool scopedGuest,
    required String? currentUserId,
    required Language initialLanguage,
    AudioCapture? capture,
    RoomRealtimeClient? realtime,
    bool startImmediately = true,
  })  : _repository = repository,
        _database = database,
        _tokens = tokens,
        _playback = playback,
        _pendingAudioRegistry = pendingAudioRegistry,
        _settings = settings,
        _recoverAuthentication = recoverAuthentication,
        _authenticationLost = authenticationLost,
        _scopedGuest = scopedGuest,
        _currentUserId = currentUserId,
        _capture = capture,
        _realtime =
            realtime ?? RoomRealtimeClient(socketUrl: AppConfig.socketUrl),
        _ledger = MessageLedger(conversationId),
        super(RoomState(inputLanguage: initialLanguage)) {
    _eventSubscription = _realtime.events.listen(_handleEvent);
    if (startImmediately) unawaited(_initialize());
  }

  final String conversationId;
  final ConversationRepository _repository;
  final LocalDatabase _database;
  final SecureTokenStore _tokens;
  final AudioPlaybackQueue _playback;
  final PendingAudioRegistry _pendingAudioRegistry;
  final Future<AppSettings> Function() _settings;
  final Future<void> Function() _recoverAuthentication;
  final Future<void> Function() _authenticationLost;
  final bool _scopedGuest;
  final String? _currentUserId;
  AudioCapture? _capture;
  final RoomRealtimeClient _realtime;
  MessageLedger _ledger;
  late final StreamSubscription<RoomEvent> _eventSubscription;
  final Set<String> _playedFinalMessageIds = {};
  final Set<String> _ttsRefreshInFlight = {};
  final Set<String> _messageReviewInFlight = {};
  Future<bool>? _backfillInFlight;
  bool _authRecoveryInFlight = false;
  bool _authRecoveryAttempted = false;
  bool _socketSyncInFlight = false;
  bool _socketSyncRetryRequested = false;
  int? _socketLatestSequence;
  bool _recordingStartInFlight = false;
  _RecordingRelease? _pendingRecordingRelease;
  _PendingAudio? _pendingAudio;
  bool _startInFlight = false;
  bool _disposed = false;

  AudioCapture get _audioCapture => _capture ??= AudioCapture();

  bool get _canSpeak =>
      !state.directChatClosed &&
      state.conversation?.canSpeakAs(_currentUserId) == true;

  bool get _canStartRecording =>
      !_disposed &&
      !_recordingStartInFlight &&
      state.action == RoomAction.idle &&
      _canSpeak;

  @visibleForTesting
  bool get debugCanStartRecording => _canStartRecording;

  Future<void> _initialize() async {
    final retained = await _pendingAudioRegistry.restore(conversationId);
    if (_disposed) return;
    if (retained != null) {
      _pendingAudio = _PendingAudio(
        path: retained.path,
        sourceLanguage: retained.sourceLanguage,
        idempotencyKey: retained.idempotencyKey,
      );
      state = state.copyWith(
        action: RoomAction.sendFailed,
        error: '上次未发送录音已保留，可继续重试或明确放弃',
      );
    }
    await _start();
  }

  Future<void> _start() async {
    if (_startInFlight || _disposed) return;
    _startInFlight = true;
    try {
      List<TranslationMessage> cachedMessages = const [];
      try {
        cachedMessages = await _database.messages(conversationId);
      } catch (_) {
        // SQLite is only a display cache. A damaged or unavailable cache must
        // not prevent an authorized room from loading from the server.
      }
      if (_disposed) return;
      // Do not expose a transcript from SQLite until the server has confirmed
      // that this identity still belongs to the meeting. This closes the
      // offline/background window after a participant is removed.
      final conversation = await _repository.get(conversationId);
      if (_disposed) return;
      if (_mustPurgeAfterEnd(conversation, conversation.status)) {
        _revokeRoomAccess('会议已结束，本次临时访问已失效');
        if (_scopedGuest) await _authenticationLost();
        return;
      }
      state = state.copyWith(
        conversation: conversation,
        messages: _ledger.merge(cachedMessages),
        clearError: true,
      );
      await _cacheConversation(conversation);
      if (_disposed) return;
      // Start at zero on room entry. Besides filling gaps, this refreshes the
      // backend's short-lived signed audioUrl values in cached messages.
      await _backfill();
      if (_disposed || state.conversation == null) return;

      // Historical rooms stay readable, but the realtime server deliberately
      // rejects ENDED/EXPIRED rooms. Do not start a reconnect loop for a room
      // that REST has already told us is closed.
      if (conversation.status == ConversationStatus.ended ||
          conversation.status == ConversationStatus.expired) {
        await _discardPendingForLifecycle();
        if (_disposed) return;
        state = state.copyWith(connection: RoomSocketStatus.ended);
        return;
      }

      final token = await _tokens.readAccessToken();
      if (token == null || token.isEmpty) {
        throw const AppException('登录已失效，请重新登录');
      }
      _realtime.connect(
        conversationId: conversationId,
        accessToken: _tokens.readAccessToken,
        lastSequence: () async => _ledger.lastSequence,
      );
    } catch (error) {
      if (!_disposed) {
        if (_isAccessRevokedError(error)) {
          _revokeRoomAccess(readableError(error));
          if (_scopedGuest) await _authenticationLost();
          return;
        }
        state = state.copyWith(
          connection: RoomSocketStatus.disconnected,
          error: readableError(error),
        );
        final authRejected = error is AppException && error.statusCode == 401;
        final scopedAccessEnded = _scopedGuest &&
            error is AppException &&
            (error.code == 'HISTORY_ACCESS_EXPIRED' ||
                error.code == 'CONVERSATION_NOT_FOUND');
        if (authRejected || scopedAccessEnded) {
          await _authenticationLost();
        }
      }
    } finally {
      _startInFlight = false;
    }
  }

  Future<bool> _backfill() {
    final active = _backfillInFlight;
    if (active != null) return active;
    final task = _runBackfill();
    _backfillInFlight = task;
    return task.whenComplete(() {
      if (identical(_backfillInFlight, task)) _backfillInFlight = null;
    });
  }

  Future<bool> _runBackfill() async {
    Object? lastError;
    for (var attempt = 0; attempt < 4; attempt += 1) {
      try {
        const pageSize = 500;
        var cursor = 0;
        while (true) {
          final missing = await _repository.messages(
            conversationId,
            afterSequence: cursor,
            limit: pageSize,
          );
          final merged = _ledger.merge(missing);
          if (_disposed) return false;
          state = state.copyWith(messages: merged, clearError: true);
          await _cacheMessages(missing);
          if (_disposed) return false;
          final nextCursor = missing.fold(
            cursor,
            (highest, message) =>
                message.sequence > highest ? message.sequence : highest,
          );
          // The no-progress guard avoids an infinite loop if a server returns a
          // duplicate full page. A short page means backfill is complete.
          if (missing.length < pageSize || nextCursor <= cursor) break;
          cursor = nextCursor;
        }
        return true;
      } catch (error) {
        lastError = error;
        if (_isAccessRevokedError(error)) {
          _revokeRoomAccess(readableError(error));
          if (_scopedGuest) unawaited(_authenticationLost());
          return false;
        }
        if (attempt < 3 && !_disposed) {
          await Future<void>.delayed(
            Duration(milliseconds: 300 * (1 << attempt)),
          );
          continue;
        }
      }
    }
    if (!_disposed) {
      state = state.copyWith(
        error:
            '记录补拉失败（已自动重试 4 次）：${readableError(lastError ?? const AppException('未知错误'))}',
      );
    }
    return false;
  }

  void _handleEvent(RoomEvent event) {
    if (_disposed) return;
    switch (event) {
      case SocketStatusChanged(:final status, :final reason):
        state = state.copyWith(
          connection: status,
          error: status == RoomSocketStatus.reconnectFailed
              ? '自动重连已停止，请点击重试连接'
              : null,
        );
        if (status == RoomSocketStatus.disconnected &&
            reason == 'io server disconnect') {
          state = state.copyWith(error: '服务器已更新登录凭证，正在恢复会议连接');
          unawaited(_recoverSocketAuthentication());
        }
      case RoomJoined(:final status, :final latestSequence):
        final conversation = state.conversation;
        if (conversation != null && conversation.status != status) {
          final updated = conversation.copyWith(status: status);
          state = state.copyWith(conversation: updated);
          unawaited(_cacheConversation(updated));
        }
        _socketLatestSequence = latestSequence;
        state = state.copyWith(
          connection: status == ConversationStatus.ended ||
                  status == ConversationStatus.expired
              ? RoomSocketStatus.ended
              : RoomSocketStatus.connecting,
        );
        unawaited(_completeSocketSync());
      case MessageReceived(:final message, :final replayed):
        final merged = _ledger.merge([message]);
        state = state.copyWith(messages: merged, clearError: true);
        if (message.sequence > 0) unawaited(_cacheMessage(message));
        final firstPlayableDelivery =
            message.status == MessageStatus.finalResult &&
                message.audioUrl?.isNotEmpty == true &&
                _playedFinalMessageIds.add(message.id);
        if (!replayed && firstPlayableDelivery) {
          unawaited(_autoPlay(message.audioUrl!));
        }
        if (_isTtsPending(message)) unawaited(_refreshPendingTts(message));
        if (_socketLatestSequence != null) {
          if (message.sequence > _socketLatestSequence!) {
            _socketLatestSequence = message.sequence;
          }
          unawaited(_completeSocketSync());
        }
      case ParticipantsSnapshot(
          :final participants,
          :final status,
          :final selfParticipantId,
        ):
        if (_mustPurgeAfterEnd(state.conversation, status)) {
          _revokeRoomAccess('会议已结束，本次临时访问已失效');
          if (_scopedGuest) unawaited(_authenticationLost());
          return;
        }
        _setParticipants(
          participants,
          status: status,
          selfParticipantId: selfParticipantId,
        );
        if (status == ConversationStatus.ended ||
            status == ConversationStatus.expired) {
          unawaited(_discardPendingForLifecycle());
          if (state.action == RoomAction.recording) {
            unawaited(cancelRecording());
          }
        }
      case ParticipantJoined(:final participant):
        final participants = {
          for (final item in state.participants) item.id: item,
          participant.id: participant,
        }.values.toList(growable: false);
        final conversation = state.conversation;
        final status = conversation?.status == ConversationStatus.waiting &&
                participant.role == UserRole.guest
            ? ConversationStatus.active
            : conversation?.status;
        _setParticipants(participants, status: status);
      case ParticipantChanged(:final participant):
        final participants = {
          for (final item in state.participants) item.id: item,
          participant.id: participant,
        }.values.toList(growable: false);
        _setParticipants(participants);
        if (participant.id == state.selfParticipantId) {
          state = state.copyWith(inputLanguage: participant.preferredLanguage);
        }
      case ParticipantRemoved(:final participantId):
        final removedSelf = participantId == state.selfParticipantId;
        final participants = state.participants.map((participant) {
          if (participant.id != participantId) return participant;
          return Participant.fromJson({
            ...participant.toJson(),
            'presence': 'REMOVED',
            'removedAt': DateTime.now().toUtc().toIso8601String(),
          });
        }).toList(growable: false);
        if (removedSelf) {
          _revokeRoomAccess('您已被主持人移出本次会议');
          if (_scopedGuest) unawaited(_authenticationLost());
        } else {
          _setParticipants(participants);
        }
      case DirectChatFriendshipEnded():
        unawaited(_discardPendingForLifecycle());
        if (state.action == RoomAction.recording) {
          unawaited(cancelRecording());
        }
        state = state.copyWith(
          connection: RoomSocketStatus.disconnected,
          action: RoomAction.idle,
          directChatClosed: true,
          error: '好友关系已解除，私聊已停止',
        );
      case RoomEnded(:final endedAt):
        if (_mustPurgeAfterEnd(state.conversation, ConversationStatus.ended)) {
          _revokeRoomAccess('会议已结束，本次临时访问已失效');
          if (_scopedGuest) unawaited(_authenticationLost());
          return;
        }
        unawaited(_discardPendingForLifecycle());
        if (state.action == RoomAction.recording) {
          unawaited(cancelRecording());
        }
        final conversation = state.conversation;
        if (conversation != null) {
          state = state.copyWith(
            conversation: conversation.copyWith(
              status: ConversationStatus.ended,
              endedAt: endedAt,
            ),
            connection: RoomSocketStatus.ended,
          );
          unawaited(_cacheConversation(state.conversation!));
        }
        _realtime.disconnect();
      case RoomFailure(:final message, :final code, :final authentication):
        if (code == 'GUEST_TOKEN_REVOKED') {
          _revokeRoomAccess('您已被主持人移出本次会议');
          unawaited(_authenticationLost());
          return;
        }
        if ((code == 'FRIEND_REQUIRED' || code == 'DIRECT_CHAT_INVALID') &&
            state.conversation?.isDirect == true) {
          unawaited(_discardPendingForLifecycle());
          if (state.action == RoomAction.recording) {
            unawaited(cancelRecording());
          }
          _realtime.disconnect();
          state = state.copyWith(
            connection: RoomSocketStatus.disconnected,
            action: RoomAction.idle,
            directChatClosed: true,
            error: '好友关系已解除，私聊已停止',
          );
          return;
        }
        if (code == 'CONVERSATION_NOT_FOUND' ||
            code == 'NOT_A_PARTICIPANT' ||
            code == 'PARTICIPANT_REMOVED' ||
            code == 'HISTORY_ACCESS_EXPIRED') {
          _revokeRoomAccess(message);
          return;
        }
        if (_isTerminalRoomError(code)) {
          unawaited(_discardPendingForLifecycle());
          if (state.action == RoomAction.recording) {
            unawaited(cancelRecording());
          }
          _realtime.disconnect();
          state = state.copyWith(
            connection: code == 'ROOM_EXPIRED'
                ? RoomSocketStatus.ended
                : RoomSocketStatus.disconnected,
            error: message,
          );
          return;
        }
        state = state.copyWith(error: message);
        if (authentication) unawaited(_recoverSocketAuthentication());
    }
  }

  /// Test seam for exercising the exact reducer used by Socket.IO delivery
  /// without opening a network connection.
  @visibleForTesting
  void debugHandleEvent(RoomEvent event) => _handleEvent(event);

  @visibleForTesting
  void debugSetConversation(Conversation conversation) {
    if (!_disposed && conversation.id == conversationId) {
      state = state.copyWith(conversation: conversation);
    }
  }

  Future<void> _completeSocketSync() async {
    if (_socketSyncInFlight || _disposed || _socketLatestSequence == null) {
      if (_socketSyncInFlight) _socketSyncRetryRequested = true;
      return;
    }
    _socketSyncInFlight = true;
    try {
      final synchronized = await _backfill();
      if (_disposed) return;
      final latest = _socketLatestSequence ?? 0;
      if (synchronized && _ledger.lastSequence >= latest) {
        _socketLatestSequence = null;
        _authRecoveryAttempted = false;
        final status = state.conversation?.status;
        state = state.copyWith(
          connection: status == ConversationStatus.ended ||
                  status == ConversationStatus.expired
              ? RoomSocketStatus.ended
              : RoomSocketStatus.connected,
          clearError: true,
        );
      }
    } finally {
      _socketSyncInFlight = false;
      if (_socketSyncRetryRequested && !_disposed) {
        _socketSyncRetryRequested = false;
        unawaited(_completeSocketSync());
      }
    }
  }

  static bool _isTerminalRoomError(String? code) => switch (code) {
        'CONVERSATION_NOT_FOUND' ||
        'NOT_A_PARTICIPANT' ||
        'PARTICIPANT_REMOVED' ||
        'HISTORY_ACCESS_EXPIRED' ||
        'ROOM_EXPIRED' ||
        'ROOM_NOT_ACTIVE' =>
          true,
        _ => false,
      };

  static bool _isAccessRevokedError(Object error) =>
      error is AppException &&
      switch (error.code) {
        'CONVERSATION_NOT_FOUND' ||
        'NOT_A_PARTICIPANT' ||
        'PARTICIPANT_REMOVED' ||
        'HISTORY_ACCESS_EXPIRED' ||
        'GUEST_TOKEN_REVOKED' =>
          true,
        _ => false,
      };

  void _setParticipants(
    List<Participant> participants, {
    ConversationStatus? status,
    String? selfParticipantId,
  }) {
    final unique = {
      for (final participant in participants) participant.id: participant,
    }.values.toList(growable: false);
    final conversation = state.conversation;
    final updated = conversation?.copyWith(
      status: status,
      participantCount: unique.length,
    );
    final resolvedSelfParticipantId =
        selfParticipantId ?? state.selfParticipantId;
    Participant? selfParticipant;
    for (final participant in unique) {
      if (participant.id == resolvedSelfParticipantId) {
        selfParticipant = participant;
        break;
      }
    }
    state = state.copyWith(
      participants: unique,
      conversation: updated,
      selfParticipantId: resolvedSelfParticipantId,
      inputLanguage: selfParticipant?.preferredLanguage ?? state.inputLanguage,
    );
    if (updated != null) unawaited(_cacheConversation(updated));
  }

  void _revokeRoomAccess(String message) {
    if (state.action == RoomAction.recording) {
      unawaited(cancelRecording());
    }
    unawaited(_discardPendingForLifecycle());
    _realtime.disconnect();
    unawaited(_playback.stop());
    _ledger = MessageLedger(conversationId);
    _playedFinalMessageIds.clear();
    _socketLatestSequence = null;
    state = RoomState(
      connection: RoomSocketStatus.disconnected,
      action: RoomAction.idle,
      inputLanguage: state.inputLanguage,
      error: message,
    );
    unawaited(_purgeRevokedRoomCache());
  }

  Future<void> _purgeRevokedRoomCache() async {
    try {
      await _database.deleteConversation(conversationId);
    } catch (_) {
      // The room remains hidden in memory even if a damaged optional cache
      // cannot be purged now. Logout clears all private rows as a second guard.
    }
  }

  Future<void> _recoverSocketAuthentication() async {
    if (_authRecoveryInFlight || _authRecoveryAttempted) return;
    _authRecoveryInFlight = true;
    _authRecoveryAttempted = true;
    try {
      await _recoverAuthentication();
      if ((await _tokens.readAccessToken())?.isNotEmpty != true) {
        throw const AppException('登录已失效，请重新登录');
      }
      _realtime.reconnectNow();
    } catch (error) {
      if (!_disposed) {
        state = state.copyWith(
          connection: RoomSocketStatus.disconnected,
          error: readableError(error),
        );
        await _authenticationLost();
      }
    } finally {
      _authRecoveryInFlight = false;
    }
  }

  bool _mustPurgeAfterEnd(
    Conversation? conversation,
    ConversationStatus status,
  ) =>
      conversation != null &&
      conversation.ownerId != _currentUserId &&
      conversation.guestHistoryPolicy == GuestHistoryPolicy.noAccessAfterEnd &&
      (status == ConversationStatus.ended ||
          status == ConversationStatus.expired);

  Future<void> _autoPlay(String url) async {
    try {
      final settings = await _settings();
      await _playback.setSpeed(settings.playbackSpeed);
      if (settings.autoPlay) _playback.enqueue(url);
    } catch (error) {
      if (!_disposed) {
        state = state.copyWith(error: '语音播放失败：${readableError(error)}');
      }
    }
  }

  /// Plays the latest signed URL for one message. If a cached URL has expired,
  /// fetch the authoritative message row once and retry with its newly signed
  /// URL instead of asking the user to reload the whole room.
  Future<void> playMessageAudio(TranslationMessage message) async {
    if (_disposed ||
        message.conversationId != conversationId ||
        message.audioUrl?.isNotEmpty != true) {
      throw const AppException('译文语音暂不可用');
    }
    try {
      await _playback.playNow(message.audioUrl!);
      return;
    } catch (_) {
      final page = await _repository.messages(
        conversationId,
        afterSequence: message.sequence > 0 ? message.sequence - 1 : 0,
        limit: 2,
      );
      TranslationMessage? fresh;
      for (final candidate in page) {
        if (candidate.id == message.id) {
          fresh = candidate;
          break;
        }
      }
      if (_disposed || fresh?.audioUrl?.isNotEmpty != true) {
        throw const AppException('译文语音已过期且无法刷新');
      }
      final merged = _ledger.merge([fresh!]);
      state = state.copyWith(messages: merged, clearError: true);
      await _cacheMessage(fresh);
      if (_disposed) return;
      await _playback.playNow(fresh.audioUrl!);
    }
  }

  Future<void> setInputLanguage(Language language) async {
    if (state.action != RoomAction.idle || language == state.inputLanguage) {
      return;
    }
    Participant? participant;
    for (final item in state.participants) {
      if (item.id == state.selfParticipantId) participant = item;
    }
    if (participant == null || participant.company?.isNotEmpty != true) {
      state = state.copyWith(error: '无法更新本次会议的发言语言');
      return;
    }
    try {
      final updated = await _repository.updateParticipantProfile(
        conversationId: conversationId,
        displayName: participant.displayName,
        company: participant.company!,
        preferredLanguage: language,
      );
      final participants = {
        for (final item in state.participants) item.id: item,
        updated.id: updated,
      }.values.toList(growable: false);
      _setParticipants(participants);
      state = state.copyWith(inputLanguage: language, clearError: true);
    } catch (error) {
      state = state.copyWith(error: readableError(error));
    }
  }

  void clearError() => state = state.copyWith(clearError: true);

  Future<void> beginRecording() async {
    if (!_canStartRecording) return;
    _recordingStartInFlight = true;
    _pendingRecordingRelease = null;
    state = state.copyWith(action: RoomAction.recording, clearError: true);
    try {
      await _audioCapture.start();
      _recordingStartInFlight = false;
      if (_disposed) {
        await _audioCapture.cancel();
        return;
      }
      final release = _pendingRecordingRelease;
      _pendingRecordingRelease = null;
      if (release == _RecordingRelease.cancel) {
        await _audioCapture.cancel();
        state = state.copyWith(action: RoomAction.idle);
      } else if (release == _RecordingRelease.send) {
        await _finishStartedRecording();
      }
    } catch (error) {
      try {
        await _audioCapture.cancel();
      } catch (_) {
        // The recorder may never have reached an active state.
      }
      if (!_disposed) {
        state = state.copyWith(
          action: RoomAction.idle,
          error: readableError(error),
        );
      }
    } finally {
      _recordingStartInFlight = false;
      _pendingRecordingRelease = null;
    }
  }

  Future<void> finishRecording() async {
    if (state.action != RoomAction.recording) return;
    if (_recordingStartInFlight) {
      _pendingRecordingRelease ??= _RecordingRelease.send;
      return;
    }
    await _finishStartedRecording();
  }

  Future<void> _finishStartedRecording() async {
    if (_disposed || state.action != RoomAction.recording) return;
    if (!_canSpeak) {
      await cancelRecording();
      return;
    }
    final sourceLanguage = state.inputLanguage;
    String? path;
    try {
      path = await _audioCapture.stop();
    } catch (error) {
      if (!_disposed) {
        state = state.copyWith(
          action: RoomAction.idle,
          error: '录音失败：${readableError(error)}',
        );
      }
      return;
    }
    if (_disposed) {
      if (path != null) await _audioCapture.deleteSegment(path);
      return;
    }
    if (path == null) {
      state = state.copyWith(action: RoomAction.idle, error: '录音失败，请重试');
      return;
    }
    final pending = _PendingAudio(
      path: path,
      sourceLanguage: sourceLanguage,
      idempotencyKey: const Uuid().v4(),
    );
    _pendingAudio = pending;
    _pendingAudioRegistry.retain(
      PendingAudioDraft(
        conversationId: conversationId,
        path: pending.path,
        sourceLanguage: pending.sourceLanguage,
        idempotencyKey: pending.idempotencyKey,
      ),
    );
    await _sendPendingAudio(pending);
  }

  Future<void> retryPendingAudio() async {
    final pending = _pendingAudio;
    if (_disposed || pending == null || state.action != RoomAction.sendFailed) {
      return;
    }
    if (!_canSpeak) {
      state = state.copyWith(error: '当前会议状态不允许发送此段录音');
      return;
    }
    await _sendPendingAudio(pending);
  }

  Future<void> _sendPendingAudio(_PendingAudio pending) async {
    if (_disposed || !identical(_pendingAudio, pending)) return;
    state = state.copyWith(action: RoomAction.uploading, clearError: true);
    try {
      final result = await _repository.uploadAudio(
        conversationId: conversationId,
        path: pending.path,
        sourceLanguage: pending.sourceLanguage,
        idempotencyKey: pending.idempotencyKey,
        onUploaded: () {
          if (!_disposed &&
              identical(_pendingAudio, pending) &&
              state.action == RoomAction.uploading) {
            state = state.copyWith(action: RoomAction.processing);
          }
        },
      );
      if (_disposed || !identical(_pendingAudio, pending)) return;
      final message = TranslationMessage.fromJson(result);
      if (message.id.isEmpty || message.conversationId != conversationId) {
        throw const FormatException('Invalid audio upload response');
      }
      // REST also returns the current idempotent message. A PROCESSING reply
      // means another worker still owns the lease; it is not proof that the
      // audio was durably translated, so the local file and key must remain.
      _handleEvent(MessageReceived(message));
      if (message.status != MessageStatus.finalResult) {
        state = state.copyWith(
          action: RoomAction.sendFailed,
          error: message.status == MessageStatus.processing
              ? '服务端仍在处理此段录音，请稍后使用同一录音重试发送'
              : '此段翻译尚未成功，可保留原录音重试发送或放弃此段',
        );
        return;
      }
      _pendingAudio = null;
      final cleanupError = await _deletePendingPath(pending.path);
      if (!_disposed) {
        state = state.copyWith(
          action: RoomAction.idle,
          error: cleanupError,
          clearError: cleanupError == null,
        );
      }
    } catch (error) {
      if (!_disposed && identical(_pendingAudio, pending)) {
        state = state.copyWith(
          action: RoomAction.sendFailed,
          error: '发送失败：${readableError(error)}。原录音已保留，可重试发送或放弃此段',
        );
      }
    }
  }

  Future<void> discardPendingAudio() async {
    final pending = _pendingAudio;
    if (pending == null ||
        state.action == RoomAction.uploading ||
        state.action == RoomAction.processing) {
      return;
    }
    _pendingAudio = null;
    final cleanupError = await _deletePendingPath(pending.path);
    if (!_disposed) {
      state = state.copyWith(
        action: RoomAction.idle,
        error: cleanupError,
        clearError: cleanupError == null,
      );
    }
  }

  Future<String?> _deletePendingPath(String path) async {
    try {
      await _pendingAudioRegistry.delete(path);
      return null;
    } catch (error) {
      return '本地临时录音清理失败：${readableError(error)}';
    }
  }

  Future<void> _discardPendingForLifecycle() async {
    final pending = _pendingAudio;
    _pendingAudio = null;
    if (pending != null) {
      try {
        await _pendingAudioRegistry.delete(pending.path);
      } catch (_) {
        // The registry keeps failed paths for logout or cold-start cleanup.
      }
    }
    if (!_disposed &&
        (state.action == RoomAction.uploading ||
            state.action == RoomAction.processing ||
            state.action == RoomAction.sendFailed)) {
      state = state.copyWith(action: RoomAction.idle);
    }
  }

  bool _isTtsPending(TranslationMessage message) =>
      message.status == MessageStatus.finalResult &&
      message.audioUrl?.isNotEmpty != true &&
      (message.errorCode == 'TTS_PENDING' ||
          message.errorCode == 'TTS_PROCESSING');

  Future<void> _refreshPendingTts(TranslationMessage pending) async {
    if (!_ttsRefreshInFlight.add(pending.id)) return;
    try {
      for (var attempt = 0; attempt < 30 && !_disposed; attempt += 1) {
        await Future<void>.delayed(const Duration(seconds: 1));
        if (_disposed) return;
        TranslationMessage? current;
        for (final item in state.messages) {
          if (item.id == pending.id) {
            current = item;
            break;
          }
        }
        if (current != null && !_isTtsPending(current)) return;
        final page = await _repository.messages(
          conversationId,
          afterSequence: pending.sequence > 0 ? pending.sequence - 1 : 0,
          limit: 2,
        );
        TranslationMessage? fresh;
        for (final candidate in page) {
          if (candidate.id == pending.id) {
            fresh = candidate;
            break;
          }
        }
        if (fresh == null) return;
        _handleEvent(MessageReceived(fresh));
        if (!_isTtsPending(fresh)) return;
      }
    } catch (_) {
      // Socket delivery remains the primary path. Polling only closes the gap
      // when TTS finishes while realtime synchronization is disconnected.
    } finally {
      _ttsRefreshInFlight.remove(pending.id);
    }
  }

  Future<void> cancelRecording() async {
    if (state.action != RoomAction.recording) return;
    if (_recordingStartInFlight) {
      _pendingRecordingRelease = _RecordingRelease.cancel;
      return;
    }
    try {
      await _audioCapture.cancel();
    } catch (error) {
      if (!_disposed) {
        state = state.copyWith(error: '停止录音失败：${readableError(error)}');
      }
    } finally {
      if (!_disposed) state = state.copyWith(action: RoomAction.idle);
    }
  }

  Future<void> endConversation() async {
    if (state.action == RoomAction.recording) await cancelRecording();
    await _discardPendingForLifecycle();
    try {
      final conversation = await _repository.end(conversationId);
      if (!_disposed) {
        state = state.copyWith(
          conversation: conversation,
          connection: RoomSocketStatus.ended,
        );
      }
      await _cacheConversation(conversation);
    } catch (error) {
      if (!_disposed) state = state.copyWith(error: readableError(error));
    }
  }

  Future<
      ({
        Conversation conversation,
        ConversationInvitation invitation,
      })?> rotateInvitation() async {
    final current = state.conversation;
    if (current == null || current.status != ConversationStatus.waiting) {
      state = state.copyWith(error: '只有等待客户加入时才能重新生成邀请');
      return null;
    }
    try {
      final invitation = await _repository.rotateInvitation(conversationId);
      if (invitation.conversationId != conversationId ||
          invitation.roomToken.isEmpty ||
          invitation.roomCode.isEmpty ||
          invitation.inviteUrl.isEmpty) {
        throw const AppException('服务端返回的邀请无效');
      }
      if (_disposed) return null;
      final latest = state.conversation;
      if (latest == null || latest.status != ConversationStatus.waiting) {
        state = state.copyWith(error: '客户已加入，无需再分享新邀请');
        return null;
      }
      final updated = latest.copyWith(
        roomToken: invitation.roomToken,
        roomCode: invitation.roomCode,
      );
      state = state.copyWith(conversation: updated, clearError: true);
      await _cacheConversation(updated);
      return (conversation: updated, invitation: invitation);
    } catch (error) {
      if (!_disposed) state = state.copyWith(error: readableError(error));
      return null;
    }
  }

  Future<void> _cacheConversation(Conversation conversation) async {
    try {
      await _database.cacheConversation(conversation);
    } catch (_) {
      // Server state remains authoritative; cache failures are non-fatal.
    }
  }

  Future<void> _cacheMessage(TranslationMessage message) async {
    try {
      await _database.upsertMessage(message);
    } catch (_) {
      // The next REST backfill can repopulate this optional cache row.
    }
  }

  Future<void> _cacheMessages(Iterable<TranslationMessage> messages) async {
    try {
      await _database.upsertMessages(messages);
    } catch (_) {
      // Live state has already been merged; reconnect will retry persistence.
    }
  }

  Future<void> retryConnection() async {
    if (_disposed || _startInFlight) return;
    state = state.copyWith(
      connection: RoomSocketStatus.connecting,
      clearError: true,
    );
    await _start();
  }

  Future<bool> removeParticipant(String participantId) async {
    final removable = state.participants.any(
      (participant) =>
          participant.id == participantId &&
          participant.role != UserRole.host &&
          participant.presence != ParticipantPresence.removed,
    );
    if (!removable) {
      state = state.copyWith(error: '只能移出当前会议中的非主持人参会者');
      return false;
    }
    try {
      final removedParticipantId = await _repository.removeParticipant(
        conversationId,
        participantId,
      );
      if (removedParticipantId != participantId) {
        throw const AppException('服务端返回的移除结果无效');
      }
      _handleEvent(ParticipantRemoved(participantId: participantId));
      state = state.copyWith(clearError: true);
      return true;
    } catch (error) {
      state = state.copyWith(error: readableError(error));
      return false;
    }
  }

  Future<bool> proposeMessageCorrection({
    required TranslationMessage message,
    required String sourceText,
    required String translatedText,
    String? reason,
  }) =>
      _runMessageReview(
        message,
        'edit',
        () => _repository.proposeMessageCorrection(
          conversationId: conversationId,
          messageId: message.id,
          expectedRevision: message.reviewRevision,
          sourceText: sourceText,
          translatedText: translatedText,
          reason: reason,
          idempotencyKey: const Uuid().v4(),
        ),
      );

  Future<bool> retranslateMessage(TranslationMessage message) =>
      _runMessageReview(
        message,
        'retranslate',
        () => _repository.retranslateMessage(
          conversationId: conversationId,
          messageId: message.id,
          expectedRevision: message.reviewRevision,
          sourceText: message.pendingSourceText ?? message.sourceText,
          idempotencyKey: const Uuid().v4(),
        ),
      );

  Future<bool> decideMessageCorrection(
    TranslationMessage message, {
    required bool confirm,
  }) =>
      _runMessageReview(
        message,
        confirm ? 'confirm' : 'reject',
        () => _repository.decideMessageCorrection(
          conversationId: conversationId,
          messageId: message.id,
          expectedRevision: message.reviewRevision,
          confirm: confirm,
        ),
      );

  Future<bool> addMessageToGlossary({
    required TranslationMessage message,
    required String sourceTerm,
    required String targetTerm,
    String? category,
  }) async {
    final key = '${message.id}:glossary';
    if (!_messageReviewInFlight.add(key)) return false;
    try {
      await _repository.addConfirmedMessageToGlossary(
        conversationId: conversationId,
        messageId: message.id,
        sourceTerm: sourceTerm,
        targetTerm: targetTerm,
        category: category,
      );
      if (!_disposed) state = state.copyWith(clearError: true);
      return true;
    } catch (error) {
      if (!_disposed) state = state.copyWith(error: readableError(error));
      return false;
    } finally {
      _messageReviewInFlight.remove(key);
    }
  }

  Future<bool> _runMessageReview(
    TranslationMessage message,
    String action,
    Future<TranslationMessage> Function() operation,
  ) async {
    if (message.conversationId != conversationId ||
        message.status != MessageStatus.finalResult) {
      state = state.copyWith(error: '只有本会议已完成的翻译可以纠错');
      return false;
    }
    final key = '${message.id}:$action';
    if (!_messageReviewInFlight.add(key)) return false;
    try {
      final reviewed = await operation();
      if (reviewed.id != message.id ||
          reviewed.conversationId != conversationId) {
        throw const FormatException('Invalid message review response');
      }
      final merged = _ledger.merge([reviewed]);
      if (!_disposed) {
        state = state.copyWith(messages: merged, clearError: true);
      }
      await _cacheMessage(reviewed);
      return true;
    } catch (error) {
      if (!_disposed) state = state.copyWith(error: readableError(error));
      return false;
    } finally {
      _messageReviewInFlight.remove(key);
    }
  }

  @override
  void dispose() {
    _disposed = true;
    // A stopped recording remains in PendingAudioRegistry across this
    // auto-disposed room controller. Only FINAL success, explicit discard,
    // logout, removal or room end is allowed to delete it.
    unawaited(_eventSubscription.cancel());
    final capture = _capture;
    if (capture != null) unawaited(capture.dispose());
    unawaited(_realtime.dispose());
    unawaited(_playback.stop());
    super.dispose();
  }
}
