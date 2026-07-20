import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/localization/app_localization.dart';
import '../../core/models.dart';
import '../../core/providers.dart';
import '../contacts/contacts_page.dart';
import '../friends/friends_page.dart';
import '../friends/social_realtime_controller.dart';
import '../history/history_page.dart';
import '../join/join_page.dart';
import '../room/room_page.dart';
import '../settings/settings_page.dart';
import 'create_conversation_page.dart';

final class HomePage extends ConsumerStatefulWidget {
  const HomePage({required this.session, super.key});

  final AuthSession session;

  @override
  ConsumerState<HomePage> createState() => _HomePageState();
}

final class _HomePageState extends ConsumerState<HomePage> {
  String? _handledInvite;
  String? _handledMeetingInvitation;
  bool _openedGuestRoom = false;

  @override
  Widget build(BuildContext context) {
    final pendingInvite = ref.watch(pendingInviteProvider);
    final socialRealtime = ref.watch(socialRealtimeProvider);
    final meetingInvitation = socialRealtime.latestInvitation;
    if (meetingInvitation != null &&
        meetingInvitation.id != _handledMeetingInvitation) {
      _handledMeetingInvitation = meetingInvitation.id;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        ref
            .read(socialRealtimeProvider.notifier)
            .consumeInvitation(meetingInvitation.id);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: AppText(
              '收到会议邀请：${meetingInvitation.title}',
            ),
            action: SnackBarAction(
              label: '查看'.tr(context),
              onPressed: () => Navigator.push<void>(
                context,
                MaterialPageRoute<void>(
                  builder: (_) => const MeetingInvitationsPage(),
                ),
              ),
            ),
          ),
        );
      });
    }
    if (widget.session.role == UserRole.guest &&
        widget.session.currentConversationId != null &&
        !_openedGuestRoom) {
      _openedGuestRoom = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        ref.read(pendingInviteProvider.notifier).state = null;
        if (mounted) {
          Navigator.push<void>(
            context,
            MaterialPageRoute<void>(
              builder: (_) => RoomPage(
                conversationId: widget.session.currentConversationId!,
              ),
            ),
          );
        }
      });
    } else if (pendingInvite != null &&
        pendingInvite != _handledInvite &&
        widget.session.role != UserRole.guest) {
      _handledInvite = pendingInvite;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        ref.read(pendingInviteProvider.notifier).state = null;
        if (mounted) {
          Navigator.push<void>(
            context,
            MaterialPageRoute<void>(
              builder: (_) => JoinPage(initialInviteToken: pendingInvite),
            ),
          );
        }
      });
    } else if (pendingInvite != null && pendingInvite != _handledInvite) {
      _handledInvite = pendingInvite;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        ref.read(pendingInviteProvider.notifier).state = null;
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: AppText('当前访客身份只限已加入的会议')),
          );
        }
      });
    }

    final guest = widget.session.role == UserRole.guest;
    return Scaffold(
      appBar: AppBar(
        title: const AppText('中俄翻译'),
        actions: [
          IconButton(
            tooltip: '设置'.tr(context),
            onPressed: () => Navigator.push<void>(
              context,
              MaterialPageRoute<void>(builder: (_) => const SettingsPage()),
            ),
            icon: const Icon(Icons.settings_outlined),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          AppText(
            '你好，${widget.session.displayName}',
            style: Theme.of(
              context,
            ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 4),
          AppText(
            guest ? '访客身份只用于当前会议。' : '发起自己的会议，或加入好友邀请的会议。',
          ),
          const SizedBox(height: 18),
          if (!guest)
            _PrimaryAction(
              icon: Icons.add_comment_outlined,
              title: '新建会议',
              subtitle: '选择客户 · 生成二维码、链接和房间码',
              onTap: () => Navigator.push<void>(
                context,
                MaterialPageRoute<void>(
                  builder: (_) => const CreateConversationPage(),
                ),
              ),
            ),
          if (guest && widget.session.currentConversationId != null)
            _PrimaryAction(
              icon: Icons.forum_outlined,
              title: '返回当前会议',
              subtitle: '访客身份仅可进入这一个翻译房间',
              onTap: () => Navigator.push<void>(
                context,
                MaterialPageRoute<void>(
                  builder: (_) => RoomPage(
                    conversationId: widget.session.currentConversationId!,
                  ),
                ),
              ),
            ),
          if (!guest)
            _PrimaryAction(
              icon: Icons.qr_code_scanner,
              title: '加入会议',
              subtitle: '扫描二维码、邀请链接或输入房间码',
              onTap: () => Navigator.push<void>(
                context,
                MaterialPageRoute<void>(builder: (_) => const JoinPage()),
              ),
            ),
          const SizedBox(height: 8),
          GridView.count(
            crossAxisCount: MediaQuery.sizeOf(context).width > 650 ? 3 : 2,
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            crossAxisSpacing: 10,
            mainAxisSpacing: 10,
            childAspectRatio: 1.25,
            children: [
              if (!guest)
                _DashboardTile(
                  icon: Icons.people_outline,
                  title: '客户',
                  subtitle: '资料与客户历史',
                  onTap: () => Navigator.push<void>(
                    context,
                    MaterialPageRoute<void>(
                      builder: (_) => const ContactsPage(),
                    ),
                  ),
                ),
              if (!guest)
                _DashboardTile(
                  icon: Icons.history,
                  title: '历史会议',
                  subtitle: '自己发起或获授权的会议',
                  onTap: () => Navigator.push<void>(
                    context,
                    MaterialPageRoute<void>(
                      builder: (_) => const HistoryPage(),
                    ),
                  ),
                ),
              if (!guest)
                _DashboardTile(
                  icon: Icons.group_outlined,
                  title: '好友',
                  subtitle: socialRealtime.unreadDirectChatIds.isEmpty
                      ? '私聊、搜索与管理好友'
                      : '${socialRealtime.unreadDirectChatIds.length} 条新私聊消息',
                  onTap: () => Navigator.push<void>(
                    context,
                    MaterialPageRoute<void>(
                        builder: (_) => const FriendsPage()),
                  ),
                ),
              if (!guest)
                _DashboardTile(
                  icon: Icons.mark_email_unread_outlined,
                  title: '会议邀请',
                  subtitle: meetingInvitation == null ? '查看并直接加入会议' : '有新的会议邀请',
                  onTap: () => Navigator.push<void>(
                    context,
                    MaterialPageRoute<void>(
                      builder: (_) => const MeetingInvitationsPage(),
                    ),
                  ),
                ),
              _DashboardTile(
                icon: Icons.tune,
                title: '设置',
                subtitle: '自动播放与账号',
                onTap: () => Navigator.push<void>(
                  context,
                  MaterialPageRoute<void>(builder: (_) => const SettingsPage()),
                ),
              ),
            ],
          ),
          const SizedBox(height: 18),
          const Card(
            child: Padding(
              padding: EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  AppText('使用提示',
                      style: TextStyle(fontWeight: FontWeight.bold)),
                  SizedBox(height: 8),
                  AppText('• 按住麦克风说话，松开后发送。'),
                  AppText('• 每位参会者使用进入会议时确认的中文或俄语。'),
                  AppText('• 不要双方同时讲话；关键数字、单位和型号请人工确认。'),
                  AppText('• 原始录音上传后即从本机临时目录删除。'),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

final class _PrimaryAction extends StatelessWidget {
  const _PrimaryAction({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });
  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Card(
        color: Theme.of(context).colorScheme.primaryContainer,
        child: ListTile(
          contentPadding: const EdgeInsets.all(16),
          leading: Icon(icon, size: 34),
          title: AppText(title, style: Theme.of(context).textTheme.titleLarge),
          subtitle: AppText(subtitle),
          trailing: const Icon(Icons.arrow_forward),
          onTap: onTap,
        ),
      );
}

final class _DashboardTile extends StatelessWidget {
  const _DashboardTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });
  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Card(
        child: InkWell(
          borderRadius: BorderRadius.circular(18),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(icon, size: 30),
                const SizedBox(height: 8),
                AppText(title,
                    style: const TextStyle(fontWeight: FontWeight.bold)),
                AppText(subtitle, style: Theme.of(context).textTheme.bodySmall),
              ],
            ),
          ),
        ),
      );
}
