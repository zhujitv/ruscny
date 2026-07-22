import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../core/audio/audio_cue_service.dart';
import '../../core/errors.dart';
import '../../core/localization/app_localization.dart';
import '../../core/models.dart';
import '../../core/providers.dart';
import 'friend_call_page.dart';
import 'social_realtime_controller.dart';

const incomingCallRecoveryInterval = Duration(seconds: 2);
const incomingCallRingingTimeout = Duration(seconds: 60);

final class IncomingCallAttemptTracker {
  String? _handledCallId;

  String? get handledCallId => _handledCallId;

  bool isHandled(String callId) => _handledCallId == callId;

  void begin(String callId) => _handledCallId = callId;

  void release(String callId) {
    if (_handledCallId == callId) _handledCallId = null;
  }

  void reset() => _handledCallId = null;
}

bool shouldDiscardPendingIncomingCallAction({
  required String pendingCallId,
  required String? activeCallId,
}) =>
    activeCallId == null || pendingCallId != activeCallId;

bool shouldResolveIncomingPromptFromRealtime({
  required String? dialogCallId,
  required String? eventCallId,
  required String? event,
  required bool localResponseInFlight,
}) =>
    !localResponseInFlight &&
    dialogCallId != null &&
    eventCallId == dialogCallId &&
    (event == 'friend.call.accepted' ||
        event == 'friend.call.declined' ||
        event == 'friend.call.ended');

String? incomingCallResolutionTarget({
  required bool dialogOpen,
  required String? handledCallId,
  required String? scheduledCallId,
  required String? notifiedCallId,
}) {
  if (dialogOpen && handledCallId?.isNotEmpty == true) return handledCallId;
  if (scheduledCallId?.isNotEmpty == true) return scheduledCallId;
  if (notifiedCallId?.isNotEmpty == true) return notifiedCallId;
  return null;
}

Duration incomingCallPromptRemaining({
  required DateTime createdAt,
  required DateTime now,
}) {
  final remaining = incomingCallRingingTimeout - now.difference(createdAt);
  if (remaining <= Duration.zero) return Duration.zero;
  if (remaining > incomingCallRingingTimeout) return incomingCallRingingTimeout;
  return remaining;
}

void scheduleIncomingCallAfterFrame(VoidCallback callback) {
  WidgetsBinding.instance.addPostFrameCallback((_) => callback());
  // REST recovery can discover a call while the current screen is completely
  // static. addPostFrameCallback alone does not request another frame, leaving
  // the incoming dialog and ringtone blocked until an unrelated UI update.
  WidgetsBinding.instance.ensureVisualUpdate();
}

final class IncomingFriendCallCoordinator extends ConsumerStatefulWidget {
  const IncomingFriendCallCoordinator({
    required this.session,
    required this.child,
    super.key,
  });

  final AuthSession session;
  final Widget child;

  @override
  ConsumerState<IncomingFriendCallCoordinator> createState() =>
      _IncomingFriendCallCoordinatorState();
}

final class _IncomingFriendCallCoordinatorState
    extends ConsumerState<IncomingFriendCallCoordinator>
    with WidgetsBindingObserver {
  Timer? _recoveryTimer;
  ProviderSubscription<int>? _callEventSubscription;
  final _callAttempts = IncomingCallAttemptTracker();
  String? _scheduledCallId;
  bool _dialogOpen = false;
  bool _recovering = false;
  bool _inForeground = true;
  String? _notifiedCallId;
  ({String action, String callId})? _pendingNativeAction;
  BuildContext? _incomingDialogContext;
  String? _resolvedOnAnotherDeviceCallId;
  String? _localResponseInFlightCallId;
  bool _recoverActiveAfterResponseFailure = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _callEventSubscription = ref.listenManual<int>(
      socialRealtimeProvider.select((state) => state.revision),
      (previous, next) {
        if (!mounted) return;
        final realtime = ref.read(socialRealtimeProvider);
        final callId = realtime.lastCallId;
        final targetCallId = incomingCallResolutionTarget(
          dialogOpen: _dialogOpen,
          handledCallId: _callAttempts.handledCallId,
          scheduledCallId: _scheduledCallId,
          notifiedCallId: _notifiedCallId,
        );
        if (!shouldResolveIncomingPromptFromRealtime(
          dialogCallId: targetCallId,
          eventCallId: callId,
          event: realtime.lastEvent,
          localResponseInFlight: _localResponseInFlightCallId == callId,
        )) {
          return;
        }
        if (callId == null) return;
        _resolvedOnAnotherDeviceCallId = callId;
        if (_scheduledCallId == callId) _scheduledCallId = null;
        if (_notifiedCallId == callId) _notifiedCallId = null;
        unawaited(AudioCueService.stopIncomingRingtone());
        unawaited(AudioCueService.cancelIncomingCallNotification(callId));
        final dialogContext = _incomingDialogContext;
        if (dialogContext != null && dialogContext.mounted) {
          Navigator.of(dialogContext).pop();
        }
      },
    );
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        unawaited(Permission.notification.request());
        unawaited(_recoverIncomingCall(includeActive: true));
      }
    });
    _recoveryTimer = Timer.periodic(incomingCallRecoveryInterval, (_) {
      if (mounted && _inForeground) {
        unawaited(
          _recoverIncomingCall(
            includeActive: _recoverActiveAfterResponseFailure,
          ),
        );
      }
    });
  }

  @override
  void didUpdateWidget(IncomingFriendCallCoordinator oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.session.userId != widget.session.userId) {
      _callAttempts.reset();
      _scheduledCallId = null;
      _notifiedCallId = null;
      _pendingNativeAction = null;
      _resolvedOnAnotherDeviceCallId = null;
      _localResponseInFlightCallId = null;
      _recoverActiveAfterResponseFailure = false;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _inForeground = state == AppLifecycleState.resumed;
    if (_inForeground) {
      unawaited(_recoverIncomingCall(includeActive: true));
    }
  }

  @override
  void dispose() {
    _recoveryTimer?.cancel();
    _callEventSubscription?.close();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final incomingCall = ref.watch(
      socialRealtimeProvider.select((state) => state.latestCall),
    );
    if (incomingCall != null &&
        incomingCall.direction == 'INCOMING' &&
        incomingCall.isRinging) {
      _scheduleIncomingCall(incomingCall);
    }
    return widget.child;
  }

  void _scheduleIncomingCall(FriendCallModel call) {
    if (_dialogOpen ||
        _callAttempts.isHandled(call.id) ||
        call.id == _scheduledCallId) {
      return;
    }
    if (!_inForeground) {
      if (_notifiedCallId != call.id) {
        _notifiedCallId = call.id;
        unawaited(
          AudioCueService.showIncomingCallNotification(
            callId: call.id,
            callerName: call.peer.displayName,
            title: AppLocalization.translate(
              context,
              call.mediaType.incomingTitle,
            ),
            answerLabel: AppLocalization.translate(context, '接听'),
            declineLabel: AppLocalization.translate(context, '拒绝'),
          ),
        );
      }
      return;
    }
    _scheduledCallId = call.id;
    scheduleIncomingCallAfterFrame(() {
      if (!mounted) return;
      _scheduledCallId = null;
      unawaited(_presentIncomingCall(call));
    });
  }

  Future<void> _recoverIncomingCall({required bool includeActive}) async {
    if (_recovering || _dialogOpen || widget.session.role == UserRole.guest) {
      return;
    }
    _recovering = true;
    try {
      _pendingNativeAction ??=
          await AudioCueService.consumeIncomingCallAction();
      final call = await ref.read(friendRepositoryProvider).activeCall();
      if (!mounted) return;
      _recoverActiveAfterResponseFailure = false;
      final pendingAction = _pendingNativeAction;
      if (pendingAction != null &&
          shouldDiscardPendingIncomingCallAction(
            pendingCallId: pendingAction.callId,
            activeCallId: call?.id,
          )) {
        _pendingNativeAction = null;
      }
      if (call == null || _callAttempts.isHandled(call.id)) return;
      final currentPendingAction = _pendingNativeAction;
      if (currentPendingAction?.callId == call.id &&
          call.direction == 'INCOMING' &&
          call.isRinging &&
          currentPendingAction?.action != 'show') {
        await AudioCueService.cancelIncomingCallNotification(call.id);
        _notifiedCallId = null;
        final accepted = currentPendingAction?.action == 'answer';
        _pendingNativeAction = null;
        if (accepted) _recoverActiveAfterResponseFailure = true;
        final updated = await ref.read(friendRepositoryProvider).respondToCall(
              call.id,
              accept: accepted,
              mediaType: accepted ? call.mediaType : null,
            );
        _recoverActiveAfterResponseFailure = false;
        _callAttempts.begin(call.id);
        if (accepted && mounted) {
          await Navigator.of(context).push<void>(
            MaterialPageRoute<void>(
              builder: (_) => FriendCallPage(initialCall: updated),
            ),
          );
        }
        return;
      }
      if (call.direction == 'INCOMING' && call.isRinging) {
        if (currentPendingAction?.callId == call.id &&
            currentPendingAction?.action == 'show') {
          _pendingNativeAction = null;
        }
        _scheduleIncomingCall(call);
      } else if (includeActive &&
          call.isActive &&
          ModalRoute.of(context)?.isCurrent == true) {
        _callAttempts.begin(call.id);
        await Navigator.of(context).push<void>(
          MaterialPageRoute<void>(
            builder: (_) => FriendCallPage(initialCall: call),
          ),
        );
      }
    } catch (_) {
      // Socket delivery remains primary; polling retries after transient errors.
    } finally {
      _recovering = false;
    }
  }

  Future<void> _presentIncomingCall(FriendCallModel call) async {
    if (_dialogOpen || _callAttempts.isHandled(call.id) || !mounted) return;
    if (_resolvedOnAnotherDeviceCallId == call.id) {
      _resolvedOnAnotherDeviceCallId = null;
      return;
    }
    _dialogOpen = true;
    _callAttempts.begin(call.id);
    var responseCompleted = false;
    var attemptedAccept = false;
    var promptExpired = false;
    Timer? promptTimeout;
    ref.read(socialRealtimeProvider.notifier).consumeCall(call.id);
    try {
      await AudioCueService.cancelIncomingCallNotification(call.id);
      _notifiedCallId = null;
      if (_resolvedOnAnotherDeviceCallId == call.id) {
        responseCompleted = true;
        return;
      }
      final promptRemaining = incomingCallPromptRemaining(
        createdAt: call.createdAt,
        now: DateTime.now(),
      );
      if (promptRemaining == Duration.zero) return;
      await AudioCueService.startIncomingRingtone();
      if (!mounted) return;
      if (_resolvedOnAnotherDeviceCallId == call.id) {
        responseCompleted = true;
        return;
      }
      final dialogFuture = showDialog<FriendCallMediaType>(
        context: context,
        useRootNavigator: true,
        barrierDismissible: false,
        builder: (dialogContext) {
          _incomingDialogContext = dialogContext;
          return AlertDialog(
            title: AppText(call.mediaType.incomingTitle),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                AppText(call.peer.displayName, translate: false),
                if (call.mediaType.isVideo) ...[
                  const SizedBox(height: 8),
                  const AppText('可以关闭摄像头，仅用语音接听。'),
                ],
              ],
            ),
            actions: [
              OutlinedButton(
                onPressed: () {
                  _localResponseInFlightCallId = call.id;
                  Navigator.pop(dialogContext);
                },
                child: const AppText('拒绝'),
              ),
              if (call.mediaType.isVideo)
                TextButton.icon(
                  onPressed: () {
                    _localResponseInFlightCallId = call.id;
                    Navigator.pop(dialogContext, FriendCallMediaType.audio);
                  },
                  icon: const Icon(Icons.call),
                  label: const AppText('语音接听'),
                ),
              FilledButton.icon(
                onPressed: () {
                  _localResponseInFlightCallId = call.id;
                  Navigator.pop(dialogContext, call.mediaType);
                },
                icon:
                    Icon(call.mediaType.isVideo ? Icons.videocam : Icons.call),
                label: AppText(call.mediaType.isVideo ? '视频接听' : '接听'),
              ),
            ],
          );
        },
      );
      promptTimeout = Timer(promptRemaining, () {
        promptExpired = true;
        unawaited(AudioCueService.stopIncomingRingtone());
        final dialogContext = _incomingDialogContext;
        if (dialogContext != null && dialogContext.mounted) {
          Navigator.of(dialogContext).pop();
        } else if (mounted) {
          Navigator.of(context, rootNavigator: true).maybePop();
        }
      });
      final answerMediaType = await dialogFuture;
      promptTimeout.cancel();
      _incomingDialogContext = null;
      await AudioCueService.stopIncomingRingtone();
      if (promptExpired) return;
      if (_resolvedOnAnotherDeviceCallId == call.id) {
        responseCompleted = true;
        return;
      }
      _localResponseInFlightCallId ??= call.id;
      attemptedAccept = answerMediaType != null;
      if (attemptedAccept) _recoverActiveAfterResponseFailure = true;
      final updated = await ref.read(friendRepositoryProvider).respondToCall(
            call.id,
            accept: answerMediaType != null,
            mediaType: answerMediaType,
          );
      _recoverActiveAfterResponseFailure = false;
      responseCompleted = true;
      if (answerMediaType != null && mounted) {
        await Navigator.of(context).push<void>(
          MaterialPageRoute<void>(
            builder: (_) => FriendCallPage(initialCall: updated),
          ),
        );
      }
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(content: AppText(readableError(error))),
      );
    } finally {
      promptTimeout?.cancel();
      await AudioCueService.stopIncomingRingtone();
      _incomingDialogContext = null;
      if (_localResponseInFlightCallId == call.id) {
        _localResponseInFlightCallId = null;
      }
      if (_resolvedOnAnotherDeviceCallId == call.id) {
        _resolvedOnAnotherDeviceCallId = null;
      }
      if (!responseCompleted) _callAttempts.release(call.id);
      _dialogOpen = false;
      if (!responseCompleted && mounted) {
        if (!attemptedAccept) _recoverActiveAfterResponseFailure = false;
        unawaited(
          _recoverIncomingCall(
            includeActive: _recoverActiveAfterResponseFailure,
          ),
        );
      }
    }
  }
}
