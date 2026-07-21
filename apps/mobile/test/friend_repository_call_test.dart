import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tooyei_translator/core/api/api_client.dart';
import 'package:tooyei_translator/core/auth/secure_token_store.dart';
import 'package:tooyei_translator/core/errors.dart';
import 'package:tooyei_translator/core/models.dart';
import 'package:tooyei_translator/features/friends/friend_repository.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  test('starts a video call and can answer it as audio', () async {
    final requests = <RequestOptions>[];
    final adapter = _FriendCallAdapter((options) {
      requests.add(options);
      final request = (options.data as Map).cast<String, dynamic>();
      final responseMediaType = request['mediaType']?.toString() ?? 'AUDIO';
      return _json({
        'ok': true,
        'data': {
          'call': {
            'id': 'call-1',
            'direction':
                options.path.endsWith('/respond') ? 'INCOMING' : 'OUTGOING',
            'status': options.path.endsWith('/respond') ? 'ACTIVE' : 'RINGING',
            'mediaType': responseMediaType,
            'createdAt': '2026-07-21T10:00:00Z',
            'peer': {'id': 'friend-1', 'displayName': 'Ivan'},
          },
        },
      });
    });
    final repository = _repository(adapter);

    final outgoing = await repository.startCall(
      'friend-1',
      mediaType: FriendCallMediaType.video,
    );
    final answered = await repository.respondToCall(
      'call-1',
      accept: true,
      mediaType: FriendCallMediaType.audio,
    );

    expect(requests[0].data, {
      'friendId': 'friend-1',
      'mediaType': 'VIDEO',
    });
    expect(requests[1].data, {
      'action': 'ACCEPT',
      'mediaType': 'AUDIO',
    });
    expect(outgoing.mediaType, FriendCallMediaType.video);
    expect(answered.mediaType, FriendCallMediaType.audio);
  });

  test('declining a call does not send a media override', () async {
    RequestOptions? captured;
    final repository = _repository(_FriendCallAdapter((options) {
      captured = options;
      return _json({
        'ok': true,
        'data': {
          'call': {
            'id': 'call-2',
            'direction': 'INCOMING',
            'status': 'DECLINED',
            'mediaType': 'VIDEO',
            'createdAt': '2026-07-21T10:00:00Z',
            'peer': {'id': 'friend-2', 'displayName': 'Maria'},
          },
        },
      });
    }));

    await repository.respondToCall(
      'call-2',
      accept: false,
      mediaType: FriendCallMediaType.audio,
    );

    expect(captured?.data, {'action': 'DECLINE'});
  });

  test('RTC credential request and response agree on media type', () async {
    RequestOptions? captured;
    final repository = _repository(_FriendCallAdapter((options) {
      captured = options;
      return _json({
        'ok': true,
        'data': {
          'credential': {
            'channelId': 'channel-1',
            'userId': 'user-1',
            'token': 'signed-token',
            'expiresAt': 2000000000,
            'realtimeTranslationAvailable': true,
            'mediaType': 'VIDEO',
          },
        },
      });
    }));

    final credential = await repository.rtcCredential(
      'call-3',
      mediaType: FriendCallMediaType.video,
    );

    expect(captured?.data, {'mediaType': 'VIDEO'});
    expect(credential.channelId, 'channel-1');
  });

  test('rejects a stale or missing RTC media negotiation', () async {
    for (final responseMediaType in <String?>['AUDIO', null]) {
      final repository = _repository(_FriendCallAdapter((options) {
        return _json({
          'ok': true,
          'data': {
            'credential': {
              'channelId': 'channel-1',
              'userId': 'user-1',
              'token': 'signed-token',
              'expiresAt': 2000000000,
              'realtimeTranslationAvailable': true,
              if (responseMediaType != null) 'mediaType': responseMediaType,
            },
          },
        });
      }));

      await expectLater(
        repository.rtcCredential(
          'call-4',
          mediaType: FriendCallMediaType.video,
        ),
        throwsA(
          isA<AppException>().having(
            (error) => error.code,
            'code',
            'FRIEND_CALL_MEDIA_TYPE_CHANGED',
          ),
        ),
      );
    }
  });
}

FriendRepository _repository(HttpClientAdapter adapter) {
  final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test/v1'))
    ..httpClientAdapter = adapter;
  return FriendRepository(
    ApiClient(
      baseUrl: 'https://api.example.test/v1',
      tokenStore: SecureTokenStore(),
      dio: dio,
    ),
  );
}

ResponseBody _json(Map<String, dynamic> body) => ResponseBody.fromString(
      jsonEncode(body),
      200,
      headers: {
        Headers.contentTypeHeader: ['application/json'],
      },
    );

final class _FriendCallAdapter implements HttpClientAdapter {
  _FriendCallAdapter(this.callback);

  final ResponseBody Function(RequestOptions options) callback;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async =>
      callback(options);

  @override
  void close({bool force = false}) {}
}
