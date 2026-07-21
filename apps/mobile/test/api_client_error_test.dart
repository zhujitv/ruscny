import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tooyei_translator/core/api/api_client.dart';
import 'package:tooyei_translator/core/auth/secure_token_store.dart';
import 'package:tooyei_translator/core/errors.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  test('turns backend email validation details into a clear message', () async {
    final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test/v1'));
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) => handler.reject(
          DioException.badResponse(
            statusCode: 400,
            requestOptions: options,
            response: Response<dynamic>(
              requestOptions: options,
              statusCode: 400,
              data: {
                'ok': false,
                'code': 'VALIDATION_ERROR',
                'message': '请求参数不正确',
                'details': {
                  'fieldErrors': {
                    'email': ['Invalid email'],
                  },
                },
              },
            ),
          ),
        ),
      ),
    );
    final client = ApiClient(
      baseUrl: 'https://api.example.test/v1',
      tokenStore: SecureTokenStore(),
      dio: dio,
    );

    await expectLater(
      client.postMap('/auth/login', data: const {}),
      throwsA(
        isA<AppException>()
            .having((error) => error.message, 'message', '请输入有效邮箱')
            .having((error) => error.code, 'code', 'VALIDATION_ERROR'),
      ),
    );
  });
}
