import 'dart:io';

import '../api/api_client.dart';
import '../errors.dart';
import '../models.dart';
import 'secure_token_store.dart';

final class AuthRepository {
  const AuthRepository(this._api, this._tokens);

  final ApiClient _api;
  final SecureTokenStore _tokens;

  Future<AuthSession?> restore() async {
    if (await _tokens.readAccessToken() == null &&
        await _tokens.readRefreshToken() == null) {
      return null;
    }
    try {
      return AuthSession.fromJson(await _api.getMap('/auth/me'));
    } catch (error) {
      // Do not destroy a valid rotating refresh credential merely because the
      // device started offline. Only an authoritative auth rejection signs
      // the local session out.
      if (error is AppException && error.statusCode == 401) {
        await _tokens.clearTokens();
        return null;
      }
      rethrow;
    }
  }

  Future<AuthSession> login({
    required String email,
    required String password,
  }) =>
      _authenticate('/auth/login', {
        'email': email.trim(),
        'password': password,
        'deviceId': _tokens.deviceId(),
        'platform': _devicePlatform,
      });

  Future<RegistrationResult> register({
    required String displayName,
    required String email,
    required String password,
  }) async {
    final payload = await _api.postMap('/auth/register', data: {
      'displayName': displayName.trim(),
      'email': email.trim().toLowerCase(),
      'password': password,
      'deviceId': await _tokens.deviceId(),
      'platform': _devicePlatform,
    });
    if (payload['verificationRequired'] != true) {
      throw const FormatException('Missing email verification requirement');
    }
    return RegistrationResult(
      verificationRequired: true,
      emailHint: payload['emailHint']?.toString(),
    );
  }

  Future<void> resendVerification(String email) async {
    await _api.postMap(
      '/auth/email/resend',
      data: {'email': email.trim().toLowerCase()},
    );
  }

  Future<void> forgotPassword(String email) async {
    await _api.postMap(
      '/auth/password/forgot',
      data: {'email': email.trim().toLowerCase()},
    );
  }

  Future<AuthSession> createGuest({
    required String displayName,
    required String company,
    required String email,
    required Language preferredLanguage,
    String? inviteToken,
    String? roomCode,
  }) async {
    final principalToken = await _tokens.readGuestPrincipalToken();
    return _authenticate('/auth/guest', {
      'displayName': displayName.trim(),
      'company': company.trim(),
      'email': email.trim().toLowerCase(),
      'preferredLanguage': preferredLanguage.code,
      if (principalToken?.isNotEmpty == true)
        'guestPrincipalToken': principalToken,
      if (inviteToken?.isNotEmpty == true) 'inviteToken': inviteToken,
      if (roomCode?.isNotEmpty == true) 'roomCode': roomCode,
      'deviceId': _tokens.deviceId(),
    });
  }

  Future<AuthSession> _authenticate(
    String path,
    Map<String, dynamic> body,
  ) async {
    // Resolve Future-valued deviceId without ever logging request data.
    final deviceId = body['deviceId'];
    if (deviceId is Future<String>) body['deviceId'] = await deviceId;
    final payload = await _api.postMap(path, data: body);
    final accessToken = payload['accessToken']?.toString();
    final refreshToken = payload['refreshToken']?.toString();
    final nestedUser = payload['user'];
    final role =
        (payload['role'] ?? (nestedUser is Map ? nestedUser['role'] : null))
            ?.toString()
            .toUpperCase();
    if (accessToken == null) {
      throw const FormatException('Missing access token');
    }
    final guestPrincipalToken = payload['guestPrincipalToken']?.toString();
    final conversationId = payload['conversationId']?.toString();
    if (role == 'GUEST' &&
        (guestPrincipalToken?.isNotEmpty != true ||
            conversationId?.isNotEmpty != true)) {
      throw const FormatException('Missing guest renewal context');
    }
    // A scoped guest may not receive a refresh token.
    await _tokens.writeTokens(
      accessToken: accessToken,
      refreshToken: refreshToken ?? '',
    );
    if (role == 'GUEST') {
      await _tokens.writeGuestRefreshContext(
        principalToken: guestPrincipalToken!,
        conversationId: conversationId!,
      );
    } else {
      // Keep the durable principal capability for a future Guest join, but a
      // registered session must never inherit automatic renewal for a stale
      // meeting scope.
      await _tokens.clearGuestSessionScope();
    }
    return AuthSession.fromJson(payload);
  }

  Future<AuthSession> updateProfile({
    required String displayName,
    String? phone,
    String? company,
    Language? preferredLanguage,
    String? avatarPreset,
  }) async {
    final payload = await _api.patchMap(
      '/auth/profile',
      data: {
        'displayName': displayName.trim(),
        'phone': phone?.trim().isEmpty == true ? null : phone?.trim(),
        if (company != null)
          'company': company.trim().isEmpty ? null : company.trim(),
        if (preferredLanguage != null)
          'preferredLanguage': preferredLanguage.code,
        if (avatarPreset != null) 'avatarPreset': avatarPreset,
      },
    );
    return AuthSession.fromJson(payload);
  }

  Future<AuthSession> updatePreferences({
    required String interfaceLanguage,
    required bool autoPlayTranslationAudio,
    required double translationPlaybackSpeed,
  }) async {
    final payload = await _api.patchMap(
      '/auth/profile',
      data: {
        'interfaceLanguage': interfaceLanguage,
        'autoPlayTranslationAudio': autoPlayTranslationAudio,
        'translationPlaybackSpeed': translationPlaybackSpeed,
      },
    );
    return AuthSession.fromJson(payload);
  }

  Future<void> changePassword({
    required String currentPassword,
    required String newPassword,
  }) async {
    await _api.postMap(
      '/auth/password/change',
      data: {
        'currentPassword': currentPassword,
        'newPassword': newPassword,
      },
    );
  }

  Future<List<LoginDevice>> devices() async {
    final rows = await _api.getList('/auth/devices');
    return rows
        .whereType<Map>()
        .map((row) => LoginDevice.fromJson(row.cast<String, dynamic>()))
        .toList(growable: false);
  }

  Future<void> revokeDevice(String deviceId) =>
      _api.delete('/auth/devices/${Uri.encodeComponent(deviceId)}');

  Future<void> logout() async {
    try {
      await _api.postMap(
        '/auth/logout',
        data: {'refreshToken': await _tokens.readRefreshToken()},
      );
    } catch (_) {
      // Logout is local-first. Offline/revoked sessions still have to leave no
      // credentials on the device, and the server endpoint is idempotent.
    } finally {
      await _tokens.clearTokens();
    }
  }

  Future<void> deleteAccount({
    String? password,
    bool clearGuestPrincipal = false,
  }) async {
    await _api.delete(
      '/auth/account',
      data: password?.isNotEmpty == true ? {'password': password} : null,
    );
    await _tokens.clearTokens();
    if (clearGuestPrincipal) {
      // Explicit guest-identity deletion is the only local action that removes
      // the stable principal capability. Ordinary logout and deletion of an
      // unrelated registered account must keep it.
      await _tokens.clearGuestPrincipalToken();
    }
  }

  static String get _devicePlatform => Platform.isIOS ? 'IOS' : 'ANDROID';
}

final class RegistrationResult {
  const RegistrationResult({
    required this.verificationRequired,
    this.emailHint,
  });

  final bool verificationRequired;
  final String? emailHint;
}

final class LoginDevice {
  const LoginDevice({
    required this.id,
    required this.deviceId,
    required this.lastSeenAt,
    required this.current,
    required this.revoked,
    this.platform,
    this.createdAt,
    this.revokedAt,
  });

  final String id;
  final String deviceId;
  final String? platform;
  final DateTime lastSeenAt;
  final DateTime? createdAt;
  final DateTime? revokedAt;
  final bool current;
  final bool revoked;

  factory LoginDevice.fromJson(Map<String, dynamic> json) => LoginDevice(
        id: (json['id'] ?? json['deviceId'] ?? '').toString(),
        deviceId: (json['deviceId'] ?? json['id'] ?? '').toString(),
        platform: json['platform']?.toString(),
        lastSeenAt: DateTime.tryParse(json['lastSeenAt']?.toString() ?? '')
                ?.toLocal() ??
            DateTime.fromMillisecondsSinceEpoch(0),
        createdAt: DateTime.tryParse(
          json['createdAt']?.toString() ?? '',
        )?.toLocal(),
        revokedAt: DateTime.tryParse(
          json['revokedAt']?.toString() ?? '',
        )?.toLocal(),
        current: json['current'] == true || json['isCurrent'] == true,
        revoked: json['revokedAt'] != null,
      );
}
