import 'dart:async';

import 'package:dio/dio.dart';

import '../auth/secure_token_store.dart';
import '../errors.dart';

final class ApiClient {
  ApiClient({
    required String baseUrl,
    required SecureTokenStore tokenStore,
    Dio? dio,
  })  : _tokenStore = tokenStore,
        _dio = dio ??
            Dio(
              BaseOptions(
                baseUrl: baseUrl,
                connectTimeout: const Duration(seconds: 15),
                receiveTimeout: const Duration(seconds: 45),
                sendTimeout: const Duration(seconds: 45),
                headers: const {'Accept': 'application/json'},
              ),
            ) {
    _dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: _authorize,
        onError: _recoverUnauthorized,
      ),
    );
  }

  final SecureTokenStore _tokenStore;
  final Dio _dio;
  Future<void>? _refreshInFlight;

  Dio get raw => _dio;

  /// Makes one authenticated request, rotating an expired token through the
  /// same guarded interceptor used by all REST calls.
  Future<void> ensureAuthenticated() async {
    await getMap('/auth/me');
  }

  Future<void> _authorize(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    final accessToken = await _tokenStore.readAccessToken();
    if (accessToken != null && accessToken.isNotEmpty) {
      options.headers['Authorization'] = 'Bearer $accessToken';
    }
    options.headers['X-Device-Id'] = await _tokenStore.deviceId();
    handler.next(options);
  }

  Future<void> _recoverUnauthorized(
    DioException error,
    ErrorInterceptorHandler handler,
  ) async {
    final options = error.requestOptions;
    final refreshToken = await _tokenStore.readRefreshToken();
    final guestPrincipal = await _tokenStore.readGuestPrincipalToken();
    final guestConversation = await _tokenStore.readGuestConversationId();
    final canRefresh = refreshToken?.isNotEmpty == true ||
        (guestPrincipal?.isNotEmpty == true &&
            guestConversation?.isNotEmpty == true);
    final shouldRefresh = error.response?.statusCode == 401 &&
        options.extra['authRetried'] != true &&
        !_isCredentialEndpoint(options.path) &&
        canRefresh;
    if (!shouldRefresh) {
      handler.next(_asAppDioException(error));
      return;
    }

    try {
      await _refreshOnce();
      options.extra['authRetried'] = true;
      options.headers['Authorization'] =
          'Bearer ${await _tokenStore.readAccessToken()}';
      handler.resolve(await _dio.fetch<dynamic>(options));
    } catch (_) {
      await _tokenStore.clearTokens();
      handler.next(_asAppDioException(error));
    }
  }

  Future<void> _refreshOnce() {
    final active = _refreshInFlight;
    if (active != null) return active;
    final refresh = _performRefresh();
    _refreshInFlight = refresh;
    return refresh.whenComplete(() => _refreshInFlight = null);
  }

  Future<void> _performRefresh() async {
    final refreshToken = await _tokenStore.readRefreshToken();
    // A separate client prevents the refresh request from entering this interceptor.
    final refreshDio = Dio(_dio.options);
    // Reuse an injected/platform adapter so renewal follows the same TLS,
    // proxy, and test transport configuration as normal API traffic.
    refreshDio.httpClientAdapter = _dio.httpClientAdapter;
    final deviceId = await _tokenStore.deviceId();
    final formal = refreshToken?.isNotEmpty == true;
    late final Response<dynamic> response;
    if (formal) {
      response = await refreshDio.post<dynamic>(
        '/auth/refresh',
        data: {'refreshToken': refreshToken, 'deviceId': deviceId},
      );
    } else {
      final principalToken = await _tokenStore.readGuestPrincipalToken();
      final conversationId = await _tokenStore.readGuestConversationId();
      if (principalToken?.isNotEmpty != true ||
          conversationId?.isNotEmpty != true) {
        throw const AppException(
          '登录已失效，请重新登录',
          code: 'NO_GUEST_REFRESH_CONTEXT',
        );
      }
      response = await refreshDio.post<dynamic>(
        '/auth/guest/refresh',
        data: {
          'guestPrincipalToken': principalToken,
          'conversationId': conversationId,
          'deviceId': deviceId,
        },
      );
    }
    final payload = unwrapMap(response.data);
    final access = payload['accessToken']?.toString();
    final rotatedRefresh = payload['refreshToken']?.toString();
    if (access == null || (formal && rotatedRefresh == null)) {
      throw const AppException('登录刷新响应无效', code: 'INVALID_REFRESH');
    }
    await _tokenStore.writeTokens(
      accessToken: access,
      refreshToken: formal ? rotatedRefresh! : '',
    );
  }

  static bool _isCredentialEndpoint(String path) =>
      path.endsWith('/auth/refresh') ||
      path.endsWith('/auth/guest/refresh') ||
      path.endsWith('/auth/login') ||
      path.endsWith('/auth/register') ||
      path.endsWith('/auth/guest') ||
      path.endsWith('/auth/email/resend') ||
      path.endsWith('/auth/email/verify') ||
      path.endsWith('/auth/password/forgot') ||
      path.endsWith('/auth/password/reset/email');

  Future<Map<String, dynamic>> getMap(
    String path, {
    Map<String, dynamic>? query,
  }) async {
    try {
      final response = await _dio.get<dynamic>(path, queryParameters: query);
      return unwrapMap(response.data);
    } on DioException catch (error) {
      throw _readError(error);
    }
  }

  Future<List<dynamic>> getList(
    String path, {
    Map<String, dynamic>? query,
  }) async {
    try {
      final response = await _dio.get<dynamic>(path, queryParameters: query);
      return unwrapList(response.data);
    } on DioException catch (error) {
      throw _readError(error);
    }
  }

  Future<Map<String, dynamic>> postMap(
    String path, {
    Object? data,
    Options? options,
    ProgressCallback? onSendProgress,
  }) async {
    try {
      final response = await _dio.post<dynamic>(
        path,
        data: data,
        options: options,
        onSendProgress: onSendProgress,
      );
      return unwrapMap(response.data);
    } on DioException catch (error) {
      throw _readError(error);
    }
  }

  Future<Map<String, dynamic>> patchMap(
    String path, {
    Object? data,
  }) async {
    try {
      final response = await _dio.patch<dynamic>(path, data: data);
      return unwrapMap(response.data);
    } on DioException catch (error) {
      throw _readError(error);
    }
  }

  Future<void> delete(String path, {Object? data}) async {
    try {
      final response = await _dio.delete<dynamic>(path, data: data);
      unwrap(response.data);
    } on DioException catch (error) {
      throw _readError(error);
    }
  }

  Future<Map<String, dynamic>> deleteMap(String path, {Object? data}) async {
    try {
      final response = await _dio.delete<dynamic>(path, data: data);
      return unwrapMap(response.data);
    } on DioException catch (error) {
      throw _readError(error);
    }
  }

  static dynamic unwrap(dynamic body) {
    if (body is Map) {
      final map = body.cast<String, dynamic>();
      if (map['ok'] == false) {
        throw AppException(
          (map['message'] ?? '请求失败').toString(),
          code: map['code']?.toString(),
        );
      }
      if (map.containsKey('data')) return map['data'];
    }
    return body;
  }

  static Map<String, dynamic> unwrapMap(dynamic body) {
    final value = unwrap(body);
    if (value is Map) return value.cast<String, dynamic>();
    throw const AppException('服务器返回格式无效', code: 'INVALID_RESPONSE');
  }

  static List<dynamic> unwrapList(dynamic body) {
    final value = unwrap(body);
    if (value is List) return value;
    if (value is Map && value['items'] is List) return value['items'] as List;
    throw const AppException('服务器返回格式无效', code: 'INVALID_RESPONSE');
  }

  DioException _asAppDioException(DioException original) => original;

  AppException _readError(DioException error) {
    final body = error.response?.data;
    if (body is Map) {
      final code = body['code']?.toString();
      return AppException(
        _validationMessage(body, code) ??
            (body['message'] ?? body['error'] ?? '请求失败').toString(),
        code: code,
        statusCode: error.response?.statusCode,
      );
    }
    if (error.type == DioExceptionType.connectionTimeout ||
        error.type == DioExceptionType.receiveTimeout ||
        error.type == DioExceptionType.sendTimeout) {
      return const AppException('网络超时，请稍后重试', code: 'NETWORK_TIMEOUT');
    }
    if (error.type == DioExceptionType.connectionError) {
      return const AppException('无法连接服务器，请检查网络', code: 'NETWORK_OFFLINE');
    }
    return AppException(
      error.message ?? '网络请求失败',
      statusCode: error.response?.statusCode,
    );
  }

  static String? _validationMessage(Map<dynamic, dynamic> body, String? code) {
    if (code != 'VALIDATION_ERROR') return null;
    final details = body['details'];
    if (details is! Map) return null;
    final fieldErrors = details['fieldErrors'];
    if (fieldErrors is! Map) return null;
    if (fieldErrors['email'] is List) return '请输入有效邮箱';
    if (fieldErrors['password'] is List) return '密码必须为 8–128 位';
    if (fieldErrors['deviceId'] is List || fieldErrors['platform'] is List) {
      return '设备信息无效，请重启 App 后重试';
    }
    return null;
  }
}
