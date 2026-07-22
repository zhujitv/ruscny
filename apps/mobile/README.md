# TOOYEI 中俄翻译移动端

Flutter client for Android and iOS. A Host creates a meeting bound to one customer record, then multiple registered or temporary participants can join with independent identities and languages. The app records only while push-to-talk is held, persists a failed upload for recovery with the same idempotency key, and deletes the local segment only after a terminal outcome or explicit discard.

## Runtime configuration

No translation, TTS, database, or JWT secret is compiled into the app. Public endpoints are injected at build time:

```sh
flutter run \
  --dart-define=API_BASE_URL=https://www.ruscny.net \
  --dart-define=SOCKET_URL=https://www.ruscny.net \
  --dart-define=APP_LINK_HOST=www.ruscny.net
```

`SOCKET_URL` is optional when Socket.IO shares the API origin; if omitted, the app derives only the origin from `API_BASE_URL` and removes a possible `/v1` path. An explicit value is still supported for a separate realtime host. The checked-in public defaults use the final production origin `https://www.ruscny.net`; release CI still passes the values explicitly so the build record proves its endpoint configuration.

The Android build decodes Flutter's forwarded `APP_LINK_HOST` define into the native manifest placeholder as well, keeping Dart routing and the verified App Link host aligned. iOS Associated Domains remains an explicit signed entitlement and must be configured per release scheme.

## Bootstrap

```sh
flutter --version # CI pins 3.44.6
flutter pub get --enforce-lockfile
flutter test
flutter analyze
flutter build appbundle --release \
  --dart-define=API_BASE_URL=https://www.ruscny.net \
  --dart-define=APP_LINK_HOST=www.ruscny.net
flutter build ipa --release \
  --dart-define=API_BASE_URL=https://www.ruscny.net \
  --dart-define=APP_LINK_HOST=www.ruscny.net
```

The Android project uses AGP 8.10.1, Gradle 8.11.1, JDK 17, and Flutter's
current SDK defaults (`compileSdk`/`targetSdk` 36 and `minSdk` 24 in Flutter
3.44.6). The
binary wrapper JAR is not committed: CI downloads the canonical v8.11.1 JAR
from Gradle's tagged source and verifies its official SHA-256, while local
scripts can fall back to Flutter's SDK artifact cache.
`gradle-wrapper.properties` also pins the 8.11.1 distribution SHA-256.

iOS source control includes `AppFrameworkInfo.plist`, AppIcon resources, `GeneratedPluginRegistrant.h/.m`, and their Xcode references. `flutter pub get --enforce-lockfile` may refresh the registrant when plugins change, and that change must be committed. Only `Generated.xcconfig`, `flutter_export_environment.sh`, Pods and plugin symlinks are intentionally ignored. iOS release still requires signing, `applinks:www.ruscny.net`, and the matching `apple-app-site-association`; Android requires `assetlinks.json`. The download landing and association templates are under `deploy/deep-links`.

`pubspec.lock` was generated with Flutter 3.44.6 and CI enforces it. `Podfile.lock` is still unavailable until CocoaPods resolves the iOS workspace; generate and commit it from the controlled macOS toolchain before calling iOS release builds reproducible.

## MVP contracts

- REST uses `Authorization: Bearer <access token>`, binds access/refresh/guest credentials to a server-side session generation, rotates refresh tokens after a single guarded refresh, and accepts `Idempotency-Key` for audio uploads. A legacy token without the current session claim must be cleared after authentication fails so the user can sign in again.
- Socket.IO includes room/message/participant events plus subject-scoped friend requests, friend presence and meeting invitations; see `docs/WEBSOCKET_EVENTS.md`.
- Reconnect sends `lastSequence`; REST backfill is merged by message ID and sequence before the room becomes live.
- Local SQLite is a bounded offline cache. The server remains authoritative for membership, contact ownership, room expiry, history policy, and deletion.
- Guest sessions are scoped to one conversation and do not expose the host's contact or history lists.
- Host invitation rotation returns a new token/code pair and invalidates the old pair immediately; the app must replace, not append to, the displayed QR/link.
- A stale `PROCESSING` message is recovered server-side as `FAILED / PROCESSING_TIMEOUT` for retry and audit, but participant transcripts display only `FINAL` translations. The speaker receives the upload failure locally and can retry the retained recording.

Structured, speaker-attributed meeting minutes are implemented from server-owned FINAL message snapshots. Generative summary quality workflows and push notifications remain later production capabilities and are not required for the real-time translation path.
