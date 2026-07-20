import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/auth/auth_repository.dart';
import '../../core/cache/app_preferences.dart';
import '../../core/localization/app_localization.dart';
import '../../core/models.dart';
import '../../core/providers.dart';
import '../../core/utils/transcript_exporter.dart';

final authControllerProvider =
    AsyncNotifierProvider<AuthController, AuthSession?>(AuthController.new);

final class AuthController extends AsyncNotifier<AuthSession?> {
  @override
  Future<AuthSession?> build() async {
    await TranscriptExporter.clearTemporaryFiles();
    final session = await ref.read(authRepositoryProvider).restore();
    if (session != null && session.role != UserRole.guest) {
      await _saveAccountPreferences(session);
    }
    if (session == null) {
      // An expired/revoked credential must not leave another user's meeting
      // cache available to the next account that signs in on this device.
      try {
        await ref.read(localDatabaseProvider).clearPrivateData();
      } catch (_) {
        // Authentication still resolves to signed-out if a damaged cache
        // cannot be opened; no cached data is surfaced by the signed-out UI.
      }
    }
    return session;
  }

  Future<bool> login({required String email, required String password}) async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(
      () async {
        final session = await ref
            .read(authRepositoryProvider)
            .login(email: email, password: password);
        await _saveAccountPreferences(session);
        return session;
      },
    );
    return !state.hasError;
  }

  Future<RegistrationResult> register({
    required String displayName,
    required String email,
    required String password,
  }) =>
      ref.read(authRepositoryProvider).register(
            displayName: displayName,
            email: email,
            password: password,
          );

  Future<bool> createGuest({
    required String displayName,
    required String company,
    required String email,
    required Language preferredLanguage,
    String? inviteToken,
    String? roomCode,
  }) async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(
      () => ref.read(authRepositoryProvider).createGuest(
            displayName: displayName,
            company: company,
            email: email,
            preferredLanguage: preferredLanguage,
            inviteToken: inviteToken,
            roomCode: roomCode,
          ),
    );
    final authenticated = !state.hasError;
    if (authenticated) {
      // POST /auth/guest already creates the scoped participant. Keeping this
      // token would send the new Guest through a redundant second join screen.
      ref.read(pendingInviteProvider.notifier).state = null;
    }
    return authenticated;
  }

  Future<void> logout() async {
    state = const AsyncLoading();
    try {
      await ref.read(authRepositoryProvider).logout();
    } finally {
      await _clearLocalSession();
      state = const AsyncData(null);
    }
  }

  Future<void> updateProfile({
    required String displayName,
    String? phone,
    String? company,
    Language? preferredLanguage,
    String? avatarPreset,
  }) async {
    final updated = await ref.read(authRepositoryProvider).updateProfile(
          displayName: displayName,
          phone: phone,
          company: company,
          preferredLanguage: preferredLanguage,
          avatarPreset: avatarPreset,
        );
    state = AsyncData(updated);
  }

  Future<void> updatePreferences({
    required AppLanguageMode languageMode,
    required bool autoPlay,
    required double playbackSpeed,
  }) async {
    final current = state.valueOrNull;
    if (current == null || current.role == UserRole.guest) return;
    final updated = await ref.read(authRepositoryProvider).updatePreferences(
          interfaceLanguage: languageMode.name,
          autoPlayTranslationAudio: autoPlay,
          translationPlaybackSpeed: playbackSpeed,
        );
    state = AsyncData(updated);
  }

  Future<void> _saveAccountPreferences(AuthSession session) async {
    try {
      await ref.read(appPreferencesProvider).save(
            AppSettings(
              autoPlay: session.autoPlayTranslationAudio,
              playbackSpeed: session.translationPlaybackSpeed,
              languageMode: AppLanguageMode.parse(session.interfaceLanguage),
            ),
          );
      ref.read(accountPreferenceRevisionProvider.notifier).state++;
    } catch (_) {
      // A damaged device cache must not turn a valid server login into an
      // authentication failure. The account values remain authoritative and
      // will be applied again after the local cache becomes available.
    }
  }

  Future<bool> deleteAccount({String? password}) async {
    final currentSession = state.valueOrNull;
    state = const AsyncLoading();
    try {
      await ref.read(authRepositoryProvider).deleteAccount(
            password: password,
            clearGuestPrincipal: currentSession?.role == UserRole.guest,
          );
      await _clearLocalSession();
      state = const AsyncData(null);
      return true;
    } catch (error, stackTrace) {
      state = AsyncData(currentSession);
      Error.throwWithStackTrace(error, stackTrace);
    }
  }

  Future<void> _clearLocalSession() async {
    ref.read(pendingInviteProvider.notifier).state = null;
    try {
      await ref.read(audioPlaybackProvider).stop();
    } catch (_) {
      // A platform player failure must not keep credentials/session UI alive.
    }
    try {
      await ref.read(pendingAudioRegistryProvider).clear();
    } catch (_) {
      // Session removal still wins if a platform temp-file deletion fails.
    }
    await TranscriptExporter.clearTemporaryFiles();
    try {
      await ref.read(localDatabaseProvider).clearPrivateData();
    } catch (_) {
      // The signed-out app never reads private cache rows. A future successful
      // database open will clear them again during restore.
    }
  }
}
