import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/localization/app_localization.dart';
import '../core/providers.dart';
import '../features/auth/auth_controller.dart';
import '../features/auth/login_page.dart';
import '../features/conversations/home_page.dart';
import '../features/friends/incoming_call_coordinator.dart';
import '../features/settings/settings_controller.dart';
import '../shared/async_view.dart';
import 'theme.dart';

final class TranslatorApp extends ConsumerStatefulWidget {
  const TranslatorApp({super.key});

  @override
  ConsumerState<TranslatorApp> createState() => _TranslatorAppState();
}

final class _TranslatorAppState extends ConsumerState<TranslatorApp> {
  @override
  void initState() {
    super.initState();
    unawaited(
      ref.read(deepLinkServiceProvider).start((inviteToken) {
        ref.read(pendingInviteProvider.notifier).state = inviteToken;
      }),
    );
  }

  @override
  Widget build(BuildContext context) {
    final languageMode =
        ref.watch(settingsControllerProvider).valueOrNull?.languageMode ??
            AppLanguageMode.system;
    return MaterialApp(
      onGenerateTitle: (context) => '中俄翻译'.tr(context),
      debugShowCheckedModeBanner: false,
      theme: buildTheme(),
      locale: languageMode.locale,
      supportedLocales: AppLocalization.supportedLocales,
      localeResolutionCallback: AppLocalization.resolve,
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      home: const _AuthGate(),
    );
  }
}

final class _AuthGate extends ConsumerWidget {
  const _AuthGate();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authControllerProvider);
    return auth.when(
      loading: () => const Scaffold(body: LoadingView(label: '正在安全登录…')),
      error: (error, _) => LoginPage(initialError: error),
      data: (session) => session == null
          ? const LoginPage()
          : IncomingFriendCallCoordinator(
              session: session,
              child: HomePage(session: session),
            ),
    );
  }
}
