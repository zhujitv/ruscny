import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tooyei_translator/core/localization/app_localization.dart';
import 'package:tooyei_translator/features/friends/friend_call_page.dart';

void main() {
  test('remote call cleanup always attempts server end and absorbs failure',
      () async {
    var attempts = 0;

    await endFriendCallOnServerBestEffort(() async {
      attempts += 1;
      throw Exception('already ended');
    });

    expect(attempts, 1);
  });

  test('camera suspension covers joined and joining video calls', () {
    expect(
      shouldSuspendRtcCamera(
        lifecycleState: AppLifecycleState.inactive,
        rtcJoined: true,
        isVideo: true,
        cameraEnabled: true,
      ),
      isTrue,
    );
    expect(
      shouldSuspendRtcCamera(
        lifecycleState: AppLifecycleState.paused,
        rtcJoined: true,
        isVideo: true,
        cameraEnabled: true,
      ),
      isTrue,
    );
    expect(
      shouldSuspendRtcCamera(
        lifecycleState: AppLifecycleState.hidden,
        rtcJoined: true,
        isVideo: true,
        cameraEnabled: true,
      ),
      isTrue,
    );
    expect(
      shouldSuspendRtcCamera(
        lifecycleState: AppLifecycleState.detached,
        rtcJoined: true,
        isVideo: true,
        cameraEnabled: true,
      ),
      isTrue,
    );
    expect(
      shouldSuspendRtcCamera(
        lifecycleState: AppLifecycleState.resumed,
        rtcJoined: true,
        isVideo: true,
        cameraEnabled: true,
      ),
      isFalse,
    );
    expect(
      shouldSuspendRtcCamera(
        lifecycleState: AppLifecycleState.paused,
        rtcJoined: false,
        isVideo: true,
        cameraEnabled: true,
      ),
      isFalse,
    );
    expect(
      shouldSuspendRtcCamera(
        lifecycleState: AppLifecycleState.paused,
        rtcJoined: false,
        rtcJoining: true,
        isVideo: true,
        cameraEnabled: true,
      ),
      isTrue,
    );
  });

  test('only a manual camera-off operation cancels lifecycle restoration', () {
    expect(
      shouldRestoreRtcCameraAfterResume(
        cameraEnabled: true,
        operationTargetEnabled: false,
        operationIsUserInitiated: true,
      ),
      isFalse,
    );
    expect(
      shouldRestoreRtcCameraAfterResume(
        cameraEnabled: true,
        operationTargetEnabled: false,
        operationIsUserInitiated: false,
      ),
      isTrue,
    );
    expect(
      shouldRestoreRtcCameraAfterResume(
        cameraEnabled: false,
        operationTargetEnabled: true,
        operationIsUserInitiated: true,
      ),
      isTrue,
    );
  });

  test('native-ready pending join can only apply a camera disable', () {
    expect(
      canApplyRtcCameraState(
        enabled: false,
        rtcJoined: false,
        rtcNativeReady: true,
      ),
      isTrue,
    );
    expect(
      canApplyRtcCameraState(
        enabled: true,
        rtcJoined: false,
        rtcNativeReady: true,
      ),
      isFalse,
    );
    expect(
      canApplyRtcCameraState(
        enabled: false,
        rtcJoined: false,
        rtcNativeReady: false,
      ),
      isFalse,
    );
  });

  testWidgets('video controls wrap safely on a narrow Russian screen',
      (tester) async {
    tester.view.physicalSize = const Size(280, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    await tester.pumpWidget(
      MaterialApp(
        locale: const Locale('ru', 'RU'),
        supportedLocales: AppLocalization.supportedLocales,
        localizationsDelegates: const [
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: Scaffold(
          backgroundColor: const Color(0xFF0B4338),
          body: Align(
            alignment: Alignment.topCenter,
            child: SizedBox(
              width: 240,
              child: FriendCallControlBar(
                isVideo: true,
                isActive: true,
                muted: false,
                cameraEnabled: true,
                cameraOperationInFlight: false,
                speakerEnabled: true,
                ending: false,
                switchingCamera: false,
                onToggleMute: () {},
                onToggleCamera: () {},
                onHangUp: () {},
                onSwitchCamera: () {},
                onToggleSpeaker: () {},
              ),
            ),
          ),
        ),
      ),
    );

    const controlKeys = [
      ValueKey('call-control-mute'),
      ValueKey('call-control-camera'),
      ValueKey('call-control-hang-up'),
      ValueKey('call-control-switch-camera'),
      ValueKey('call-control-speaker'),
    ];
    for (final key in controlKeys) {
      expect(find.byKey(key), findsOneWidget);
    }
    final rowOffsets = controlKeys
        .map((key) => tester.getTopLeft(find.byKey(key)).dy.round())
        .toSet();
    expect(rowOffsets.length, greaterThan(1));
    expect(find.text('Выключить камеру'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('camera actions are disabled while a camera operation is active',
      (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: FriendCallControlBar(
            isVideo: true,
            isActive: true,
            muted: false,
            cameraEnabled: true,
            cameraOperationInFlight: true,
            speakerEnabled: true,
            ending: false,
            switchingCamera: false,
            onToggleMute: () {},
            onToggleCamera: () {},
            onHangUp: () {},
            onSwitchCamera: () {},
            onToggleSpeaker: () {},
          ),
        ),
      ),
    );

    IconButton button(String key) => tester.widget<IconButton>(
          find.descendant(
            of: find.byKey(ValueKey(key)),
            matching: find.byType(IconButton),
          ),
        );

    expect(button('call-control-camera').onPressed, isNull);
    expect(button('call-control-switch-camera').onPressed, isNull);
  });
}
