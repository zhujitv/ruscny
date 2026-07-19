import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/errors.dart';
import '../../core/localization/app_localization.dart';
import '../../core/models.dart';
import '../../core/realtime/room_realtime_client.dart';
import '../auth/auth_controller.dart';
import '../conversations/invite_page.dart';
import '../settings/settings_controller.dart';
import 'room_controller.dart';

final class RoomPage extends ConsumerStatefulWidget {
  const RoomPage({required this.conversationId, super.key});

  final String conversationId;

  @override
  ConsumerState<RoomPage> createState() => _RoomPageState();
}

final class _RoomPageState extends ConsumerState<RoomPage>
    with WidgetsBindingObserver {
  final _scrollController = ScrollController();
  int _lastMessageCount = 0;
  String? _removingParticipantId;
  bool _rotatingInvitation = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) {
      unawaited(
        ref
            .read(roomControllerProvider(widget.conversationId).notifier)
            .cancelRecording(),
      );
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(roomControllerProvider(widget.conversationId));
    final session = ref.watch(authControllerProvider).valueOrNull;
    final settings = ref.watch(settingsControllerProvider).valueOrNull;
    if (state.messages.length != _lastMessageCount) {
      _lastMessageCount = state.messages.length;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scrollController.hasClients) {
          _scrollController.animateTo(
            _scrollController.position.maxScrollExtent,
            duration: const Duration(milliseconds: 250),
            curve: Curves.easeOut,
          );
        }
      });
    }

    final conversation = state.conversation;
    final isConversationOwner = conversation != null &&
        session != null &&
        conversation.ownerId == session.userId;
    final canSpeak = conversation?.canSpeakAs(session?.userId) == true;
    final canRecord = canSpeak && state.action == RoomAction.idle;
    final canReviewMessages = conversation?.status == ConversationStatus.active;
    return PopScope(
      canPop: state.action != RoomAction.recording,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop && state.action == RoomAction.recording) {
          ref
              .read(roomControllerProvider(widget.conversationId).notifier)
              .cancelRecording();
        }
      },
      child: Scaffold(
        appBar: AppBar(
          title: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              AppText(
                conversation?.contactName ?? '翻译房间',
                translate: conversation?.contactName == null,
              ),
              AppText(
                conversation?.title ?? '正在读取会议信息',
                translate: conversation?.title == null,
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ),
          actions: [
            _ConnectionChip(status: state.connection),
            const SizedBox(width: 8),
          ],
        ),
        body: Column(
          children: [
            _RoomSummary(
              state: state,
              canManageGuests: isConversationOwner &&
                  conversation.status == ConversationStatus.active,
              removingParticipantId: _removingParticipantId,
              onRemoveGuest: _confirmRemoveParticipant,
            ),
            if (isConversationOwner &&
                conversation.status == ConversationStatus.waiting)
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 8, 14, 0),
                child: SizedBox(
                  width: double.infinity,
                  child: OutlinedButton.icon(
                    onPressed: _rotatingInvitation ? null : _rotateInvitation,
                    icon: _rotatingInvitation
                        ? const SizedBox.square(
                            dimension: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.qr_code_2),
                    label: AppText(
                      _rotatingInvitation ? '正在生成…' : '重新生成邀请',
                    ),
                  ),
                ),
              ),
            if (state.error != null)
              MaterialBanner(
                content: AppText(state.error!),
                actions: [
                  if (state.connection == RoomSocketStatus.disconnected ||
                      state.connection == RoomSocketStatus.reconnectFailed)
                    TextButton(
                      onPressed: () => ref
                          .read(
                            roomControllerProvider(
                              widget.conversationId,
                            ).notifier,
                          )
                          .retryConnection(),
                      child: const AppText('重试连接'),
                    ),
                  TextButton(
                    onPressed: () => ref
                        .read(
                          roomControllerProvider(
                            widget.conversationId,
                          ).notifier,
                        )
                        .clearError(),
                    child: const AppText('知道了'),
                  ),
                ],
              ),
            Expanded(
              child: state.messages.isEmpty
                  ? const _EmptyRoom()
                  : ListView.builder(
                      controller: _scrollController,
                      padding: const EdgeInsets.fromLTRB(12, 12, 12, 20),
                      itemCount: state.messages.length,
                      itemBuilder: (context, index) => _MessageCard(
                        message: state.messages[index],
                        selfParticipantId: state.selfParticipantId,
                        onReplay: _playAudio,
                        canReview: canReviewMessages &&
                            (isConversationOwner ||
                                state.messages[index].participantId ==
                                    state.selfParticipantId),
                        canAddGlossary: canReviewMessages &&
                            isConversationOwner &&
                            state.messages[index].hasConfirmedCorrection,
                        onEdit: () => _editMessage(state.messages[index]),
                        onRetranslate: () =>
                            _retranslateMessage(state.messages[index]),
                        onConfirm: () => _decideCorrection(
                          state.messages[index],
                          confirm: true,
                        ),
                        onReject: () => _decideCorrection(
                          state.messages[index],
                          confirm: false,
                        ),
                        onAddGlossary: () =>
                            _addMessageToGlossary(state.messages[index]),
                      ),
                    ),
            ),
            SafeArea(
              top: false,
              child: Container(
                padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
                decoration: const BoxDecoration(
                  color: Colors.white,
                  border: Border(top: BorderSide(color: Color(0xFFE2E8F0))),
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: SegmentedButton<Language>(
                            segments: const [
                              ButtonSegment(
                                value: Language.zh,
                                label: AppText('说中文'),
                              ),
                              ButtonSegment(
                                value: Language.ru,
                                label: AppText('Говорить по-русски'),
                              ),
                            ],
                            selected: {state.inputLanguage},
                            onSelectionChanged: state.action == RoomAction.idle
                                ? (value) => unawaited(
                                      ref
                                          .read(
                                            roomControllerProvider(
                                              widget.conversationId,
                                            ).notifier,
                                          )
                                          .setInputLanguage(value.first),
                                    )
                                : null,
                          ),
                        ),
                        const SizedBox(width: 6),
                        IconButton(
                          tooltip: (settings?.autoPlay == false
                                  ? '开启自动播放'
                                  : '关闭自动播放')
                              .tr(context),
                          onPressed: () => ref
                              .read(settingsControllerProvider.notifier)
                              .setAutoPlay(!(settings?.autoPlay ?? true)),
                          icon: Icon(
                            settings?.autoPlay == false
                                ? Icons.volume_off_outlined
                                : Icons.volume_up_outlined,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),
                    if (state.action == RoomAction.sendFailed) ...[
                      const Align(
                        alignment: Alignment.centerLeft,
                        child: AppText(
                          '此段录音尚未成功发送，新录音已暂停。',
                          style: TextStyle(fontWeight: FontWeight.w600),
                        ),
                      ),
                      const SizedBox(height: 8),
                      Row(
                        children: [
                          Expanded(
                            child: OutlinedButton.icon(
                              onPressed: _confirmDiscardPendingAudio,
                              icon: const Icon(Icons.delete_outline),
                              label: const AppText('放弃此段'),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: FilledButton.icon(
                              onPressed: canSpeak
                                  ? () => ref
                                      .read(
                                        roomControllerProvider(
                                          widget.conversationId,
                                        ).notifier,
                                      )
                                      .retryPendingAudio()
                                  : null,
                              icon: const Icon(Icons.refresh),
                              label: const AppText('重试发送'),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 10),
                    ],
                    if (canSpeak &&
                        state.connection != RoomSocketStatus.connected) ...[
                      const AppText(
                        '实时同步正在恢复，仍可录音翻译，结果会在连接恢复后自动补齐',
                        style: TextStyle(color: Colors.black54, fontSize: 12),
                      ),
                      const SizedBox(height: 8),
                    ],
                    Row(
                      children: [
                        Expanded(
                          child: RoomPushToTalkButton(
                            action: state.action,
                            language: state.inputLanguage,
                            enabled: canRecord,
                            onStart: () => ref
                                .read(
                                  roomControllerProvider(
                                    widget.conversationId,
                                  ).notifier,
                                )
                                .beginRecording(),
                            onEnd: () => ref
                                .read(
                                  roomControllerProvider(
                                    widget.conversationId,
                                  ).notifier,
                                )
                                .finishRecording(),
                            onCancel: () => ref
                                .read(
                                  roomControllerProvider(
                                    widget.conversationId,
                                  ).notifier,
                                )
                                .cancelRecording(),
                          ),
                        ),
                        if (isConversationOwner) ...[
                          const SizedBox(width: 8),
                          IconButton.filledTonal(
                            tooltip: '结束会议'.tr(context),
                            onPressed: conversation.canEnd ? _confirmEnd : null,
                            icon: const Icon(Icons.stop_circle_outlined),
                          ),
                        ],
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _confirmEnd() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const AppText('结束本次会议？'),
        content: const AppText('结束后任何参与者都不能继续发送语音，记录会按本次会议单独保存。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const AppText('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const AppText('结束会议'),
          ),
        ],
      ),
    );
    if (confirmed == true) {
      await ref
          .read(roomControllerProvider(widget.conversationId).notifier)
          .endConversation();
    }
  }

  Future<void> _rotateInvitation() async {
    if (_rotatingInvitation) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const AppText('重新生成邀请？'),
        content: const AppText('新邀请生成后，之前的邀请链接和房间码会立即失效。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const AppText('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const AppText('生成新邀请'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _rotatingInvitation = true);
    final result = await ref
        .read(roomControllerProvider(widget.conversationId).notifier)
        .rotateInvitation();
    if (!mounted) return;
    setState(() => _rotatingInvitation = false);
    if (result == null) return;
    await Navigator.push<void>(
      context,
      MaterialPageRoute<void>(
        builder: (_) => InvitePage(
          conversation: result.conversation,
          inviteUrl: result.invitation.inviteUrl,
          expiresAt: result.invitation.expiresAt,
          roomAlreadyOpen: true,
        ),
      ),
    );
  }

  Future<void> _confirmDiscardPendingAudio() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const AppText('放弃这段录音？'),
        content: const AppText('本地录音会立即删除，之后无法再次发送。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const AppText('继续保留'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const AppText('确认放弃'),
          ),
        ],
      ),
    );
    if (confirmed == true && mounted) {
      await ref
          .read(roomControllerProvider(widget.conversationId).notifier)
          .discardPendingAudio();
    }
  }

  Future<void> _editMessage(TranslationMessage message) async {
    final source = TextEditingController(
      text: message.pendingSourceText ?? message.sourceText,
    );
    final translation = TextEditingController(
      text: message.pendingTranslatedText ?? message.translatedText,
    );
    final reason = TextEditingController();
    final result = await showDialog<
        ({
          String sourceText,
          String translatedText,
          String reason,
        })>(
      context: context,
      builder: (context) => AlertDialog(
        title: const AppText('修改原文和译文'),
        content: SizedBox(
          width: 560,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: source,
                  minLines: 2,
                  maxLines: 6,
                  decoration: const InputDecoration(label: AppText('修正后原文')),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: translation,
                  minLines: 2,
                  maxLines: 6,
                  decoration: const InputDecoration(label: AppText('修正后译文')),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: reason,
                  maxLength: 1000,
                  decoration: const InputDecoration(
                    label: AppText('修改原因（可选）'),
                  ),
                ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const AppText('取消'),
          ),
          FilledButton(
            onPressed: () {
              if (source.text.trim().isEmpty ||
                  translation.text.trim().isEmpty) {
                return;
              }
              Navigator.pop(context, (
                sourceText: source.text.trim(),
                translatedText: translation.text.trim(),
                reason: reason.text.trim(),
              ));
            },
            child: const AppText('提交纠错'),
          ),
        ],
      ),
    );
    source.dispose();
    translation.dispose();
    reason.dispose();
    if (result == null || !mounted) return;
    final saved = await ref
        .read(roomControllerProvider(widget.conversationId).notifier)
        .proposeMessageCorrection(
          message: message,
          sourceText: result.sourceText,
          translatedText: result.translatedText,
          reason: result.reason,
        );
    if (saved && mounted) _showReviewSuccess('纠错已提交，等待确认');
  }

  Future<void> _retranslateMessage(TranslationMessage message) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const AppText('重新翻译这段原文？'),
        content: AppText(
          message.pendingSourceText ?? message.sourceText,
          translate: false,
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const AppText('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const AppText('重新翻译'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    final saved = await ref
        .read(roomControllerProvider(widget.conversationId).notifier)
        .retranslateMessage(message);
    if (saved && mounted) _showReviewSuccess('新译文已生成，等待确认');
  }

  Future<void> _decideCorrection(
    TranslationMessage message, {
    required bool confirm,
  }) async {
    if (message.reviewStatus != MessageReviewStatus.pending) return;
    final accepted = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: AppText(confirm ? '确认采用这次纠错？' : '拒绝这次纠错？'),
        content: confirm
            ? AppText(
                '${message.pendingSourceText ?? ''}\n\n'
                '${message.pendingTranslatedText ?? ''}',
                translate: false,
              )
            : const AppText('拒绝后继续显示上一次已确认内容或原始翻译。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const AppText('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: AppText(confirm ? '确认采用' : '拒绝纠错'),
          ),
        ],
      ),
    );
    if (accepted != true || !mounted) return;
    final saved = await ref
        .read(roomControllerProvider(widget.conversationId).notifier)
        .decideMessageCorrection(message, confirm: confirm);
    if (saved && mounted) {
      _showReviewSuccess(confirm ? '纠错已确认并同步给参会者' : '纠错已拒绝');
    }
  }

  Future<void> _addMessageToGlossary(TranslationMessage message) async {
    final source = TextEditingController(text: message.sourceText);
    final target = TextEditingController(text: message.translatedText);
    final category = TextEditingController(text: '会议纠错'.tr(context));
    final result = await showDialog<
        ({
          String sourceTerm,
          String targetTerm,
          String category,
        })>(
      context: context,
      builder: (context) => AlertDialog(
        title: const AppText('加入专业术语库'),
        content: SizedBox(
          width: 520,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: source,
                maxLength: 200,
                decoration: const InputDecoration(label: AppText('原词')),
              ),
              TextField(
                controller: target,
                maxLength: 200,
                decoration: const InputDecoration(label: AppText('目标词')),
              ),
              TextField(
                controller: category,
                maxLength: 100,
                decoration: const InputDecoration(label: AppText('分类')),
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
              if (source.text.trim().isEmpty || target.text.trim().isEmpty) {
                return;
              }
              Navigator.pop(context, (
                sourceTerm: source.text.trim(),
                targetTerm: target.text.trim(),
                category: category.text.trim(),
              ));
            },
            child: const AppText('加入术语库'),
          ),
        ],
      ),
    );
    source.dispose();
    target.dispose();
    category.dispose();
    if (result == null || !mounted) return;
    final saved = await ref
        .read(roomControllerProvider(widget.conversationId).notifier)
        .addMessageToGlossary(
          message: message,
          sourceTerm: result.sourceTerm,
          targetTerm: result.targetTerm,
          category: result.category,
        );
    if (saved && mounted) _showReviewSuccess('已加入专业术语库');
  }

  void _showReviewSuccess(String text) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: AppText(text)),
    );
  }

  Future<void> _playAudio(TranslationMessage message) async {
    try {
      await ref
          .read(roomControllerProvider(widget.conversationId).notifier)
          .playMessageAudio(message);
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: AppText('语音播放失败：${readableError(error)}')),
        );
      }
    }
  }

  Future<void> _confirmRemoveParticipant(Participant participant) async {
    if (_removingParticipantId != null) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const AppText('移出客户？'),
        content: AppText(
          _removeParticipantMessage(context, participant.displayName),
          translate: false,
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const AppText('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const AppText('确认移出'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _removingParticipantId = participant.id);
    final result = await ref
        .read(roomControllerProvider(widget.conversationId).notifier)
        .removeParticipant(participant.id);
    if (!mounted) return;
    setState(() => _removingParticipantId = null);
    if (result) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(
        SnackBar(content: AppText('已移出 ${participant.displayName}')),
      );
    }
  }

  static String _removeParticipantMessage(BuildContext context, String name) {
    if (Localizations.localeOf(context).languageCode == 'ru') {
      return 'Удалить «$name» из этой сессии?\n\n'
          'Участник будет немедленно отключён и потеряет право повторного входа '
          'и выступления. Остальные участники и приглашения не изменятся.';
    }
    return '确定将“$name”移出本次会议？\n\n'
        '对方会立即断开并失去重连和发言权限；其他参会者和邀请不受影响。';
  }
}

final class _RoomSummary extends StatelessWidget {
  const _RoomSummary({
    required this.state,
    required this.canManageGuests,
    required this.removingParticipantId,
    required this.onRemoveGuest,
  });

  final RoomState state;
  final bool canManageGuests;
  final String? removingParticipantId;
  final ValueChanged<Participant> onRemoveGuest;

  @override
  Widget build(BuildContext context) {
    final conversation = state.conversation;
    final participantCount = state.participants.isNotEmpty
        ? state.participants
            .where((item) => item.presence != ParticipantPresence.removed)
            .length
        : conversation?.participantCount ?? 0;
    return Container(
      width: double.infinity,
      color: Theme.of(context).colorScheme.surfaceContainerLow,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 14,
            runSpacing: 4,
            children: [
              AppText('状态：${_statusLabel(conversation?.status)}'),
              AppText('参与：$participantCount 人'),
              if (conversation?.company?.isNotEmpty == true)
                AppText(conversation!.company!, translate: false),
            ],
          ),
          if (state.participants.isNotEmpty) ...[
            const SizedBox(height: 7),
            AppText('会议参与者', style: Theme.of(context).textTheme.labelMedium),
            const SizedBox(height: 4),
            Wrap(
              spacing: 7,
              runSpacing: 5,
              children: [
                for (final participant in state.participants)
                  InputChip(
                    avatar: removingParticipantId == participant.id
                        ? const SizedBox.square(
                            dimension: 15,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : Icon(
                            participant.role == UserRole.host
                                ? Icons.support_agent
                                : Icons.person_outline,
                            size: 17,
                          ),
                    label: AppText(
                      '${participant.displayName}'
                      '${participant.company?.isNotEmpty == true ? ' · ${participant.company}' : ''}'
                      ' · ${participant.preferredLanguage.label.tr(context)}'
                      ' · ${_presenceLabel(participant.presence).tr(context)}',
                      translate: false,
                    ),
                    onDeleted: canManageGuests &&
                            participant.role != UserRole.host &&
                            participant.presence !=
                                ParticipantPresence.removed &&
                            removingParticipantId == null
                        ? () => onRemoveGuest(participant)
                        : null,
                    deleteIcon: const Icon(
                      Icons.person_remove_outlined,
                      size: 18,
                    ),
                    deleteButtonTooltipMessage: '移出参会者'.tr(context),
                    visualDensity: VisualDensity.compact,
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  static String _statusLabel(ConversationStatus? status) => switch (status) {
        ConversationStatus.waiting => '等待参会者',
        ConversationStatus.active => '进行中',
        ConversationStatus.ended => '已结束',
        ConversationStatus.expired => '已过期',
        null => '加载中',
      };

  static String _presenceLabel(ParticipantPresence presence) =>
      switch (presence) {
        ParticipantPresence.online => '在线',
        ParticipantPresence.offline => '离线',
        ParticipantPresence.left => '已离开',
        ParticipantPresence.removed => '已移出',
      };
}

final class _ConnectionChip extends StatelessWidget {
  const _ConnectionChip({required this.status});
  final RoomSocketStatus status;

  @override
  Widget build(BuildContext context) {
    final (label, color) = switch (status) {
      RoomSocketStatus.connected => ('已连接', Colors.green),
      RoomSocketStatus.connecting => ('连接中', Colors.orange),
      RoomSocketStatus.reconnecting => ('弱网重连', Colors.orange),
      RoomSocketStatus.reconnectFailed => ('重连失败', Colors.red),
      RoomSocketStatus.disconnected => ('已断开', Colors.red),
      RoomSocketStatus.ended => ('已结束', Colors.grey),
    };
    return Chip(
      avatar: Icon(Icons.circle, size: 10, color: color),
      label: AppText(label, style: const TextStyle(fontSize: 12)),
      visualDensity: VisualDensity.compact,
    );
  }
}

final class _MessageCard extends StatelessWidget {
  const _MessageCard({
    required this.message,
    required this.selfParticipantId,
    required this.onReplay,
    required this.canReview,
    required this.canAddGlossary,
    required this.onEdit,
    required this.onRetranslate,
    required this.onConfirm,
    required this.onReject,
    required this.onAddGlossary,
  });

  final TranslationMessage message;
  final String? selfParticipantId;
  final ValueChanged<TranslationMessage> onReplay;
  final bool canReview;
  final bool canAddGlossary;
  final VoidCallback onEdit;
  final VoidCallback onRetranslate;
  final VoidCallback onConfirm;
  final VoidCallback onReject;
  final VoidCallback onAddGlossary;

  @override
  Widget build(BuildContext context) {
    final mine = message.participantId == selfParticipantId;
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 560),
        margin: const EdgeInsets.symmetric(vertical: 5),
        padding: const EdgeInsets.all(13),
        decoration: BoxDecoration(
          color: mine
              ? Theme.of(context).colorScheme.primaryContainer
              : Colors.white,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: const Color(0xFFE2E8F0)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            AppText(
              '${message.displayName ?? '参会者'.tr(context)}'
              '${message.company?.isNotEmpty == true ? ' · ${message.company}' : ''}'
              ' · ${message.sourceLanguage.label.tr(context)}'
              ' · ${DateFormat('HH:mm:ss').format(message.createdAt)}',
              translate: false,
              style: Theme.of(context).textTheme.labelMedium,
            ),
            const SizedBox(height: 6),
            switch (message.status) {
              MessageStatus.processing => const Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                    SizedBox(width: 8),
                    AppText('正在识别和翻译…'),
                  ],
                ),
              MessageStatus.failed => Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const AppText(
                      '翻译失败',
                      style: TextStyle(
                        fontWeight: FontWeight.bold,
                        color: Colors.red,
                      ),
                    ),
                    const SizedBox(height: 4),
                    AppText(
                        message.errorMessage ?? message.errorCode ?? '请重新按住说话'),
                  ],
                ),
              MessageStatus.finalResult => Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        if (message.reviewStatus !=
                            MessageReviewStatus.unreviewed)
                          _ReviewStatusChip(status: message.reviewStatus),
                        const Spacer(),
                        if (canReview || canAddGlossary)
                          PopupMenuButton<String>(
                            tooltip: '纠错与确认'.tr(context),
                            onSelected: (value) => switch (value) {
                              'edit' => onEdit(),
                              'retranslate' => onRetranslate(),
                              'confirm' => onConfirm(),
                              'reject' => onReject(),
                              'glossary' => onAddGlossary(),
                              _ => null,
                            },
                            itemBuilder: (_) => [
                              if (canReview)
                                const PopupMenuItem(
                                  value: 'edit',
                                  child: AppText('修改原文和译文'),
                                ),
                              if (canReview)
                                const PopupMenuItem(
                                  value: 'retranslate',
                                  child: AppText('重新翻译'),
                                ),
                              if (canReview &&
                                  message.reviewStatus ==
                                      MessageReviewStatus.pending) ...[
                                const PopupMenuDivider(),
                                const PopupMenuItem(
                                  value: 'confirm',
                                  child: AppText('确认采用纠错'),
                                ),
                                const PopupMenuItem(
                                  value: 'reject',
                                  child: AppText('拒绝纠错'),
                                ),
                              ],
                              if (canAddGlossary) ...[
                                const PopupMenuDivider(),
                                const PopupMenuItem(
                                  value: 'glossary',
                                  child: AppText('加入专业术语库'),
                                ),
                              ],
                            ],
                            icon: const Icon(Icons.more_horiz, size: 20),
                          ),
                        if (message.audioUrl?.isNotEmpty == true)
                          IconButton(
                            tooltip: '重播译文'.tr(context),
                            visualDensity: VisualDensity.compact,
                            onPressed: () => onReplay(message),
                            icon:
                                const Icon(Icons.volume_up_outlined, size: 20),
                          ),
                        IconButton(
                          tooltip: '复制'.tr(context),
                          visualDensity: VisualDensity.compact,
                          onPressed: () {
                            unawaited(
                              Clipboard.setData(
                                ClipboardData(
                                  text:
                                      '${message.sourceText}\n${message.translatedText}',
                                ),
                              ),
                            );
                            ScaffoldMessenger.of(
                              context,
                            ).showSnackBar(
                                const SnackBar(content: AppText('已复制原文和译文')));
                          },
                          icon: const Icon(Icons.copy_outlined, size: 19),
                        ),
                      ],
                    ),
                    AppText(
                      '${message.sourceLanguage.label.tr(context)} ${'原文'.tr(context)}',
                      translate: false,
                      style: Theme.of(context).textTheme.labelSmall,
                    ),
                    SelectableText(message.sourceText),
                    const SizedBox(height: 8),
                    AppText(
                      '${message.targetLanguage.label.tr(context)} ${'译文'.tr(context)}',
                      translate: false,
                      style: Theme.of(context).textTheme.labelSmall?.copyWith(
                            color: Theme.of(context).colorScheme.primary,
                          ),
                    ),
                    SelectableText(
                      message.translatedText,
                      style: const TextStyle(
                        fontSize: 17,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    if (message.reviewStatus == MessageReviewStatus.pending &&
                        message.pendingSourceText != null &&
                        message.pendingTranslatedText != null) ...[
                      const SizedBox(height: 10),
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: Colors.orange.shade50,
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const AppText(
                              '待确认纠错',
                              style: TextStyle(fontWeight: FontWeight.w600),
                            ),
                            const SizedBox(height: 4),
                            AppText(
                              message.pendingSourceText!,
                              translate: false,
                            ),
                            const SizedBox(height: 4),
                            AppText(
                              message.pendingTranslatedText!,
                              translate: false,
                              style:
                                  const TextStyle(fontWeight: FontWeight.w600),
                            ),
                          ],
                        ),
                      ),
                    ],
                    if (message.errorMessage?.isNotEmpty == true) ...[
                      const SizedBox(height: 7),
                      AppText(
                        message.errorMessage!,
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                          fontSize: 12,
                        ),
                      ),
                    ],
                    if (message.audioUrl?.isNotEmpty != true &&
                        (message.errorCode == 'TTS_PENDING' ||
                            message.errorCode == 'TTS_PROCESSING')) ...[
                      const SizedBox(height: 7),
                      const Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          SizedBox(
                            width: 12,
                            height: 12,
                            child: CircularProgressIndicator(strokeWidth: 1.5),
                          ),
                          SizedBox(width: 6),
                          AppText(
                            '正在生成译文语音…',
                            style: TextStyle(fontSize: 12),
                          ),
                        ],
                      ),
                    ],
                  ],
                ),
            },
          ],
        ),
      ),
    );
  }
}

final class _ReviewStatusChip extends StatelessWidget {
  const _ReviewStatusChip({required this.status});

  final MessageReviewStatus status;

  @override
  Widget build(BuildContext context) {
    final (label, color) = switch (status) {
      MessageReviewStatus.pending => ('待确认纠错', Colors.orange),
      MessageReviewStatus.confirmed => ('已人工确认', Colors.green),
      MessageReviewStatus.rejected => ('纠错已拒绝', Colors.grey),
      MessageReviewStatus.unreviewed => ('未复核', Colors.grey),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(999),
      ),
      child: AppText(
        label,
        style: TextStyle(color: color, fontSize: 11),
      ),
    );
  }
}

/// Kept public so the press/rebuild/release interaction can be covered by a
/// real widget gesture test. RoomPage remains its only production caller.
final class RoomPushToTalkButton extends StatelessWidget {
  const RoomPushToTalkButton({
    required this.action,
    required this.language,
    required this.enabled,
    required this.onStart,
    required this.onEnd,
    required this.onCancel,
    super.key,
  });

  final RoomAction action;
  final Language language;
  final bool enabled;
  final VoidCallback onStart;
  final VoidCallback onEnd;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final recording = action == RoomAction.recording;
    final uploading = action == RoomAction.uploading;
    final processing = action == RoomAction.processing;
    final sendFailed = action == RoomAction.sendFailed;
    // RoomPage intentionally disables starting a second recording as soon as
    // state becomes `recording`. The recognizer must nevertheless keep its
    // release/cancel callbacks through that rebuild, otherwise lifting the
    // finger never stops or submits the active segment.
    final canRelease = recording;
    final visuallyEnabled = enabled || canRelease;
    return GestureDetector(
      key: const ValueKey('room-push-to-talk-gesture'),
      onLongPressStart: enabled && !uploading && !processing && !sendFailed
          ? (_) => onStart()
          : null,
      onLongPressEnd: canRelease ? (_) => onEnd() : null,
      onLongPressCancel: canRelease ? onCancel : null,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        height: 58,
        decoration: BoxDecoration(
          color: !visuallyEnabled
              ? Colors.grey.shade300
              : recording
                  ? Colors.red
                  : Theme.of(context).colorScheme.primary,
          borderRadius: BorderRadius.circular(18),
        ),
        alignment: Alignment.center,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              recording
                  ? Icons.mic
                  : uploading
                      ? Icons.upload
                      : processing
                          ? Icons.hourglass_top
                          : sendFailed
                              ? Icons.error_outline
                              : Icons.mic_none,
              color: visuallyEnabled ? Colors.white : Colors.black45,
            ),
            const SizedBox(width: 8),
            AppText(
              recording
                  ? '松开发送'
                  : uploading
                      ? '正在上传…'
                      : processing
                          ? '正在识别和翻译…'
                          : sendFailed
                              ? '请先处理未发送录音'
                              : enabled
                                  ? '按住说${language.label}'
                                  : '等待连接',
              style: TextStyle(
                color: visuallyEnabled ? Colors.white : Colors.black45,
                fontWeight: FontWeight.bold,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

final class _EmptyRoom extends StatelessWidget {
  const _EmptyRoom();
  @override
  Widget build(BuildContext context) => const Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.record_voice_over_outlined, size: 52),
              SizedBox(height: 12),
              AppText('按住底部按钮说话，松开后识别并翻译'),
              SizedBox(height: 6),
              AppText('第一版不支持双方同时讲话', style: TextStyle(color: Colors.black54)),
            ],
          ),
        ),
      );
}
