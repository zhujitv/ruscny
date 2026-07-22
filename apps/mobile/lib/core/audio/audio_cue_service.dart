import 'package:flutter/services.dart';

/// Best-effort audible feedback for call setup and push-to-talk capture.
///
/// Android uses a native tone generator so the cue does not depend on bundled
/// media assets. Other platforms fall back to the system click for the talk
/// cue; RTC calls are currently Android-only.
final class AudioCueService {
  AudioCueService._();

  static const _channel = MethodChannel('com.tooyei.translator/audio_cues');
  static const _fallbackTalkDelay = Duration(milliseconds: 180);

  static Future<void> startRingback() async {
    try {
      await _channel.invokeMethod<void>('startRingback');
    } on MissingPluginException {
      // RTC is Android-only today; keep call setup functional elsewhere.
    } on PlatformException {
      // Audible feedback must never prevent a call from being placed.
    }
  }

  static Future<void> stopRingback() async {
    try {
      await _channel.invokeMethod<void>('stopRingback');
    } on MissingPluginException {
      // No native ringback was started on this platform.
    } on PlatformException {
      // Call teardown must continue even if the audio route has disappeared.
    }
  }

  static Future<void> startIncomingRingtone() async {
    try {
      await _channel.invokeMethod<void>('startIncomingRingtone');
    } on MissingPluginException {
      // Incoming-call audio is currently implemented by Android.
    } on PlatformException {
      // The visual incoming-call prompt must remain usable without audio.
    }
  }

  static Future<void> stopIncomingRingtone() async {
    try {
      await _channel.invokeMethod<void>('stopIncomingRingtone');
    } on MissingPluginException {
      // No native ringtone was started on this platform.
    } on PlatformException {
      // Call handling must continue even if audio focus was already released.
    }
  }

  static Future<void> showIncomingCallNotification({
    required String callId,
    required String callerName,
    required String title,
    required String answerLabel,
    required String declineLabel,
  }) async {
    try {
      await _channel.invokeMethod<void>('showIncomingCall', {
        'callId': callId,
        'callerName': callerName,
        'title': title,
        'answerLabel': answerLabel,
        'declineLabel': declineLabel,
      });
    } on MissingPluginException {
      // System call notifications are currently implemented by Android.
    } on PlatformException {
      // Foreground recovery remains available if notification setup fails.
    }
  }

  static Future<void> cancelIncomingCallNotification(String callId) async {
    try {
      await _channel.invokeMethod<void>('cancelIncomingCall', {
        'callId': callId,
      });
    } on MissingPluginException {
      // No native call notification exists on this platform.
    } on PlatformException {
      // The notification may already have expired or been removed.
    }
  }

  static Future<({String action, String callId})?>
      consumeIncomingCallAction() async {
    try {
      final result = await _channel
          .invokeMapMethod<String, String>('consumeIncomingCallAction');
      final action = result?['action'];
      final callId = result?['callId'];
      if (action == null || callId == null) return null;
      return (action: action, callId: callId);
    } on MissingPluginException {
      return null;
    } on PlatformException {
      return null;
    }
  }

  /// Completes only after the ready tone has ended, so callers can safely
  /// enable recording/unmute the microphone after awaiting this method.
  static Future<void> playTalkReady() async {
    try {
      await _channel.invokeMethod<void>('playTalkReady');
      return;
    } on MissingPluginException {
      // Fall through to the portable system sound.
    } on PlatformException {
      // Fall through to the portable system sound.
    }
    await SystemSound.play(SystemSoundType.click);
    await Future<void>.delayed(_fallbackTalkDelay);
  }
}
