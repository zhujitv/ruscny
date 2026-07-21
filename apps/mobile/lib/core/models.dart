import 'dart:convert';

// Formal accounts are always `user`. `host` is a per-meeting Participant
// role and must never be used as a permanent account type.
enum UserRole { user, host, guest }

enum ConversationStatus { waiting, active, ended, expired }

enum ConversationKind { meeting, direct }

enum GuestHistoryPolicy {
  noAccessAfterEnd,
  accessFor24Hours,
  accessFor7Days,
  permanent,
}

enum SpeakerRole { host, guest }

enum MessageStatus { processing, finalResult, failed }

enum MessageReviewStatus { unreviewed, pending, confirmed, rejected }

enum ParticipantPresence { online, offline, left, removed }

enum Language { zh, ru }

extension LanguageX on Language {
  String get code => name;
  String get label => this == Language.zh ? '中文' : '俄语';
  Language get opposite => this == Language.zh ? Language.ru : Language.zh;
}

extension GuestHistoryPolicyX on GuestHistoryPolicy {
  String get wireValue => switch (this) {
        GuestHistoryPolicy.noAccessAfterEnd => 'NO_ACCESS_AFTER_END',
        GuestHistoryPolicy.accessFor24Hours => 'ACCESS_FOR_24_HOURS',
        GuestHistoryPolicy.accessFor7Days => 'ACCESS_FOR_7_DAYS',
        GuestHistoryPolicy.permanent => 'PERMANENT',
      };

  String get label => switch (this) {
        GuestHistoryPolicy.noAccessAfterEnd => '结束后不可查看',
        GuestHistoryPolicy.accessFor24Hours => '结束后 24 小时',
        GuestHistoryPolicy.accessFor7Days => '结束后 7 天',
        GuestHistoryPolicy.permanent => '永久授权',
      };
}

DateTime _date(dynamic value, {DateTime? fallback}) {
  if (value is DateTime) return value;
  if (value is String) {
    return DateTime.tryParse(value)?.toLocal() ??
        fallback ??
        DateTime.fromMillisecondsSinceEpoch(0);
  }
  return fallback ?? DateTime.fromMillisecondsSinceEpoch(0);
}

String? _optionalString(dynamic value) {
  if (value == null) return null;
  final text = value.toString().trim();
  return text.isEmpty ? null : text;
}

UserRole _userRole(dynamic value) => switch (value?.toString().toUpperCase()) {
      'HOST' => UserRole.host,
      'GUEST' => UserRole.guest,
      _ => UserRole.user,
    };

ConversationStatus _conversationStatus(dynamic value) =>
    switch (value?.toString().toUpperCase()) {
      'ACTIVE' => ConversationStatus.active,
      'ENDED' => ConversationStatus.ended,
      'EXPIRED' => ConversationStatus.expired,
      _ => ConversationStatus.waiting,
    };

ConversationKind _conversationKind(dynamic value) =>
    value?.toString().toUpperCase() == 'DIRECT'
        ? ConversationKind.direct
        : ConversationKind.meeting;

MessageStatus _messageStatus(dynamic value) =>
    switch (value?.toString().toUpperCase()) {
      'FINAL' => MessageStatus.finalResult,
      'FAILED' => MessageStatus.failed,
      _ => MessageStatus.processing,
    };

MessageReviewStatus _messageReviewStatus(dynamic value) =>
    switch (value?.toString().toUpperCase()) {
      'PENDING' => MessageReviewStatus.pending,
      'CONFIRMED' => MessageReviewStatus.confirmed,
      'REJECTED' => MessageReviewStatus.rejected,
      _ => MessageReviewStatus.unreviewed,
    };

Language _language(dynamic value) =>
    value?.toString().toLowerCase() == 'ru' ? Language.ru : Language.zh;

SpeakerRole _speakerRole(dynamic value) =>
    value?.toString().toUpperCase() == 'GUEST'
        ? SpeakerRole.guest
        : SpeakerRole.host;

GuestHistoryPolicy _historyPolicy(dynamic value) =>
    switch (value?.toString().toUpperCase()) {
      'NO_ACCESS_AFTER_END' => GuestHistoryPolicy.noAccessAfterEnd,
      'ACCESS_FOR_7_DAYS' => GuestHistoryPolicy.accessFor7Days,
      'PERMANENT' => GuestHistoryPolicy.permanent,
      _ => GuestHistoryPolicy.accessFor24Hours,
    };

final class AuthSession {
  const AuthSession({
    required this.userId,
    required this.role,
    required this.displayName,
    this.email,
    this.phone,
    this.company,
    this.preferredLanguage = Language.zh,
    this.avatarPreset = 'jade',
    this.interfaceLanguage = 'system',
    this.autoPlayTranslationAudio = true,
    this.translationPlaybackSpeed = 1,
    this.currentConversationId,
  });

  final String userId;
  final UserRole role;
  final String displayName;
  final String? email;
  final String? phone;
  final String? company;
  final Language preferredLanguage;
  final String avatarPreset;
  final String interfaceLanguage;
  final bool autoPlayTranslationAudio;
  final double translationPlaybackSpeed;
  final String? currentConversationId;

  factory AuthSession.fromJson(Map<String, dynamic> json) {
    final user = (json['user'] as Map?)?.cast<String, dynamic>() ?? json;
    return AuthSession(
      userId: (user['id'] ?? json['guestIdentityId'] ?? '').toString(),
      role: _userRole(user['role'] ?? json['role']),
      displayName:
          (user['displayName'] ?? json['displayName'] ?? '访客').toString(),
      email: _optionalString(user['email']),
      phone: _optionalString(user['phone']),
      company: _optionalString(user['company'] ?? json['company']),
      preferredLanguage: _language(
        user['preferredLanguage'] ?? json['preferredLanguage'],
      ),
      avatarPreset: _avatarPreset(user['avatarPreset']),
      interfaceLanguage: _interfaceLanguage(user['interfaceLanguage']),
      autoPlayTranslationAudio: user['autoPlayTranslationAudio'] != false,
      translationPlaybackSpeed:
          _playbackSpeed(user['translationPlaybackSpeed']),
      currentConversationId: _optionalString(
        json['conversationId'] ?? user['conversationId'],
      ),
    );
  }
}

String _avatarPreset(dynamic value) => const {
      'jade',
      'ocean',
      'amber',
      'plum',
      'graphite',
      'rose',
    }.contains(value?.toString())
        ? value.toString()
        : 'jade';

String _interfaceLanguage(dynamic value) =>
    const {'zh', 'ru'}.contains(value?.toString())
        ? value.toString()
        : 'system';

double _playbackSpeed(dynamic value) {
  final parsed = value is num
      ? value.toDouble()
      : double.tryParse(value?.toString() ?? '');
  return {0.75, 1.0, 1.25, 1.5}.contains(parsed) ? parsed! : 1;
}

final class Contact {
  const Contact({
    required this.id,
    required this.ownerId,
    required this.displayName,
    required this.createdAt,
    required this.updatedAt,
    this.company,
    this.country,
    this.phone,
    this.email,
    this.notes,
    this.linkedUserId,
  });

  final String id;
  final String ownerId;
  final String displayName;
  final String? company;
  final String? country;
  final String? phone;
  final String? email;
  final String? notes;
  final String? linkedUserId;
  final DateTime createdAt;
  final DateTime updatedAt;

  factory Contact.fromJson(Map<String, dynamic> json) => Contact(
        id: json['id'].toString(),
        ownerId: (json['ownerId'] ?? '').toString(),
        displayName: (json['displayName'] ?? '').toString(),
        company: _optionalString(json['company']),
        country: _optionalString(json['country']),
        phone: _optionalString(json['phone']),
        email: _optionalString(json['email']),
        notes: _optionalString(json['notes']),
        linkedUserId: _optionalString(json['linkedUserId']),
        createdAt: _date(json['createdAt']),
        updatedAt: _date(json['updatedAt']),
      );
}

final class Conversation {
  const Conversation({
    required this.id,
    required this.ownerId,
    required this.contactId,
    required this.status,
    required this.roomToken,
    required this.roomCode,
    required this.guestHistoryPolicy,
    required this.createdAt,
    required this.updatedAt,
    this.title,
    this.contactName,
    this.company,
    this.guestAccessExpiresAt,
    this.startedAt,
    this.endedAt,
    this.messageCount = 0,
    this.participantCount = 1,
    this.participants = const [],
    this.kind = ConversationKind.meeting,
    this.directPeer,
    this.supportsDocuments = true,
  });

  final String id;
  final String ownerId;
  final String contactId;
  final String? title;
  final String? contactName;
  final String? company;
  final ConversationStatus status;
  final String roomToken;
  final String roomCode;
  final GuestHistoryPolicy guestHistoryPolicy;
  final DateTime? guestAccessExpiresAt;
  final DateTime? startedAt;
  final DateTime? endedAt;
  final DateTime createdAt;
  final DateTime updatedAt;
  final int messageCount;
  final int participantCount;
  final List<Participant> participants;
  final ConversationKind kind;
  final DirectChatPeer? directPeer;
  final bool supportsDocuments;

  bool get isDirect => kind == ConversationKind.direct;

  // ACTIVE meetings accept every current participant. While the invitation is
  // still WAITING, only the registered owner/host may run a solo microphone
  // check; the server independently revalidates the stored Participant role.
  bool get canSpeak => status == ConversationStatus.active;

  bool canSpeakAs(String? currentUserId) =>
      canSpeak ||
      (status == ConversationStatus.waiting &&
          currentUserId != null &&
          currentUserId.isNotEmpty &&
          ownerId == currentUserId);

  bool get canEnd =>
      !isDirect &&
      (status == ConversationStatus.waiting ||
          status == ConversationStatus.active);

  Conversation copyWith({
    String? title,
    ConversationStatus? status,
    DateTime? endedAt,
    int? participantCount,
    String? roomToken,
    String? roomCode,
  }) =>
      Conversation(
        id: id,
        ownerId: ownerId,
        contactId: contactId,
        title: title ?? this.title,
        contactName: contactName,
        company: company,
        status: status ?? this.status,
        roomToken: roomToken ?? this.roomToken,
        roomCode: roomCode ?? this.roomCode,
        guestHistoryPolicy: guestHistoryPolicy,
        guestAccessExpiresAt: guestAccessExpiresAt,
        startedAt: startedAt,
        endedAt: endedAt ?? this.endedAt,
        createdAt: createdAt,
        updatedAt: DateTime.now(),
        messageCount: messageCount,
        participantCount: participantCount ?? this.participantCount,
        participants: participants,
        kind: kind,
        directPeer: directPeer,
        supportsDocuments: supportsDocuments,
      );

  factory Conversation.fromJson(Map<String, dynamic> json) {
    final contact = (json['contact'] as Map?)?.cast<String, dynamic>();
    return Conversation(
      id: json['id'].toString(),
      kind: _conversationKind(json['kind']),
      ownerId: (json['ownerId'] ?? '').toString(),
      contactId: (json['contactId'] ?? contact?['id'] ?? '').toString(),
      title: _optionalString(json['title']),
      contactName: _optionalString(
        json['contactName'] ?? contact?['displayName'],
      ),
      company: _optionalString(json['company'] ?? contact?['company']),
      status: _conversationStatus(json['status']),
      roomToken: (json['roomToken'] ?? '').toString(),
      roomCode: (json['roomCode'] ?? '').toString(),
      guestHistoryPolicy: _historyPolicy(json['guestHistoryPolicy']),
      guestAccessExpiresAt: json['guestAccessExpiresAt'] == null
          ? null
          : _date(json['guestAccessExpiresAt']),
      startedAt: json['startedAt'] == null ? null : _date(json['startedAt']),
      endedAt: json['endedAt'] == null ? null : _date(json['endedAt']),
      createdAt: _date(json['createdAt']),
      updatedAt: _date(json['updatedAt']),
      messageCount: (json['messageCount'] as num?)?.toInt() ?? 0,
      participantCount: (json['participantCount'] as num?)?.toInt() ?? 1,
      participants: (json['participants'] as List?)
              ?.whereType<Map>()
              .map((item) => Participant.fromJson(item.cast<String, dynamic>()))
              .toList(growable: false) ??
          const [],
      directPeer: json['directPeer'] is Map
          ? DirectChatPeer.fromJson(
              (json['directPeer'] as Map).cast<String, dynamic>(),
            )
          : null,
      supportsDocuments:
          _conversationKind(json['kind']) == ConversationKind.meeting &&
              (json['capabilities'] as Map?)?['aiSummary'] != false &&
              (json['capabilities'] as Map?)?['documentExport'] != false,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'kind': kind.name.toUpperCase(),
        'ownerId': ownerId,
        'contactId': contactId,
        'title': title,
        'contactName': contactName,
        'company': company,
        'status': status.name.toUpperCase(),
        'roomToken': roomToken,
        'roomCode': roomCode,
        'guestHistoryPolicy': guestHistoryPolicy.wireValue,
        'guestAccessExpiresAt': guestAccessExpiresAt?.toUtc().toIso8601String(),
        'startedAt': startedAt?.toUtc().toIso8601String(),
        'endedAt': endedAt?.toUtc().toIso8601String(),
        'createdAt': createdAt.toUtc().toIso8601String(),
        'updatedAt': updatedAt.toUtc().toIso8601String(),
        'messageCount': messageCount,
        'participantCount': participantCount,
        'participants': participants.map((item) => item.toJson()).toList(),
        'directPeer': directPeer?.toJson(),
        'capabilities': {
          'aiSummary': supportsDocuments,
          'documentExport': supportsDocuments,
          'summaryDistribution': supportsDocuments,
        },
      };
}

final class DirectChatPeer {
  const DirectChatPeer({
    required this.id,
    required this.displayName,
    required this.preferredLanguage,
    this.company,
    this.presence,
  });

  final String id;
  final String displayName;
  final String? company;
  final Language preferredLanguage;
  final String? presence;

  factory DirectChatPeer.fromJson(Map<String, dynamic> json) => DirectChatPeer(
        id: (json['id'] ?? '').toString(),
        displayName: (json['displayName'] ?? '').toString(),
        company: _optionalString(json['company']),
        preferredLanguage: _language(json['preferredLanguage']),
        presence: _optionalString(json['presence']),
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'displayName': displayName,
        'company': company,
        'preferredLanguage': preferredLanguage.code,
        'presence': presence,
      };
}

final class ConversationInvitation {
  const ConversationInvitation({
    required this.conversationId,
    required this.roomToken,
    required this.roomCode,
    required this.inviteUrl,
    required this.expiresAt,
  });

  final String conversationId;
  final String roomToken;
  final String roomCode;
  final String inviteUrl;
  final DateTime expiresAt;

  factory ConversationInvitation.fromJson(Map<String, dynamic> json) =>
      ConversationInvitation(
        conversationId: (json['conversationId'] ?? '').toString(),
        roomToken: (json['roomToken'] ?? '').toString(),
        roomCode: (json['roomCode'] ?? '').toString(),
        inviteUrl: (json['inviteUrl'] ?? '').toString(),
        expiresAt: _date(json['expiresAt']),
      );
}

final class TranslationMessage {
  const TranslationMessage({
    required this.id,
    required this.conversationId,
    required this.participantId,
    required this.speakerRole,
    required this.sourceLanguage,
    required this.targetLanguage,
    required this.sourceText,
    required this.translatedText,
    required this.status,
    required this.sequence,
    required this.createdAt,
    this.audioUrl,
    this.displayName,
    this.company,
    this.speakerLanguage,
    this.errorCode,
    this.errorMessage,
    this.reviewStatus = MessageReviewStatus.unreviewed,
    this.reviewRevision = 0,
    this.originalSourceText,
    this.originalTranslatedText,
    this.pendingSourceText,
    this.pendingTranslatedText,
    this.hasConfirmedCorrection = false,
    this.reviewedAt,
  });

  final String id;
  final String conversationId;
  final String participantId;
  final SpeakerRole speakerRole;
  final Language sourceLanguage;
  final Language targetLanguage;
  final String sourceText;
  final String translatedText;
  final String? audioUrl;
  final MessageStatus status;
  final int sequence;
  final DateTime createdAt;
  final String? displayName;
  final String? company;
  final Language? speakerLanguage;
  final String? errorCode;
  final String? errorMessage;
  final MessageReviewStatus reviewStatus;
  final int reviewRevision;
  final String? originalSourceText;
  final String? originalTranslatedText;
  final String? pendingSourceText;
  final String? pendingTranslatedText;
  final bool hasConfirmedCorrection;
  final DateTime? reviewedAt;

  factory TranslationMessage.fromJson(Map<String, dynamic> json) =>
      TranslationMessage(
        id: (json['id'] ?? json['messageId'] ?? '').toString(),
        conversationId: (json['conversationId'] ?? '').toString(),
        participantId: (json['participantId'] ?? '').toString(),
        speakerRole: _speakerRole(json['speakerRole']),
        sourceLanguage: _language(json['sourceLanguage']),
        targetLanguage: _language(json['targetLanguage']),
        sourceText: (json['sourceText'] ?? '').toString(),
        translatedText: (json['translatedText'] ?? '').toString(),
        audioUrl: _optionalString(json['audioUrl']),
        status: _messageStatus(
          json['status'] ?? _statusFromEvent(json['type']),
        ),
        sequence: (json['sequence'] as num?)?.toInt() ?? 0,
        createdAt: _date(json['createdAt'], fallback: DateTime.now()),
        displayName: _optionalString(
          json['speakerDisplayName'] ??
              json['speakerName'] ??
              json['displayName'],
        ),
        company: _optionalString(json['speakerCompany'] ?? json['company']),
        speakerLanguage: json['speakerLanguage'] == null
            ? null
            : _language(json['speakerLanguage']),
        errorCode: _optionalString(json['errorCode']),
        errorMessage: _optionalString(json['errorMessage']),
        reviewStatus: _messageReviewStatus(json['reviewStatus']),
        reviewRevision: (json['reviewRevision'] as num?)?.toInt() ?? 0,
        originalSourceText: _optionalString(json['originalSourceText']),
        originalTranslatedText: _optionalString(json['originalTranslatedText']),
        pendingSourceText: _optionalString(
          (json['pendingCorrection'] as Map?)?['sourceText'] ??
              json['pendingSourceText'],
        ),
        pendingTranslatedText: _optionalString(
          (json['pendingCorrection'] as Map?)?['translatedText'] ??
              json['pendingTranslatedText'],
        ),
        hasConfirmedCorrection: json['hasConfirmedCorrection'] == true,
        reviewedAt:
            json['reviewedAt'] == null ? null : _date(json['reviewedAt']),
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'conversationId': conversationId,
        'participantId': participantId,
        'speakerRole': speakerRole.name.toUpperCase(),
        'sourceLanguage': sourceLanguage.code,
        'targetLanguage': targetLanguage.code,
        'sourceText': sourceText,
        'translatedText': translatedText,
        'audioUrl': audioUrl,
        'status': switch (status) {
          MessageStatus.processing => 'PROCESSING',
          MessageStatus.finalResult => 'FINAL',
          MessageStatus.failed => 'FAILED',
        },
        'sequence': sequence,
        'createdAt': createdAt.toUtc().toIso8601String(),
        'displayName': displayName,
        'speakerDisplayName': displayName,
        'speakerCompany': company,
        'speakerLanguage': speakerLanguage?.code,
        'errorCode': errorCode,
        'errorMessage': errorMessage,
        'reviewStatus': reviewStatus.name.toUpperCase(),
        'reviewRevision': reviewRevision,
        'originalSourceText': originalSourceText,
        'originalTranslatedText': originalTranslatedText,
        'pendingCorrection':
            pendingSourceText != null && pendingTranslatedText != null
                ? {
                    'revision': reviewRevision,
                    'sourceText': pendingSourceText,
                    'translatedText': pendingTranslatedText,
                  }
                : null,
        'hasConfirmedCorrection': hasConfirmedCorrection,
        'reviewedAt': reviewedAt?.toUtc().toIso8601String(),
      };

  String encode() => jsonEncode(toJson());

  static TranslationMessage decode(String value) => TranslationMessage.fromJson(
        (jsonDecode(value) as Map).cast<String, dynamic>(),
      );
}

String _statusFromEvent(dynamic type) => switch (type) {
      'translation.final' => 'FINAL',
      'translation.failed' => 'FAILED',
      _ => 'PROCESSING',
    };

final class Participant {
  const Participant({
    required this.id,
    required this.displayName,
    required this.role,
    this.company,
    this.preferredLanguage = Language.zh,
    this.presence = ParticipantPresence.offline,
    this.registered = false,
    this.joinedAt,
    this.leftAt,
    this.lastSeenAt,
    this.removedAt,
  });

  final String id;
  final String displayName;
  final UserRole role;
  final String? company;
  final Language preferredLanguage;
  final ParticipantPresence presence;
  final bool registered;
  final DateTime? joinedAt;
  final DateTime? leftAt;
  final DateTime? lastSeenAt;
  final DateTime? removedAt;

  factory Participant.fromJson(Map<String, dynamic> json) => Participant(
        id: (json['id'] ?? json['participantId'] ?? '').toString(),
        displayName: (json['displayName'] ?? '参与者').toString(),
        role: _userRole(json['role']),
        company: _optionalString(json['company']),
        preferredLanguage: _language(json['preferredLanguage']),
        presence: switch (json['presence']?.toString().toUpperCase()) {
          'ONLINE' => ParticipantPresence.online,
          'LEFT' => ParticipantPresence.left,
          'REMOVED' => ParticipantPresence.removed,
          _ => ParticipantPresence.offline,
        },
        registered: json['registered'] == true || json['userId'] != null,
        joinedAt: json['joinedAt'] == null ? null : _date(json['joinedAt']),
        leftAt: json['leftAt'] == null ? null : _date(json['leftAt']),
        lastSeenAt:
            json['lastSeenAt'] == null ? null : _date(json['lastSeenAt']),
        removedAt: json['removedAt'] == null ? null : _date(json['removedAt']),
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'displayName': displayName,
        'role': role.name.toUpperCase(),
        'company': company,
        'preferredLanguage': preferredLanguage.code,
        'presence': presence.name.toUpperCase(),
        'registered': registered,
        'joinedAt': joinedAt?.toUtc().toIso8601String(),
        'leftAt': leftAt?.toUtc().toIso8601String(),
        'lastSeenAt': lastSeenAt?.toUtc().toIso8601String(),
        'removedAt': removedAt?.toUtc().toIso8601String(),
      };
}

final class UserProfile {
  const UserProfile({
    required this.id,
    required this.displayName,
    this.email,
    this.company,
    this.preferredLanguage = Language.zh,
    this.relationship,
    this.online = false,
    this.canInvite = false,
  });

  final String id;
  final String displayName;
  final String? email;
  final String? company;
  final Language preferredLanguage;
  final String? relationship;
  final bool online;
  final bool canInvite;

  factory UserProfile.fromJson(Map<String, dynamic> json) => UserProfile(
        id: json['id']?.toString() ?? '',
        displayName: json['displayName']?.toString() ?? '',
        email: _optionalString(json['email']),
        company: _optionalString(json['company']),
        preferredLanguage: _language(json['preferredLanguage']),
        relationship: _optionalString(json['relationship']),
        online: json['online'] == true,
        canInvite: json['canInvite'] == true,
      );
}

enum FriendCallMediaType {
  audio,
  video;

  String get wireValue => name.toUpperCase();
  bool get isVideo => this == FriendCallMediaType.video;
  String get label => isVideo ? '视频通话' : '语音通话';
  String get incomingTitle => isVideo ? '好友视频来电' : '好友语音来电';

  static FriendCallMediaType fromWire(Object? value) =>
      value?.toString().toUpperCase() == 'VIDEO'
          ? FriendCallMediaType.video
          : FriendCallMediaType.audio;
}

final class FriendCallModel {
  const FriendCallModel({
    required this.id,
    required this.direction,
    required this.status,
    required this.peer,
    required this.createdAt,
    this.mediaType = FriendCallMediaType.audio,
    this.acceptedAt,
    this.endedAt,
  });

  final String id;
  final String direction;
  final String status;
  final UserProfile peer;
  final DateTime createdAt;
  final FriendCallMediaType mediaType;
  final DateTime? acceptedAt;
  final DateTime? endedAt;

  bool get isActive => status == 'ACTIVE';
  bool get isRinging => status == 'RINGING';

  factory FriendCallModel.fromJson(Map<String, dynamic> json) =>
      FriendCallModel(
        id: json['id']?.toString() ?? '',
        direction: json['direction']?.toString() ?? 'INCOMING',
        status: json['status']?.toString() ?? 'RINGING',
        peer: UserProfile.fromJson(
          (json['peer'] as Map?)?.cast<String, dynamic>() ?? const {},
        ),
        createdAt: _date(json['createdAt']),
        mediaType: FriendCallMediaType.fromWire(json['mediaType']),
        acceptedAt:
            json['acceptedAt'] == null ? null : _date(json['acceptedAt']),
        endedAt: json['endedAt'] == null ? null : _date(json['endedAt']),
      );
}

final class RtcCredential {
  const RtcCredential({
    required this.channelId,
    required this.userId,
    required this.token,
    required this.expiresAt,
    required this.realtimeTranslationAvailable,
  });

  final String channelId;
  final String userId;
  final String token;
  final int expiresAt;
  final bool realtimeTranslationAvailable;

  factory RtcCredential.fromJson(Map<String, dynamic> json) => RtcCredential(
        channelId: json['channelId']?.toString() ?? '',
        userId: json['userId']?.toString() ?? '',
        token: json['token']?.toString() ?? '',
        expiresAt: (json['expiresAt'] as num?)?.toInt() ?? 0,
        realtimeTranslationAvailable:
            json['realtimeTranslationAvailable'] == true,
      );

  Map<String, dynamic> toJson() => {
        'channelId': channelId,
        'userId': userId,
        'token': token,
        'expiresAt': expiresAt,
        'realtimeTranslationAvailable': realtimeTranslationAvailable,
      };
}

final class FriendRequestModel {
  const FriendRequestModel({
    required this.id,
    required this.sender,
    required this.receiver,
    required this.status,
    required this.createdAt,
  });

  final String id;
  final UserProfile sender;
  final UserProfile receiver;
  final String status;
  final DateTime createdAt;

  factory FriendRequestModel.fromJson(Map<String, dynamic> json) =>
      FriendRequestModel(
        id: json['id']?.toString() ?? '',
        sender: UserProfile.fromJson(
          (json['sender'] as Map?)?.cast<String, dynamic>() ?? const {},
        ),
        receiver: UserProfile.fromJson(
          (json['receiver'] as Map?)?.cast<String, dynamic>() ?? const {},
        ),
        status: json['status']?.toString() ?? 'PENDING',
        createdAt: _date(json['createdAt']),
      );
}

final class MeetingInvitationModel {
  const MeetingInvitationModel({
    required this.id,
    required this.conversationId,
    required this.status,
    required this.inviter,
    required this.title,
    required this.expiresAt,
    this.contactName,
    this.company,
  });

  final String id;
  final String conversationId;
  final String status;
  final UserProfile inviter;
  final String title;
  final String? contactName;
  final String? company;
  final DateTime expiresAt;

  factory MeetingInvitationModel.fromJson(Map<String, dynamic> json) {
    final conversation =
        (json['conversation'] as Map?)?.cast<String, dynamic>() ?? const {};
    return MeetingInvitationModel(
      id: json['id']?.toString() ?? '',
      conversationId:
          (json['conversationId'] ?? conversation['id'] ?? '').toString(),
      status: json['status']?.toString() ?? 'PENDING',
      inviter: UserProfile.fromJson(
        (json['inviter'] as Map?)?.cast<String, dynamic>() ?? const {},
      ),
      title: _optionalString(conversation['title']) ?? '翻译会议',
      contactName: _optionalString(conversation['contactName']),
      company: _optionalString(conversation['company']),
      expiresAt: _date(conversation['expiresAt']),
    );
  }
}

final class MeetingSummary {
  const MeetingSummary({
    required this.summary,
    required this.participants,
    required this.coreDiscussion,
    required this.partyViews,
    required this.confirmedItems,
    required this.actionItems,
    required this.openQuestions,
    required this.generatedAt,
    required this.revision,
    this.sourceMaxSequence,
    this.sourceMessageCount,
    this.isStale,
    this.approvedRevision,
    this.approvedAt,
  });

  final String summary;
  final List<Participant> participants;
  final List<Map<String, dynamic>> coreDiscussion;
  final List<dynamic> partyViews;
  final List<dynamic> confirmedItems;
  final List<dynamic> actionItems;
  final List<dynamic> openQuestions;
  final DateTime generatedAt;
  final int revision;
  final int? sourceMaxSequence;
  final int? sourceMessageCount;
  final bool? isStale;
  final int? approvedRevision;
  final DateTime? approvedAt;

  bool get isApproved => approvedAt != null && approvedRevision == revision;

  factory MeetingSummary.fromJson(Map<String, dynamic> json) => MeetingSummary(
        summary: json['summary']?.toString() ?? '',
        participants: (json['participantRoster'] as List?)
                ?.whereType<Map>()
                .map((item) =>
                    Participant.fromJson(item.cast<String, dynamic>()))
                .toList(growable: false) ??
            const [],
        coreDiscussion: (json['coreDiscussion'] as List?)
                ?.whereType<Map>()
                .map((item) => item.cast<String, dynamic>())
                .toList(growable: false) ??
            const [],
        partyViews: List<dynamic>.from(json['partyViews'] as List? ?? const []),
        confirmedItems:
            List<dynamic>.from(json['confirmedItems'] as List? ?? const []),
        actionItems:
            List<dynamic>.from(json['actionItems'] as List? ?? const []),
        openQuestions:
            List<dynamic>.from(json['openQuestions'] as List? ?? const []),
        generatedAt: _date(json['generatedAt'], fallback: DateTime.now()),
        revision: (json['revision'] as num?)?.toInt() ?? 1,
        sourceMaxSequence: (json['sourceMaxSequence'] as num?)?.toInt(),
        sourceMessageCount: (json['sourceMessageCount'] as num?)?.toInt(),
        isStale: json['isStale'] is bool ? json['isStale'] as bool : null,
        approvedRevision: (json['approvedRevision'] as num?)?.toInt(),
        approvedAt:
            json['approvedAt'] == null ? null : _date(json['approvedAt']),
      );
}

final class SummaryEmailRecipientCandidate {
  const SummaryEmailRecipientCandidate({
    required this.participantId,
    required this.displayName,
    required this.preferredLanguage,
    required this.eligible,
    this.company,
    this.emailHint,
    this.reason,
  });

  final String participantId;
  final String displayName;
  final String? company;
  final String? emailHint;
  final Language preferredLanguage;
  final bool eligible;
  final String? reason;

  factory SummaryEmailRecipientCandidate.fromJson(Map<String, dynamic> json) =>
      SummaryEmailRecipientCandidate(
        participantId: json['participantId']?.toString() ?? '',
        displayName: json['displayName']?.toString() ?? '参与者',
        company: _optionalString(json['company']),
        emailHint: _optionalString(json['emailHint']),
        preferredLanguage: _language(json['preferredLanguage']),
        eligible: json['eligible'] == true,
        reason: _optionalString(json['reason']),
      );
}

final class SummaryEmailRecipientResult {
  const SummaryEmailRecipientResult({
    required this.participantId,
    required this.displayName,
    required this.status,
    this.company,
    this.emailHint,
    this.errorMessage,
    this.sentAt,
  });

  final String participantId;
  final String displayName;
  final String? company;
  final String? emailHint;
  final String status;
  final String? errorMessage;
  final DateTime? sentAt;

  factory SummaryEmailRecipientResult.fromJson(Map<String, dynamic> json) =>
      SummaryEmailRecipientResult(
        participantId: json['participantId']?.toString() ?? '',
        displayName: json['displayName']?.toString() ?? '参与者',
        company: _optionalString(json['company']),
        emailHint: _optionalString(json['emailHint']),
        status: json['status']?.toString() ?? 'FAILED',
        errorMessage: _optionalString(json['errorMessage']),
        sentAt: json['sentAt'] == null ? null : _date(json['sentAt']),
      );
}

final class SummaryEmailDistribution {
  const SummaryEmailDistribution({
    required this.id,
    required this.status,
    required this.summaryRevision,
    required this.recipientCount,
    required this.sentCount,
    required this.failedCount,
    required this.recipients,
  });

  final String id;
  final String status;
  final int summaryRevision;
  final int recipientCount;
  final int sentCount;
  final int failedCount;
  final List<SummaryEmailRecipientResult> recipients;

  factory SummaryEmailDistribution.fromJson(Map<String, dynamic> json) =>
      SummaryEmailDistribution(
        id: json['id']?.toString() ?? '',
        status: json['status']?.toString() ?? 'FAILED',
        summaryRevision: (json['summaryRevision'] as num?)?.toInt() ?? 0,
        recipientCount: (json['recipientCount'] as num?)?.toInt() ?? 0,
        sentCount: (json['sentCount'] as num?)?.toInt() ?? 0,
        failedCount: (json['failedCount'] as num?)?.toInt() ?? 0,
        recipients: (json['recipients'] as List?)
                ?.whereType<Map>()
                .map((item) => SummaryEmailRecipientResult.fromJson(
                    item.cast<String, dynamic>()))
                .toList(growable: false) ??
            const [],
      );
}
