import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tooyei_translator/core/api/api_client.dart';
import 'package:tooyei_translator/core/audio/audio_playback_queue.dart';
import 'package:tooyei_translator/core/audio/pending_audio_registry.dart';
import 'package:tooyei_translator/core/auth/secure_token_store.dart';
import 'package:tooyei_translator/core/cache/app_preferences.dart';
import 'package:tooyei_translator/core/cache/local_database.dart';
import 'package:tooyei_translator/core/models.dart';
import 'package:tooyei_translator/core/realtime/room_realtime_client.dart';
import 'package:tooyei_translator/features/conversations/conversation_repository.dart';
import 'package:tooyei_translator/features/room/room_controller.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('participant snapshot initializes input language from self profile', () {
    final controller = controllerForTest(initialLanguage: Language.zh);

    controller.debugHandleEvent(
      const ParticipantsSnapshot(
        participants: [
          Participant(
            id: 'self',
            displayName: 'Иван',
            role: UserRole.user,
            company: 'ACME',
            preferredLanguage: Language.ru,
            presence: ParticipantPresence.online,
          ),
        ],
        status: ConversationStatus.active,
        selfParticipantId: 'self',
      ),
    );

    expect(controller.state.selfParticipantId, 'self');
    expect(controller.state.inputLanguage, Language.ru);
  });

  test('reconnect failure exposes recoverable connection state', () {
    final controller = controllerForTest();

    controller.debugHandleEvent(
      const SocketStatusChanged(RoomSocketStatus.reconnectFailed),
    );

    expect(controller.state.connection, RoomSocketStatus.reconnectFailed);
    expect(controller.state.error, contains('点击重试连接'));
  });

  test('friendship end stops live direct chat without purging history', () {
    final controller = controllerForTest(currentUserId: 'user-1');
    controller.debugSetConversation(
      Conversation(
        id: 'conversation-1',
        kind: ConversationKind.direct,
        ownerId: 'user-1',
        contactId: 'contact-1',
        status: ConversationStatus.active,
        roomToken: '',
        roomCode: '',
        guestHistoryPolicy: GuestHistoryPolicy.permanent,
        createdAt: DateTime.utc(2026, 7, 20),
        updatedAt: DateTime.utc(2026, 7, 20),
        supportsDocuments: false,
      ),
    );
    expect(controller.debugCanStartRecording, isTrue);

    controller.debugHandleEvent(const DirectChatFriendshipEnded());

    expect(controller.state.connection, RoomSocketStatus.disconnected);
    expect(controller.state.action, RoomAction.idle);
    expect(controller.state.directChatClosed, isTrue);
    expect(controller.debugCanStartRecording, isFalse);
    expect(controller.state.error, contains('好友关系已解除'));
    controller.dispose();
  });

  test('waiting host can record while realtime synchronization is unavailable',
      () {
    final controller = controllerForTest(currentUserId: 'host-1');
    controller.debugSetConversation(
      Conversation(
        id: 'conversation-1',
        ownerId: 'host-1',
        contactId: 'contact-1',
        status: ConversationStatus.waiting,
        roomToken: '',
        roomCode: '',
        guestHistoryPolicy: GuestHistoryPolicy.accessFor24Hours,
        createdAt: DateTime.utc(2026, 7, 19),
        updatedAt: DateTime.utc(2026, 7, 19),
      ),
    );
    controller.debugHandleEvent(
      const SocketStatusChanged(RoomSocketStatus.reconnectFailed),
    );

    expect(controller.state.connection, RoomSocketStatus.reconnectFailed);
    expect(controller.debugCanStartRecording, isTrue);
    controller.dispose();
  });

  test('waiting non-owner remains unable to record', () {
    final controller = controllerForTest(currentUserId: 'participant-2');
    controller.debugSetConversation(
      Conversation(
        id: 'conversation-1',
        ownerId: 'host-1',
        contactId: 'contact-1',
        status: ConversationStatus.waiting,
        roomToken: '',
        roomCode: '',
        guestHistoryPolicy: GuestHistoryPolicy.accessFor24Hours,
        createdAt: DateTime.utc(2026, 7, 19),
        updatedAt: DateTime.utc(2026, 7, 19),
      ),
    );

    expect(controller.debugCanStartRecording, isFalse);
    controller.dispose();
  });

  test('self removal immediately hides in-memory transcript and identity',
      () async {
    final controller = controllerForTest();
    controller.debugHandleEvent(
      const ParticipantsSnapshot(
        participants: [
          Participant(
            id: 'self',
            displayName: '张三',
            role: UserRole.user,
            company: '甲公司',
          ),
        ],
        status: ConversationStatus.active,
        selfParticipantId: 'self',
      ),
    );
    controller.debugHandleEvent(
      MessageReceived(
        TranslationMessage(
          id: 'message-1',
          conversationId: 'conversation-1',
          participantId: 'self',
          speakerRole: SpeakerRole.guest,
          sourceLanguage: Language.zh,
          targetLanguage: Language.ru,
          sourceText: '敏感原文',
          translatedText: '敏感译文',
          status: MessageStatus.finalResult,
          sequence: 1,
          createdAt: DateTime.utc(2026, 7, 19),
        ),
      ),
    );
    expect(controller.state.messages, hasLength(1));

    controller.debugHandleEvent(
      const ParticipantRemoved(participantId: 'self'),
    );

    expect(controller.state.messages, isEmpty);
    expect(controller.state.participants, isEmpty);
    expect(controller.state.selfParticipantId, isNull);
    expect(controller.state.error, contains('移出'));

    // Let the best-effort asynchronous cache purge enter its guarded path.
    await Future<void>.delayed(Duration.zero);
  });

  test('server-forced disconnect authenticates and reconnects with new token',
      () async {
    FlutterSecureStorage.setMockInitialValues({
      'auth.access_token': 'rotated-access',
    });
    var recoveries = 0;
    var lost = 0;
    final controller = controllerForTest(
      recoverAuthentication: () async => recoveries += 1,
      authenticationLost: () async => lost += 1,
    );

    controller.debugHandleEvent(
      const SocketStatusChanged(
        RoomSocketStatus.disconnected,
        reason: 'io server disconnect',
      ),
    );
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);

    expect(recoveries, 1);
    expect(lost, 0);
    expect(controller.state.error, contains('恢复会议连接'));
    controller.dispose();
  });

  test('NO_ACCESS_AFTER_END guest immediately purges transcript and session',
      () async {
    var authenticationLost = 0;
    final controller = controllerForTest(
      scopedGuest: true,
      authenticationLost: () async => authenticationLost += 1,
    );
    controller.debugSetConversation(
      Conversation(
        id: 'conversation-1',
        ownerId: 'host-1',
        contactId: 'contact-1',
        status: ConversationStatus.active,
        roomToken: '',
        roomCode: '',
        guestHistoryPolicy: GuestHistoryPolicy.noAccessAfterEnd,
        createdAt: DateTime.utc(2026, 7, 19),
        updatedAt: DateTime.utc(2026, 7, 19),
      ),
    );
    controller.debugHandleEvent(
      MessageReceived(
        TranslationMessage(
          id: 'message-1',
          conversationId: 'conversation-1',
          participantId: 'self',
          speakerRole: SpeakerRole.guest,
          sourceLanguage: Language.zh,
          targetLanguage: Language.ru,
          sourceText: '不应保留的原文',
          translatedText: '不应保留的译文',
          status: MessageStatus.finalResult,
          sequence: 1,
          createdAt: DateTime.utc(2026, 7, 19),
        ),
      ),
    );

    controller.debugHandleEvent(RoomEnded(DateTime.utc(2026, 7, 19, 1)));

    expect(controller.state.messages, isEmpty);
    expect(controller.state.conversation, isNull);
    expect(controller.state.participants, isEmpty);
    await Future<void>.delayed(Duration.zero);
    expect(authenticationLost, 1);
    controller.dispose();
  });

  test(
      'NO_ACCESS_AFTER_END also purges a registered non-owner without global logout',
      () async {
    var authenticationLost = 0;
    final controller = controllerForTest(
      scopedGuest: false,
      currentUserId: 'registered-participant',
      authenticationLost: () async => authenticationLost += 1,
    );
    controller.debugSetConversation(
      Conversation(
        id: 'conversation-1',
        ownerId: 'host-1',
        contactId: 'contact-1',
        status: ConversationStatus.active,
        roomToken: '',
        roomCode: '',
        guestHistoryPolicy: GuestHistoryPolicy.noAccessAfterEnd,
        createdAt: DateTime.utc(2026, 7, 19),
        updatedAt: DateTime.utc(2026, 7, 19),
      ),
    );
    controller.debugHandleEvent(
      MessageReceived(
        TranslationMessage(
          id: 'message-registered',
          conversationId: 'conversation-1',
          participantId: 'registered-participant',
          speakerRole: SpeakerRole.guest,
          sourceLanguage: Language.zh,
          targetLanguage: Language.ru,
          sourceText: '会后不应保留',
          translatedText: '会后不应保留',
          status: MessageStatus.finalResult,
          sequence: 1,
          createdAt: DateTime.utc(2026, 7, 19),
        ),
      ),
    );

    controller.debugHandleEvent(RoomEnded(DateTime.utc(2026, 7, 19, 1)));

    expect(controller.state.messages, isEmpty);
    expect(controller.state.conversation, isNull);
    await Future<void>.delayed(Duration.zero);
    expect(authenticationLost, 0);
    controller.dispose();
  });

  test('NO_ACCESS_AFTER_END does not purge the conversation owner', () {
    final controller = controllerForTest(currentUserId: 'host-1');
    controller.debugSetConversation(
      Conversation(
        id: 'conversation-1',
        ownerId: 'host-1',
        contactId: 'contact-1',
        status: ConversationStatus.active,
        roomToken: '',
        roomCode: '',
        guestHistoryPolicy: GuestHistoryPolicy.noAccessAfterEnd,
        createdAt: DateTime.utc(2026, 7, 19),
        updatedAt: DateTime.utc(2026, 7, 19),
      ),
    );

    controller.debugHandleEvent(RoomEnded(DateTime.utc(2026, 7, 19, 1)));

    expect(controller.state.conversation?.status, ConversationStatus.ended);
    controller.dispose();
  });
}

RoomController controllerForTest({
  Language initialLanguage = Language.zh,
  bool scopedGuest = false,
  String? currentUserId = 'user-1',
  Future<void> Function()? recoverAuthentication,
  Future<void> Function()? authenticationLost,
}) {
  final tokens = SecureTokenStore();
  return RoomController(
    conversationId: 'conversation-1',
    repository: ConversationRepository(
      ApiClient(baseUrl: 'http://127.0.0.1', tokenStore: tokens),
    ),
    database: LocalDatabase(),
    tokens: tokens,
    playback: AudioPlaybackQueue(),
    pendingAudioRegistry: PendingAudioRegistry(),
    settings: () async => const AppSettings(autoPlay: false),
    recoverAuthentication: recoverAuthentication ?? () async {},
    authenticationLost: authenticationLost ?? () async {},
    scopedGuest: scopedGuest,
    currentUserId: currentUserId,
    initialLanguage: initialLanguage,
    startImmediately: false,
    realtime: RoomRealtimeClient(socketUrl: 'http://127.0.0.1'),
  );
}
