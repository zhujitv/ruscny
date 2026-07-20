import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/cache/app_preferences.dart';
import '../../core/localization/app_localization.dart';
import '../../core/providers.dart';
import '../auth/auth_controller.dart';

final settingsControllerProvider =
    AsyncNotifierProvider<SettingsController, AppSettings>(
        SettingsController.new);

final class SettingsController extends AsyncNotifier<AppSettings> {
  @override
  Future<AppSettings> build() {
    ref.watch(accountPreferenceRevisionProvider);
    return ref.read(appPreferencesProvider).load();
  }

  Future<void> setAutoPlay(bool enabled) async {
    final current = state.valueOrNull ?? const AppSettings();
    final next = current.copyWith(autoPlay: enabled);
    await _save(current, next);
  }

  Future<void> setPlaybackSpeed(double speed) async {
    final current = state.valueOrNull ?? const AppSettings();
    final next = current.copyWith(playbackSpeed: speed);
    await _save(current, next);
    await ref.read(audioPlaybackProvider).setSpeed(speed);
  }

  Future<void> setLanguageMode(AppLanguageMode mode) async {
    final current = state.valueOrNull ?? const AppSettings();
    final next = current.copyWith(languageMode: mode);
    await _save(current, next);
  }

  Future<void> _save(AppSettings previous, AppSettings next) async {
    state = AsyncData(next);
    try {
      await ref.read(appPreferencesProvider).save(next);
      await ref.read(authControllerProvider.notifier).updatePreferences(
            languageMode: next.languageMode,
            autoPlay: next.autoPlay,
            playbackSpeed: next.playbackSpeed,
          );
    } catch (error, stackTrace) {
      state = AsyncData(previous);
      try {
        await ref.read(appPreferencesProvider).save(previous);
      } catch (_) {
        // Preserve the original save/sync error for the user-facing message.
      }
      Error.throwWithStackTrace(error, stackTrace);
    }
  }
}
