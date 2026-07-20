import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../features/contacts/contact_repository.dart';
import '../features/conversations/conversation_repository.dart';
import '../features/friends/friend_repository.dart';
import '../features/glossary/glossary_repository.dart';
import 'api/api_client.dart';
import 'audio/audio_playback_queue.dart';
import 'audio/pending_audio_registry.dart';
import 'auth/auth_repository.dart';
import 'auth/secure_token_store.dart';
import 'cache/app_preferences.dart';
import 'cache/local_database.dart';
import 'config.dart';
import 'deep_links/deep_link_service.dart';

final secureTokenStoreProvider = Provider<SecureTokenStore>(
  (_) => SecureTokenStore(),
);

final localDatabaseProvider = Provider<LocalDatabase>((ref) {
  final database = LocalDatabase();
  ref.onDispose(() => unawaited(database.close()));
  return database;
});

final apiClientProvider = Provider<ApiClient>((ref) {
  return ApiClient(
    baseUrl: AppConfig.apiBaseUrl,
    tokenStore: ref.watch(secureTokenStoreProvider),
  );
});

final authRepositoryProvider = Provider<AuthRepository>((ref) {
  return AuthRepository(
    ref.watch(apiClientProvider),
    ref.watch(secureTokenStoreProvider),
  );
});

final contactRepositoryProvider = Provider<ContactRepository>(
  (ref) => ContactRepository(ref.watch(apiClientProvider)),
);

final conversationRepositoryProvider = Provider<ConversationRepository>(
  (ref) => ConversationRepository(ref.watch(apiClientProvider)),
);

final glossaryRepositoryProvider = Provider<GlossaryRepository>(
  (ref) => GlossaryRepository(ref.watch(apiClientProvider)),
);

final friendRepositoryProvider = Provider<FriendRepository>(
  (ref) => FriendRepository(ref.watch(apiClientProvider)),
);

final appPreferencesProvider = Provider<AppPreferences>(
  (ref) => AppPreferences(ref.watch(localDatabaseProvider)),
);

/// Forces account-backed preferences to be reloaded after login or restore.
final accountPreferenceRevisionProvider = StateProvider<int>((_) => 0);

final audioPlaybackProvider = Provider<AudioPlaybackQueue>((ref) {
  final playback = AudioPlaybackQueue(
    accessToken: ref.watch(secureTokenStoreProvider).readAccessToken,
  );
  ref.onDispose(() => unawaited(playback.dispose()));
  return playback;
});

final pendingAudioRegistryProvider = Provider<PendingAudioRegistry>(
  (_) => PendingAudioRegistry(),
);

final deepLinkServiceProvider = Provider<DeepLinkService>((ref) {
  final service = DeepLinkService();
  ref.onDispose(() => unawaited(service.dispose()));
  return service;
});

final pendingInviteProvider = StateProvider<String?>((_) => null);
