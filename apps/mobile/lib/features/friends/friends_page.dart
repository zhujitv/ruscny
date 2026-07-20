import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/errors.dart';
import '../../core/localization/app_localization.dart';
import '../../core/models.dart';
import '../../core/providers.dart';
import '../../shared/async_view.dart';
import '../auth/auth_controller.dart';
import '../room/room_page.dart';
import 'social_realtime_controller.dart';

final class FriendsPage extends ConsumerStatefulWidget {
  const FriendsPage({super.key});

  @override
  ConsumerState<FriendsPage> createState() => _FriendsPageState();
}

final class _FriendsPageState extends ConsumerState<FriendsPage>
    with SingleTickerProviderStateMixin {
  final _search = TextEditingController();
  late final TabController _tabs;
  late Future<List<Conversation>> _directChats;
  late Future<List<UserProfile>> _friends;
  late Future<List<FriendRequestModel>> _requests;
  List<UserProfile>? _searchResults;
  bool _searching = false;
  final _respondingRequestIds = <String>{};
  String? _openingChatFriendId;

  @override
  void initState() {
    super.initState();
    _tabs = TabController(length: 4, vsync: this);
    _reload();
  }

  @override
  void dispose() {
    _search.dispose();
    _tabs.dispose();
    super.dispose();
  }

  void _reload() {
    _directChats = ref.read(friendRepositoryProvider).directChats();
    _friends = ref.read(friendRepositoryProvider).friends();
    _requests = ref.read(friendRepositoryProvider).requests();
    if (_tabs.indexIsChanging || !mounted) return;
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<int>(
      socialRealtimeProvider.select((value) => value.revision),
      (previous, next) {
        if (previous != next && mounted) _reload();
      },
    );
    return Scaffold(
      appBar: AppBar(
        title: const AppText('好友'),
        bottom: TabBar(
          controller: _tabs,
          tabs: const [
            Tab(child: AppText('私聊列表')),
            Tab(child: AppText('好友列表')),
            Tab(child: AppText('好友申请')),
            Tab(child: AppText('添加好友')),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabs,
        children: [
          _directChatsTab(),
          _friendsTab(),
          _requestsTab(),
          _searchTab(),
        ],
      ),
    );
  }

  Widget _directChatsTab() => FutureBuilder<List<Conversation>>(
        future: _directChats,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const LoadingView();
          }
          if (snapshot.hasError) {
            return ErrorView(error: snapshot.error!, onRetry: _reload);
          }
          final chats = snapshot.data ?? const [];
          if (chats.isEmpty) {
            return const Center(child: AppText('还没有好友私聊'));
          }
          final unread = ref.watch(
            socialRealtimeProvider.select((state) => state.unreadDirectChatIds),
          );
          return RefreshIndicator(
            onRefresh: () async => _reload(),
            child: ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: chats.length,
              separatorBuilder: (_, __) => const SizedBox(height: 8),
              itemBuilder: (context, index) {
                final chat = chats[index];
                final peer = chat.directPeer;
                final hasUnread = unread.contains(chat.id);
                return Card(
                  child: ListTile(
                    leading: CircleAvatar(
                      child: Text(
                        (peer?.displayName.trim().isNotEmpty == true
                                ? peer!.displayName.trim()
                                : '好')
                            .characters
                            .first,
                      ),
                    ),
                    title: AppText(
                      peer?.displayName ?? chat.contactName ?? '好友私聊',
                      translate: peer == null && chat.contactName == null,
                    ),
                    subtitle: AppText(
                      chat.messageCount == 0
                          ? '一对一翻译聊天 · 不创建会议房间'
                          : '${chat.messageCount} 条翻译记录',
                    ),
                    trailing: hasUnread
                        ? const Chip(label: AppText('新消息'))
                        : const Icon(Icons.chevron_right),
                    onTap: () => _openExistingDirectChat(chat.id),
                  ),
                );
              },
            ),
          );
        },
      );

  Widget _friendsTab() => FutureBuilder<List<UserProfile>>(
        future: _friends,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const LoadingView();
          }
          if (snapshot.hasError) {
            return ErrorView(error: snapshot.error!, onRetry: _reload);
          }
          final friends = snapshot.data ?? const [];
          if (friends.isEmpty) {
            return const Center(child: AppText('还没有好友'));
          }
          return RefreshIndicator(
            onRefresh: () async => _reload(),
            child: ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: friends.length,
              separatorBuilder: (_, __) => const SizedBox(height: 8),
              itemBuilder: (context, index) {
                final friend = friends[index];
                return Card(
                  child: ListTile(
                    leading: _PresenceAvatar(profile: friend),
                    title: AppText(friend.displayName, translate: false),
                    subtitle: AppText(
                      '${friend.company ?? '—'} · '
                      '${friend.online ? '在线'.tr(context) : '可邀请'.tr(context)}',
                      translate: false,
                    ),
                    onTap: _openingChatFriendId == friend.id
                        ? null
                        : () => _openDirectChat(friend),
                    trailing: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        IconButton.filledTonal(
                          tooltip: '直接聊天'.tr(context),
                          onPressed: _openingChatFriendId == friend.id
                              ? null
                              : () => _openDirectChat(friend),
                          icon: _openingChatFriendId == friend.id
                              ? const SizedBox.square(
                                  dimension: 18,
                                  child:
                                      CircularProgressIndicator(strokeWidth: 2),
                                )
                              : const Icon(Icons.chat_bubble_outline),
                        ),
                        PopupMenuButton<String>(
                          onSelected: (value) {
                            if (value == 'delete') _removeFriend(friend);
                          },
                          itemBuilder: (_) => const [
                            PopupMenuItem(
                              value: 'delete',
                              child: AppText('删除好友'),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                );
              },
            ),
          );
        },
      );

  Widget _requestsTab() => FutureBuilder<List<FriendRequestModel>>(
        future: _requests,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const LoadingView();
          }
          if (snapshot.hasError) {
            return ErrorView(error: snapshot.error!, onRetry: _reload);
          }
          final requests = (snapshot.data ?? const [])
              .where((item) => item.status == 'PENDING')
              .toList(growable: false);
          if (requests.isEmpty) {
            return const Center(child: AppText('没有待处理的好友申请'));
          }
          return ListView.separated(
            padding: const EdgeInsets.all(16),
            itemCount: requests.length,
            separatorBuilder: (_, __) => const SizedBox(height: 8),
            itemBuilder: (context, index) {
              final request = requests[index];
              final responding = _respondingRequestIds.contains(request.id);
              return Card(
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      AppText(
                        request.sender.displayName,
                        translate: false,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      AppText(
                        request.sender.company ?? request.sender.email ?? '—',
                        translate: false,
                      ),
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          Expanded(
                            child: OutlinedButton(
                              onPressed: responding
                                  ? null
                                  : () => _respond(request, false),
                              child: const AppText('拒绝'),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: FilledButton(
                              onPressed: responding
                                  ? null
                                  : () => _respond(request, true),
                              child: const AppText('接受'),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              );
            },
          );
        },
      );

  Widget _searchTab() => ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            controller: _search,
            textInputAction: TextInputAction.search,
            onSubmitted: (_) => _runSearch(),
            decoration: InputDecoration(
              hintText: '搜索姓名、邮箱或公司'.tr(context),
              prefixIcon: const Icon(Icons.search),
              suffixIcon: IconButton(
                onPressed: _searching ? null : _runSearch,
                icon: _searching
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.arrow_forward),
              ),
            ),
          ),
          const SizedBox(height: 12),
          if (_searchResults == null)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Center(child: AppText('输入至少两个字符搜索注册用户')),
            )
          else if (_searchResults!.isEmpty)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Center(child: AppText('没有找到用户')),
            )
          else
            for (final profile in _searchResults!)
              Card(
                child: ListTile(
                  leading: CircleAvatar(
                    child: AppText(
                      profile.displayName.characters.first,
                      translate: false,
                    ),
                  ),
                  title: AppText(profile.displayName, translate: false),
                  subtitle: AppText(
                    profile.company ?? profile.email ?? '—',
                    translate: false,
                  ),
                  trailing: _relationshipAction(profile),
                ),
              ),
        ],
      );

  Widget _relationshipAction(UserProfile profile) =>
      switch (profile.relationship) {
        'FRIEND' => const AppText('已是好友'),
        'OUTGOING' => const AppText('已申请'),
        'INCOMING' => const AppText('待你处理'),
        _ => FilledButton.tonal(
            onPressed: () => _requestFriend(profile),
            child: const AppText('添加'),
          ),
      };

  Future<void> _runSearch() async {
    if (_search.text.trim().length < 2) {
      _snack('请输入至少两个字符');
      return;
    }
    setState(() => _searching = true);
    try {
      final results =
          await ref.read(friendRepositoryProvider).search(_search.text);
      if (mounted) setState(() => _searchResults = results);
    } catch (error) {
      _snack(readableError(error));
    } finally {
      if (mounted) setState(() => _searching = false);
    }
  }

  Future<void> _requestFriend(UserProfile profile) async {
    try {
      await ref.read(friendRepositoryProvider).requestFriend(profile.id);
      if (mounted) {
        _snack('好友申请已发送');
        await _runSearch();
      }
    } catch (error) {
      _snack(readableError(error));
    }
  }

  Future<void> _respond(FriendRequestModel request, bool accept) async {
    if (_respondingRequestIds.contains(request.id)) return;
    setState(() => _respondingRequestIds.add(request.id));
    try {
      await ref
          .read(friendRepositoryProvider)
          .respondToRequest(request.id, accept: accept);
      _reload();
    } catch (error) {
      _snack(readableError(error));
    } finally {
      if (mounted) setState(() => _respondingRequestIds.remove(request.id));
    }
  }

  Future<void> _removeFriend(UserProfile friend) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const AppText('删除好友？'),
        content: AppText(friend.displayName, translate: false),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const AppText('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const AppText('删除'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await ref.read(friendRepositoryProvider).removeFriend(friend.id);
      _reload();
    } catch (error) {
      _snack(readableError(error));
    }
  }

  Future<void> _openDirectChat(UserProfile friend) async {
    if (_openingChatFriendId != null) return;
    setState(() => _openingChatFriendId = friend.id);
    try {
      final conversation =
          await ref.read(friendRepositoryProvider).openDirectChat(friend.id);
      if (!mounted) return;
      ref
          .read(socialRealtimeProvider.notifier)
          .markDirectChatRead(conversation.id);
      await Navigator.push<void>(
        context,
        MaterialPageRoute<void>(
          builder: (_) => RoomPage(conversationId: conversation.id),
        ),
      );
    } catch (error) {
      _snack(readableError(error));
    } finally {
      if (mounted) setState(() => _openingChatFriendId = null);
    }
  }

  Future<void> _openExistingDirectChat(String conversationId) async {
    ref
        .read(socialRealtimeProvider.notifier)
        .markDirectChatRead(conversationId);
    await Navigator.push<void>(
      context,
      MaterialPageRoute<void>(
        builder: (_) => RoomPage(conversationId: conversationId),
      ),
    );
    if (mounted) _reload();
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: AppText(message)),
    );
  }
}

final class FriendInvitePage extends ConsumerStatefulWidget {
  const FriendInvitePage({required this.conversationId, super.key});

  final String conversationId;

  @override
  ConsumerState<FriendInvitePage> createState() => _FriendInvitePageState();
}

final class _FriendInvitePageState extends ConsumerState<FriendInvitePage> {
  late Future<List<UserProfile>> _future;
  final _invited = <String>{};

  @override
  void initState() {
    super.initState();
    _future = ref.read(friendRepositoryProvider).friends();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const AppText('邀请好友参会')),
        body: FutureBuilder<List<UserProfile>>(
          future: _future,
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const LoadingView();
            }
            if (snapshot.hasError) {
              return ErrorView(
                error: snapshot.error!,
                onRetry: () => setState(
                  () => _future = ref.read(friendRepositoryProvider).friends(),
                ),
              );
            }
            final friends = snapshot.data ?? const [];
            if (friends.isEmpty) {
              return const Center(child: AppText('还没有可邀请的好友'));
            }
            return ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: friends.length,
              separatorBuilder: (_, __) => const SizedBox(height: 8),
              itemBuilder: (context, index) {
                final friend = friends[index];
                final invited = _invited.contains(friend.id);
                return Card(
                  child: ListTile(
                    leading: _PresenceAvatar(profile: friend),
                    title: AppText(friend.displayName, translate: false),
                    subtitle: AppText(
                      '${friend.company ?? '—'} · '
                      '${friend.online ? '在线'.tr(context) : '可邀请'.tr(context)}',
                      translate: false,
                    ),
                    trailing: FilledButton.tonal(
                      onPressed: invited ? null : () => _invite(friend),
                      child: AppText(invited ? '已邀请' : '邀请'),
                    ),
                  ),
                );
              },
            );
          },
        ),
      );

  Future<void> _invite(UserProfile friend) async {
    try {
      await ref.read(friendRepositoryProvider).inviteToMeeting(
            conversationId: widget.conversationId,
            friendId: friend.id,
          );
      if (mounted) setState(() => _invited.add(friend.id));
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: AppText(readableError(error))),
        );
      }
    }
  }
}

final class MeetingInvitationsPage extends ConsumerStatefulWidget {
  const MeetingInvitationsPage({super.key});

  @override
  ConsumerState<MeetingInvitationsPage> createState() =>
      _MeetingInvitationsPageState();
}

final class _MeetingInvitationsPageState
    extends ConsumerState<MeetingInvitationsPage> {
  late Future<List<MeetingInvitationModel>> _future;
  final _respondingInvitationIds = <String>{};

  @override
  void initState() {
    super.initState();
    _reload();
  }

  void _reload() {
    _future = ref.read(friendRepositoryProvider).meetingInvitations();
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<int>(
      socialRealtimeProvider.select((value) => value.revision),
      (previous, next) {
        if (previous != next && mounted) _reload();
      },
    );
    return Scaffold(
      appBar: AppBar(title: const AppText('会议邀请')),
      body: FutureBuilder<List<MeetingInvitationModel>>(
        future: _future,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const LoadingView();
          }
          if (snapshot.hasError) {
            return ErrorView(error: snapshot.error!, onRetry: _reload);
          }
          final invitations = snapshot.data ?? const [];
          if (invitations.isEmpty) {
            return const Center(child: AppText('没有待处理的会议邀请'));
          }
          return ListView.separated(
            padding: const EdgeInsets.all(16),
            itemCount: invitations.length,
            separatorBuilder: (_, __) => const SizedBox(height: 8),
            itemBuilder: (context, index) {
              final invitation = invitations[index];
              final responding =
                  _respondingInvitationIds.contains(invitation.id);
              return Card(
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      AppText(
                        invitation.title,
                        translate: false,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      AppText(
                        '${'邀请人'.tr(context)}：${invitation.inviter.displayName}\n'
                        '${invitation.inviter.company ?? '—'}',
                        translate: false,
                      ),
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          Expanded(
                            child: OutlinedButton(
                              onPressed: responding
                                  ? null
                                  : () => _respond(invitation, false),
                              child: const AppText('拒绝'),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: FilledButton(
                              onPressed: responding
                                  ? null
                                  : () => _respond(invitation, true),
                              child: const AppText('确认资料并加入'),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              );
            },
          );
        },
      ),
    );
  }

  Future<void> _respond(
    MeetingInvitationModel invitation,
    bool accept,
  ) async {
    if (_respondingInvitationIds.contains(invitation.id)) return;
    ParticipantProfileInput? profile;
    if (accept) {
      final session = ref.read(authControllerProvider).valueOrNull;
      profile = await showParticipantProfileDialog(
        context,
        initialName: session?.displayName ?? '',
        initialCompany: session?.company ?? '',
        initialLanguage: session?.preferredLanguage ?? Language.zh,
      );
      if (profile == null) return;
    }
    setState(() => _respondingInvitationIds.add(invitation.id));
    try {
      final conversation =
          await ref.read(friendRepositoryProvider).respondToMeetingInvitation(
                invitationId: invitation.id,
                accept: accept,
                displayName: profile?.displayName,
                company: profile?.company,
                preferredLanguage: profile?.preferredLanguage,
              );
      if (!mounted) return;
      if (conversation == null) {
        _reload();
      } else {
        await Navigator.pushReplacement<void, void>(
          context,
          MaterialPageRoute<void>(
            builder: (_) => RoomPage(conversationId: conversation.id),
          ),
        );
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: AppText(readableError(error))),
        );
      }
    } finally {
      if (mounted) {
        setState(() => _respondingInvitationIds.remove(invitation.id));
      }
    }
  }
}

typedef ParticipantProfileInput = ({
  String displayName,
  String company,
  Language preferredLanguage,
});

Future<ParticipantProfileInput?> showParticipantProfileDialog(
  BuildContext context, {
  required String initialName,
  required String initialCompany,
  required Language initialLanguage,
}) async {
  final name = TextEditingController(text: initialName);
  final company = TextEditingController(text: initialCompany);
  var language = initialLanguage;
  final result = await showDialog<ParticipantProfileInput>(
    context: context,
    builder: (context) => StatefulBuilder(
      builder: (context, setDialogState) => AlertDialog(
        title: const AppText('确认本次会议资料'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: name,
                decoration: InputDecoration(
                  labelText: '显示名称 *'.tr(context),
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: company,
                decoration: InputDecoration(
                  labelText: '所属公司 *'.tr(context),
                ),
              ),
              const SizedBox(height: 12),
              SegmentedButton<Language>(
                segments: const [
                  ButtonSegment(value: Language.zh, label: AppText('中文')),
                  ButtonSegment(value: Language.ru, label: AppText('Русский')),
                ],
                selected: {language},
                onSelectionChanged: (value) {
                  setDialogState(() => language = value.first);
                },
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const AppText('取消'),
          ),
          FilledButton(
            onPressed: () {
              if (name.text.trim().isEmpty || company.text.trim().isEmpty) {
                return;
              }
              Navigator.pop(context, (
                displayName: name.text.trim(),
                company: company.text.trim(),
                preferredLanguage: language,
              ));
            },
            child: const AppText('确认并加入'),
          ),
        ],
      ),
    ),
  );
  name.dispose();
  company.dispose();
  return result;
}

final class _PresenceAvatar extends StatelessWidget {
  const _PresenceAvatar({required this.profile});

  final UserProfile profile;

  @override
  Widget build(BuildContext context) => Stack(
        clipBehavior: Clip.none,
        children: [
          CircleAvatar(
            child: AppText(
              profile.displayName.characters.first,
              translate: false,
            ),
          ),
          Positioned(
            right: -1,
            bottom: -1,
            child: Container(
              width: 12,
              height: 12,
              decoration: BoxDecoration(
                color: profile.online ? Colors.green : Colors.grey,
                shape: BoxShape.circle,
                border: Border.all(color: Colors.white, width: 2),
              ),
            ),
          ),
        ],
      );
}
