import 'package:dio/dio.dart';

import '../../core/api/api_client.dart';
import '../../core/models.dart';

final class ConversationRepository {
  const ConversationRepository(this._api);

  final ApiClient _api;

  Future<Conversation> create({
    required String contactId,
    required String title,
    required GuestHistoryPolicy guestHistoryPolicy,
    required String hostDisplayName,
    required String hostCompany,
    required Language hostLanguage,
  }) async =>
      _conversationFromPayload(
        await _api.postMap(
          '/conversations',
          data: {
            'contactId': contactId,
            'title': title.trim(),
            'hostLanguage': 'zh',
            'guestLanguage': 'ru',
            'guestHistoryPolicy': guestHistoryPolicy.wireValue,
            'hostProfile': {
              'displayName': hostDisplayName.trim(),
              'company': hostCompany.trim(),
              'preferredLanguage': hostLanguage.code,
            },
          },
        ),
      );

  Future<Conversation> join({
    String? roomToken,
    String? roomCode,
    required String displayName,
    required String company,
    required Language preferredLanguage,
  }) async =>
      _conversationFromPayload(
        await _api.postMap(
          '/conversations/join',
          data: {
            if (roomToken?.isNotEmpty == true) 'roomToken': roomToken,
            if (roomCode?.isNotEmpty == true) 'roomCode': roomCode,
            'displayName': displayName.trim(),
            'company': company.trim(),
            'preferredLanguage': preferredLanguage.code,
          },
        ),
      );

  Future<List<Conversation>> list({
    String? contactId,
    String? search,
    DateTime? from,
    DateTime? to,
  }) async {
    final rows = await _api.getList(
      '/conversations',
      query: {
        if (contactId?.isNotEmpty == true) 'contactId': contactId,
        if (search?.trim().isNotEmpty == true) 'search': search!.trim(),
        if (from != null) 'from': from.toUtc().toIso8601String(),
        if (to != null) 'to': to.toUtc().toIso8601String(),
      },
    );
    return rows
        .whereType<Map>()
        .map((row) => Conversation.fromJson(row.cast<String, dynamic>()))
        .toList(growable: false);
  }

  Future<Conversation> get(String id) async => _conversationFromPayload(
        await _api.getMap('/conversations/${Uri.encodeComponent(id)}'),
      );

  Future<List<TranslationMessage>> messages(
    String conversationId, {
    int afterSequence = 0,
    int limit = 500,
  }) async {
    final rows = await _api.getList(
      '/conversations/${Uri.encodeComponent(conversationId)}/messages',
      query: {'afterSequence': afterSequence, 'limit': limit},
    );
    return rows
        .whereType<Map>()
        .map((row) => TranslationMessage.fromJson(row.cast<String, dynamic>()))
        .where((message) => message.conversationId == conversationId)
        .toList(growable: false);
  }

  Future<List<TranslationMessage>> allMessages(String conversationId) async {
    const pageSize = 500;
    final byId = <String, TranslationMessage>{};
    var cursor = 0;
    while (true) {
      final page = await messages(
        conversationId,
        afterSequence: cursor,
        limit: pageSize,
      );
      for (final message in page) {
        if (message.id.isNotEmpty) byId[message.id] = message;
      }
      final nextCursor = page.fold(
        cursor,
        (highest, message) =>
            message.sequence > highest ? message.sequence : highest,
      );
      if (page.length < pageSize || nextCursor <= cursor) break;
      cursor = nextCursor;
    }
    final ordered = byId.values.toList(growable: false)
      ..sort((a, b) => a.sequence.compareTo(b.sequence));
    return ordered;
  }

  Future<Conversation> updateTitle(String id, String title) async =>
      _conversationFromPayload(
        await _api.patchMap(
          '/conversations/${Uri.encodeComponent(id)}',
          data: {'title': title.trim()},
        ),
      );

  Future<Conversation> end(String id) async => _conversationFromPayload(
        await _api.postMap('/conversations/${Uri.encodeComponent(id)}/end'),
      );

  Future<ConversationInvitation> rotateInvitation(String id) async =>
      ConversationInvitation.fromJson(
        await _api.postMap(
          '/conversations/${Uri.encodeComponent(id)}/invitation/rotate',
        ),
      );

  Future<void> delete(String id) =>
      _api.delete('/conversations/${Uri.encodeComponent(id)}');

  Future<String> removeParticipant(
    String conversationId,
    String participantId,
  ) async {
    final payload = await _api.deleteMap(
      '/conversations/${Uri.encodeComponent(conversationId)}'
      '/participants/${Uri.encodeComponent(participantId)}',
    );
    return (payload['participantId'] ?? '').toString();
  }

  Future<List<Participant>> participants(String conversationId) async {
    final rows = await _api.getList(
      '/conversations/${Uri.encodeComponent(conversationId)}/participants',
    );
    return rows
        .whereType<Map>()
        .map((row) => Participant.fromJson(row.cast<String, dynamic>()))
        .toList(growable: false);
  }

  Future<Participant> updateParticipantProfile({
    required String conversationId,
    required String displayName,
    required String company,
    required Language preferredLanguage,
  }) async {
    final payload = await _api.patchMap(
      '/conversations/${Uri.encodeComponent(conversationId)}/participants/me',
      data: {
        'displayName': displayName.trim(),
        'company': company.trim(),
        'preferredLanguage': preferredLanguage.code,
      },
    );
    final nested = payload['participant'];
    return Participant.fromJson(
      nested is Map ? nested.cast<String, dynamic>() : payload,
    );
  }

  Future<void> leave(String conversationId) async {
    await _api.postMap(
      '/conversations/${Uri.encodeComponent(conversationId)}/leave',
    );
  }

  Future<MeetingSummary> summary(String conversationId) async {
    final payload = await _api.getMap(
      '/conversations/${Uri.encodeComponent(conversationId)}/summary',
    );
    final nested = payload['summary'];
    return MeetingSummary.fromJson(
      nested is Map ? nested.cast<String, dynamic>() : payload,
    );
  }

  Future<MeetingSummary> generateSummary(String conversationId) async {
    final payload = await _api.postMap(
      '/conversations/${Uri.encodeComponent(conversationId)}/summary',
      data: const <String, dynamic>{},
    );
    final nested = payload['summary'];
    return MeetingSummary.fromJson(
      nested is Map ? nested.cast<String, dynamic>() : payload,
    );
  }

  Future<
      ({
        int summaryRevision,
        bool isStale,
        List<SummaryEmailRecipientCandidate> items
      })> summaryEmailRecipients(String conversationId) async {
    final payload = await _api.getMap(
      '/conversations/${Uri.encodeComponent(conversationId)}/summary/email-recipients',
    );
    final rows = payload['items'] as List? ?? const [];
    return (
      summaryRevision: (payload['summaryRevision'] as num?)?.toInt() ?? 0,
      isStale: payload['isStale'] == true,
      items: rows
          .whereType<Map>()
          .map((item) => SummaryEmailRecipientCandidate.fromJson(
                item.cast<String, dynamic>(),
              ))
          .toList(growable: false),
    );
  }

  Future<SummaryEmailDistribution> distributeSummaryEmail({
    required String conversationId,
    required List<String> participantIds,
    required String idempotencyKey,
  }) async {
    final payload = await _api.postMap(
      '/conversations/${Uri.encodeComponent(conversationId)}/summary/email-distributions',
      data: {'participantIds': participantIds},
      options: Options(headers: {'Idempotency-Key': idempotencyKey}),
    );
    var distribution = _summaryEmailDistributionFromPayload(payload);
    for (var attempt = 0;
        distribution.status == 'PROCESSING' && attempt < 300;
        attempt += 1) {
      final statusPayload = await _api.getMap(
        '/conversations/${Uri.encodeComponent(conversationId)}'
        '/summary/email-distributions/${Uri.encodeComponent(distribution.id)}',
      );
      distribution = _summaryEmailDistributionFromPayload(statusPayload);
      if (distribution.status == 'PROCESSING') {
        await Future<void>.delayed(const Duration(seconds: 1));
      }
    }
    return distribution;
  }

  SummaryEmailDistribution _summaryEmailDistributionFromPayload(
    Map<String, dynamic> payload,
  ) {
    final nested = payload['distribution'];
    return SummaryEmailDistribution.fromJson(
      nested is Map ? nested.cast<String, dynamic>() : payload,
    );
  }

  Future<TranslationMessage> proposeMessageCorrection({
    required String conversationId,
    required String messageId,
    required int expectedRevision,
    required String sourceText,
    required String translatedText,
    required String idempotencyKey,
    String? reason,
  }) async =>
      _reviewMessageFromPayload(
        await _api.postMap(
          '/conversations/${Uri.encodeComponent(conversationId)}'
          '/messages/${Uri.encodeComponent(messageId)}/corrections',
          data: {
            'sourceText': sourceText.trim(),
            'translatedText': translatedText.trim(),
            'expectedRevision': expectedRevision,
            'idempotencyKey': idempotencyKey,
            if (reason?.trim().isNotEmpty == true) 'reason': reason!.trim(),
          },
        ),
      );

  Future<TranslationMessage> retranslateMessage({
    required String conversationId,
    required String messageId,
    required int expectedRevision,
    required String sourceText,
    required String idempotencyKey,
    String? reason,
  }) async =>
      _reviewMessageFromPayload(
        await _api.postMap(
          '/conversations/${Uri.encodeComponent(conversationId)}'
          '/messages/${Uri.encodeComponent(messageId)}/retranslate',
          data: {
            'sourceText': sourceText.trim(),
            'expectedRevision': expectedRevision,
            'idempotencyKey': idempotencyKey,
            if (reason?.trim().isNotEmpty == true) 'reason': reason!.trim(),
          },
        ),
      );

  Future<TranslationMessage> decideMessageCorrection({
    required String conversationId,
    required String messageId,
    required int expectedRevision,
    required bool confirm,
    String? reason,
  }) async =>
      _reviewMessageFromPayload(
        await _api.postMap(
          '/conversations/${Uri.encodeComponent(conversationId)}'
          '/messages/${Uri.encodeComponent(messageId)}/review/'
          '${confirm ? 'confirm' : 'reject'}',
          data: {
            'expectedRevision': expectedRevision,
            if (reason?.trim().isNotEmpty == true) 'reason': reason!.trim(),
          },
        ),
      );

  Future<void> addConfirmedMessageToGlossary({
    required String conversationId,
    required String messageId,
    required String sourceTerm,
    required String targetTerm,
    String? category,
  }) async {
    await _api.postMap(
      '/conversations/${Uri.encodeComponent(conversationId)}'
      '/messages/${Uri.encodeComponent(messageId)}/glossary',
      data: {
        'sourceTerm': sourceTerm.trim(),
        'targetTerm': targetTerm.trim(),
        if (category?.trim().isNotEmpty == true) 'category': category!.trim(),
      },
    );
  }

  Future<Map<String, dynamic>> uploadAudio({
    required String conversationId,
    required String path,
    required Language sourceLanguage,
    required String idempotencyKey,
    void Function()? onUploaded,
  }) async {
    // Keep scalar fields before the stream-backed file. Fastify's
    // request.file() can only expose multipart fields that the parser has
    // already consumed when the file part is yielded.
    final form = FormData()
      ..fields.addAll([
        MapEntry('sourceLanguage', sourceLanguage.code),
        MapEntry('targetLanguage', sourceLanguage.opposite.code),
      ])
      ..files.add(
        MapEntry(
          'audio',
          await MultipartFile.fromFile(path, filename: '$idempotencyKey.m4a'),
        ),
      );
    var uploadReported = false;
    return _api.postMap(
      '/conversations/${Uri.encodeComponent(conversationId)}/audio',
      data: form,
      options: Options(
        headers: {'Idempotency-Key': idempotencyKey},
        contentType: 'multipart/form-data',
      ),
      onSendProgress: (sent, total) {
        if (!uploadReported && total > 0 && sent >= total) {
          uploadReported = true;
          onUploaded?.call();
        }
      },
    );
  }

  static Conversation _conversationFromPayload(Map<String, dynamic> payload) {
    final nested = payload['conversation'];
    return Conversation.fromJson(
      nested is Map ? nested.cast<String, dynamic>() : payload,
    );
  }

  static TranslationMessage _reviewMessageFromPayload(
    Map<String, dynamic> payload,
  ) {
    final nested = payload['message'];
    return TranslationMessage.fromJson(
      nested is Map ? nested.cast<String, dynamic>() : payload,
    );
  }
}
