import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tooyei_translator/core/localization/app_localization.dart';
import 'package:tooyei_translator/features/auth/login_page.dart';

void main() {
  testWidgets('offers account and scoped guest entry', (tester) async {
    await tester.pumpWidget(
      const ProviderScope(
        child: MaterialApp(home: LoginPage()),
      ),
    );

    expect(find.text('中俄实时翻译'), findsOneWidget);
    expect(find.text('账号登录'), findsOneWidget);
    expect(find.text('访客加入'), findsOneWidget);

    await tester.tap(find.text('访客加入'));
    await tester.pumpAndSettle();

    expect(find.text('姓名或备注名 *'), findsOneWidget);
    expect(find.text('快速加入'), findsOneWidget);

    await tester.tap(find.text('账号登录'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('没有账号，立即注册'));
    await tester.pumpAndSettle();

    expect(find.text('注册并发送激活邮件'), findsOneWidget);
    expect(find.text('重新发送激活邮件'), findsOneWidget);
    expect(find.text('忘记密码？'), findsOneWidget);
    expect(find.text('账号类型'), findsNothing);
    expect(find.text('主持人'), findsNothing);
    expect(find.text('客户'), findsNothing);
  });

  testWidgets('renders the login flow in Russian', (tester) async {
    await tester.binding.setSurfaceSize(const Size(800, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(
      const ProviderScope(
        child: MaterialApp(
          locale: Locale('ru', 'RU'),
          supportedLocales: AppLocalization.supportedLocales,
          localizationsDelegates: [
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          home: LoginPage(),
        ),
      ),
    );

    expect(find.text('Китайско-русский перевод'), findsOneWidget);
    expect(find.text('Вход'), findsOneWidget);
    expect(find.text('Войти как гость'), findsOneWidget);

    await tester.tap(find.text('Войти как гость'));
    await tester.pumpAndSettle();

    expect(find.text('Имя или метка *'), findsOneWidget);
    await tester.drag(find.byType(ListView).last, const Offset(0, -300));
    await tester.pumpAndSettle();
    expect(find.text('Быстрый вход'), findsOneWidget);
  });

  testWidgets('rejects a malformed email before sending login', (tester) async {
    await tester.pumpWidget(
      const ProviderScope(
        child: MaterialApp(home: LoginPage()),
      ),
    );

    await tester.enterText(find.byType(TextField).at(0), 'user@example');
    await tester.enterText(find.byType(TextField).at(1), 'password123');
    await tester.tap(find.text('登录'));
    await tester.pump();

    expect(find.text('请输入有效邮箱和至少 8 位密码'), findsOneWidget);
  });
}
