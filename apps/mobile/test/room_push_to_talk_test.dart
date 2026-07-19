import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tooyei_translator/core/models.dart';
import 'package:tooyei_translator/features/room/room_controller.dart';
import 'package:tooyei_translator/features/room/room_page.dart';

void main() {
  testWidgets('release callback survives recording-state rebuild',
      (tester) async {
    var action = RoomAction.idle;
    var starts = 0;
    var ends = 0;
    late StateSetter setHarnessState;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: StatefulBuilder(
            builder: (context, setState) {
              setHarnessState = setState;
              return RoomPushToTalkButton(
                action: action,
                language: Language.zh,
                enabled: action == RoomAction.idle,
                onStart: () {
                  starts += 1;
                  setHarnessState(() => action = RoomAction.recording);
                },
                onEnd: () => ends += 1,
                onCancel: () {},
              );
            },
          ),
        ),
      ),
    );

    final target = find.byKey(
      const ValueKey('room-push-to-talk-gesture'),
    );
    final gesture = await tester.startGesture(tester.getCenter(target));
    await tester.pump(kLongPressTimeout + const Duration(milliseconds: 20));
    expect(starts, 1);
    expect(action, RoomAction.recording);

    // This pump rebuilds the button with `enabled == false`, matching the
    // production RoomPage transition that previously removed the recognizer.
    await tester.pump();
    await gesture.up();
    await tester.pump();

    expect(ends, 1);
  });

  testWidgets('cancel callback survives recording-state rebuild',
      (tester) async {
    var action = RoomAction.idle;
    var cancels = 0;
    late StateSetter setHarnessState;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: StatefulBuilder(
            builder: (context, setState) {
              setHarnessState = setState;
              return RoomPushToTalkButton(
                action: action,
                language: Language.ru,
                enabled: action == RoomAction.idle,
                onStart: () {
                  setHarnessState(() => action = RoomAction.recording);
                },
                onEnd: () {},
                onCancel: () => cancels += 1,
              );
            },
          ),
        ),
      ),
    );

    final target = find.byKey(
      const ValueKey('room-push-to-talk-gesture'),
    );
    final gesture = await tester.startGesture(tester.getCenter(target));
    await tester.pump(kLongPressTimeout + const Duration(milliseconds: 20));
    await tester.pump();
    await gesture.cancel();
    await tester.pump();

    expect(cancels, 1);
  });

  testWidgets('shows model processing separately from network upload',
      (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: RoomPushToTalkButton(
            action: RoomAction.processing,
            language: Language.zh,
            enabled: false,
            onStart: () {},
            onEnd: () {},
            onCancel: () {},
          ),
        ),
      ),
    );

    expect(find.text('正在识别和翻译…'), findsOneWidget);
    expect(find.text('正在上传…'), findsNothing);
  });
}
