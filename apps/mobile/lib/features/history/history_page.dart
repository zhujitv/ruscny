import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:share_plus/share_plus.dart';
import 'package:uuid/uuid.dart';

import '../../core/errors.dart';
import '../../core/localization/app_localization.dart';
import '../../core/models.dart';
import '../../core/providers.dart';
import '../../core/utils/transcript_exporter.dart';
import '../../shared/async_view.dart';
import '../auth/auth_controller.dart';
import '../room/room_page.dart';

final class HistoryPage extends ConsumerStatefulWidget {
  const HistoryPage({super.key, this.contactId});

  final String? contactId;

  @override
  ConsumerState<HistoryPage> createState() => _HistoryPageState();
}

final class _HistoryPageState extends ConsumerState<HistoryPage> {
  final _search = TextEditingController();
  DateTimeRange? _range;
  late Future<List<Conversation>> _future;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  void _load() {
    setState(() {
      _future = ref.read(conversationRepositoryProvider).list(
            contactId: widget.contactId,
            search: _search.text,
            from: _range?.start,
            to: _range?.end.add(const Duration(days: 1)),
          );
    });
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar:
            AppBar(title: AppText(widget.contactId == null ? '历史会议' : '客户历史')),
        body: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 10),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _search,
                      onSubmitted: (_) => _load(),
                      textInputAction: TextInputAction.search,
                      decoration: InputDecoration(
                        hintText: '搜索会议标题或客户'.tr(context),
                        prefixIcon: const Icon(Icons.search),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton.filledTonal(
                    tooltip: '日期筛选'.tr(context),
                    onPressed: _pickRange,
                    icon: Badge(
                      isLabelVisible: _range != null,
                      child: const Icon(Icons.date_range_outlined),
                    ),
                  ),
                  IconButton(onPressed: _load, icon: const Icon(Icons.refresh)),
                ],
              ),
            ),
            if (_range != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: InputChip(
                    label: AppText(
                      _dateRangeLabel(context, _range!),
                      translate: false,
                    ),
                    onDeleted: () {
                      setState(() => _range = null);
                      _load();
                    },
                  ),
                ),
              ),
            Expanded(
              child: FutureBuilder<List<Conversation>>(
                future: _future,
                builder: (context, snapshot) {
                  if (snapshot.connectionState != ConnectionState.done) {
                    return const LoadingView();
                  }
                  if (snapshot.hasError) {
                    return ErrorView(error: snapshot.error!, onRetry: _load);
                  }
                  final conversations = snapshot.data ?? const [];
                  if (conversations.isEmpty) {
                    return const Center(child: AppText('没有符合条件的历史会议'));
                  }
                  return RefreshIndicator(
                    onRefresh: () async => _load(),
                    child: ListView.separated(
                      padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                      itemCount: conversations.length,
                      separatorBuilder: (_, __) => const SizedBox(height: 8),
                      itemBuilder: (context, index) {
                        final conversation = conversations[index];
                        return Card(
                          child: ListTile(
                            title: AppText(
                              conversation.title ?? '未命名会议',
                              translate: conversation.title == null,
                            ),
                            subtitle: AppText(
                              _conversationSubtitle(context, conversation),
                              translate: false,
                            ),
                            isThreeLine: true,
                            trailing: const Icon(Icons.chevron_right),
                            onTap: () => Navigator.push<void>(
                              context,
                              MaterialPageRoute<void>(
                                builder: (_) => ConversationDetailPage(
                                  conversationId: conversation.id,
                                ),
                              ),
                            ).then((_) => _load()),
                          ),
                        );
                      },
                    ),
                  );
                },
              ),
            ),
          ],
        ),
      );

  Future<void> _pickRange() async {
    final range = await showDateRangePicker(
      context: context,
      firstDate: DateTime(2020),
      lastDate: DateTime.now().add(const Duration(days: 1)),
      initialDateRange: _range,
    );
    if (range != null) {
      setState(() => _range = range);
      _load();
    }
  }

  static String _dateRangeLabel(BuildContext context, DateTimeRange range) {
    final separator =
        Localizations.localeOf(context).languageCode == 'ru' ? ' — ' : ' 至 ';
    return '${DateFormat('yyyy-MM-dd').format(range.start)}$separator'
        '${DateFormat('yyyy-MM-dd').format(range.end)}';
  }

  static String _conversationSubtitle(
    BuildContext context,
    Conversation conversation,
  ) {
    final contact = conversation.contactName ?? '客户'.tr(context);
    final started = DateFormat('yyyy-MM-dd HH:mm').format(
      conversation.startedAt ?? conversation.createdAt,
    );
    final duration = _duration(conversation);
    final status = _status(conversation.status).tr(context);
    if (Localizations.localeOf(context).languageCode == 'ru') {
      final durationLabel =
          duration == '—' ? duration : '${duration.split(' ').first} мин';
      return '$contact · $started\n'
          '${conversation.messageCount} сообщ. · $durationLabel · $status';
    }
    return '$contact · $started\n'
        '${conversation.messageCount} 条消息 · $duration · $status';
  }

  static String _duration(Conversation conversation) {
    final start = conversation.startedAt;
    final end = conversation.endedAt;
    if (start == null || end == null) return '—';
    final minutes = end.difference(start).inMinutes;
    return '$minutes 分钟';
  }

  static String _status(ConversationStatus status) => switch (status) {
        ConversationStatus.waiting => '等待中',
        ConversationStatus.active => '进行中',
        ConversationStatus.ended => '已结束',
        ConversationStatus.expired => '已过期',
      };
}

final class ConversationDetailPage extends ConsumerStatefulWidget {
  const ConversationDetailPage({required this.conversationId, super.key});

  final String conversationId;

  @override
  ConsumerState<ConversationDetailPage> createState() =>
      _ConversationDetailPageState();
}

final class _ConversationDetailPageState
    extends ConsumerState<ConversationDetailPage> {
  late Future<(Conversation, List<TranslationMessage>)> _future;

  @override
  void initState() {
    super.initState();
    _load();
  }

  void _load() {
    setState(() {
      _future = _fetch();
    });
  }

  Future<(Conversation, List<TranslationMessage>)> _fetch() async {
    final repository = ref.read(conversationRepositoryProvider);
    final database = ref.read(localDatabaseProvider);
    final conversation = await repository.get(widget.conversationId);
    final messages = await repository.allMessages(widget.conversationId);
    try {
      await database.cacheConversation(conversation);
      await database.upsertMessages(messages);
    } catch (_) {
      // History came from the authorized server response. A local cache issue
      // must not hide records that are already safe to display.
    }
    return (conversation, messages);
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(authControllerProvider).valueOrNull;
    return FutureBuilder<(Conversation, List<TranslationMessage>)>(
      future: _future,
      builder: (context, snapshot) {
        final data = snapshot.data;
        final isOwner = data != null && data.$1.ownerId == session?.userId;
        return Scaffold(
          appBar: AppBar(
            title: AppText(
              data?.$1.title ?? '会议详情',
              translate: data?.$1.title == null,
            ),
            actions: data == null
                ? null
                : [
                    PopupMenuButton<String>(
                      onSelected: (value) => _action(value, data.$1, data.$2),
                      itemBuilder: (_) => [
                        const PopupMenuItem(
                            value: 'copy', child: AppText('复制全部')),
                        const PopupMenuItem(
                          value: 'txt',
                          child: AppText('导出 TXT'),
                        ),
                        const PopupMenuItem(
                          value: 'md',
                          child: AppText('导出 Markdown'),
                        ),
                        const PopupMenuDivider(),
                        const PopupMenuItem(
                          value: 'copy-speaker',
                          child: AppText('按发言者复制'),
                        ),
                        const PopupMenuItem(
                          value: 'txt-speaker',
                          child: AppText('按发言者导出 TXT'),
                        ),
                        const PopupMenuItem(
                          value: 'md-speaker',
                          child: AppText('按发言者导出 Markdown'),
                        ),
                        const PopupMenuDivider(),
                        const PopupMenuItem(
                          value: 'summary',
                          child: AppText('查看会议纪要'),
                        ),
                        if (isOwner &&
                            data.$1.status == ConversationStatus.ended)
                          const PopupMenuItem(
                            value: 'summary-generate',
                            child: AppText('生成或更新会议纪要'),
                          ),
                        if (isOwner &&
                            data.$1.status == ConversationStatus.ended)
                          const PopupMenuItem(
                            value: 'summary-email',
                            child: AppText('邮件分发会议纪要'),
                          ),
                        if (isOwner)
                          const PopupMenuItem(
                            value: 'rename',
                            child: AppText('修改标题'),
                          ),
                        if (isOwner)
                          const PopupMenuItem(
                            value: 'delete',
                            child: AppText('删除会议'),
                          ),
                      ],
                    ),
                  ],
          ),
          body: snapshot.connectionState != ConnectionState.done
              ? const LoadingView()
              : snapshot.hasError
                  ? ErrorView(error: snapshot.error!, onRetry: _load)
                  : _timeline(data!.$1, data.$2),
        );
      },
    );
  }

  Widget _timeline(
    Conversation conversation,
    List<TranslationMessage> messages,
  ) =>
      ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  AppText(
                    conversation.contactName ?? '客户',
                    translate: conversation.contactName == null,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  if (conversation.company != null)
                    AppText(conversation.company!, translate: false),
                  const SizedBox(height: 8),
                  AppText(
                    '会议 ID：${conversation.id}',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                  AppText(
                    '会后权限：${conversation.guestHistoryPolicy.label}',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
          ),
          if (conversation.status == ConversationStatus.waiting ||
              conversation.status == ConversationStatus.active) ...[
            const SizedBox(height: 10),
            FilledButton.icon(
              onPressed: () => Navigator.push<void>(
                context,
                MaterialPageRoute<void>(
                  builder: (_) => RoomPage(conversationId: conversation.id),
                ),
              ).then((_) => _load()),
              icon: const Icon(Icons.forum_outlined),
              label: AppText(
                conversation.status == ConversationStatus.waiting
                    ? '进入房间等待客户'
                    : '返回进行中的会议',
              ),
            ),
          ],
          const SizedBox(height: 10),
          if (messages.isEmpty)
            const Padding(
              padding: EdgeInsets.all(32),
              child: Center(child: AppText('本次会议没有最终翻译记录')),
            )
          else
            for (final message in messages) _HistoryMessage(message: message),
        ],
      );

  Future<void> _action(
    String action,
    Conversation conversation,
    List<TranslationMessage> messages,
  ) async {
    final groupBySpeaker = action.endsWith('-speaker');
    final baseAction = action.replaceFirst('-speaker', '');
    switch (baseAction) {
      case 'copy':
        await Clipboard.setData(
          ClipboardData(
            text: TranscriptExporter.text(
              conversation,
              messages,
              locale: Localizations.localeOf(context),
              groupBySpeaker: groupBySpeaker,
            ),
          ),
        );
        _snack('已复制完整记录');
      case 'txt':
        final txtFile = await TranscriptExporter.temporaryFile(
          conversation,
          messages,
          markdownFormat: false,
          locale: Localizations.localeOf(context),
          groupBySpeaker: groupBySpeaker,
        );
        try {
          await SharePlus.instance.share(
            ShareParams(
              files: [txtFile],
              subject: conversation.title ?? '翻译记录',
              sharePositionOrigin: _shareOrigin(),
            ),
          );
        } finally {
          await TranscriptExporter.deleteTemporaryFile(txtFile);
        }
      case 'md':
        final markdownFile = await TranscriptExporter.temporaryFile(
          conversation,
          messages,
          markdownFormat: true,
          locale: Localizations.localeOf(context),
          groupBySpeaker: groupBySpeaker,
        );
        try {
          await SharePlus.instance.share(
            ShareParams(
              files: [markdownFile],
              subject: conversation.title ?? '翻译记录',
              sharePositionOrigin: _shareOrigin(),
            ),
          );
        } finally {
          await TranscriptExporter.deleteTemporaryFile(markdownFile);
        }
      case 'rename':
        await _rename(conversation);
      case 'delete':
        await _delete(conversation);
      case 'summary':
        await _showSummary(conversation);
      case 'summary-generate':
        await _showSummary(conversation, regenerate: true);
      case 'summary-email':
        await _emailSummary(conversation);
    }
  }

  Future<void> _emailSummary(Conversation conversation) async {
    try {
      final repository = ref.read(conversationRepositoryProvider);
      final recipients =
          await repository.summaryEmailRecipients(conversation.id);
      if (!mounted) return;
      if (recipients.isStale) {
        _snack('会议内容已变化，请重新生成会议纪要后再发送');
        return;
      }
      if (!recipients.isApproved) {
        _snack('请先查看并确认当前会议纪要，再进行邮件分发');
        return;
      }
      final selected = recipients.items
          .where((item) => item.eligible)
          .map((item) => item.participantId)
          .toSet();
      if (selected.isEmpty) {
        _snack('没有可发送会议纪要的参会者');
        return;
      }
      final confirmed = await showDialog<Set<String>>(
        context: context,
        builder: (context) => StatefulBuilder(
          builder: (context, setDialogState) => AlertDialog(
            title: const AppText('邮件分发会议纪要'),
            content: SizedBox(
              width: 560,
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const AppText('请选择收件人。邮件将逐人发送，不会向其他参会者公开邮箱。'),
                    const SizedBox(height: 12),
                    for (final recipient in recipients.items)
                      CheckboxListTile(
                        contentPadding: EdgeInsets.zero,
                        value: selected.contains(recipient.participantId),
                        onChanged: recipient.eligible
                            ? (value) => setDialogState(() {
                                  if (value == true) {
                                    selected.add(recipient.participantId);
                                  } else {
                                    selected.remove(recipient.participantId);
                                  }
                                })
                            : null,
                        title: AppText(
                          [recipient.displayName, recipient.company]
                              .whereType<String>()
                              .where((value) => value.isNotEmpty)
                              .join('｜'),
                          translate: false,
                        ),
                        subtitle: AppText(
                          recipient.emailHint ??
                              _summaryEmailReason(recipient.reason),
                          translate: recipient.emailHint == null,
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
              FilledButton.icon(
                onPressed: selected.isEmpty
                    ? null
                    : () => Navigator.pop(context, Set<String>.from(selected)),
                icon: const Icon(Icons.send_outlined),
                label: AppText('发送给 ${selected.length} 人'),
              ),
            ],
          ),
        ),
      );
      if (confirmed == null || confirmed.isEmpty || !mounted) return;
      final distribution = await repository.distributeSummaryEmail(
        conversationId: conversation.id,
        participantIds: confirmed.toList(growable: false),
        idempotencyKey: const Uuid().v4(),
      );
      if (!mounted) return;
      if (distribution.status == 'PROCESSING') {
        _snack('邮件仍在后台发送，请稍后重新查看');
        return;
      }
      await showDialog<void>(
        context: context,
        builder: (context) => AlertDialog(
          title: const AppText('会议纪要发送结果'),
          content: SizedBox(
            width: 520,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  AppText(
                    '成功 ${distribution.sentCount} 人，失败 ${distribution.failedCount} 人',
                  ),
                  const SizedBox(height: 12),
                  for (final recipient in distribution.recipients)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: Icon(
                        recipient.status == 'SENT'
                            ? Icons.check_circle_outline
                            : Icons.error_outline,
                        color: recipient.status == 'SENT'
                            ? Colors.green
                            : Theme.of(context).colorScheme.error,
                      ),
                      title: AppText(recipient.displayName, translate: false),
                      subtitle: AppText(
                        recipient.status == 'SENT'
                            ? (recipient.emailHint ?? '发送成功')
                            : (recipient.errorMessage ?? '发送失败'),
                        translate: recipient.emailHint == null ||
                            recipient.status != 'SENT',
                      ),
                    ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const AppText('关闭'),
            ),
          ],
        ),
      );
    } catch (error) {
      _snack(readableError(error));
    }
  }

  String _summaryEmailReason(String? reason) => switch (reason) {
        'PARTICIPANT_REMOVED' => '参会者已被移出，不能发送',
        'HISTORY_ACCESS_EXPIRED' => '会议历史访问权限已过期',
        'GUEST_ACCESS_REVOKED' => '访客访问权限已撤销',
        'ACCOUNT_UNAVAILABLE' => '账号已停用或删除',
        _ => '缺少可用邮箱',
      };

  Future<void> _showSummary(
    Conversation conversation, {
    bool regenerate = false,
  }) async {
    final isOwner = ref.read(authControllerProvider).valueOrNull?.userId ==
        conversation.ownerId;
    if (regenerate) {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const AppText('生成或更新会议纪要？'),
          content: const AppText('如果已有纪要，将按当前最终消息重建，原有人工填写内容会被替换。'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const AppText('取消'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const AppText('确认生成'),
            ),
          ],
        ),
      );
      if (confirmed != true || !mounted) return;
    }
    try {
      final repository = ref.read(conversationRepositoryProvider);
      final summary = regenerate
          ? await repository.generateSummary(conversation.id)
          : await repository.summary(conversation.id);
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (context) => AlertDialog(
          title: const AppText('会议纪要'),
          content: SizedBox(
            width: 620,
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (summary.isStale == true) ...[
                    const AppText(
                      '会议纪要可能已过期，请由主持人重新生成',
                      style: TextStyle(
                        color: Colors.orange,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 12),
                  ] else if (summary.isStale == null) ...[
                    const AppText(
                      '旧版会议纪要无法验证来源版本，建议重新生成',
                      style: TextStyle(color: Colors.orange),
                    ),
                    const SizedBox(height: 12),
                  ] else if (!summary.isApproved) ...[
                    const AppText(
                      'AI 生成内容尚未由主持人确认，暂不能邮件分发',
                      style: TextStyle(
                        color: Colors.orange,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 12),
                  ],
                  const AppText(
                    '参会人员',
                    style: TextStyle(fontWeight: FontWeight.bold),
                  ),
                  for (final participant in summary.participants)
                    AppText(
                      '• ${participant.displayName}｜${participant.company ?? '-'}｜${participant.preferredLanguage.label}',
                      translate: false,
                    ),
                  const SizedBox(height: 12),
                  const AppText(
                    '核心讨论内容',
                    style: TextStyle(fontWeight: FontWeight.bold),
                  ),
                  AppText(summary.summary, translate: false),
                  for (final item in summary.coreDiscussion)
                    AppText(
                      '• ${item['speakerDisplayName'] ?? '参会者'}：'
                      '${item['sourceText'] ?? ''}\n  ${item['translatedText'] ?? ''}',
                      translate: false,
                    ),
                  _SummaryList(title: '各方观点', values: summary.partyViews),
                  _SummaryList(title: '已确认事项', values: summary.confirmedItems),
                  _SummaryList(title: '待办事项及负责人', values: summary.actionItems),
                  _SummaryList(title: '尚未解决的问题', values: summary.openQuestions),
                ],
              ),
            ),
          ),
          actions: [
            if (isOwner &&
                conversation.status == ConversationStatus.ended &&
                summary.isStale == false &&
                !summary.isApproved)
              FilledButton(
                onPressed: () async {
                  Navigator.pop(context);
                  try {
                    await repository.approveSummary(
                      conversation.id,
                      summary.revision,
                    );
                    if (mounted) _snack('会议纪要已确认，可以邮件分发');
                  } catch (error) {
                    if (mounted) _snack(readableError(error));
                  }
                },
                child: const AppText('确认内容无误'),
              ),
            if (isOwner &&
                conversation.status == ConversationStatus.ended &&
                !regenerate)
              TextButton(
                onPressed: () {
                  Navigator.pop(context);
                  unawaited(_showSummary(conversation, regenerate: true));
                },
                child: const AppText('生成或更新会议纪要'),
              ),
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const AppText('关闭'),
            ),
          ],
        ),
      );
    } catch (error) {
      _snack(readableError(error));
    }
  }

  Rect _shareOrigin() {
    final size = MediaQuery.sizeOf(context);
    return Rect.fromLTWH(size.width / 2, size.height / 2, 1, 1);
  }

  Future<void> _rename(Conversation conversation) async {
    final controller = TextEditingController(text: conversation.title);
    final title = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const AppText('修改会议标题'),
        content: TextField(controller: controller, autofocus: true),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const AppText('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, controller.text),
            child: const AppText('保存'),
          ),
        ],
      ),
    );
    controller.dispose();
    if (title?.trim().isNotEmpty == true) {
      try {
        await ref
            .read(conversationRepositoryProvider)
            .updateTitle(conversation.id, title!);
        _load();
      } catch (error) {
        _snack(readableError(error));
      }
    }
  }

  Future<void> _delete(Conversation conversation) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const AppText('删除会议记录？'),
        content: const AppText('此操作会请求服务端删除本次会议及其翻译记录，无法撤销。'),
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
      await ref.read(conversationRepositoryProvider).delete(conversation.id);
      try {
        await ref
            .read(localDatabaseProvider)
            .deleteConversation(conversation.id);
      } catch (_) {
        // The server deletion succeeded; a stale local row is not authoritative
        // and will be cleared on logout or replaced by the next server list.
      }
      if (mounted) Navigator.pop(context);
    } catch (error) {
      _snack(readableError(error));
    }
  }

  void _snack(String value) {
    if (mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: AppText(value)));
    }
  }
}

final class _SummaryList extends StatelessWidget {
  const _SummaryList({required this.title, required this.values});

  final String title;
  final List<dynamic> values;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            AppText(title, style: const TextStyle(fontWeight: FontWeight.bold)),
            if (values.isEmpty)
              const AppText('—', translate: false)
            else
              for (final value in values)
                AppText('• ${_label(value)}', translate: false),
          ],
        ),
      );

  static String _label(dynamic value) {
    if (value is Map) {
      return value.entries
          .map((item) => '${item.key}: ${item.value}')
          .join('｜');
    }
    return value.toString();
  }
}

final class _HistoryMessage extends ConsumerWidget {
  const _HistoryMessage({required this.message});
  final TranslationMessage message;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final separator =
        Localizations.localeOf(context).languageCode == 'ru' ? ': ' : '：';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: AppText(
                    '${message.displayName ?? '参会者'.tr(context)}'
                    '${message.company?.isNotEmpty == true ? ' · ${message.company}' : ''}'
                    ' · ${(message.speakerLanguage ?? message.sourceLanguage).label.tr(context)} · '
                    '${DateFormat('HH:mm:ss').format(message.createdAt)}',
                    translate: false,
                    style: Theme.of(context).textTheme.labelMedium,
                  ),
                ),
                if (message.audioUrl?.isNotEmpty == true)
                  IconButton(
                    tooltip: '重播'.tr(context),
                    onPressed: () =>
                        _playAudio(context, ref, message.audioUrl!),
                    icon: const Icon(Icons.volume_up_outlined),
                  ),
                if (message.status == MessageStatus.finalResult)
                  IconButton(
                    tooltip: '复制'.tr(context),
                    onPressed: () => unawaited(
                      Clipboard.setData(
                        ClipboardData(
                          text:
                              '${message.sourceText}\n${message.translatedText}',
                        ),
                      ),
                    ),
                    icon: const Icon(Icons.copy_outlined),
                  ),
              ],
            ),
            if (message.reviewStatus != MessageReviewStatus.unreviewed) ...[
              const SizedBox(height: 4),
              AppText(
                switch (message.reviewStatus) {
                  MessageReviewStatus.pending => '待确认纠错',
                  MessageReviewStatus.confirmed => '已人工确认',
                  MessageReviewStatus.rejected => '纠错已拒绝',
                  MessageReviewStatus.unreviewed => '未复核',
                },
                style: TextStyle(
                  color: message.reviewStatus == MessageReviewStatus.confirmed
                      ? Colors.green
                      : message.reviewStatus == MessageReviewStatus.pending
                          ? Colors.orange
                          : Colors.grey,
                  fontWeight: FontWeight.w600,
                  fontSize: 12,
                ),
              ),
            ],
            if (message.status == MessageStatus.processing)
              const AppText('该消息仍在处理中')
            else if (message.status == MessageStatus.failed)
              AppText(
                message.errorMessage ?? message.errorCode ?? '翻译失败',
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              )
            else ...[
              AppText(
                '${message.sourceLanguage.label.tr(context)}$separator${message.sourceText}',
                translate: false,
              ),
              const SizedBox(height: 7),
              AppText(
                '${message.targetLanguage.label.tr(context)}$separator${message.translatedText}',
                translate: false,
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
              if (message.reviewStatus == MessageReviewStatus.pending &&
                  message.pendingSourceText != null &&
                  message.pendingTranslatedText != null) ...[
                const SizedBox(height: 8),
                const AppText(
                  '待确认纠错',
                  style: TextStyle(fontWeight: FontWeight.w600),
                ),
                AppText(message.pendingSourceText!, translate: false),
                AppText(
                  message.pendingTranslatedText!,
                  translate: false,
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
              ],
              if (message.errorMessage?.isNotEmpty == true) ...[
                const SizedBox(height: 6),
                AppText(
                  message.errorMessage!,
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.error,
                    fontSize: 12,
                  ),
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }

  static Future<void> _playAudio(
    BuildContext context,
    WidgetRef ref,
    String url,
  ) async {
    try {
      await ref.read(audioPlaybackProvider).playNow(url);
    } catch (error) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: AppText('语音播放失败：${readableError(error)}')),
        );
      }
    }
  }
}
