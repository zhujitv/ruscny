import 'package:flutter_test/flutter_test.dart';
import 'package:tooyei_translator/core/models.dart';
import 'package:tooyei_translator/features/friends/friend_call_page.dart';
import 'package:tooyei_translator/features/friends/incoming_call_coordinator.dart';
import 'package:tooyei_translator/features/friends/rtc_voice_service.dart';
import 'package:tooyei_translator/features/friends/social_realtime_controller.dart';

void main() {
  group('ringing timeout recovery', () {
    test('uses the call creation time instead of restarting a 60 second timer',
        () {
      final createdAt = DateTime.utc(2026, 7, 21, 12);

      expect(
        friendCallRingingRemaining(
          createdAt: createdAt,
          now: createdAt.add(const Duration(seconds: 25)),
        ),
        const Duration(seconds: 35),
      );
      expect(
        friendCallRingingRemaining(
          createdAt: createdAt,
          now: createdAt.add(const Duration(seconds: 61)),
        ),
        Duration.zero,
      );
    });

    test('never ends a call that became active at the timeout boundary', () {
      expect(
        friendCallRingTimeoutDecision(
          activeCall: _call('call-1', status: 'ACTIVE'),
          currentCallId: 'call-1',
        ),
        FriendCallRingTimeoutDecision.join,
      );
      expect(
        friendCallRingTimeoutDecision(
          activeCall: _call('call-1', status: 'RINGING'),
          currentCallId: 'call-1',
        ),
        FriendCallRingTimeoutDecision.retry,
      );
      expect(
        friendCallRingTimeoutDecision(
          activeCall: null,
          currentCallId: 'call-1',
        ),
        FriendCallRingTimeoutDecision.close,
      );
    });
  });

  group('incoming call recovery', () {
    testWidgets('REST recovery requests a frame for a static incoming screen',
        (tester) async {
      await tester.pumpAndSettle();
      expect(tester.binding.hasScheduledFrame, isFalse);

      var presented = false;
      scheduleIncomingCallAfterFrame(() => presented = true);

      expect(tester.binding.hasScheduledFrame, isTrue);
      await tester.pump();
      expect(presented, isTrue);
    });

    test('a failed response releases the call so it can be presented again',
        () {
      final attempts = IncomingCallAttemptTracker()..begin('call-1');

      expect(attempts.isHandled('call-1'), isTrue);
      attempts.release('call-1');

      expect(attempts.isHandled('call-1'), isFalse);
      attempts.begin('call-1');
      expect(attempts.isHandled('call-1'), isTrue);
    });

    test('an expired native notification action is discarded', () {
      expect(
        shouldDiscardPendingIncomingCallAction(
          pendingCallId: 'old-call',
          activeCallId: 'new-call',
        ),
        isTrue,
      );
      expect(
        shouldDiscardPendingIncomingCallAction(
          pendingCallId: 'ended-call',
          activeCallId: null,
        ),
        isTrue,
      );
      expect(
        shouldDiscardPendingIncomingCallAction(
          pendingCallId: 'call-1',
          activeCallId: 'call-1',
        ),
        isFalse,
      );
    });

    test('another device response closes only the matching prompt', () {
      expect(
        shouldResolveIncomingPromptFromRealtime(
          dialogCallId: 'call-1',
          eventCallId: 'call-1',
          event: 'friend.call.accepted',
          localResponseInFlight: false,
        ),
        isTrue,
      );
      expect(
        shouldResolveIncomingPromptFromRealtime(
          dialogCallId: 'call-1',
          eventCallId: 'old-call',
          event: 'friend.call.declined',
          localResponseInFlight: false,
        ),
        isFalse,
      );
      expect(
        shouldResolveIncomingPromptFromRealtime(
          dialogCallId: 'call-1',
          eventCallId: 'call-1',
          event: 'friend.call.accepted',
          localResponseInFlight: true,
        ),
        isFalse,
      );
    });

    test('scheduled and background notification calls are resolution targets',
        () {
      expect(
        incomingCallResolutionTarget(
          dialogOpen: false,
          handledCallId: null,
          scheduledCallId: 'scheduled-call',
          notifiedCallId: null,
        ),
        'scheduled-call',
      );
      expect(
        incomingCallResolutionTarget(
          dialogOpen: false,
          handledCallId: null,
          scheduledCallId: null,
          notifiedCallId: 'notified-call',
        ),
        'notified-call',
      );
      expect(
        incomingCallResolutionTarget(
          dialogOpen: true,
          handledCallId: 'dialog-call',
          scheduledCallId: 'scheduled-call',
          notifiedCallId: 'notified-call',
        ),
        'dialog-call',
      );
    });

    test('incoming prompt uses only the remaining ringing lifetime', () {
      final createdAt = DateTime.utc(2026, 7, 21, 12);

      expect(
        incomingCallPromptRemaining(
          createdAt: createdAt,
          now: createdAt.add(const Duration(seconds: 25)),
        ),
        const Duration(seconds: 35),
      );
      expect(
        incomingCallPromptRemaining(
          createdAt: createdAt,
          now: createdAt.add(const Duration(seconds: 61)),
        ),
        Duration.zero,
      );
      expect(
        incomingCallPromptRemaining(
          createdAt: createdAt.add(const Duration(minutes: 5)),
          now: createdAt,
        ),
        incomingCallRingingTimeout,
      );
    });
  });

  group('call event isolation', () {
    test('reads call ids from accepted and ended payload shapes', () {
      expect(
        friendCallIdFromRealtimePayload({
          'call': {'id': 'accepted-call'},
        }),
        'accepted-call',
      );
      expect(
        friendCallIdFromRealtimePayload({'callId': 'ended-call'}),
        'ended-call',
      );
      expect(
        friendCallIdFromRealtimePayload([
          {'callId': 'wrapped-call'},
        ]),
        'wrapped-call',
      );
    });

    test('never applies an old or unidentified event to the current call', () {
      expect(
        friendCallEventMatches(
          currentCallId: 'current-call',
          eventCallId: 'current-call',
        ),
        isTrue,
      );
      expect(
        friendCallEventMatches(
          currentCallId: 'current-call',
          eventCallId: 'old-call',
        ),
        isFalse,
      );
      expect(
        friendCallEventMatches(
          currentCallId: 'current-call',
          eventCallId: null,
        ),
        isFalse,
      );
    });
  });

  group('peer recovery policy', () {
    test('waits through a short disconnect while REST still reports active',
        () {
      expect(
        friendCallPeerRecoveryDecision(
          peerPresent: false,
          restConfirmed: true,
          activeCall: _call('call-1', status: 'ACTIVE'),
          currentCallId: 'call-1',
          disconnectedFor: const Duration(seconds: 5),
        ),
        FriendCallPeerRecoveryDecision.wait,
      );
    });

    test('accepts RTC recovery without ending the server call', () {
      expect(
        friendCallPeerRecoveryDecision(
          peerPresent: true,
          restConfirmed: true,
          activeCall: null,
          currentCallId: 'call-1',
          disconnectedFor: const Duration(seconds: 30),
        ),
        FriendCallPeerRecoveryDecision.recovered,
      );
    });

    test('ends only after REST or the bounded recovery timeout confirms it',
        () {
      expect(
        friendCallPeerRecoveryDecision(
          peerPresent: false,
          restConfirmed: true,
          activeCall: null,
          currentCallId: 'call-1',
          disconnectedFor: const Duration(seconds: 5),
        ),
        FriendCallPeerRecoveryDecision.ended,
      );
      expect(
        friendCallPeerRecoveryDecision(
          peerPresent: false,
          restConfirmed: false,
          activeCall: null,
          currentCallId: 'call-1',
          disconnectedFor: friendCallPeerRecoveryTimeout,
        ),
        FriendCallPeerRecoveryDecision.timedOut,
      );
    });

    testWidgets('peer join deadline fires unless peer arrival cancels it',
        (tester) async {
      var timeouts = 0;
      final deadline = FriendCallPeerJoinDeadline(
        duration: const Duration(seconds: 1),
        onTimeout: () => timeouts += 1,
      );

      deadline.start();
      await tester.pump(const Duration(milliseconds: 999));
      expect(timeouts, 0);
      await tester.pump(const Duration(milliseconds: 1));
      expect(timeouts, 1);

      deadline.start();
      deadline.cancel();
      await tester.pump(const Duration(seconds: 1));
      expect(timeouts, 1);
    });

    test('peer_left stays recoverable throughout the grace period', () {
      expect(friendCallPeerLeaveGrace, const Duration(seconds: 5));
      expect(
        friendCallPeerRecoveryDecision(
          peerPresent: false,
          restConfirmed: true,
          activeCall: _call('call-1', status: 'ACTIVE'),
          currentCallId: 'call-1',
          disconnectedFor: friendCallPeerLeaveGrace,
        ),
        FriendCallPeerRecoveryDecision.wait,
      );
    });
  });

  testWidgets('heartbeat starts only on joined and stops on RTC failure',
      (tester) async {
    var beats = 0;
    final heartbeat = FriendCallHeartbeatScheduler(
      interval: const Duration(seconds: 1),
      onHeartbeat: () async => beats += 1,
    );

    heartbeat.handleRtcState(const RtcVoiceState(value: 'peer_joined'));
    await tester.pump(const Duration(seconds: 2));
    expect(beats, 0);

    heartbeat.handleRtcState(const RtcVoiceState(value: 'joined'));
    expect(beats, 1);
    await tester.pump(const Duration(seconds: 2));
    expect(beats, 3);

    heartbeat.handleRtcState(const RtcVoiceState(value: 'error'));
    await tester.pump(const Duration(seconds: 2));
    expect(beats, 3);
  });

  test('native leave failure never prevents route cleanup', () async {
    var attempts = 0;

    await leaveRtcBestEffort(() async {
      attempts += 1;
      throw Exception('native leave timed out');
    });

    expect(attempts, 1);
  });
}

FriendCallModel _call(String id, {required String status}) => FriendCallModel(
      id: id,
      direction: 'INCOMING',
      status: status,
      peer: const UserProfile(id: 'peer-1', displayName: 'Ivan'),
      createdAt: DateTime.utc(2026, 7, 21),
    );
