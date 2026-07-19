import 'package:flutter_test/flutter_test.dart';
import 'package:tooyei_translator/core/models.dart';
import 'package:tooyei_translator/core/realtime/message_ledger.dart';

void main() {
  group('MessageLedger', () {
    test('orders by sequence and deduplicates reconnect delivery', () {
      final ledger = MessageLedger('conv-a');
      final second = message(id: 'm2', conversationId: 'conv-a', sequence: 2);
      final first = message(id: 'm1', conversationId: 'conv-a', sequence: 1);

      final result = ledger.merge([second, first, second]);

      expect(result.map((item) => item.id), ['m1', 'm2']);
      expect(ledger.lastSequence, 2);
    });

    test('rejects messages from another conversation', () {
      final ledger = MessageLedger('conv-a');

      final result = ledger.merge([
        message(id: 'valid', conversationId: 'conv-a', sequence: 1),
        message(id: 'leak', conversationId: 'conv-b', sequence: 2),
      ]);

      expect(result.single.id, 'valid');
      expect(result.any((item) => item.id == 'leak'), isFalse);
    });

    test('final result replaces processing event with the same ID', () {
      final ledger = MessageLedger('conv-a');
      ledger.merge([
        message(
          id: 'm1',
          conversationId: 'conv-a',
          sequence: 0,
          status: MessageStatus.processing,
        ),
      ]);

      final result = ledger.merge([
        message(
          id: 'm1',
          conversationId: 'conv-a',
          sequence: 7,
          status: MessageStatus.finalResult,
        ),
      ]);

      expect(result, hasLength(1));
      expect(result.single.status, MessageStatus.finalResult);
      expect(result.single.sequence, 7);
    });

    test('one final message wins a duplicate temporary sequence', () {
      final ledger = MessageLedger('conv-a');

      final result = ledger.merge([
        message(
          id: 'temporary',
          conversationId: 'conv-a',
          sequence: 8,
          status: MessageStatus.processing,
        ),
        message(
          id: 'final',
          conversationId: 'conv-a',
          sequence: 8,
          status: MessageStatus.finalResult,
        ),
      ]);

      expect(result, hasLength(1));
      expect(result.single.id, 'final');
    });

    test('resume cursor stops before a sequence gap', () {
      final ledger = MessageLedger('conv-a');
      ledger.merge([
        message(id: 'm1', conversationId: 'conv-a', sequence: 1),
        message(id: 'm3', conversationId: 'conv-a', sequence: 3),
      ]);

      expect(ledger.lastSequence, 1);
      expect(ledger.highestSequence, 3);

      ledger.merge([message(id: 'm2', conversationId: 'conv-a', sequence: 2)]);
      expect(ledger.lastSequence, 3);
    });

    test('processing placeholder is not an acknowledged resume sequence', () {
      final ledger = MessageLedger('conv-a');
      ledger.merge([
        message(
          id: 'm1',
          conversationId: 'conv-a',
          sequence: 1,
          status: MessageStatus.processing,
        ),
        message(id: 'm2', conversationId: 'conv-a', sequence: 2),
      ]);

      expect(ledger.lastSequence, 0);

      ledger.merge([message(id: 'm1', conversationId: 'conv-a', sequence: 1)]);
      expect(ledger.lastSequence, 2);
    });

    test('stale processing becoming failed restores contiguous resume cursor',
        () {
      final ledger = MessageLedger('conv-a');
      ledger.merge([
        message(
          id: 'm1',
          conversationId: 'conv-a',
          sequence: 1,
          status: MessageStatus.processing,
        ),
        message(id: 'm2', conversationId: 'conv-a', sequence: 2),
      ]);

      final result = ledger.merge([
        message(
          id: 'm1',
          conversationId: 'conv-a',
          sequence: 1,
          status: MessageStatus.failed,
        ),
      ]);

      expect(result.where((item) => item.id == 'm1').single.status,
          MessageStatus.failed);
      expect(ledger.lastSequence, 2);
    });

    test('stale review event cannot overwrite a newer correction revision', () {
      final ledger = MessageLedger('conv-a');
      ledger.merge([
        message(
          id: 'm1',
          conversationId: 'conv-a',
          sequence: 1,
          reviewRevision: 4,
          sourceText: '已确认的新版本',
        ),
      ]);

      final result = ledger.merge([
        message(
          id: 'm1',
          conversationId: 'conv-a',
          sequence: 1,
          reviewRevision: 3,
          sourceText: '延迟到达的旧版本',
        ),
      ]);

      expect(result.single.reviewRevision, 4);
      expect(result.single.sourceText, '已确认的新版本');
    });

    test(
        'pending event cannot roll back a terminal review at the same revision',
        () {
      final ledger = MessageLedger('conv-a');
      ledger.merge([
        message(
          id: 'm1',
          conversationId: 'conv-a',
          sequence: 1,
          reviewRevision: 4,
          reviewStatus: MessageReviewStatus.confirmed,
          sourceText: '已确认版本',
        ),
      ]);

      final result = ledger.merge([
        message(
          id: 'm1',
          conversationId: 'conv-a',
          sequence: 1,
          reviewRevision: 4,
          reviewStatus: MessageReviewStatus.pending,
          sourceText: '延迟到达的待确认版本',
        ),
      ]);

      expect(result.single.reviewStatus, MessageReviewStatus.confirmed);
      expect(result.single.sourceText, '已确认版本');
    });

    test('late TTS-pending response cannot remove an already playable URL', () {
      final ledger = MessageLedger('conv-a');
      ledger.merge([
        message(
          id: 'm1',
          conversationId: 'conv-a',
          sequence: 1,
          audioUrl: 'https://api.example.test/audio.wav',
        ),
      ]);

      final result = ledger.merge([
        message(
          id: 'm1',
          conversationId: 'conv-a',
          sequence: 1,
          errorCode: 'TTS_PENDING',
        ),
      ]);

      expect(result.single.audioUrl, 'https://api.example.test/audio.wav');
      expect(result.single.errorCode, isNull);
    });
  });
}

TranslationMessage message({
  required String id,
  required String conversationId,
  required int sequence,
  MessageStatus status = MessageStatus.finalResult,
  int reviewRevision = 0,
  MessageReviewStatus reviewStatus = MessageReviewStatus.unreviewed,
  String sourceText = '你好',
  String? audioUrl,
  String? errorCode,
}) =>
    TranslationMessage(
      id: id,
      conversationId: conversationId,
      participantId: 'participant',
      speakerRole: SpeakerRole.host,
      sourceLanguage: Language.zh,
      targetLanguage: Language.ru,
      sourceText: sourceText,
      translatedText: 'Здравствуйте',
      audioUrl: audioUrl,
      status: status,
      sequence: sequence,
      createdAt: DateTime.utc(2026, 7, 18),
      reviewRevision: reviewRevision,
      reviewStatus: reviewStatus,
      errorCode: errorCode,
    );
