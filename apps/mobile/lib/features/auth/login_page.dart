import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/errors.dart';
import '../../core/localization/app_localization.dart';
import '../../core/models.dart';
import '../../core/providers.dart';
import '../../core/validation.dart';
import 'auth_controller.dart';

final class LoginPage extends ConsumerStatefulWidget {
  const LoginPage({super.key, this.initialError});

  final Object? initialError;

  @override
  ConsumerState<LoginPage> createState() => _LoginPageState();
}

final class _LoginPageState extends ConsumerState<LoginPage> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _name = TextEditingController();
  final _guestName = TextEditingController();
  final _guestCompany = TextEditingController();
  final _guestEmail = TextEditingController();
  final _roomCode = TextEditingController();
  bool _register = false;
  bool _accountBusy = false;
  bool _guestConsent = false;
  Language _guestLanguage = Language.ru;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _name.dispose();
    _guestName.dispose();
    _guestCompany.dispose();
    _guestEmail.dispose();
    _roomCode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final pendingInvite = ref.watch(pendingInviteProvider);
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        body: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 480),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Icon(Icons.translate_rounded, size: 58),
                    const SizedBox(height: 12),
                    AppText(
                      '中俄实时翻译',
                      textAlign: TextAlign.center,
                      style:
                          Theme.of(context).textTheme.headlineMedium?.copyWith(
                                fontWeight: FontWeight.bold,
                              ),
                    ),
                    const SizedBox(height: 6),
                    const AppText(
                      '中文 ⇄ Русский · 多人共享会议',
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 24),
                    if (widget.initialError != null)
                      _ErrorBanner(
                          message: readableError(widget.initialError!)),
                    const TabBar(
                      tabs: [
                        Tab(child: AppText('账号登录')),
                        Tab(child: AppText('访客加入')),
                      ],
                    ),
                    const SizedBox(height: 18),
                    SizedBox(
                      height: _register ? 450 : 390,
                      child: TabBarView(
                        children: [
                          _accountForm(),
                          _guestForm(pendingInvite),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _accountForm() => ListView(
        children: [
          if (_register) ...[
            TextField(
              controller: _name,
              textInputAction: TextInputAction.next,
              decoration: InputDecoration(labelText: '姓名或显示名称'.tr(context)),
            ),
            const SizedBox(height: 12),
          ],
          TextField(
            controller: _email,
            keyboardType: TextInputType.emailAddress,
            textInputAction: TextInputAction.next,
            decoration: InputDecoration(labelText: '邮箱'.tr(context)),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _password,
            obscureText: true,
            onSubmitted: (_) => _submitAccount(),
            decoration: InputDecoration(labelText: '密码'.tr(context)),
          ),
          Wrap(
            alignment: WrapAlignment.end,
            spacing: 4,
            children: [
              TextButton(
                onPressed: _accountBusy ? null : _resendVerification,
                child: const AppText('重新发送激活邮件'),
              ),
              TextButton(
                onPressed: _accountBusy ? null : _forgotPassword,
                child: const AppText('忘记密码？'),
              ),
            ],
          ),
          FilledButton(
            onPressed: _accountBusy ? null : _submitAccount,
            child: AppText(
              _accountBusy
                  ? '正在提交…'
                  : _register
                      ? '注册并发送激活邮件'
                      : '登录',
            ),
          ),
          TextButton(
            onPressed: () => setState(() => _register = !_register),
            child: AppText(_register ? '已有账号，直接登录' : '没有账号，立即注册'),
          ),
          const AppText(
            '登录即表示您同意用户协议和隐私政策。App 不保存密码，令牌存入系统安全存储。',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12, color: Colors.black54),
          ),
        ],
      );

  Widget _guestForm(String? pendingInvite) => ListView(
        children: [
          if (pendingInvite != null)
            const _InfoBanner(message: '已保留邀请，填写姓名后将继续加入该会议。'),
          TextField(
            controller: _guestName,
            textInputAction: TextInputAction.next,
            decoration: InputDecoration(labelText: '姓名或备注名 *'.tr(context)),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _guestCompany,
            textInputAction: TextInputAction.next,
            decoration: InputDecoration(labelText: '所属公司 *'.tr(context)),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _guestEmail,
            keyboardType: TextInputType.emailAddress,
            textInputAction: TextInputAction.next,
            decoration: InputDecoration(
              labelText: '接收会议纪要的邮箱 *'.tr(context),
            ),
          ),
          const SizedBox(height: 12),
          SegmentedButton<Language>(
            segments: const [
              ButtonSegment(value: Language.zh, label: AppText('中文')),
              ButtonSegment(value: Language.ru, label: AppText('Русский')),
            ],
            selected: {_guestLanguage},
            onSelectionChanged: (value) {
              setState(() => _guestLanguage = value.first);
            },
          ),
          if (pendingInvite == null) ...[
            const SizedBox(height: 12),
            TextField(
              controller: _roomCode,
              keyboardType: TextInputType.number,
              textCapitalization: TextCapitalization.characters,
              decoration: InputDecoration(labelText: '6 或 8 位房间码'.tr(context)),
            ),
          ],
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            value: _guestConsent,
            onChanged: (value) =>
                setState(() => _guestConsent = value ?? false),
            title: const AppText(
              '我已知悉本次交流会进行语音识别、翻译并保存文字记录。',
              style: TextStyle(fontSize: 13),
            ),
            controlAffinity: ListTileControlAffinity.leading,
          ),
          FilledButton.icon(
            onPressed: _guestConsent ? () => _submitGuest(pendingInvite) : null,
            icon: const Icon(Icons.meeting_room_outlined),
            label: const AppText('快速加入'),
          ),
          const SizedBox(height: 12),
          const AppText(
            '访客身份仅能访问当前会议，不能查看主持人的客户和其他历史记录。',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12, color: Colors.black54),
          ),
        ],
      );

  Future<void> _submitAccount() async {
    if (!isValidEmail(_email.text) || _password.text.length < 8) {
      _snack('请输入有效邮箱和至少 8 位密码');
      return;
    }
    setState(() => _accountBusy = true);
    try {
      final controller = ref.read(authControllerProvider.notifier);
      if (_register) {
        if (_name.text.trim().isEmpty) {
          _snack('请输入姓名');
          return;
        }
        await controller.register(
          displayName: _name.text,
          email: _email.text,
          password: _password.text,
        );
        if (!mounted) return;
        _password.clear();
        setState(() => _register = false);
        await showDialog<void>(
          context: context,
          builder: (context) => AlertDialog(
            title: const AppText('请查收激活邮件'),
            content: const AppText('激活邮件已发送。完成邮箱认证后即可登录。'),
            actions: [
              FilledButton(
                onPressed: () => Navigator.pop(context),
                child: const AppText('我知道了'),
              ),
            ],
          ),
        );
      } else {
        await controller.login(email: _email.text, password: _password.text);
      }
    } catch (error) {
      _snack(readableError(error));
    } finally {
      if (mounted) setState(() => _accountBusy = false);
    }
  }

  Future<void> _resendVerification() async {
    if (!isValidEmail(_email.text)) {
      _snack('请输入有效邮箱');
      return;
    }
    setState(() => _accountBusy = true);
    try {
      await ref.read(authRepositoryProvider).resendVerification(_email.text);
      _snack('如果账号尚未激活，新的激活邮件已经发送');
    } catch (error) {
      _snack(readableError(error));
    } finally {
      if (mounted) setState(() => _accountBusy = false);
    }
  }

  Future<void> _forgotPassword() async {
    if (!isValidEmail(_email.text)) {
      _snack('请输入有效邮箱');
      return;
    }
    setState(() => _accountBusy = true);
    try {
      await ref.read(authRepositoryProvider).forgotPassword(_email.text);
      _snack('如果账号可用，密码重置邮件已经发送');
    } catch (error) {
      _snack(readableError(error));
    } finally {
      if (mounted) setState(() => _accountBusy = false);
    }
  }

  Future<void> _submitGuest(String? inviteToken) async {
    if (_guestName.text.trim().isEmpty) {
      _snack('请输入姓名或备注名');
      return;
    }
    if (_guestCompany.text.trim().isEmpty) {
      _snack('请输入所属公司');
      return;
    }
    if (!_guestEmail.text.contains('@')) {
      _snack('请输入有效邮箱');
      return;
    }
    if (inviteToken == null &&
        !RegExp(r'^\d{6,8}$').hasMatch(_roomCode.text.trim())) {
      _snack('请输入有效房间码');
      return;
    }
    await ref.read(authControllerProvider.notifier).createGuest(
          displayName: _guestName.text,
          company: _guestCompany.text,
          email: _guestEmail.text,
          preferredLanguage: _guestLanguage,
          inviteToken: inviteToken,
          roomCode: inviteToken == null ? _roomCode.text.trim() : null,
        );
  }

  void _snack(String message) {
    if (mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: AppText(message)));
    }
  }
}

final class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.message});
  final String message;
  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.errorContainer,
          borderRadius: BorderRadius.circular(12),
        ),
        child: AppText(message),
      );
}

final class _InfoBanner extends StatelessWidget {
  const _InfoBanner({required this.message});
  final String message;
  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.secondaryContainer,
          borderRadius: BorderRadius.circular(12),
        ),
        child: AppText(message),
      );
}
