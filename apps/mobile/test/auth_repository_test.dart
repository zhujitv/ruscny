import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tooyei_translator/core/api/api_client.dart';
import 'package:tooyei_translator/core/auth/auth_repository.dart';
import 'package:tooyei_translator/core/auth/secure_token_store.dart';
import 'package:tooyei_translator/core/models.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
  });

  test('guest authentication presents and rotates stable principal token',
      () async {
    final tokenStore = SecureTokenStore();
    await tokenStore.writeGuestPrincipalToken('existing-principal');
    Map<String, dynamic>? requestBody;
    final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test/v1'));
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          requestBody = (options.data as Map).cast<String, dynamic>();
          handler.resolve(
            Response<dynamic>(
              requestOptions: options,
              statusCode: 200,
              data: {
                'ok': true,
                'data': {
                  'accessToken': 'guest-access',
                  'guestPrincipalToken': 'rotated-principal',
                  'guestIdentityId': 'guest-1',
                  'conversationId': 'conversation-1',
                  'role': 'GUEST',
                  'displayName': 'Иван',
                  'company': 'ACME',
                  'email': 'ivan@example.test',
                  'preferredLanguage': 'ru',
                },
              },
            ),
          );
        },
      ),
    );
    final repository = AuthRepository(
      ApiClient(
        baseUrl: 'https://api.example.test/v1',
        tokenStore: tokenStore,
        dio: dio,
      ),
      tokenStore,
    );

    final session = await repository.createGuest(
      displayName: 'Иван',
      company: 'ACME',
      email: 'ivan@example.test',
      preferredLanguage: Language.ru,
      roomCode: '123456',
    );

    expect(requestBody?['guestPrincipalToken'], 'existing-principal');
    expect(requestBody?['email'], 'ivan@example.test');
    expect(await tokenStore.readGuestPrincipalToken(), 'rotated-principal');
    expect(await tokenStore.readGuestConversationId(), 'conversation-1');
    expect(await tokenStore.readAccessToken(), 'guest-access');
    expect(session.userId, 'guest-1');
    expect(session.preferredLanguage, Language.ru);
  });

  test('registered authentication clears only the stale guest meeting scope',
      () async {
    final tokenStore = SecureTokenStore();
    await tokenStore.writeGuestRefreshContext(
      principalToken: 'durable-principal',
      conversationId: 'old-conversation',
    );
    final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test/v1'));
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) => handler.resolve(
          Response<dynamic>(
            requestOptions: options,
            statusCode: 200,
            data: {
              'ok': true,
              'data': {
                'accessToken': 'user-access',
                'refreshToken': 'user-refresh',
                'user': {
                  'id': 'user-1',
                  'role': 'USER',
                  'displayName': 'Host',
                },
              },
            },
          ),
        ),
      ),
    );
    final repository = AuthRepository(
      ApiClient(
        baseUrl: 'https://api.example.test/v1',
        tokenStore: tokenStore,
        dio: dio,
      ),
      tokenStore,
    );

    final session = await repository.login(
      email: 'host@example.test',
      password: 'password1',
    );

    expect(session.role, UserRole.user);
    expect(await tokenStore.readGuestPrincipalToken(), 'durable-principal');
    expect(await tokenStore.readGuestConversationId(), isNull);
    expect(await tokenStore.readRefreshToken(), 'user-refresh');
  });

  test(
      'profile preferences and password changes use authenticated account APIs',
      () async {
    final tokenStore = SecureTokenStore();
    final requests = <MapEntry<String, Map<String, dynamic>>>[];
    final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test/v1'));
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          requests.add(MapEntry(
            options.path,
            (options.data as Map).cast<String, dynamic>(),
          ));
          handler.resolve(
            Response<dynamic>(
              requestOptions: options,
              statusCode: 200,
              data: {
                'ok': true,
                'data': options.path.endsWith('/auth/profile')
                    ? {
                        'id': 'user-1',
                        'role': 'USER',
                        'displayName': '王伟',
                        'avatarPreset': 'ocean',
                        'interfaceLanguage':
                            (options.data as Map)['interfaceLanguage'] ?? 'zh',
                        'autoPlayTranslationAudio':
                            (options.data as Map)['autoPlayTranslationAudio'] ??
                                true,
                        'translationPlaybackSpeed':
                            (options.data as Map)['translationPlaybackSpeed'] ??
                                1,
                      }
                    : <String, dynamic>{},
              },
            ),
          );
        },
      ),
    );
    final repository = AuthRepository(
      ApiClient(
        baseUrl: 'https://api.example.test/v1',
        tokenStore: tokenStore,
        dio: dio,
      ),
      tokenStore,
    );

    final session = await repository.updateProfile(
      displayName: '王伟',
      avatarPreset: 'ocean',
    );
    final preferences = await repository.updatePreferences(
      interfaceLanguage: 'ru',
      autoPlayTranslationAudio: false,
      translationPlaybackSpeed: 1.25,
    );
    await repository.changePassword(
      currentPassword: 'current-password',
      newPassword: 'different-password',
    );

    final profileRequests = requests
        .where((entry) => entry.key.endsWith('/auth/profile'))
        .map((entry) => entry.value)
        .toList();
    final passwordRequest = requests
        .singleWhere((entry) => entry.key.endsWith('/auth/password/change'))
        .value;
    expect(session.avatarPreset, 'ocean');
    expect(profileRequests.first['avatarPreset'], 'ocean');
    expect(profileRequests.last, {
      'interfaceLanguage': 'ru',
      'autoPlayTranslationAudio': false,
      'translationPlaybackSpeed': 1.25,
    });
    expect(preferences.interfaceLanguage, 'ru');
    expect(preferences.autoPlayTranslationAudio, isFalse);
    expect(preferences.translationPlaybackSpeed, 1.25);
    expect(passwordRequest, {
      'currentPassword': 'current-password',
      'newPassword': 'different-password',
    });
  });

  test(
      'registration waits for email verification and recovery uses public email APIs',
      () async {
    final tokenStore = SecureTokenStore();
    final requests = <String, Map<String, dynamic>>{};
    final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test/v1'));
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          requests[options.path] =
              (options.data as Map).cast<String, dynamic>();
          handler.resolve(
            Response<dynamic>(
              requestOptions: options,
              statusCode: 200,
              data: {
                'ok': true,
                'data': options.path.endsWith('/auth/register')
                    ? {
                        'verificationRequired': true,
                        'emailHint': 'al***@example.test',
                      }
                    : {'accepted': true},
              },
            ),
          );
        },
      ),
    );
    final repository = AuthRepository(
      ApiClient(
        baseUrl: 'https://api.example.test/v1',
        tokenStore: tokenStore,
        dio: dio,
      ),
      tokenStore,
    );

    final result = await repository.register(
      displayName: 'Alice',
      email: 'Alice@Example.Test',
      password: 'password-123',
    );
    await repository.resendVerification('Alice@Example.Test');
    await repository.forgotPassword('Alice@Example.Test');

    expect(result.verificationRequired, isTrue);
    expect(result.emailHint, 'al***@example.test');
    expect(
        requests.entries
            .singleWhere((entry) => entry.key.endsWith('/auth/register'))
            .value['email'],
        'alice@example.test');
    expect(
        requests.entries
            .singleWhere((entry) => entry.key.endsWith('/auth/email/resend'))
            .value,
        {'email': 'alice@example.test'});
    expect(
        requests.entries
            .singleWhere((entry) => entry.key.endsWith('/auth/password/forgot'))
            .value,
        {'email': 'alice@example.test'});
    expect(await tokenStore.readAccessToken(), isNull);
  });

  test('only explicit guest deletion clears the principal token', () async {
    final tokenStore = SecureTokenStore();
    await tokenStore.writeGuestPrincipalToken('principal-token');
    Object? requestBody;
    final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test/v1'));
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          requestBody = options.data;
          handler.resolve(
            Response<dynamic>(
              requestOptions: options,
              statusCode: 200,
              data: {'ok': true, 'data': <String, dynamic>{}},
            ),
          );
        },
      ),
    );
    final repository = AuthRepository(
      ApiClient(
        baseUrl: 'https://api.example.test/v1',
        tokenStore: tokenStore,
        dio: dio,
      ),
      tokenStore,
    );

    await repository.deleteAccount(password: 'secret-password');
    expect(requestBody, {'password': 'secret-password'});
    expect(await tokenStore.readGuestPrincipalToken(), 'principal-token');

    await repository.deleteAccount(clearGuestPrincipal: true);
    expect(await tokenStore.readGuestPrincipalToken(), isNull);
  });
}
