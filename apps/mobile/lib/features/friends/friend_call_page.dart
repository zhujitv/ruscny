import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../core/audio/audio_cue_service.dart';
import '../../core/errors.dart';
import '../../core/localization/app_localization.dart';
import '../../core/models.dart';
import '../../core/providers.dart';
import '../auth/auth_controller.dart';
import 'friend_repository.dart';
import 'rtc_voice_service.dart';
import 'social_realtime_controller.dart';

const friendCallRecoveryInterval = Duration(seconds: 2);
const friendCallRingingTimeout = Duration(seconds: 60);
const friendCallPeerJoinTimeout = Duration(seconds: 30);
const friendCallPeerLeaveGrace = Duration(seconds: 5);
const friendCallPeerRecoveryTimeout = Duration(seconds: 20);

enum FriendCallRingTimeoutDecision {
  join,
  close,
  retry,
}

Duration friendCallRingingRemaining({
  required DateTime createdAt,
  required DateTime now,
}) {
  final elapsed = now.difference(createdAt);
  if (elapsed <= Duration.zero) return friendCallRingingTimeout;
  if (elapsed >= friendCallRingingTimeout) return Duration.zero;
  return friendCallRingingTimeout - elapsed;
}

FriendCallRingTimeoutDecision friendCallRingTimeoutDecision({
  required FriendCallModel? activeCall,
  required String currentCallId,
}) {
  if (activeCall?.id != currentCallId) {
    return FriendCallRingTimeoutDecision.close;
  }
  if (activeCall!.isActive) return FriendCallRingTimeoutDecision.join;
  if (activeCall.isRinging) return FriendCallRingTimeoutDecision.retry;
  return FriendCallRingTimeoutDecision.close;
}

Future<void> endFriendCallOnServerBestEffort(
  Future<void> Function() endCall,
) async {
  try {
    await endCall();
  } catch (_) {
    // The peer may already have ended the call, or the network may be gone.
  }
}

Future<void> leaveRtcBestEffort(Future<void> Function() leave) async {
  try {
    await leave();
  } catch (_) {
    // A native timeout or an already-destroyed engine must not trap the route.
  }
}

enum FriendCallPeerRecoveryDecision {
  recovered,
  ended,
  wait,
  timedOut,
}

final class FriendCallPeerJoinDeadline {
  FriendCallPeerJoinDeadline({
    required this.duration,
    required this.onTimeout,
  });

  final Duration duration;
  final void Function() onTimeout;
  Timer? _timer;

  bool get isActive => _timer?.isActive == true;

  void start() {
    if (isActive) return;
    _timer = Timer(duration, onTimeout);
  }

  void cancel() {
    _timer?.cancel();
    _timer = null;
  }
}

final class FriendCallHeartbeatScheduler {
  FriendCallHeartbeatScheduler({
    required this.onHeartbeat,
    this.interval = const Duration(seconds: 20),
  });

  final Future<void> Function() onHeartbeat;
  final Duration interval;
  Timer? _timer;

  bool get isActive => _timer?.isActive == true;

  void handleRtcState(RtcVoiceState state) {
    if (state.isJoined) {
      _startAfterJoined();
    } else if (state.isError) {
      cancel();
    }
  }

  void _startAfterJoined() {
    if (isActive) return;
    unawaited(onHeartbeat());
    _timer = Timer.periodic(interval, (_) => unawaited(onHeartbeat()));
  }

  void cancel() {
    _timer?.cancel();
    _timer = null;
  }
}

FriendCallPeerRecoveryDecision friendCallPeerRecoveryDecision({
  required bool peerPresent,
  required bool restConfirmed,
  required FriendCallModel? activeCall,
  required String currentCallId,
  required Duration disconnectedFor,
  Duration recoveryTimeout = friendCallPeerRecoveryTimeout,
}) {
  if (peerPresent) return FriendCallPeerRecoveryDecision.recovered;
  if (restConfirmed &&
      (activeCall == null ||
          activeCall.id != currentCallId ||
          !activeCall.isActive)) {
    return FriendCallPeerRecoveryDecision.ended;
  }
  if (disconnectedFor >= recoveryTimeout) {
    return FriendCallPeerRecoveryDecision.timedOut;
  }
  return FriendCallPeerRecoveryDecision.wait;
}

bool shouldRestoreRtcCameraAfterResume({
  required bool cameraEnabled,
  required bool? operationTargetEnabled,
  required bool operationIsUserInitiated,
}) =>
    operationIsUserInitiated && operationTargetEnabled != null
        ? operationTargetEnabled
        : cameraEnabled;

bool canApplyRtcCameraState({
  required bool enabled,
  required bool rtcJoined,
  required bool rtcNativeReady,
}) =>
    rtcJoined || (!enabled && rtcNativeReady);

bool shouldSuspendRtcCamera({
  required AppLifecycleState lifecycleState,
  required bool rtcJoined,
  bool rtcJoining = false,
  required bool isVideo,
  required bool cameraEnabled,
}) =>
    lifecycleState != AppLifecycleState.resumed &&
    (rtcJoined || rtcJoining) &&
    isVideo &&
    cameraEnabled;

final class FriendCallPage extends ConsumerStatefulWidget {
  const FriendCallPage({required this.initialCall, super.key});

  final FriendCallModel initialCall;

  @override
  ConsumerState<FriendCallPage> createState() => _FriendCallPageState();
}

final class _FriendCallPageState extends ConsumerState<FriendCallPage>
    with WidgetsBindingObserver {
  late FriendCallModel _call;
  late final RtcVoiceService _rtc;
  late final FriendRepository _friendRepository;
  late final SocialRealtimeController _socialRealtime;
  late final String _displayName;
  ProviderSubscription<bool>? _connectionSubscription;
  ProviderSubscription<int>? _callEventSubscription;
  StreamSubscription<RtcVoiceState>? _rtcSubscription;
  StreamSubscription<Uint8List>? _audioFrameSubscription;
  StreamSubscription<FriendCallTranslationEvent>? _translationEventSubscription;
  String _connectionState = '等待对方接听';
  bool _joining = false;
  bool _muted = false;
  bool _speaker = true;
  bool _cameraEnabled = true;
  bool _cameraOperationInFlight = false;
  bool? _cameraOperationTargetEnabled;
  bool _cameraOperationIsUserInitiated = false;
  bool _switchingCamera = false;
  bool _rtcJoined = false;
  bool _rtcJoinPending = false;
  bool _rtcNativeReady = false;
  bool _inForeground = true;
  bool _restoreCameraOnResume = false;
  bool? _pendingLifecycleCameraEnabled;
  bool _cameraDisabledNoticePending = false;
  bool _ending = false;
  bool _handlingRtcFailure = false;
  bool _rtcJoinFailed = false;
  Timer? _ringTimeout;
  Timer? _ringRecoveryTimer;
  late final FriendCallHeartbeatScheduler _heartbeat;
  FriendCallPeerJoinDeadline? _peerJoinDeadline;
  Timer? _peerRecoveryTimer;
  bool _refreshingCall = false;
  bool _heartbeatInFlight = false;
  bool _peerPresent = false;
  bool _confirmingPeerDeparture = false;
  Stopwatch? _peerRecoveryClock;
  int _heartbeatFailures = 0;
  RtcCredential? _credential;
  bool _translationStarting = false;
  bool _translationEnabled = false;
  bool _playTranslatedAudio = true;
  bool _translatedAudioActivated = false;
  String _translationStatus = '实时翻译等待通话连接';
  String _sourceText = '';
  String _translatedText = '';
  String _sourceLanguage = 'zh';
  String _targetLanguage = 'ru';
  int _audioSequence = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _call = widget.initialCall;
    _friendRepository = ref.read(friendRepositoryProvider);
    _socialRealtime = ref.read(socialRealtimeProvider.notifier);
    _heartbeat = FriendCallHeartbeatScheduler(onHeartbeat: _sendHeartbeat);
    _displayName =
        ref.read(authControllerProvider).valueOrNull?.displayName ?? '用户';
    _playTranslatedAudio = ref
            .read(authControllerProvider)
            .valueOrNull
            ?.autoPlayTranslationAudio ??
        true;
    _rtc = RtcVoiceService();
    _audioFrameSubscription = _rtc.audioFrames.listen(_sendTranslationAudio);
    _translationEventSubscription =
        _socialRealtime.callTranslationEvents.listen(_handleTranslationEvent);
    _connectionSubscription = ref.listenManual<bool>(
      socialRealtimeProvider.select((state) => state.connected),
      (previous, connected) {
        if (!mounted) return;
        if (!connected && _translationEnabled) {
          _disableRealtimeTranslation('实时连接中断，已恢复原声通话');
        } else if (connected && previous == false && _call.isActive) {
          unawaited(_startRealtimeTranslation());
        }
      },
    );
    _callEventSubscription = ref.listenManual<int>(
      socialRealtimeProvider.select((state) => state.revision),
      (previous, next) {
        if (!mounted) return;
        final realtime = ref.read(socialRealtimeProvider);
        final event = realtime.lastEvent;
        if (!friendCallEventMatches(
          currentCallId: _call.id,
          eventCallId: realtime.lastCallId,
        )) {
          return;
        }
        if (event == 'friend.call.accepted') {
          unawaited(_refreshAndJoin());
        } else if (event == 'friend.call.declined' ||
            event == 'friend.call.ended') {
          unawaited(_remoteEnded(
              event == 'friend.call.declined' ? '对方已拒绝' : '通话已结束'));
        }
      },
    );
    _rtcSubscription = _rtc.states.listen((state) {
      if (!mounted) return;
      setState(() {
        _connectionState = switch (state.value) {
          'joined' => '等待对方连接',
          'peer_joined' => '通话中',
          'peer_left' => '对方网络中断，等待重连',
          'reconnecting' => '网络波动，正在重连',
          'error' => state.userMessage,
          _ => _connectionState,
        };
        if (state.isJoined) {
          _rtcJoined = true;
          _rtcJoinPending = false;
          _rtcNativeReady = true;
          _rtcJoinFailed = false;
          _heartbeatFailures = 0;
        }
        if (state.isError) {
          _rtcJoined = false;
          _rtcJoinPending = false;
          _rtcNativeReady = false;
        }
        if (state.isCameraDisabled) _cameraEnabled = false;
      });
      _heartbeat.handleRtcState(state);
      if (state.isCameraDisabled) {
        _handleNativeCameraDisabled(state.reason);
      }
      if (state.isJoined) {
        _startPeerJoinDeadline();
        unawaited(_syncCameraAfterRtcJoin());
      }
      if (state.isPeerJoined) {
        _markPeerJoined();
        unawaited(AudioCueService.stopRingback());
        unawaited(_startRealtimeTranslation());
      }
      if (state.isPeerLeft && !_ending) {
        _markPeerDisconnected();
      }
      if (state.isError && !_ending && !_handlingRtcFailure) {
        unawaited(_handleRtcFailure(state.userMessage));
      }
    });
    if (_call.isActive) {
      unawaited(AudioCueService.stopRingback());
      unawaited(_joinRtc());
    }
    if (_call.isRinging) {
      unawaited(AudioCueService.startRingback());
      // Recover an acceptance event that may have arrived between the REST
      // response and this route being mounted.
      unawaited(_refreshAndJoin());
      _ringRecoveryTimer = Timer.periodic(
        friendCallRecoveryInterval,
        (_) => unawaited(_refreshAndJoin()),
      );
      _ringTimeout = Timer(
        friendCallRingingRemaining(
          createdAt: _call.createdAt,
          now: DateTime.now(),
        ),
        () => unawaited(_resolveRingTimeout()),
      );
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final wasForeground = _inForeground;
    _inForeground = state == AppLifecycleState.resumed;
    if (shouldSuspendRtcCamera(
      lifecycleState: state,
      rtcJoined: _rtcJoined,
      rtcJoining: _rtcJoinPending,
      isVideo: _call.mediaType.isVideo,
      cameraEnabled: _cameraEnabled || _cameraOperationTargetEnabled == true,
    )) {
      if (wasForeground) {
        _restoreCameraOnResume = shouldRestoreRtcCameraAfterResume(
          cameraEnabled: _cameraEnabled,
          operationTargetEnabled: _cameraOperationTargetEnabled,
          operationIsUserInitiated: _cameraOperationIsUserInitiated,
        );
      }
      _queueLifecycleCameraState(false);
      return;
    }
    if (state == AppLifecycleState.resumed) {
      unawaited(_restoreCameraAfterResume());
      _showPendingCameraDisabledNotice();
    }
  }

  @override
  Widget build(BuildContext context) {
    final isVideo = _call.mediaType.isVideo;
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) unawaited(_endAndClose());
      },
      child: Scaffold(
        backgroundColor: const Color(0xFF0B4338),
        body: SafeArea(
          child: Padding(
            padding: EdgeInsets.symmetric(
              horizontal: isVideo ? 16 : 28,
              vertical: isVideo ? 16 : 36,
            ),
            child: Column(
              children: [
                if (isVideo) ...[
                  Expanded(child: _buildVideoStage()),
                  const SizedBox(height: 14),
                ] else ...[
                  const Spacer(),
                  CircleAvatar(
                    radius: 54,
                    backgroundColor: Colors.white.withValues(alpha: .14),
                    child: AppText(
                      _peerInitial,
                      translate: false,
                      style: const TextStyle(fontSize: 40, color: Colors.white),
                    ),
                  ),
                  const SizedBox(height: 24),
                ],
                AppText(
                  _call.peer.displayName,
                  translate: false,
                  style: (isVideo
                          ? Theme.of(context).textTheme.titleLarge
                          : Theme.of(context).textTheme.headlineMedium)
                      ?.copyWith(
                    color: Colors.white,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 10),
                AppText(
                  _connectionState,
                  style: const TextStyle(color: Color(0xFFC5DAD4)),
                ),
                if (_call.isActive && _rtcJoinFailed) ...[
                  const SizedBox(height: 14),
                  FilledButton.tonalIcon(
                    onPressed: _joining ? null : _joinRtc,
                    icon: const Icon(Icons.refresh),
                    label: const AppText('重新连接'),
                  ),
                ],
                const SizedBox(height: 18),
                _TranslationPanel(
                  enabled: _translationEnabled,
                  status: _translationStatus,
                  sourceText: _sourceText,
                  translatedText: _translatedText,
                  sourceLanguage: _sourceLanguage,
                  targetLanguage: _targetLanguage,
                ),
                if (!isVideo) const Spacer() else const SizedBox(height: 18),
                FriendCallControlBar(
                  isVideo: isVideo,
                  isActive: _call.isActive && _rtcJoined && !_ending,
                  muted: _muted,
                  cameraEnabled: _cameraEnabled,
                  cameraOperationInFlight: _cameraOperationInFlight,
                  speakerEnabled: _speaker,
                  ending: _ending,
                  switchingCamera: _switchingCamera,
                  onToggleMute: _toggleMute,
                  onToggleCamera: _toggleCamera,
                  onHangUp: _endAndClose,
                  onSwitchCamera: _switchCamera,
                  onToggleSpeaker: _toggleSpeaker,
                ),
                SizedBox(height: isVideo ? 10 : 32),
              ],
            ),
          ),
        ),
      ),
    );
  }

  String get _peerInitial {
    final name = _call.peer.displayName.trim();
    return name.isEmpty ? '好' : name.characters.first;
  }

  Widget _buildVideoStage() => ClipRRect(
        borderRadius: BorderRadius.circular(24),
        child: ColoredBox(
          color: const Color(0xFF062C25),
          child: Stack(
            fit: StackFit.expand,
            children: [
              const RtcVideoView(role: RtcVideoRole.remote),
              if (!_call.isActive)
                ColoredBox(
                  color: const Color(0xFF0A392F).withValues(alpha: .86),
                  child: Center(
                    child: CircleAvatar(
                      radius: 48,
                      backgroundColor: Colors.white.withValues(alpha: .14),
                      child: AppText(
                        _peerInitial,
                        translate: false,
                        style:
                            const TextStyle(fontSize: 36, color: Colors.white),
                      ),
                    ),
                  ),
                ),
              Positioned(
                left: 12,
                top: 12,
                child: _VideoBadge(label: _call.mediaType.label),
              ),
              Positioned(
                right: 12,
                top: 12,
                width: 104,
                height: 142,
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(16),
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: const Color(0xFF183F38),
                      border: Border.all(
                        color: Colors.white.withValues(alpha: .24),
                      ),
                    ),
                    child: _cameraEnabled
                        ? const RtcVideoView(role: RtcVideoRole.local)
                        : const Center(
                            child: Icon(
                              Icons.videocam_off,
                              color: Colors.white54,
                            ),
                          ),
                  ),
                ),
              ),
            ],
          ),
        ),
      );

  Future<void> _refreshAndJoin() async {
    if (_refreshingCall || !_call.isRinging || !mounted) return;
    _refreshingCall = true;
    try {
      final active = await _friendRepository.activeCall();
      if (!mounted ||
          active == null ||
          active.id != _call.id ||
          !active.isActive) {
        return;
      }
      setState(() => _call = active);
      _ringTimeout?.cancel();
      _ringRecoveryTimer?.cancel();
      await AudioCueService.stopRingback();
      await _joinRtc();
    } catch (error) {
      if (mounted) setState(() => _connectionState = readableError(error));
    } finally {
      _refreshingCall = false;
    }
  }

  Future<void> _resolveRingTimeout() async {
    if (_ending || !mounted || !_call.isRinging) return;
    if (_refreshingCall) {
      _scheduleRingTimeoutConfirmation();
      return;
    }
    _refreshingCall = true;
    try {
      final active = await _friendRepository.activeCall();
      if (!mounted || _ending || !_call.isRinging) return;
      switch (friendCallRingTimeoutDecision(
        activeCall: active,
        currentCallId: _call.id,
      )) {
        case FriendCallRingTimeoutDecision.join:
          setState(() => _call = active!);
          _ringTimeout?.cancel();
          _ringRecoveryTimer?.cancel();
          await AudioCueService.stopRingback();
          await _joinRtc();
          return;
        case FriendCallRingTimeoutDecision.close:
          // The server has already expired or closed this ringing call. Close
          // only the stale local route: /end can also terminate ACTIVE calls,
          // so it must not be used after a timeout race.
          await _endAndClose(notifyServer: false);
          return;
        case FriendCallRingTimeoutDecision.retry:
          if (mounted) setState(() => _connectionState = '正在确认接听状态');
          _scheduleRingTimeoutConfirmation();
          return;
      }
    } catch (error) {
      if (mounted && !_ending) {
        setState(() => _connectionState = readableError(error));
        _scheduleRingTimeoutConfirmation();
      }
    } finally {
      _refreshingCall = false;
    }
  }

  void _scheduleRingTimeoutConfirmation() {
    _ringTimeout?.cancel();
    _ringTimeout = Timer(
      friendCallRecoveryInterval,
      () => unawaited(_resolveRingTimeout()),
    );
  }

  Future<void> _joinRtc() async {
    if (_joining || !_call.isActive) return;
    _joining = true;
    _rtcJoinPending = true;
    _rtcNativeReady = false;
    if (mounted) {
      setState(() {
        _rtcJoinFailed = false;
        _connectionState = '正在连接';
      });
    }
    try {
      final permission = await Permission.microphone.request();
      if (!mounted || _ending) {
        _rtcJoinPending = false;
        return;
      }
      if (!permission.isGranted) {
        throw const AppException('需要麦克风权限才能进行实时通话');
      }
      if (_call.mediaType.isVideo) {
        final cameraPermission = await Permission.camera.request();
        if (!mounted || _ending) {
          _rtcJoinPending = false;
          return;
        }
        if (!cameraPermission.isGranted && mounted) {
          setState(() => _cameraEnabled = false);
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: AppText('相机未授权，将关闭画面继续通话')),
          );
        }
      }
      final credential = await _friendRepository.rtcCredential(
        _call.id,
        mediaType: _call.mediaType,
      );
      if (!mounted || _ending) {
        _rtcJoinPending = false;
        return;
      }
      _credential = credential;
      final initialCameraEnabled =
          _call.mediaType.isVideo && _cameraEnabled && _inForeground;
      if (_call.mediaType.isVideo && _cameraEnabled) {
        if (_inForeground) {
          // A resume before the native join can satisfy the restore request
          // through the initial join itself.
          _restoreCameraOnResume = false;
          _pendingLifecycleCameraEnabled = null;
        } else {
          _restoreCameraOnResume = true;
          _pendingLifecycleCameraEnabled = false;
        }
      }
      await _rtc.join(
        credential,
        _displayName,
        mediaType: _call.mediaType,
        cameraEnabled: initialCameraEnabled,
      );
      if (!mounted || _ending) {
        _rtcJoinPending = false;
        await leaveRtcBestEffort(_rtc.leave);
        return;
      }
      _rtcNativeReady = true;
      // The engine and preview now exist even though the asynchronous joined
      // state may not have arrived. Apply a queued background suspension now.
      await _drainLifecycleCameraState();
    } catch (error) {
      _rtcJoinPending = false;
      _rtcNativeReady = false;
      if (!_ending) await _handleRtcFailure(readableError(error));
    } finally {
      _joining = false;
    }
  }

  Future<void> _startRealtimeTranslation() async {
    if (_translationStarting ||
        _translationEnabled ||
        !_call.isActive ||
        !_rtcJoined ||
        !_peerPresent) {
      return;
    }
    final credential = _credential;
    if (credential == null || !credential.realtimeTranslationAvailable) {
      if (mounted) {
        setState(() {
          _translationStatus = '实时翻译未配置，当前为原声通话';
        });
      }
      return;
    }
    _translationStarting = true;
    if (mounted) setState(() => _translationStatus = '正在连接实时翻译');
    try {
      final ready = await _socialRealtime.startCallTranslation(_call.id);
      await _rtc.setTranslationMode(
        true,
        // Keep the original remote voice until the first translated PCM chunk
        // arrives. This preserves audio when the peer is still connecting or
        // is running an older client that cannot upload translation audio.
        muteRemoteAudio: false,
      );
      if (!mounted) return;
      setState(() {
        _translationEnabled = true;
        _sourceLanguage = ready.sourceLanguage ?? _sourceLanguage;
        _targetLanguage = ready.targetLanguage ?? _targetLanguage;
        _translationStatus =
            !_playTranslatedAudio ? '实时字幕已开启，译音频按个人偏好关闭' : '中俄实时翻译已开启';
      });
    } catch (error) {
      _socialRealtime.finishCallTranslation(_call.id);
      try {
        await _rtc.setTranslationMode(false);
      } catch (routeError) {
        if (mounted && !_ending) {
          await _handleRtcFailure(readableError(routeError));
        }
        return;
      }
      if (mounted) {
        setState(() {
          _translationEnabled = false;
          _translationStatus = readableError(error);
        });
      }
    } finally {
      _translationStarting = false;
    }
  }

  void _sendTranslationAudio(Uint8List audio) {
    if (!_translationEnabled || audio.isEmpty || _ending) return;
    _socialRealtime.sendCallTranslationAudio(
      _call.id,
      base64Encode(audio),
      _audioSequence++,
    );
  }

  void _handleTranslationEvent(FriendCallTranslationEvent event) {
    if (!mounted || event.callId != _call.id) return;
    switch (event.type) {
      case 'source.partial':
      case 'source.final':
        if (event.text?.isNotEmpty == true) {
          setState(() {
            _sourceText = event.text!;
            _sourceLanguage = event.language ?? _sourceLanguage;
          });
        }
        break;
      case 'translation.partial':
      case 'translation.final':
        if (event.text?.isNotEmpty == true) {
          setState(() {
            _translatedText = event.text!;
            _targetLanguage = event.language ?? _targetLanguage;
          });
        }
        break;
      case 'friend.call.translation.audio':
        if (!_translationEnabled ||
            !_playTranslatedAudio ||
            event.audio?.isNotEmpty != true) {
          return;
        }
        unawaited(_playTranslationAudioEvent(event));
        break;
      case 'friend.call.translation.error':
        _disableRealtimeTranslation(
          event.message ?? '实时翻译服务暂时不可用，已恢复原声通话',
        );
        break;
      case 'friend.call.translation.finished':
        _disableRealtimeTranslation('实时翻译已结束，当前为原声通话');
        break;
      default:
        break;
    }
  }

  void _disableRealtimeTranslation(String message) {
    if (!_translationEnabled && !_translationStarting) {
      if (mounted) setState(() => _translationStatus = message);
      return;
    }
    _translationEnabled = false;
    _translationStarting = false;
    _translatedAudioActivated = false;
    _socialRealtime.finishCallTranslation(_call.id);
    if (mounted) setState(() => _translationStatus = '正在恢复原声通话');
    unawaited(_restoreOriginalAudio(message));
  }

  Future<void> _restoreOriginalAudio(String successMessage) async {
    try {
      await _rtc.setTranslationMode(false);
      if (mounted && !_ending) {
        setState(() => _translationStatus = successMessage);
      }
    } catch (error) {
      if (mounted && !_ending) {
        await _handleRtcFailure(readableError(error));
      }
    }
  }

  Future<void> _playTranslationAudioEvent(
    FriendCallTranslationEvent event,
  ) async {
    try {
      final audio = base64Decode(event.audio!);
      if (!_translatedAudioActivated) {
        _translatedAudioActivated = true;
        await _rtc.setTranslationMode(true, muteRemoteAudio: true);
      }
      await _rtc.playTranslationAudio(audio, event.sampleRate ?? 24000);
    } catch (_) {
      _disableRealtimeTranslation('译音频播放失败，已恢复原声通话');
    }
  }

  Future<void> _toggleMute() async {
    if (!_rtcJoined || _ending) return;
    final next = !_muted;
    try {
      if (!next) {
        // Keep the mic muted until the user hears that capture is ready.
        await AudioCueService.playTalkReady();
        if (!mounted || !_call.isActive || _ending || !_rtcJoined) return;
      }
      await _rtc.setMuted(next);
      if (mounted) setState(() => _muted = next);
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: AppText(readableError(error))),
        );
      }
    }
  }

  Future<void> _toggleSpeaker() async {
    if (!_rtcJoined || _ending) return;
    final next = !_speaker;
    try {
      await _rtc.setSpeaker(next);
      if (mounted) setState(() => _speaker = next);
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: AppText(readableError(error))),
        );
      }
    }
  }

  Future<void> _toggleCamera() async {
    if (_cameraOperationInFlight || _switchingCamera || !_rtcJoined) return;
    final next = !_cameraEnabled;
    setState(() {
      _cameraOperationInFlight = true;
      _cameraOperationTargetEnabled = next;
      _cameraOperationIsUserInitiated = true;
    });
    try {
      if (next) {
        final permission = await Permission.camera.request();
        if (!mounted || _ending || !_rtcJoined) return;
        if (!permission.isGranted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: AppText('需要相机权限才能开启画面')),
          );
          return;
        }
      }
      await _applyCameraState(next, showError: true);
    } finally {
      if (mounted) {
        setState(() {
          _cameraOperationInFlight = false;
          _cameraOperationTargetEnabled = null;
          _cameraOperationIsUserInitiated = false;
        });
      }
      unawaited(_drainLifecycleCameraState());
    }
  }

  Future<void> _switchCamera() async {
    if (_switchingCamera || _cameraOperationInFlight || !_rtcJoined) return;
    setState(() => _switchingCamera = true);
    try {
      await _rtc.switchCamera();
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: AppText(readableError(error))),
        );
      }
    } finally {
      if (mounted) setState(() => _switchingCamera = false);
    }
  }

  void _queueLifecycleCameraState(bool enabled) {
    if (_ending || !_call.mediaType.isVideo) return;
    _pendingLifecycleCameraEnabled = enabled;
    unawaited(_drainLifecycleCameraState());
  }

  Future<void> _drainLifecycleCameraState() async {
    if (_cameraOperationInFlight || _ending || !mounted) return;
    while (mounted && !_ending) {
      final enabled = _pendingLifecycleCameraEnabled;
      if (enabled == null) return;
      if (!_call.mediaType.isVideo ||
          !canApplyRtcCameraState(
            enabled: enabled,
            rtcJoined: _rtcJoined,
            rtcNativeReady: _rtcNativeReady,
          )) {
        return;
      }
      _pendingLifecycleCameraEnabled = null;
      if (enabled && !_inForeground) continue;
      if (enabled == _cameraEnabled) continue;
      await _performCameraOperation(enabled, showError: false);
    }
  }

  Future<bool> _performCameraOperation(
    bool enabled, {
    required bool showError,
  }) async {
    if (_cameraOperationInFlight ||
        !mounted ||
        _ending ||
        (enabled && !_inForeground)) {
      return false;
    }
    setState(() {
      _cameraOperationInFlight = true;
      _cameraOperationTargetEnabled = enabled;
      _cameraOperationIsUserInitiated = false;
    });
    try {
      return await _applyCameraState(enabled, showError: showError);
    } finally {
      if (mounted) {
        setState(() {
          _cameraOperationInFlight = false;
          _cameraOperationTargetEnabled = null;
          _cameraOperationIsUserInitiated = false;
        });
      }
    }
  }

  Future<bool> _applyCameraState(
    bool enabled, {
    required bool showError,
  }) async {
    if (!mounted ||
        _ending ||
        !canApplyRtcCameraState(
          enabled: enabled,
          rtcJoined: _rtcJoined,
          rtcNativeReady: _rtcNativeReady,
        ) ||
        (enabled && !_inForeground)) {
      return false;
    }
    try {
      await _rtc.setCameraEnabled(enabled);
      if (!mounted || _ending) return false;
      if (enabled && !_inForeground) {
        // The lifecycle can change while the platform call is in flight. Undo
        // a successful enable immediately so the camera never remains active
        // after the app moves to the background.
        try {
          await _rtc.setCameraEnabled(false);
        } catch (_) {
          // Native will also emit camera_disabled when it corrects the state.
        }
        return false;
      }
      setState(() {
        _cameraEnabled = enabled;
        if (enabled) _cameraDisabledNoticePending = false;
      });
      return true;
    } catch (error) {
      if (showError && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: AppText(readableError(error))),
        );
      }
      return false;
    }
  }

  Future<void> _restoreCameraAfterResume() async {
    if (!_restoreCameraOnResume ||
        _ending ||
        !_rtcJoined ||
        !_call.mediaType.isVideo) {
      return;
    }
    final permission = await Permission.camera.status;
    if (!mounted || !_inForeground || !_restoreCameraOnResume) return;
    _restoreCameraOnResume = false;
    if (!permission.isGranted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: AppText('需要相机权限才能开启画面')),
      );
      return;
    }
    _queueLifecycleCameraState(true);
  }

  Future<void> _syncCameraAfterRtcJoin() async {
    await _drainLifecycleCameraState();
    if (_inForeground) await _restoreCameraAfterResume();
  }

  void _handleNativeCameraDisabled(String? reason) {
    if (reason == 'disable_partial_failure') return;

    // A native correction means the camera could not remain enabled. Do not
    // automatically retry it after a lifecycle resume; leave the user in the
    // explicit receive-only state until they choose to enable it again.
    _restoreCameraOnResume = false;
    _pendingLifecycleCameraEnabled = null;
    _cameraDisabledNoticePending = true;
    _showPendingCameraDisabledNotice();
  }

  void _showPendingCameraDisabledNotice() {
    if (!_cameraDisabledNoticePending || !mounted || !_inForeground) return;
    _cameraDisabledNoticePending = false;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      const SnackBar(content: AppText('摄像头不可用，已切换为仅接收对方视频')),
    );
  }

  void _startPeerJoinDeadline() {
    if (_ending || !_call.isActive || _peerPresent) return;
    _peerJoinDeadline ??= FriendCallPeerJoinDeadline(
      duration: friendCallPeerJoinTimeout,
      onTimeout: () {
        if (!mounted || _ending || _peerPresent) return;
        unawaited(_remoteEnded('对方连接超时，通话已结束'));
      },
    );
    _peerJoinDeadline!.start();
  }

  void _markPeerJoined() {
    _peerPresent = true;
    _peerJoinDeadline?.cancel();
    _peerRecoveryTimer?.cancel();
    _peerRecoveryTimer = null;
    _peerRecoveryClock?.stop();
    _peerRecoveryClock = null;
  }

  void _markPeerDisconnected() {
    if (_ending) return;
    _peerPresent = false;
    _peerJoinDeadline?.cancel();
    _peerRecoveryClock ??= Stopwatch()..start();
    _peerRecoveryTimer?.cancel();
    _peerRecoveryTimer = Timer(
      friendCallPeerLeaveGrace,
      () => unawaited(_confirmPeerDeparture()),
    );
  }

  Future<void> _confirmPeerDeparture() async {
    if (_confirmingPeerDeparture || _ending || _peerPresent || !mounted) return;
    _confirmingPeerDeparture = true;
    FriendCallModel? activeCall;
    var restConfirmed = false;
    try {
      activeCall = await _friendRepository.activeCall();
      restConfirmed = true;
    } catch (_) {
      // A failed status read is not proof that the peer left. Keep the short
      // recovery window open and let RTC or a later REST read confirm it.
    } finally {
      _confirmingPeerDeparture = false;
    }
    if (!mounted || _ending) return;
    final disconnectedFor =
        _peerRecoveryClock?.elapsed ?? friendCallPeerRecoveryTimeout;
    final decision = friendCallPeerRecoveryDecision(
      peerPresent: _peerPresent,
      restConfirmed: restConfirmed,
      activeCall: activeCall,
      currentCallId: _call.id,
      disconnectedFor: disconnectedFor,
    );
    switch (decision) {
      case FriendCallPeerRecoveryDecision.recovered:
        return;
      case FriendCallPeerRecoveryDecision.ended:
        await _remoteEnded('通话已结束');
        return;
      case FriendCallPeerRecoveryDecision.timedOut:
        await _remoteEnded('对方连接超时，通话已结束');
        return;
      case FriendCallPeerRecoveryDecision.wait:
        if (mounted) {
          setState(() => _connectionState = '对方网络中断，等待重连');
        }
        final remaining = friendCallPeerRecoveryTimeout - disconnectedFor;
        final nextDelay = remaining < friendCallPeerLeaveGrace
            ? remaining
            : friendCallPeerLeaveGrace;
        _peerRecoveryTimer?.cancel();
        _peerRecoveryTimer = Timer(
          nextDelay <= Duration.zero ? Duration.zero : nextDelay,
          () => unawaited(_confirmPeerDeparture()),
        );
    }
  }

  Future<void> _remoteEnded(String message) async {
    if (_ending) return;
    _ending = true;
    _rtcJoined = false;
    _rtcJoinPending = false;
    _rtcNativeReady = false;
    _pendingLifecycleCameraEnabled = null;
    if (mounted) setState(() {});
    _heartbeat.cancel();
    _ringRecoveryTimer?.cancel();
    _peerJoinDeadline?.cancel();
    _peerRecoveryTimer?.cancel();
    unawaited(
      endFriendCallOnServerBestEffort(
        () => _friendRepository.endCall(_call.id),
      ),
    );
    await AudioCueService.stopRingback();
    _socialRealtime.finishCallTranslation(_call.id);
    _translationEnabled = false;
    try {
      await _rtc.setTranslationMode(false);
    } catch (_) {
      // The peer departure may coincide with native RTC teardown.
    }
    try {
      await _rtc.leave();
    } catch (_) {
      // The native engine may already be gone; the page must still close.
    }
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: AppText(message)));
    Navigator.pop(context);
  }

  Future<void> _endAndClose({bool notifyServer = true}) async {
    if (_ending) return;
    setState(() => _ending = true);
    _rtcJoined = false;
    _rtcJoinPending = false;
    _rtcNativeReady = false;
    _pendingLifecycleCameraEnabled = null;
    _heartbeat.cancel();
    _peerJoinDeadline?.cancel();
    _peerRecoveryTimer?.cancel();
    _peerRecoveryTimer = null;
    _peerRecoveryClock?.stop();
    _peerRecoveryClock = null;
    _ringRecoveryTimer?.cancel();
    await AudioCueService.stopRingback();
    _socialRealtime.finishCallTranslation(_call.id);
    _translationEnabled = false;
    if (notifyServer) {
      try {
        await _friendRepository.endCall(_call.id);
      } catch (_) {
        // Local audio must still stop when the server already ended the call.
      }
    }
    await leaveRtcBestEffort(_rtc.leave);
    if (mounted) Navigator.pop(context);
  }

  Future<void> _sendHeartbeat() async {
    if (_heartbeatInFlight || _ending || !_rtcJoined) return;
    _heartbeatInFlight = true;
    try {
      await _friendRepository.heartbeatCall(_call.id);
      _heartbeatFailures = 0;
    } catch (_) {
      _heartbeatFailures += 1;
      if (_heartbeatFailures >= 3 && mounted && !_ending) {
        await _remoteEnded('通话连接已失效');
      }
    } finally {
      _heartbeatInFlight = false;
    }
  }

  Future<void> _handleRtcFailure(String message) async {
    if (_handlingRtcFailure || _ending) return;
    _handlingRtcFailure = true;
    await AudioCueService.stopRingback();
    _socialRealtime.finishCallTranslation(_call.id);
    _translationEnabled = false;
    _rtcJoined = false;
    _rtcJoinPending = false;
    _rtcNativeReady = false;
    _pendingLifecycleCameraEnabled = null;
    _heartbeat.cancel();
    _peerJoinDeadline?.cancel();
    _peerRecoveryTimer?.cancel();
    _peerRecoveryTimer = null;
    _peerRecoveryClock?.stop();
    _peerRecoveryClock = null;
    try {
      await _rtc.leave();
    } catch (_) {
      // A failed native join may already have disposed the engine.
    }
    if (mounted) {
      setState(() {
        _rtcJoinFailed = true;
        _connectionState = message;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: AppText(message)),
      );
    }
    _handlingRtcFailure = false;
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _connectionSubscription?.close();
    _callEventSubscription?.close();
    unawaited(_rtcSubscription?.cancel());
    unawaited(_audioFrameSubscription?.cancel());
    unawaited(_translationEventSubscription?.cancel());
    _ringTimeout?.cancel();
    _ringRecoveryTimer?.cancel();
    _heartbeat.cancel();
    _peerJoinDeadline?.cancel();
    _peerRecoveryTimer?.cancel();
    unawaited(AudioCueService.stopRingback());
    _socialRealtime.finishCallTranslation(_call.id);
    unawaited(_rtc.dispose());
    super.dispose();
  }
}

final class _TranslationPanel extends StatelessWidget {
  const _TranslationPanel({
    required this.enabled,
    required this.status,
    required this.sourceText,
    required this.translatedText,
    required this.sourceLanguage,
    required this.targetLanguage,
  });

  final bool enabled;
  final String status;
  final String sourceText;
  final String translatedText;
  final String sourceLanguage;
  final String targetLanguage;

  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        constraints: const BoxConstraints(minHeight: 82),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        decoration: BoxDecoration(
          color: Colors.white.withValues(alpha: .1),
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: Colors.white.withValues(alpha: .12)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  enabled ? Icons.translate : Icons.graphic_eq,
                  size: 17,
                  color: enabled
                      ? const Color(0xFFD8F27B)
                      : const Color(0xFFB2C7C1),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: AppText(
                    status,
                    style: const TextStyle(
                      color: Color(0xFFD7E5E1),
                      fontSize: 13,
                    ),
                  ),
                ),
              ],
            ),
            if (sourceText.isNotEmpty) ...[
              const SizedBox(height: 12),
              _TranslationLine(
                language: sourceLanguage,
                label: sourceLanguage == 'ru' ? '俄文原文' : '中文原文',
                text: sourceText,
                muted: true,
              ),
            ],
            if (translatedText.isNotEmpty) ...[
              const SizedBox(height: 8),
              _TranslationLine(
                language: targetLanguage,
                label: targetLanguage == 'ru' ? '俄文译文' : '中文译文',
                text: translatedText,
                muted: false,
              ),
            ],
          ],
        ),
      );
}

final class _TranslationLine extends StatelessWidget {
  const _TranslationLine({
    required this.language,
    required this.label,
    required this.text,
    required this.muted,
  });

  final String language;
  final String label;
  final String text;
  final bool muted;

  @override
  Widget build(BuildContext context) => Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(language == 'ru' ? '🇷🇺' : '🇨🇳'),
          const SizedBox(width: 6),
          SizedBox(
            width: 62,
            child: AppText(
              label,
              style: TextStyle(
                color: Colors.white.withValues(alpha: .65),
                fontSize: 12,
              ),
            ),
          ),
          Expanded(
            child: AppText(
              text,
              translate: false,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: muted ? const Color(0xFFCAD9D5) : Colors.white,
                fontSize: 15,
                height: 1.35,
                fontWeight: muted ? FontWeight.w400 : FontWeight.w600,
              ),
            ),
          ),
        ],
      );
}

final class FriendCallControlBar extends StatelessWidget {
  const FriendCallControlBar({
    required this.isVideo,
    required this.isActive,
    required this.muted,
    required this.cameraEnabled,
    required this.cameraOperationInFlight,
    required this.speakerEnabled,
    required this.ending,
    required this.switchingCamera,
    required this.onToggleMute,
    required this.onToggleCamera,
    required this.onHangUp,
    required this.onSwitchCamera,
    required this.onToggleSpeaker,
    super.key,
  });

  final bool isVideo;
  final bool isActive;
  final bool muted;
  final bool cameraEnabled;
  final bool cameraOperationInFlight;
  final bool speakerEnabled;
  final bool ending;
  final bool switchingCamera;
  final VoidCallback onToggleMute;
  final VoidCallback onToggleCamera;
  final VoidCallback onHangUp;
  final VoidCallback onSwitchCamera;
  final VoidCallback onToggleSpeaker;

  @override
  Widget build(BuildContext context) {
    final mute = _RoundCallButton(
      key: const ValueKey('call-control-mute'),
      icon: muted ? Icons.mic_off : Icons.mic,
      label: muted ? '取消静音' : '静音',
      onPressed: isActive ? onToggleMute : null,
      compact: isVideo,
    );
    final hangUp = _RoundCallButton(
      key: const ValueKey('call-control-hang-up'),
      icon: Icons.call_end,
      label: '挂断',
      destructive: true,
      onPressed: ending ? null : onHangUp,
      compact: isVideo,
    );
    final speaker = _RoundCallButton(
      key: const ValueKey('call-control-speaker'),
      icon: speakerEnabled ? Icons.volume_up : Icons.hearing,
      label: speakerEnabled ? '扬声器' : '听筒',
      onPressed: isActive ? onToggleSpeaker : null,
      compact: isVideo,
    );
    if (!isVideo) {
      return Row(
        mainAxisAlignment: MainAxisAlignment.spaceEvenly,
        children: [
          Expanded(child: mute),
          Expanded(child: hangUp),
          Expanded(child: speaker),
        ],
      );
    }
    return Wrap(
      alignment: WrapAlignment.center,
      runAlignment: WrapAlignment.center,
      spacing: 8,
      runSpacing: 10,
      children: [
        SizedBox(width: 68, child: mute),
        SizedBox(
          width: 68,
          child: _RoundCallButton(
            key: const ValueKey('call-control-camera'),
            icon: cameraEnabled ? Icons.videocam : Icons.videocam_off,
            label: cameraEnabled ? '关摄像头' : '开摄像头',
            onPressed: isActive && !cameraOperationInFlight && !switchingCamera
                ? onToggleCamera
                : null,
            compact: true,
          ),
        ),
        SizedBox(width: 68, child: hangUp),
        SizedBox(
          width: 68,
          child: _RoundCallButton(
            key: const ValueKey('call-control-switch-camera'),
            icon: Icons.cameraswitch,
            label: '切换镜头',
            onPressed: isActive &&
                    cameraEnabled &&
                    !cameraOperationInFlight &&
                    !switchingCamera
                ? onSwitchCamera
                : null,
            compact: true,
          ),
        ),
        SizedBox(width: 68, child: speaker),
      ],
    );
  }
}

final class _VideoBadge extends StatelessWidget {
  const _VideoBadge({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) => DecoratedBox(
        decoration: BoxDecoration(
          color: Colors.black.withValues(alpha: .42),
          borderRadius: BorderRadius.circular(999),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.videocam, size: 15, color: Colors.white),
              const SizedBox(width: 5),
              AppText(
                label,
                style: const TextStyle(color: Colors.white, fontSize: 12),
              ),
            ],
          ),
        ),
      );
}

final class _RoundCallButton extends StatelessWidget {
  const _RoundCallButton({
    required this.icon,
    required this.label,
    required this.onPressed,
    this.destructive = false,
    this.compact = false,
    super.key,
  });

  final IconData icon;
  final String label;
  final VoidCallback? onPressed;
  final bool destructive;
  final bool compact;

  @override
  Widget build(BuildContext context) => Column(
        children: [
          IconButton.filled(
            onPressed: onPressed,
            style: IconButton.styleFrom(
              fixedSize: Size.square(compact ? 54 : 64),
              backgroundColor: destructive
                  ? const Color(0xFFE65353)
                  : Colors.white.withValues(alpha: .16),
              disabledBackgroundColor: Colors.white.withValues(alpha: .08),
              foregroundColor: Colors.white,
            ),
            icon: Icon(icon, size: compact ? 24 : 28),
          ),
          SizedBox(height: compact ? 5 : 8),
          AppText(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: TextStyle(
              color: Colors.white,
              fontSize: compact ? 12 : null,
            ),
          ),
        ],
      );
}
