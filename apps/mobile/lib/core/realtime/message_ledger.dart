import '../models.dart';

/// Deterministically merges cache, REST backfill and Socket.IO delivery.
/// It rejects cross-conversation data before anything can reach the UI/cache.
final class MessageLedger {
  MessageLedger(this.conversationId);

  final String conversationId;
  final Map<String, TranslationMessage> _byId = {};

  List<TranslationMessage> merge(Iterable<TranslationMessage> incoming) {
    for (final message in incoming) {
      if (message.conversationId != conversationId || message.id.isEmpty) {
        continue;
      }
      final existing = _byId[message.id];
      if (existing == null || _isAtLeastAsComplete(message, existing)) {
        _byId[message.id] = message;
      }
    }

    // A reconnect can occasionally deliver the same sequence under a temporary
    // and a final ID. Prefer the most complete status for that sequence.
    final bySequence = <int, TranslationMessage>{};
    final withoutSequence = <TranslationMessage>[];
    for (final message in _byId.values) {
      if (message.sequence <= 0) {
        withoutSequence.add(message);
        continue;
      }
      final existing = bySequence[message.sequence];
      if (existing == null || _isAtLeastAsComplete(message, existing)) {
        bySequence[message.sequence] = message;
      }
    }

    final ordered = [...bySequence.values, ...withoutSequence]..sort((a, b) {
        if (a.sequence <= 0 && b.sequence > 0) return 1;
        if (b.sequence <= 0 && a.sequence > 0) return -1;
        final sequenceOrder = a.sequence.compareTo(b.sequence);
        return sequenceOrder != 0
            ? sequenceOrder
            : a.createdAt.compareTo(b.createdAt);
      });
    return List.unmodifiable(ordered);
  }

  /// Highest sequence that can safely be sent as Socket.IO `lastSequence`.
  /// A later message must never make the client skip an earlier gap, and a
  /// PROCESSING placeholder is not considered durably complete yet.
  int get lastSequence {
    final completed = <int>{
      for (final message in _byId.values)
        if (message.sequence > 0 && message.status != MessageStatus.processing)
          message.sequence,
    };
    var contiguous = 0;
    while (completed.contains(contiguous + 1)) {
      contiguous += 1;
    }
    return contiguous;
  }

  int get highestSequence => _byId.values.fold(
        0,
        (highest, message) =>
            message.sequence > highest ? message.sequence : highest,
      );

  static int _rank(MessageStatus status) => switch (status) {
        MessageStatus.processing => 0,
        MessageStatus.failed => 1,
        MessageStatus.finalResult => 2,
      };

  static bool _isAtLeastAsComplete(
    TranslationMessage incoming,
    TranslationMessage existing,
  ) {
    final incomingRank = _rank(incoming.status);
    final existingRank = _rank(existing.status);
    if (incomingRank != existingRank) return incomingRank > existingRank;
    if (incoming.reviewRevision != existing.reviewRevision) {
      return incoming.reviewRevision > existing.reviewRevision;
    }
    final incomingTtsRank = _ttsRank(incoming);
    final existingTtsRank = _ttsRank(existing);
    if (incomingTtsRank != existingTtsRank) {
      return incomingTtsRank > existingTtsRank;
    }
    return _reviewRank(incoming.reviewStatus) >=
        _reviewRank(existing.reviewStatus);
  }

  static int _ttsRank(TranslationMessage message) {
    if (message.audioUrl?.isNotEmpty == true) return 2;
    if (message.errorCode == 'TTS_PENDING' ||
        message.errorCode == 'TTS_PROCESSING') {
      return 0;
    }
    return 1;
  }

  static int _reviewRank(MessageReviewStatus status) => switch (status) {
        MessageReviewStatus.unreviewed => 0,
        MessageReviewStatus.pending => 1,
        MessageReviewStatus.confirmed => 2,
        MessageReviewStatus.rejected => 2,
      };
}
