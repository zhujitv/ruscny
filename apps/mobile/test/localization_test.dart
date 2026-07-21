import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tooyei_translator/core/localization/app_localization.dart';

void main() {
  test('follows Chinese and Russian system locales with Chinese fallback', () {
    expect(
      AppLocalization.resolve(const Locale('ru', 'RU'), const []),
      const Locale('ru', 'RU'),
    );
    expect(
      AppLocalization.resolve(const Locale('zh', 'TW'), const []),
      const Locale('zh', 'CN'),
    );
    expect(
      AppLocalization.resolve(const Locale('en', 'US'), const []),
      const Locale('zh', 'CN'),
    );
  });

  test('language preference is parsed and exposes an override locale', () {
    expect(AppLanguageMode.parse(null), AppLanguageMode.system);
    expect(AppLanguageMode.parse('unknown'), AppLanguageMode.system);
    expect(AppLanguageMode.parse('zh').locale, const Locale('zh', 'CN'));
    expect(AppLanguageMode.parse('ru').locale, const Locale('ru', 'RU'));
  });

  test('translates representative interface and server error strings', () {
    const locale = Locale('ru', 'RU');
    expect(
      AppLocalization.translateForLocale('账号登录', locale),
      'Вход',
    );
    expect(
      AppLocalization.translateForLocale('无法连接服务器，请检查网络', locale),
      'Не удаётся подключиться к серверу. Проверьте сеть.',
    );
    expect(
      AppLocalization.translateForLocale('你好，Иван', locale),
      'Здравствуйте, Иван',
    );
    expect(
      AppLocalization.translateForLocale('好友申请', locale),
      'Заявки в друзья',
    );
    expect(
      AppLocalization.translateForLocale('会议纪要', locale),
      'Протокол встречи',
    );
    expect(
      AppLocalization.translateForLocale('会议纪要工作区', locale),
      'Рабочая область протокола',
    );
    expect(
      AppLocalization.translateForLocale(
        '会议内容已变化，需要重新生成',
        locale,
      ),
      'Содержание встречи изменилось. '
      'Протокол нужно создать заново.',
    );
    expect(
      AppLocalization.translateForLocale('本次会议参会信息', locale),
      'Данные участника этой встречи',
    );
    expect(
      AppLocalization.translateForLocale('请输入至少两个字符', locale),
      'Введите не менее двух символов',
    );
    expect(
      AppLocalization.translateForLocale('收到会议邀请：Переговоры', locale),
      'Новое приглашение: Переговоры',
    );
    expect(
      AppLocalization.translateForLocale('修改原文和译文', locale),
      'Изменить оригинал и перевод',
    );
    expect(
      AppLocalization.translateForLocale('语音服务鉴权失败，请重新拨打', locale),
      'Не удалось авторизовать голосовой сервис. Позвоните ещё раз',
    );
    expect(
      AppLocalization.translateForLocale('好友视频来电', locale),
      'Входящий видеозвонок от друга',
    );
    expect(
      AppLocalization.translateForLocale('呼叫 Иван', locale),
      'Позвонить: Иван',
    );
    expect(
      AppLocalization.translateForLocale('关摄像头', locale),
      'Выключить камеру',
    );
    expect(
      AppLocalization.translateForLocale('等待对方连接', locale),
      'Ожидание подключения собеседника',
    );
    expect(
      AppLocalization.translateForLocale(
        '摄像头不可用，已切换为仅接收对方视频',
        locale,
      ),
      'Камера недоступна. '
      'Вы будете только получать видео собеседника',
    );
    expect(
      AppLocalization.translateForLocale(
        '实时通话服务鉴权失败，请重新拨打',
        locale,
      ),
      'Не удалось авторизовать сервис звонков. Позвоните ещё раз',
    );
    expect(
      AppLocalization.translateForLocale('待确认纠错', locale),
      'Исправление ожидает подтверждения',
    );
    expect(
      AppLocalization.translateForLocale('加入专业术语库', locale),
      'Добавить в словарь терминов',
    );
  });
}
