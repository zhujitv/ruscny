import 'dart:async';
import 'dart:developer' as developer;
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/errors.dart';
import '../../core/models.dart';

const rtcJoinPlatformTimeout = Duration(seconds: 10);
const rtcLeavePlatformTimeout = Duration(seconds: 5);

final class RtcVoiceState {
  const RtcVoiceState({
    required this.value,
    this.code,
    this.message,
    this.phase,
    this.category,
    this.reason,
  });

  final String value;
  final int? code;
  final String? message;
  final String? phase;
  final String? category;
  final String? reason;

  bool get isJoined => value == 'joined';
  bool get isPeerJoined => value == 'peer_joined';
  bool get isPeerLeft => value == 'peer_left';
  bool get isCameraDisabled => value == 'camera_disabled';
  bool get isError => value == 'error';

  String get userMessage {
    if (!isError) return value;
    if (category == 'authentication' ||
        category == 'credential' ||
        phase == 'sync_join' ||
        phase == 'preflight') {
      return '实时通话服务鉴权失败，请重新拨打';
    }
    if (category == 'account') return '实时通话服务账号不可用，请联系管理员';
    if (category == 'network') return '实时通话网络连接失败，请检查网络后重试';
    return '实时通话连接失败，请重试';
  }
}

String rtcJoinFailureMessage(PlatformException error) => switch (error.code) {
      'RTC_JOIN_REJECTED' || 'INVALID_RTC_CREDENTIAL' => '实时通话服务鉴权失败，请重新拨打',
      _ => '实时通话连接失败，请重试',
    };

Map<String, dynamic> rtcJoinArguments(
  RtcCredential credential,
  String displayName, {
  FriendCallMediaType mediaType = FriendCallMediaType.audio,
  bool? cameraEnabled,
}) =>
    {
      ...credential.toJson(),
      'displayName': displayName,
      'mediaType': mediaType.wireValue,
      'cameraEnabled': cameraEnabled ?? mediaType.isVideo,
    };

enum RtcVideoRole {
  local,
  remote;

  String get wireValue => name;
}

final class RtcVideoView extends StatelessWidget {
  const RtcVideoView({required this.role, super.key});

  static const viewType = 'com.tooyei.translator/rtc_video';

  final RtcVideoRole role;

  @override
  Widget build(BuildContext context) {
    if (!Platform.isAndroid) {
      return ColoredBox(
        key: ValueKey('rtc-video-${role.wireValue}-placeholder'),
        color: const Color(0xFF163F37),
        child: Center(
          child: Icon(
            role == RtcVideoRole.local ? Icons.person : Icons.videocam,
            color: Colors.white38,
          ),
        ),
      );
    }
    return AndroidView(
      key: ValueKey('rtc-video-${role.wireValue}'),
      viewType: viewType,
      creationParams: {'role': role.wireValue},
      creationParamsCodec: const StandardMessageCodec(),
    );
  }
}

final class RtcVoiceService {
  RtcVoiceService({
    Duration joinTimeout = rtcJoinPlatformTimeout,
    Duration leaveTimeout = rtcLeavePlatformTimeout,
    bool? androidPlatform,
  })  : _joinTimeout = joinTimeout,
        _leaveTimeout = leaveTimeout,
        _androidPlatform = androidPlatform ?? Platform.isAndroid {
    _owner = this;
    _channel.setMethodCallHandler(_handleNativeCall);
  }

  static const _channel = MethodChannel('com.tooyei.translator/rtc');
  static RtcVoiceService? _owner;
  final _states = StreamController<RtcVoiceState>.broadcast();
  final _audioFrames = StreamController<Uint8List>.broadcast();
  final Duration _joinTimeout;
  final Duration _leaveTimeout;
  final bool _androidPlatform;

  Stream<RtcVoiceState> get states => _states.stream;
  Stream<Uint8List> get audioFrames => _audioFrames.stream;

  Future<void> join(
    RtcCredential credential,
    String displayName, {
    FriendCallMediaType mediaType = FriendCallMediaType.audio,
    bool? cameraEnabled,
  }) async {
    if (!_androidPlatform) {
      throw const AppException('当前版本先支持 Android 实时音视频通话');
    }
    if (credential.expiresAt <= DateTime.now().millisecondsSinceEpoch ~/ 1000) {
      throw const AppException('RTC 鉴权已过期，请重新拨打');
    }
    try {
      await _channel
          .invokeMethod<int>(
            'join',
            rtcJoinArguments(
              credential,
              displayName,
              mediaType: mediaType,
              cameraEnabled: cameraEnabled,
            ),
          )
          .timeout(_joinTimeout);
    } on TimeoutException {
      throw const AppException(
        '实时通话连接超时，请重试',
        code: 'RTC_JOIN_TIMEOUT',
      );
    } on PlatformException catch (error) {
      final details = error.details;
      final phase = details is Map ? details['phase']?.toString() : null;
      final rawCode = details is Map ? details['code']?.toString() : null;
      developer.log(
        'join rejected phase=${phase ?? 'unknown'} code=${rawCode ?? 'unavailable'}',
        name: 'rtc.voice',
      );
      throw AppException(
        rtcJoinFailureMessage(error),
        code: error.code == 'RTC_JOIN_REJECTED' ||
                error.code == 'INVALID_RTC_CREDENTIAL'
            ? 'RTC_AUTH_FAILED'
            : 'RTC_JOIN_FAILED',
      );
    }
  }

  Future<void> leave() async {
    try {
      await _channel.invokeMethod<void>('leave').timeout(_leaveTimeout);
    } on TimeoutException {
      throw const AppException(
        '实时通话释放超时',
        code: 'RTC_LEAVE_TIMEOUT',
      );
    }
  }

  Future<void> setMuted(bool muted) async {
    final code = await _channel.invokeMethod<int>('setMuted', {'muted': muted});
    if (code != 0) {
      throw const AppException(
        '麦克风状态更新失败，请重试',
        code: 'RTC_MICROPHONE_CONTROL_FAILED',
      );
    }
  }

  Future<void> setSpeaker(bool enabled) async {
    final code =
        await _channel.invokeMethod<int>('setSpeaker', {'enabled': enabled});
    if (code != 0) {
      throw const AppException(
        '音频输出切换失败，请重试',
        code: 'RTC_SPEAKER_CONTROL_FAILED',
      );
    }
  }

  Future<void> setCameraEnabled(bool enabled) async {
    final code = await _channel.invokeMethod<int>(
      'setCameraEnabled',
      {'enabled': enabled},
    );
    if (code != 0) {
      throw const AppException(
        '摄像头不可用，请重试',
        code: 'RTC_CAMERA_UNAVAILABLE',
      );
    }
  }

  Future<void> switchCamera() async {
    final code = await _channel.invokeMethod<int>('switchCamera');
    if (code != 0) {
      throw const AppException(
        '摄像头切换失败，请重试',
        code: 'RTC_CAMERA_SWITCH_FAILED',
      );
    }
  }

  Future<void> setTranslationMode(
    bool enabled, {
    bool muteRemoteAudio = true,
  }) async {
    final code = await _channel.invokeMethod<int>('setTranslationMode', {
      'enabled': enabled,
      'muteRemoteAudio': enabled && muteRemoteAudio,
    });
    if (code != 0) {
      throw const AppException(
        '实时翻译音频通道切换失败，请重新连接',
        code: 'RTC_TRANSLATION_AUDIO_ROUTE_FAILED',
      );
    }
  }

  Future<void> playTranslationAudio(Uint8List audio, int sampleRate) async {
    final code = await _channel.invokeMethod<int>('playTranslationAudio', {
      'audio': audio,
      'sampleRate': sampleRate,
    });
    if (code != 0) {
      throw const AppException(
        '译音频播放失败，已恢复原声通话',
        code: 'RTC_TRANSLATION_AUDIO_PLAYBACK_FAILED',
      );
    }
  }

  Future<void> _handleNativeCall(MethodCall call) async {
    if (!identical(_owner, this)) return;
    if (call.method == 'audioFrame') {
      final audio = call.arguments;
      if (audio is Uint8List && audio.isNotEmpty) _audioFrames.add(audio);
      return;
    }
    if (call.method == 'state' && call.arguments is Map) {
      final arguments = call.arguments as Map;
      final state = arguments['state']?.toString();
      if (state != null) {
        final code = switch (arguments['code']) {
          final int value => value,
          final num value => value.toInt(),
          _ => null,
        };
        final phase = arguments['phase']?.toString();
        final category = arguments['category']?.toString();
        if (state == 'error') {
          developer.log(
            'native state error phase=${phase ?? 'unknown'} '
            'category=${category ?? 'unknown'} code=${code ?? 'unavailable'}',
            name: 'rtc.voice',
          );
        }
        _states.add(
          RtcVoiceState(
            value: state,
            code: code,
            message: arguments['message']?.toString(),
            phase: phase,
            category: category,
            reason: arguments['reason']?.toString(),
          ),
        );
      }
    }
  }

  Future<void> dispose() async {
    if (identical(_owner, this)) {
      try {
        await leave();
      } catch (_) {
        // Dart resources and the method handler must still be released when
        // native teardown times out or the engine has already disappeared.
      }
      // A newer call can take ownership while the old native leave is pending.
      // Never let the old instance clear the new call's method handler.
      if (identical(_owner, this)) {
        _owner = null;
        _channel.setMethodCallHandler(null);
      }
    }
    if (!_states.isClosed) await _states.close();
    if (!_audioFrames.isClosed) await _audioFrames.close();
  }
}
