import 'package:flutter_test/flutter_test.dart';
import 'package:tooyei_translator/core/models.dart';

void main() {
  test('registered account parses avatar and synchronized preferences', () {
    final session = AuthSession.fromJson({
      'id': 'user-1',
      'role': 'USER',
      'displayName': '王伟',
      'avatarPreset': 'plum',
      'interfaceLanguage': 'ru',
      'autoPlayTranslationAudio': false,
      'translationPlaybackSpeed': 1.25,
    });

    expect(session.avatarPreset, 'plum');
    expect(session.interfaceLanguage, 'ru');
    expect(session.autoPlayTranslationAudio, isFalse);
    expect(session.translationPlaybackSpeed, 1.25);
  });

  test('translation.final event parses required isolation fields', () {
    final message = TranslationMessage.fromJson({
      'type': 'translation.final',
      'conversationId': 'conv-123',
      'messageId': 'msg-456',
      'participantId': 'p-1',
      'speakerRole': 'GUEST',
      'speakerDisplayName': 'Ivan Petrov',
      'speakerCompany': 'RU Trade',
      'speakerLanguage': 'ru',
      'sourceLanguage': 'ru',
      'targetLanguage': 'zh',
      'sourceText': 'Какой минимальный объём заказа?',
      'translatedText': '最低订购量是多少？',
      'sequence': 35,
      'createdAt': '2026-07-18T10:20:00Z',
    });

    expect(message.conversationId, 'conv-123');
    expect(message.id, 'msg-456');
    expect(message.status, MessageStatus.finalResult);
    expect(message.sourceLanguage, Language.ru);
    expect(message.sequence, 35);
    expect(message.displayName, 'Ivan Petrov');
    expect(message.company, 'RU Trade');
    expect(message.speakerLanguage, Language.ru);
  });

  test('translation.review.updated keeps confirmed and pending review state',
      () {
    final message = TranslationMessage.fromJson({
      'type': 'translation.review.updated',
      'status': 'FINAL',
      'conversationId': 'conv-review',
      'messageId': 'msg-review',
      'participantId': 'p-speaker',
      'speakerRole': 'GUEST',
      'sourceLanguage': 'ru',
      'targetLanguage': 'zh',
      'sourceText': 'Подтвержденный текст',
      'translatedText': '已确认文本',
      'originalSourceText': 'Исходный текст',
      'originalTranslatedText': '原始译文',
      'reviewStatus': 'PENDING',
      'reviewRevision': 3,
      'hasConfirmedCorrection': true,
      'pendingCorrection': {
        'revision': 3,
        'sourceText': 'Новое исправление',
        'translatedText': '新的纠错',
      },
      'sequence': 8,
      'createdAt': '2026-07-19T10:20:00Z',
    });

    expect(message.status, MessageStatus.finalResult);
    expect(message.reviewStatus, MessageReviewStatus.pending);
    expect(message.reviewRevision, 3);
    expect(message.hasConfirmedCorrection, isTrue);
    expect(message.originalSourceText, 'Исходный текст');
    expect(message.pendingSourceText, 'Новое исправление');
    expect(message.pendingTranslatedText, '新的纠错');
    expect(TranslationMessage.decode(message.encode()).reviewRevision, 3);
  });

  test('conversation parses a complete multi-participant presence snapshot',
      () {
    final conversation = Conversation.fromJson({
      'id': 'conv-multi',
      'ownerId': 'host-1',
      'contactId': 'contact-1',
      'status': 'ACTIVE',
      'roomToken': '',
      'roomCode': '',
      'createdAt': '2026-07-18T10:00:00Z',
      'updatedAt': '2026-07-18T10:00:00Z',
      'participants': [
        {
          'participantId': 'p-host',
          'displayName': '王经理',
          'company': '图远科技',
          'role': 'HOST',
          'preferredLanguage': 'zh',
          'presence': 'ONLINE',
          'registered': true,
        },
        {
          'participantId': 'p-guest',
          'displayName': 'Ivan',
          'company': 'RU Trade',
          'role': 'GUEST',
          'preferredLanguage': 'ru',
          'presence': 'REMOVED',
        },
      ],
    });

    expect(conversation.participants, hasLength(2));
    expect(
        conversation.participants.first.presence, ParticipantPresence.online);
    expect(
        conversation.participants.last.presence, ParticipantPresence.removed);
    expect(conversation.participants.last.preferredLanguage, Language.ru);
  });

  test('direct chat disables meeting documents and keeps the friend identity',
      () {
    final conversation = Conversation.fromJson({
      'id': 'direct-a-b',
      'kind': 'DIRECT',
      'ownerId': 'user-a',
      'contactId': 'contact-b',
      'status': 'ACTIVE',
      'roomToken': '',
      'roomCode': '',
      'createdAt': '2026-07-20T10:00:00Z',
      'updatedAt': '2026-07-20T10:00:00Z',
      'capabilities': {
        'documentExport': false,
        'aiSummary': false,
        'summaryDistribution': false,
      },
      'directPeer': {
        'id': 'user-b',
        'displayName': 'Иван',
        'company': 'RU Trade',
        'preferredLanguage': 'ru',
        'presence': 'ONLINE',
      },
    });

    expect(conversation.kind, ConversationKind.direct);
    expect(conversation.isDirect, isTrue);
    expect(conversation.directPeer?.displayName, 'Иван');
    expect(conversation.directPeer?.preferredLanguage, Language.ru);
    expect(conversation.supportsDocuments, isFalse);
    expect(conversation.canEnd, isFalse);
    expect(conversation.canSpeakAs('user-b'), isTrue);
    expect(Conversation.fromJson(conversation.toJson()).isDirect, isTrue);
  });

  test('meeting summary keeps participant and speaker attribution', () {
    final summary = MeetingSummary.fromJson({
      'summary': '报价讨论',
      'participantRoster': [
        {
          'participantId': 'p-1',
          'displayName': 'Ivan',
          'company': 'RU Trade',
          'preferredLanguage': 'ru',
          'role': 'GUEST',
        },
      ],
      'coreDiscussion': [
        {
          'participantId': 'p-1',
          'speakerDisplayName': 'Ivan',
          'sourceText': 'Цена подтверждена.',
        },
      ],
      'partyViews': [],
      'confirmedItems': [],
      'actionItems': [],
      'openQuestions': [],
      'sourceMaxSequence': 12,
      'sourceMessageCount': 10,
      'revision': 3,
      'isStale': true,
      'generatedAt': '2026-07-18T10:30:00Z',
    });

    expect(summary.participants.single.id, 'p-1');
    expect(summary.coreDiscussion.single['participantId'], 'p-1');
    expect(summary.coreDiscussion.single['speakerDisplayName'], 'Ivan');
    expect(summary.sourceMaxSequence, 12);
    expect(summary.sourceMessageCount, 10);
    expect(summary.revision, 3);
    expect(summary.isStale, isTrue);
  });

  test('conversation defaults history access to 24 hours', () {
    final conversation = Conversation.fromJson({
      'id': 'conv-1',
      'ownerId': 'host-1',
      'contactId': 'contact-1',
      'status': 'WAITING',
      'roomToken': 'unguessable',
      'roomCode': '123456',
      'createdAt': '2026-07-18T10:00:00Z',
      'updatedAt': '2026-07-18T10:00:00Z',
    });

    expect(
      conversation.guestHistoryPolicy,
      GuestHistoryPolicy.accessFor24Hours,
    );
    expect(conversation.canSpeak, isFalse);
    expect(conversation.canSpeakAs('host-1'), isTrue);
    expect(conversation.canSpeakAs('participant-2'), isFalse);
    expect(conversation.canSpeakAs(null), isFalse);
    expect(conversation.canEnd, isTrue);
    expect(
      conversation.copyWith(status: ConversationStatus.active).canSpeak,
      isTrue,
    );
    expect(
      conversation
          .copyWith(status: ConversationStatus.active)
          .canSpeakAs('participant-2'),
      isTrue,
    );
    expect(
      conversation
          .copyWith(status: ConversationStatus.ended)
          .canSpeakAs('host-1'),
      isFalse,
    );
    expect(
      conversation.copyWith(status: ConversationStatus.ended).canEnd,
      isFalse,
    );
    final rotated = conversation.copyWith(
      roomToken: 'new-token',
      roomCode: '87654321',
    );
    expect(rotated.roomToken, 'new-token');
    expect(rotated.roomCode, '87654321');
  });

  test('rotated invitation parses the direct endpoint payload', () {
    final invitation = ConversationInvitation.fromJson({
      'conversationId': 'conv-1',
      'roomToken': 'new-room-token',
      'roomCode': '87654321',
      'inviteUrl': 'https://www.ruscny.net/join/new-room-token',
      'expiresAt': '2026-07-18T12:00:00Z',
    });

    expect(invitation.conversationId, 'conv-1');
    expect(invitation.roomToken, 'new-room-token');
    expect(invitation.roomCode, '87654321');
    expect(
        invitation.expiresAt, DateTime.parse('2026-07-18T12:00:00Z').toLocal());
  });
}
