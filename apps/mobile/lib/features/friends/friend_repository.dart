import '../../core/api/api_client.dart';
import '../../core/models.dart';

final class FriendRepository {
  const FriendRepository(this._api);

  final ApiClient _api;

  Future<List<UserProfile>> search(String query) async {
    final rows =
        await _api.getList('/users/search', query: {'q': query.trim()});
    return rows
        .whereType<Map>()
        .map((row) => UserProfile.fromJson(row.cast<String, dynamic>()))
        .toList(growable: false);
  }

  Future<List<UserProfile>> friends() async {
    final rows = await _api.getList('/friends');
    return rows
        .whereType<Map>()
        .map((row) => UserProfile.fromJson(row.cast<String, dynamic>()))
        .toList(growable: false);
  }

  Future<List<FriendRequestModel>> requests({String box = 'incoming'}) async {
    final rows = await _api.getList('/friend-requests', query: {'box': box});
    return rows
        .whereType<Map>()
        .map((row) => FriendRequestModel.fromJson(row.cast<String, dynamic>()))
        .toList(growable: false);
  }

  Future<void> requestFriend(String receiverId) async {
    await _api.postMap('/friend-requests', data: {'receiverId': receiverId});
  }

  Future<void> respondToRequest(String requestId,
      {required bool accept}) async {
    await _api.postMap(
      '/friend-requests/${Uri.encodeComponent(requestId)}/respond',
      data: {'action': accept ? 'ACCEPT' : 'DECLINE'},
    );
  }

  Future<void> removeFriend(String friendId) async {
    await _api.delete('/friends/${Uri.encodeComponent(friendId)}');
  }

  Future<Conversation> openDirectChat(String friendId) async {
    final payload = await _api.postMap(
      '/direct-chats/${Uri.encodeComponent(friendId)}',
    );
    final conversation = payload['conversation'];
    if (conversation is! Map) {
      throw const FormatException('私聊响应缺少会话数据');
    }
    return Conversation.fromJson(conversation.cast<String, dynamic>());
  }

  Future<List<Conversation>> directChats() async {
    final rows = await _api.getList('/direct-chats');
    return rows
        .whereType<Map>()
        .map((row) => Conversation.fromJson(row.cast<String, dynamic>()))
        .toList(growable: false);
  }

  Future<void> inviteToMeeting({
    required String conversationId,
    required String friendId,
  }) async {
    await _api.postMap(
      '/conversations/${Uri.encodeComponent(conversationId)}/invitations',
      data: {'inviteeId': friendId},
    );
  }

  Future<List<MeetingInvitationModel>> meetingInvitations() async {
    final rows = await _api.getList('/meeting-invitations');
    return rows
        .whereType<Map>()
        .map(
          (row) => MeetingInvitationModel.fromJson(row.cast<String, dynamic>()),
        )
        .toList(growable: false);
  }

  Future<Conversation?> respondToMeetingInvitation({
    required String invitationId,
    required bool accept,
    String? displayName,
    String? company,
    Language? preferredLanguage,
  }) async {
    final payload = await _api.postMap(
      '/meeting-invitations/${Uri.encodeComponent(invitationId)}/respond',
      data: {
        'action': accept ? 'ACCEPT' : 'DECLINE',
        if (accept) 'displayName': displayName?.trim(),
        if (accept) 'company': company?.trim(),
        if (accept) 'preferredLanguage': preferredLanguage?.code,
      },
    );
    final conversation = payload['conversation'];
    return conversation is Map
        ? Conversation.fromJson(conversation.cast<String, dynamic>())
        : null;
  }
}
