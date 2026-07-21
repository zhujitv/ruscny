import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tooyei_translator/core/errors.dart';
import 'package:tooyei_translator/core/models.dart';
import 'package:tooyei_translator/features/friends/rtc_voice_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('maps synchronous RTC rejection to a user-safe authentication message',
      () {
    final error = PlatformException(
      code: 'RTC_JOIN_REJECTED',
      details: const {'phase': 'sync_join', 'code': -1},
    );

    expect(rtcJoinFailureMessage(error), '实时通话服务鉴权失败，请重新拨打');
    expect(rtcJoinFailureMessage(error), isNot(contains('PlatformException')));
    expect(rtcJoinFailureMessage(error), isNot(contains('-1')));
  });

  test('maps asynchronous join failures by authentication, account and network',
      () {
    const authentication = RtcVoiceState(
      value: 'error',
      code: 33620485,
      phase: 'async_join',
      category: 'authentication',
    );
    const account = RtcVoiceState(
      value: 'error',
      code: 16974339,
      phase: 'async_join',
      category: 'account',
    );
    const network = RtcVoiceState(
      value: 'error',
      code: 16908804,
      phase: 'async_join',
      category: 'network',
    );

    expect(authentication.userMessage, '实时通话服务鉴权失败，请重新拨打');
    expect(account.userMessage, '实时通话服务账号不可用，请联系管理员');
    expect(network.userMessage, '实时通话网络连接失败，请检查网络后重试');
    expect(authentication.userMessage, isNot(contains('33620485')));
  });

  test('distinguishes local channel join from remote peer presence', () {
    const localJoined = RtcVoiceState(value: 'joined');
    const peerJoined = RtcVoiceState(value: 'peer_joined');
    const peerLeft = RtcVoiceState(value: 'peer_left');

    expect(localJoined.isJoined, isTrue);
    expect(localJoined.isPeerJoined, isFalse);
    expect(peerJoined.isPeerJoined, isTrue);
    expect(peerLeft.isPeerLeft, isTrue);
  });

  test('camera-disabled state preserves the native failure reason', () {
    const state = RtcVoiceState(
      value: 'camera_disabled',
      category: 'camera',
      reason: 'preview_bind_failed',
    );

    expect(state.isCameraDisabled, isTrue);
    expect(state.isError, isFalse);
    expect(state.reason, 'preview_bind_failed');
  });

  test('video join arguments carry media type and initial camera state', () {
    const credential = RtcCredential(
      channelId: 'channel-1',
      userId: 'user-1',
      token: 'signed-token',
      expiresAt: 2000000000,
      realtimeTranslationAvailable: true,
    );

    final video = rtcJoinArguments(
      credential,
      'Wang',
      mediaType: FriendCallMediaType.video,
    );
    final receiveOnly = rtcJoinArguments(
      credential,
      'Wang',
      mediaType: FriendCallMediaType.video,
      cameraEnabled: false,
    );
    final audio = rtcJoinArguments(credential, 'Wang');

    expect(video['mediaType'], 'VIDEO');
    expect(video['cameraEnabled'], isTrue);
    expect(receiveOnly['mediaType'], 'VIDEO');
    expect(receiveOnly['cameraEnabled'], isFalse);
    expect(audio['mediaType'], 'AUDIO');
    expect(audio['cameraEnabled'], isFalse);
  });

  test('camera controls use the agreed native method channel contract',
      () async {
    const channel = MethodChannel('com.tooyei.translator/rtc');
    final calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      return 0;
    });
    final service = RtcVoiceService();

    await service.setCameraEnabled(false);
    await service.switchCamera();
    await service.dispose();

    expect(calls[0].method, 'setCameraEnabled');
    expect(calls[0].arguments, {'enabled': false});
    expect(calls[1].method, 'switchCamera');
    expect(calls[1].arguments, isNull);
    expect(calls[2].method, 'leave');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test('camera controls reject non-zero native result codes', () async {
    const channel = MethodChannel('com.tooyei.translator/rtc');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'leave') return null;
      return -1;
    });
    final service = RtcVoiceService();

    await expectLater(
      service.setCameraEnabled(true),
      throwsA(
        isA<AppException>().having(
          (error) => error.code,
          'code',
          'RTC_CAMERA_UNAVAILABLE',
        ),
      ),
    );
    await expectLater(
      service.switchCamera(),
      throwsA(
        isA<AppException>().having(
          (error) => error.code,
          'code',
          'RTC_CAMERA_SWITCH_FAILED',
        ),
      ),
    );
    await service.dispose();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test('audio controls reject non-zero native result codes', () async {
    const channel = MethodChannel('com.tooyei.translator/rtc');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'leave') return null;
      return -1;
    });
    final service = RtcVoiceService();

    await expectLater(
      service.setMuted(true),
      throwsA(
        isA<AppException>().having(
          (error) => error.code,
          'code',
          'RTC_MICROPHONE_CONTROL_FAILED',
        ),
      ),
    );
    await expectLater(
      service.setSpeaker(false),
      throwsA(
        isA<AppException>().having(
          (error) => error.code,
          'code',
          'RTC_SPEAKER_CONTROL_FAILED',
        ),
      ),
    );
    await expectLater(
      service.setTranslationMode(true),
      throwsA(
        isA<AppException>().having(
          (error) => error.code,
          'code',
          'RTC_TRANSLATION_AUDIO_ROUTE_FAILED',
        ),
      ),
    );
    await expectLater(
      service.playTranslationAudio(Uint8List.fromList([0, 1]), 16000),
      throwsA(
        isA<AppException>().having(
          (error) => error.code,
          'code',
          'RTC_TRANSLATION_AUDIO_PLAYBACK_FAILED',
        ),
      ),
    );
    await service.dispose();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test('join and leave platform calls have bounded timeouts', () async {
    const channel = MethodChannel('com.tooyei.translator/rtc');
    final never = Completer<Object?>();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'join') return never.future;
      return null;
    });
    final joinService = RtcVoiceService(
      androidPlatform: true,
      joinTimeout: const Duration(milliseconds: 10),
      leaveTimeout: const Duration(milliseconds: 10),
    );
    const credential = RtcCredential(
      channelId: 'channel-1',
      userId: 'user-1',
      token: 'signed-token',
      expiresAt: 2000000000,
      realtimeTranslationAvailable: true,
    );

    await expectLater(
      joinService.join(credential, 'Wang'),
      throwsA(
        isA<AppException>().having(
          (error) => error.code,
          'code',
          'RTC_JOIN_TIMEOUT',
        ),
      ),
    );
    await joinService.dispose();

    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) => never.future);
    final leaveService = RtcVoiceService(
      leaveTimeout: const Duration(milliseconds: 10),
    );
    await expectLater(
      leaveService.leave(),
      throwsA(
        isA<AppException>().having(
          (error) => error.code,
          'code',
          'RTC_LEAVE_TIMEOUT',
        ),
      ),
    );
    await leaveService.dispose();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test('an old dispose never clears a newer service method handler', () async {
    const channel = MethodChannel('com.tooyei.translator/rtc');
    final oldLeaveStarted = Completer<void>();
    final finishOldLeave = Completer<void>();
    var leaveCalls = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      if (call.method != 'leave') return 0;
      leaveCalls += 1;
      if (leaveCalls == 1) {
        oldLeaveStarted.complete();
        await finishOldLeave.future;
      }
      return null;
    });
    final oldService = RtcVoiceService();
    final oldDispose = oldService.dispose();
    await oldLeaveStarted.future;

    final newService = RtcVoiceService();
    final joined = newService.states.firstWhere((state) => state.isJoined);
    finishOldLeave.complete();
    await oldDispose;
    await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .handlePlatformMessage(
      channel.name,
      const StandardMethodCodec().encodeMethodCall(
        const MethodCall('state', {'state': 'joined'}),
      ),
      null,
    );

    expect((await joined).isJoined, isTrue);
    await newService.dispose();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  testWidgets('video view exposes separate local and remote containers',
      (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Row(
          children: [
            Expanded(child: RtcVideoView(role: RtcVideoRole.local)),
            Expanded(child: RtcVideoView(role: RtcVideoRole.remote)),
          ],
        ),
      ),
    );

    expect(
      find.byKey(const ValueKey('rtc-video-local-placeholder')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('rtc-video-remote-placeholder')),
      findsOneWidget,
    );
    expect(RtcVideoView.viewType, 'com.tooyei.translator/rtc_video');
  });
}
