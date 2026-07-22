package com.tooyei.translator

import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.Ringtone
import android.media.RingtoneManager
import android.media.ToneGenerator
import android.Manifest
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.os.Bundle
import android.os.Build
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import com.alivc.rtc.AliRtcEngine
import com.alivc.rtc.AliRtcEngineEventListener
import com.alivc.rtc.AliRtcEngineNotify
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.Executors
import kotlin.math.min
import org.json.JSONObject

class MainActivity : FlutterActivity(), RtcVideoViewHost {
    private enum class RtcMediaType {
        AUDIO,
        VIDEO;

        companion object {
            fun fromWireValue(value: String?): RtcMediaType? = when (value?.uppercase()) {
                null, "AUDIO" -> AUDIO
                "VIDEO" -> VIDEO
                else -> null
            }
        }
    }

    private data class ArtcTokenValidation(
        val valid: Boolean = false,
        val timestamp: Long? = null,
        val channelMatches: Boolean = false,
        val userMatches: Boolean = false,
        val expiryMatches: Boolean = false,
        val unexpired: Boolean = false,
        val structureValid: Boolean = false,
        val reason: String,
    )

    private data class PendingRtcJoin(
        val channelId: String,
        val userId: String,
        val token: String,
        val displayName: String,
        val mediaType: RtcMediaType,
        val initialCameraEnabled: Boolean,
        val activityGeneration: Long,
        val result: MethodChannel.Result,
    )

    @Volatile private var rtcEngine: AliRtcEngine? = null
    private val rtcOwnerToken = RtcEngineRegistry.newOwnerToken()
    private var channel: MethodChannel? = null
    private var audioCueChannel: MethodChannel? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val shutdownCallbacks = mutableListOf<() -> Unit>()
    private var pendingJoin: PendingRtcJoin? = null
    private var globalEngineWait: Runnable? = null
    private var globalEngineWaitDeadline = 0L
    private var globalEngineReleaseRequested = false
    @Volatile private var shuttingDown = false
    @Volatile private var rtcGeneration = 0L
    @Volatile private var activityResumed = false
    @Volatile private var activityDestroyed = false
    @Volatile private var activityGeneration = 0L
    private var destroyingEngine: AliRtcEngine? = null
    private var fatalCameraEngine: AliRtcEngine? = null
    @Volatile private var deferredShutdownEngine: AliRtcEngine? = null
    @Volatile private var rtcChannelJoinedSuccessfully = false
    @Volatile private var audioPublishRequested = false
    @Volatile private var localAudioPublished = false
    @Volatile private var localMicMuted = false
    private var joinedStateEmitted = false
    private var joinCallbackTimeout: Runnable? = null
    private var audioPublishTimeout: Runnable? = null
    @Volatile private var videoPublishRequested = false
    @Volatile private var localVideoPublished = false
    private var videoPublishTimeout: Runnable? = null
    private var cameraOperationGeneration = 0L
    private var cameraSafetyConfirmation: Runnable? = null
    private val remoteOnlineUsers = mutableSetOf<String>()
    private val remoteAudioSubscribedUsers = mutableSetOf<String>()
    private val announcedRemoteUsers = mutableSetOf<String>()
    private var leaveTimeout: Runnable? = null
    private val translationCaptureLock = Any()
    private val translationCaptureBuffer = ByteArray(TRANSLATION_CAPTURE_CHUNK_BYTES)
    private var translationCaptureBufferSize = 0
    private val translationPlaybackLock = Any()
    private val translationPlaybackExecutor = Executors.newSingleThreadExecutor()
    @Volatile private var translationPlaybackGeneration = 0L
    @Volatile private var translationCaptureEnabled = false
    @Volatile private var translationFrameObserverAvailable = false
    @Volatile private var translationCaptureMetadataLogged = false
    @Volatile private var translationCaptureChunkLogged = false
    @Volatile private var translationPlaybackWriteLogged = false
    private var translationAudioTrack: AudioTrack? = null
    private var translationAudioSampleRate = 0
    private var ringbackTone: ToneGenerator? = null
    private var ringbackPulse: Runnable? = null
    private var incomingRingtone: Ringtone? = null
    private var rtcMediaType = RtcMediaType.AUDIO
    private var cameraEnabled = false
    private var activeRemoteUserId: String? = null
    private var localVideoPlatformView: RtcVideoPlatformView? = null
    private var remoteVideoPlatformView: RtcVideoPlatformView? = null
    private var localRtcRenderView: android.view.View? = null
    private var remoteRtcRenderView: android.view.View? = null
    private var remoteRenderUserId: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        captureIncomingCallAction(intent)
        super.onCreate(savedInstanceState)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        captureIncomingCallAction(intent)
    }

    override fun onResume() {
        super.onResume()
        activityResumed = true
    }

    override fun onPause() {
        // Close the native race between Dart computing join/toggle arguments
        // and Android pausing the Activity. There is deliberately no native
        // auto-restore; Flutter owns the user's restore intent after resume.
        activityResumed = false
        val engine = rtcEngine
        if (
            engine != null &&
            RtcEngineRegistry.isOwner(rtcOwnerToken, engine) &&
            rtcMediaType == RtcMediaType.VIDEO &&
            cameraEnabled &&
            !shuttingDown
        ) {
            disableLocalVideoBestEffort(
                engine,
                fatalReason = "background_disable_failed",
            )
        }
        super.onPause()
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        flutterEngine.platformViewsController.registry.registerViewFactory(
            RTC_VIDEO_VIEW_TYPE,
            RtcVideoViewFactory(this),
        )
        channel = MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "com.tooyei.translator/rtc",
        ).also { bridge ->
            bridge.setMethodCallHandler { call, result ->
                when (call.method) {
                    "join" -> join(call.arguments as? Map<*, *>, result)
                    "leave" -> {
                        cancelPendingJoin(
                            "RTC_JOIN_CANCELLED",
                            "RTC join was cancelled by leave",
                        )
                        shutdownRtc { result.success(null) }
                    }
                    "setMuted" -> {
                        val muted = call.argument<Boolean>("muted") ?: false
                        result.success(setMuted(muted))
                    }
                    "setSpeaker" -> {
                        val enabled = call.argument<Boolean>("enabled") ?: true
                        result.success(setSpeakerEnabled(enabled))
                    }
                    "setCameraEnabled" -> {
                        val enabled = call.argument<Boolean>("enabled")
                        if (enabled == null) {
                            result.error(
                                "INVALID_CAMERA_STATE",
                                "Camera enabled state is required",
                                null,
                            )
                        } else {
                            result.success(setCameraEnabled(enabled))
                        }
                    }
                    "switchCamera" -> result.success(switchCamera())
                    "setTranslationMode" -> {
                        val enabled = call.argument<Boolean>("enabled") ?: false
                        val muteRemoteAudio =
                            call.argument<Boolean>("muteRemoteAudio") ?: enabled
                        result.success(setTranslationMode(enabled, muteRemoteAudio))
                    }
                    "playTranslationAudio" -> {
                        val audio = call.argument<ByteArray>("audio")
                        val sampleRate = call.argument<Int>("sampleRate") ?: 24_000
                        if (
                            audio == null ||
                            audio.isEmpty() ||
                            audio.size > MAX_TRANSLATION_AUDIO_BYTES ||
                            sampleRate !in 8_000..48_000
                        ) {
                            Log.w(
                                RTC_DIAGNOSTIC_TAG,
                                "ARTC translated audio rejected bytes=${audio?.size ?: 0} " +
                                    "sampleRate=$sampleRate",
                            )
                            result.error(
                                "INVALID_TRANSLATION_AUDIO",
                                "Translated audio frame is invalid",
                                null,
                            )
                        } else {
                            result.success(
                                enqueueTranslationAudio(audio.copyOf(), sampleRate),
                            )
                        }
                    }
                    else -> result.notImplemented()
                }
            }
        }
        audioCueChannel = MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "com.tooyei.translator/audio_cues",
        ).also { bridge ->
            bridge.setMethodCallHandler { call, result ->
                when (call.method) {
                    "startRingback" -> {
                        startRingbackTone()
                        result.success(null)
                    }
                    "stopRingback" -> {
                        stopRingbackTone()
                        result.success(null)
                    }
                    "startIncomingRingtone" -> {
                        startIncomingRingtone()
                        result.success(null)
                    }
                    "stopIncomingRingtone" -> {
                        stopIncomingRingtone()
                        result.success(null)
                    }
                    "showIncomingCall" -> {
                        val callId = call.argument<String>("callId")
                        val callerName = call.argument<String>("callerName")
                        val title = call.argument<String>("title")
                        val answerLabel = call.argument<String>("answerLabel")
                        val declineLabel = call.argument<String>("declineLabel")
                        if (listOf(callId, callerName, title, answerLabel, declineLabel)
                                .any { it.isNullOrBlank() }
                        ) {
                            result.error(
                                "INVALID_INCOMING_CALL",
                                "Incoming call notification is incomplete",
                                null,
                            )
                        } else {
                            IncomingCallNotification.show(
                                applicationContext,
                                callId!!,
                                callerName!!,
                                title!!,
                                answerLabel!!,
                                declineLabel!!,
                            )
                            result.success(null)
                        }
                    }
                    "cancelIncomingCall" -> {
                        call.argument<String>("callId")?.let {
                            IncomingCallNotification.cancel(applicationContext, it)
                        }
                        result.success(null)
                    }
                    "consumeIncomingCallAction" -> {
                        val preferences = getSharedPreferences(
                            INCOMING_CALL_PREFERENCES,
                            MODE_PRIVATE,
                        )
                        val action = preferences.getString(INCOMING_CALL_ACTION_KEY, null)
                        val callId = preferences.getString(INCOMING_CALL_ID_KEY, null)
                        preferences.edit()
                            .remove(INCOMING_CALL_ACTION_KEY)
                            .remove(INCOMING_CALL_ID_KEY)
                            .apply()
                        result.success(
                            if (action != null && callId != null) {
                                mapOf("action" to action, "callId" to callId)
                            } else {
                                null
                            },
                        )
                    }
                    "playTalkReady" -> playTalkReadyTone(result)
                    else -> result.notImplemented()
                }
            }
        }
    }

    private fun startRingbackTone() {
        stopRingbackTone()
        // Ringback starts before the RTC engine owns the voice-call route, so
        // use the media stream to keep it audible on normal device settings.
        val tone = try {
            ToneGenerator(AudioManager.STREAM_MUSIC, RINGBACK_VOLUME)
        } catch (_: RuntimeException) {
            return
        }
        ringbackTone = tone
        val pulse = object : Runnable {
            override fun run() {
                if (ringbackTone !== tone) return
                tone.startTone(ToneGenerator.TONE_SUP_RINGTONE, RINGBACK_PULSE_MS)
                mainHandler.postDelayed(this, RINGBACK_INTERVAL_MS)
            }
        }
        ringbackPulse = pulse
        pulse.run()
    }

    private fun stopRingbackTone() {
        ringbackPulse?.let(mainHandler::removeCallbacks)
        ringbackPulse = null
        ringbackTone?.let { tone ->
            try {
                tone.stopTone()
            } catch (_: RuntimeException) {
                // The audio route may already be gone during call teardown.
            }
            releaseTone(tone)
        }
        ringbackTone = null
    }

    private fun startIncomingRingtone() {
        stopIncomingRingtone()
        val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE) ?: return
        incomingRingtone = RingtoneManager.getRingtone(applicationContext, uri)?.also { ringtone ->
            ringtone.audioAttributes = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                ringtone.isLooping = true
            }
            ringtone.play()
        }
    }

    private fun captureIncomingCallAction(intent: Intent?) {
        val callId = intent?.getStringExtra(IncomingCallNotification.EXTRA_CALL_ID)
        val action = intent?.getStringExtra(IncomingCallNotification.EXTRA_ACTION)
        if (callId.isNullOrBlank() || action.isNullOrBlank()) return
        getSharedPreferences(INCOMING_CALL_PREFERENCES, MODE_PRIVATE)
            .edit()
            .putString(INCOMING_CALL_ACTION_KEY, action)
            .putString(INCOMING_CALL_ID_KEY, callId)
            .apply()
    }

    private fun stopIncomingRingtone() {
        incomingRingtone?.let { ringtone ->
            try {
                ringtone.stop()
            } catch (_: RuntimeException) {
                // The system audio service may already have reclaimed the ringtone.
            }
        }
        incomingRingtone = null
    }

    private fun playTalkReadyTone(result: MethodChannel.Result) {
        val tone = try {
            ToneGenerator(AudioManager.STREAM_MUSIC, TALK_READY_VOLUME)
        } catch (_: RuntimeException) {
            result.error("TALK_READY_TONE_FAILED", "Unable to create talk-ready tone", null)
            return
        }
        val started = tone.startTone(ToneGenerator.TONE_PROP_BEEP, TALK_READY_DURATION_MS)
        if (!started) {
            releaseTone(tone)
            result.error("TALK_READY_TONE_FAILED", "Unable to play talk-ready tone", null)
            return
        }
        // Complete the Dart future after the beep. Recording/unmute begins
        // only after this callback, making the cue an unambiguous start mark.
        mainHandler.postDelayed({
            releaseTone(tone)
            result.success(null)
        }, TALK_READY_DURATION_MS.toLong())
    }

    private fun releaseTone(tone: ToneGenerator) {
        try {
            tone.release()
        } catch (_: RuntimeException) {
            // Already released by the platform audio service.
        }
    }

    private fun join(arguments: Map<*, *>?, result: MethodChannel.Result) {
        if (activityDestroyed) {
            result.error("RTC_ACTIVITY_DESTROYED", "RTC activity is no longer available", null)
            return
        }
        val channelId = arguments?.get("channelId") as? String
        val userId = arguments?.get("userId") as? String
        val token = arguments?.get("token") as? String
        val displayName = arguments?.get("displayName") as? String
        val expiresAt = (arguments?.get("expiresAt") as? Number)?.toLong()
        val mediaType = RtcMediaType.fromWireValue(arguments?.get("mediaType") as? String)
        if (listOf(channelId, userId, token, displayName).any { it.isNullOrBlank() } || expiresAt == null) {
            result.error("INVALID_RTC_CREDENTIAL", "RTC credential is incomplete", null)
            return
        }
        if (mediaType == null) {
            result.error(
                "INVALID_RTC_MEDIA_TYPE",
                "RTC mediaType must be AUDIO or VIDEO",
                null,
            )
            return
        }
        val initialCameraEnabled =
            mediaType == RtcMediaType.VIDEO &&
                ((arguments?.get("cameraEnabled") as? Boolean) ?: true)
        val validation = validateArtcToken(token!!, channelId!!, userId!!, expiresAt)
        Log.i(
            RTC_DIAGNOSTIC_TAG,
            "ARTC credential validation " +
                "sdkVersion=${AliRtcEngine.getSdkVersion()} " +
                "tokenLength=${token.length} " +
                "expiresAt=${validation.timestamp ?: expiresAt} " +
                "channelMatches=${validation.channelMatches} " +
                "userMatches=${validation.userMatches} " +
                "expiryMatches=${validation.expiryMatches} " +
                "unexpired=${validation.unexpired} " +
                "structureValid=${validation.structureValid}",
        )
        if (!validation.valid) {
            result.error(
                "INVALID_RTC_CREDENTIAL",
                "ARTC credential validation failed",
                mapOf("phase" to "preflight", "reason" to validation.reason),
            )
            return
        }
        val request = PendingRtcJoin(
            channelId = channelId,
            userId = userId,
            token = token,
            displayName = displayName!!,
            mediaType = mediaType,
            initialCameraEnabled = initialCameraEnabled,
            activityGeneration = activityGeneration,
            result = result,
        )
        cancelPendingJoin(
            "RTC_JOIN_SUPERSEDED",
            "A newer RTC join request replaced this request",
        )
        pendingJoin = request
        if (rtcEngine == null && !shuttingDown) {
            startPendingJoinIfAllowed()
        } else {
            shutdownRtc()
        }
    }

    private fun startPendingJoinIfAllowed() {
        val request = pendingJoin ?: return
        if (
            activityDestroyed ||
            request.activityGeneration != activityGeneration ||
            !activityResumed
        ) {
            pendingJoin = null
            cancelGlobalEngineWait()
            request.result.error(
                "RTC_ACTIVITY_NOT_FOREGROUND",
                "RTC join was cancelled because the activity is not active",
                null,
            )
            stopRtcForegroundServiceIfIdle()
            return
        }
        if (
            checkSelfPermission(Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            pendingJoin = null
            cancelGlobalEngineWait()
            request.result.error(
                "RTC_MICROPHONE_PERMISSION_REQUIRED",
                "Microphone permission is required for an RTC call",
                null,
            )
            stopRtcForegroundServiceIfIdle()
            return
        }
        if (rtcEngine != null || shuttingDown) return

        val claim = try {
            RtcEngineRegistry.claim(
                token = rtcOwnerToken,
                createEngine = { AliRtcEngine.getInstance(applicationContext, "") },
                requestRelease = {
                    mainHandler.post {
                        if (RtcEngineRegistry.isOwnedBy(rtcOwnerToken)) shutdownRtc()
                    }
                },
            )
        } catch (error: RuntimeException) {
            Log.e(RTC_DIAGNOSTIC_TAG, "ARTC engine creation failed", error)
            pendingJoin = null
            cancelGlobalEngineWait()
            request.result.error("RTC_SETUP_FAILED", "Unable to create the RTC engine", null)
            stopRtcForegroundServiceIfIdle()
            return
        }
        when (claim) {
            is RtcEngineRegistry.Claim.Busy -> {
                waitForGlobalEngineRelease(request, claim.requestRelease)
            }
            is RtcEngineRegistry.Claim.Acquired -> {
                pendingJoin = null
                cancelGlobalEngineWait()
                rtcEngine = claim.engine
                startJoin(request, claim.engine)
            }
        }
    }

    private fun cancelPendingJoin(code: String, message: String) {
        val request = pendingJoin
        pendingJoin = null
        cancelGlobalEngineWait()
        if (request == null) return
        try {
            request.result.error(code, message, null)
        } catch (error: RuntimeException) {
            Log.e(RTC_DIAGNOSTIC_TAG, "Unable to complete cancelled RTC join", error)
        }
    }

    private fun waitForGlobalEngineRelease(
        request: PendingRtcJoin,
        requestRelease: () -> Unit,
    ) {
        if (globalEngineWaitDeadline == 0L) {
            globalEngineWaitDeadline =
                SystemClock.elapsedRealtime() + GLOBAL_ENGINE_WAIT_TIMEOUT_MS
        }
        if (!globalEngineReleaseRequested) {
            globalEngineReleaseRequested = true
            try {
                requestRelease()
            } catch (error: RuntimeException) {
                Log.e(RTC_DIAGNOSTIC_TAG, "Unable to request old RTC owner release", error)
            }
        }
        if (globalEngineWait != null) return
        val waiter = Runnable {
            globalEngineWait = null
            if (pendingJoin !== request) return@Runnable
            if (SystemClock.elapsedRealtime() >= globalEngineWaitDeadline) {
                pendingJoin = null
                cancelGlobalEngineWait()
                request.result.error(
                    "RTC_ENGINE_BUSY",
                    "The previous RTC engine did not finish shutting down",
                    mapOf("phase" to "engine_handover"),
                )
                stopRtcForegroundServiceIfIdle()
                return@Runnable
            }
            startPendingJoinIfAllowed()
        }
        globalEngineWait = waiter
        mainHandler.postDelayed(waiter, GLOBAL_ENGINE_WAIT_POLL_MS)
    }

    private fun cancelGlobalEngineWait() {
        globalEngineWait?.let(mainHandler::removeCallbacks)
        globalEngineWait = null
        globalEngineWaitDeadline = 0L
        globalEngineReleaseRequested = false
    }

    private fun validateArtcToken(
        token: String,
        channelId: String,
        userId: String,
        expiresAt: Long,
    ): ArtcTokenValidation = try {
        val decoded = Base64.decode(token, Base64.DEFAULT)
        val payload = JSONObject(String(decoded, Charsets.UTF_8))
        val timestamp = payload.getLong("timestamp")
        val channelMatches = payload.optString("channelid") == channelId
        val userMatches = payload.optString("userid") == userId
        val expiryMatches = timestamp == expiresAt
        val unexpired = timestamp > System.currentTimeMillis() / 1_000
        val signature = payload.optString("token")
        val structureValid =
            payload.optString("appid").isNotBlank() &&
                payload.optString("nonce") == "" &&
                signature.matches(Regex("^[a-f0-9]{64}$"))
        ArtcTokenValidation(
            valid = channelMatches && userMatches && expiryMatches && unexpired && structureValid,
            timestamp = timestamp,
            channelMatches = channelMatches,
            userMatches = userMatches,
            expiryMatches = expiryMatches,
            unexpired = unexpired,
            structureValid = structureValid,
            reason = when {
                !channelMatches -> "channel_mismatch"
                !userMatches -> "user_mismatch"
                !expiryMatches -> "expiry_mismatch"
                !unexpired -> "expired"
                !structureValid -> "invalid_structure"
                else -> "ok"
            },
        )
    } catch (_: Exception) {
        ArtcTokenValidation(reason = "decode_failed")
    }

    private fun startJoin(request: PendingRtcJoin, engine: AliRtcEngine) {
        if (
            activityDestroyed ||
            request.activityGeneration != activityGeneration ||
            !activityResumed
        ) {
            request.result.error(
                "RTC_ACTIVITY_NOT_FOREGROUND",
                "RTC join was cancelled because the activity is not active",
                null,
            )
            shutdownRtc()
            return
        }
        if (!RtcCallForegroundService.start(this, rtcOwnerToken)) {
            request.result.error(
                "RTC_FOREGROUND_SERVICE_FAILED",
                "Unable to start the ongoing-call foreground service",
                null,
            )
            shutdownRtc()
            return
        }
        val channelId = request.channelId
        val userId = request.userId
        val token = request.token
        val displayName = request.displayName
        val requestedMediaType = request.mediaType
        var effectiveMediaType = requestedMediaType
        var videoFallbackReason: String? = null
        val initialCameraEnabled = request.initialCameraEnabled
        val result = request.result
        val generation = ++rtcGeneration
        fatalCameraEngine = null
        deferredShutdownEngine = null
        rtcChannelJoinedSuccessfully = false
        audioPublishRequested = false
        localAudioPublished = false
        localMicMuted = false
        joinedStateEmitted = false
        cancelJoinCallbackTimeout()
        cancelAudioPublishTimeout()
        videoPublishRequested = false
        localVideoPublished = false
        cancelVideoPublishTimeout()
        invalidateCameraSafetyConfirmation()
        rtcMediaType = effectiveMediaType
        // This becomes true only after every preparation step succeeds.
        cameraEnabled = false
        activeRemoteUserId = null
        remoteRenderUserId = null
        remoteOnlineUsers.clear()
        remoteAudioSubscribedUsers.clear()
        announcedRemoteUsers.clear()
        translationCaptureEnabled = false
        translationFrameObserverAvailable = false
        resetTranslationCaptureBuffer()
        val setupSteps = listOf<Pair<String, () -> Int>>(
            "setAudioOnlyMode" to {
                engine.setAudioOnlyMode(requestedMediaType == RtcMediaType.AUDIO)
            },
            "setDefaultRemoteAudio" to {
                engine.setDefaultSubscribeAllRemoteAudioStreams(true)
            },
            "setDefaultAudioRoute" to {
                engine.setDefaultAudioRoutetoSpeakerphone(true)
            },
        )
        for ((step, operation) in setupSteps) {
            val code = runRtcOperation(step, operation)
            Log.i(RTC_DIAGNOSTIC_TAG, "ARTC setup step=$step result=$code")
            if (code != 0) {
                failInitialRtcSetup(result, engine, code, step)
                return
            }
        }
        // This test emulator forwards the host microphone at a much lower
        // level than a physical handset. Compensate only on emulator hardware;
        // real phones keep the SDK's original 100% capture level so their
        // noise floor and clipping behavior do not change.
        val recordingVolume =
            if (isRunningOnEmulator()) RTC_EMULATOR_RECORDING_VOLUME
            else RTC_DEVICE_RECORDING_VOLUME
        val recordingVolumeCode = runRtcOperation("setRecordingVolume") {
            engine.setRecordingVolume(recordingVolume)
        }
        Log.i(
            RTC_DIAGNOSTIC_TAG,
            "ARTC optional setup step=setRecordingVolume " +
                "volume=$recordingVolume emulator=${isRunningOnEmulator()} " +
                "result=$recordingVolumeCode",
        )
        if (recordingVolumeCode != 0) {
            Log.w(
                RTC_DIAGNOSTIC_TAG,
                "ARTC recording gain unavailable result=$recordingVolumeCode; " +
                    "continuing base call",
            )
        }
        if (requestedMediaType == RtcMediaType.VIDEO) {
            // Establish the room and its audio path first. Camera startup is
            // intentionally deferred until onJoinChannelResult so a missing or
            // busy camera degrades to an audio call instead of cancelling it.
            val videoDefaults = listOf<Pair<String, () -> Int>>(
                "setDefaultRemoteVideo" to {
                    engine.setDefaultSubscribeAllRemoteVideoStreams(true)
                },
                "prejoinUnpublishLocalVideo" to {
                    engine.publishLocalVideoStream(false)
                },
                "prejoinDisableLocalVideo" to { engine.enableLocalVideo(false) },
            )
            var videoSetupFailure = 0
            var videoSetupFailureStep = ""
            for ((step, operation) in videoDefaults) {
                val code = runRtcOperation(step, operation)
                Log.i(RTC_DIAGNOSTIC_TAG, "ARTC video setup step=$step result=$code")
                if (videoSetupFailure == 0 && code != 0) {
                    videoSetupFailure = code
                    videoSetupFailureStep = step
                }
            }
            if (videoSetupFailure != 0) {
                // If the engine cannot prove video is disabled before join,
                // fail closed to its documented audio-only mode. The call can
                // still connect, and Flutter is notified after the audio room
                // is ready instead of showing a generic connection failure.
                val fallbackCode = runRtcOperation("fallbackToAudioOnly") {
                    engine.setAudioOnlyMode(true)
                }
                Log.w(
                    RTC_DIAGNOSTIC_TAG,
                    "ARTC video prejoin setup failed step=$videoSetupFailureStep " +
                        "result=$videoSetupFailure fallback=$fallbackCode",
                )
                if (fallbackCode != 0) {
                    failInitialRtcSetup(
                        result,
                        engine,
                        fallbackCode,
                        "fallbackToAudioOnly",
                    )
                    return
                }
                effectiveMediaType = RtcMediaType.AUDIO
                videoFallbackReason = "prejoin_$videoSetupFailureStep"
            }
            rtcMediaType = effectiveMediaType
            localVideoPlatformView?.clearRenderView()
            localRtcRenderView = null
        }
        engine.registerAudioFrameObserver(object : AliRtcEngine.AliRtcAudioFrameObserver {
            override fun onCapturedAudioFrame(frame: AliRtcEngine.AliRtcAudioFrame): Boolean = true

            override fun onProcessCapturedAudioFrame(
                frame: AliRtcEngine.AliRtcAudioFrame,
            ): Boolean {
                captureTranslationAudio(frame, engine, generation)
                return true
            }

            override fun onPublishAudioFrame(frame: AliRtcEngine.AliRtcAudioFrame): Boolean = true

            override fun onPlaybackAudioFrame(frame: AliRtcEngine.AliRtcAudioFrame): Boolean = true

            override fun onMixedAllAudioFrame(frame: AliRtcEngine.AliRtcAudioFrame): Boolean = true

            override fun onRemoteUserAudioFrame(
                userId: String?,
                frame: AliRtcEngine.AliRtcAudioFrame,
            ): Boolean = true
        })
        val observerConfig = AliRtcEngine.AliRtcAudioFrameObserverConfig().apply {
            sampleRate = AliRtcEngine.AliRtcAudioSampleRate.AliRtcAudioSampleRate_16000
            channels = AliRtcEngine.AliRtcAudioNumChannel.AliRtcMonoAudio
            mode = AliRtcEngine.AliRtcAudioFrameObserverOperationMode
                .AliRtcAudioDataObserverOperationModeReadOnly
            userDefinedInfo = 0
        }
        val audioObserverCode = runRtcOperation("enableAudioFrameObserver") {
            engine.enableAudioFrameObserver(
                true,
                AliRtcEngine.AliRtcAudioSource.AliRtcAudioSourceProcessCaptured,
                observerConfig,
            )
        }
        Log.i(
            RTC_DIAGNOSTIC_TAG,
            "ARTC optional setup step=enableAudioFrameObserver result=$audioObserverCode",
        )
        translationFrameObserverAvailable = audioObserverCode == 0
        if (audioObserverCode != 0) {
            // Frame observation powers translation, but it is not required for
            // the two participants to establish a normal audio call.
            Log.w(
                RTC_DIAGNOSTIC_TAG,
                "ARTC translation frame observer unavailable result=$audioObserverCode",
            )
        }
        engine.setRtcEngineEventListener(object : AliRtcEngineEventListener() {
            override fun onJoinChannelResult(resultCode: Int, channelName: String?, joinedUserId: String?, elapsed: Int) {
                if (!isCurrentRtcCallback(engine, generation)) return
                mainHandler.post {
                    if (!isCurrentRtcCallback(engine, generation)) return@post
                    cancelJoinCallbackTimeout()
                    val category = classifyAsyncJoinFailure(resultCode)
                    Log.i(
                        RTC_DIAGNOSTIC_TAG,
                        "ARTC onJoinChannelResult asyncResult=$resultCode category=$category " +
                            "channelMatches=${channelName == channelId} userMatches=${joinedUserId == userId}",
                    )
                    if (resultCode != 0) {
                        reportRtcErrorAndScheduleShutdown(
                            engine,
                            generation,
                            resultCode,
                            phase = "async_join",
                            category = category,
                        )
                        return@post
                    }
                    rtcChannelJoinedSuccessfully = true
                    // ARTC may auto-publish the default microphone as part of
                    // joining. A publish callback that arrived first is kept,
                    // and channel readiness can now complete immediately.
                    emitJoinedIfReady()
                    if (videoFallbackReason != null) {
                        notifyCameraDisabled(
                            RTC_OPERATION_UNAVAILABLE,
                            videoFallbackReason!!,
                        )
                    }
                    val focusCode = runRtcOperation("requestAudioFocus") {
                        engine.requestAudioFocus()
                    }
                    // requestAudioFocus is the exception to ARTC's usual
                    // return convention: 1 means granted and 0 means denied.
                    // The SDK also requests focus automatically, so this is
                    // best-effort and must not tear down an established room.
                    Log.i(
                        RTC_DIAGNOSTIC_TAG,
                        "ARTC requestAudioFocus result=$focusCode granted=${focusCode == 1}",
                    )
                    if (focusCode != 1) {
                        Log.w(
                            RTC_DIAGNOSTIC_TAG,
                            "ARTC audio focus not explicitly granted; continuing base call",
                        )
                    }
                    audioPublishRequested = true
                    val audioPublishCode = runRtcOperation("publishLocalAudio") {
                        engine.publishLocalAudioStream(true)
                    }
                    Log.i(
                        RTC_DIAGNOSTIC_TAG,
                        "ARTC publishLocalAudio requested result=$audioPublishCode",
                    )
                    if (audioPublishCode != 0) {
                        reportRtcErrorAndScheduleShutdown(
                            engine,
                            generation,
                            audioPublishCode,
                            phase = "audio_publish",
                            category = "audio",
                        )
                        return@post
                    }
                    if (!localAudioPublished) {
                        scheduleAudioPublishTimeout(engine, generation)
                    }
                    if (rtcMediaType == RtcMediaType.VIDEO) {
                        if (initialCameraEnabled && activityResumed) {
                            val cameraCode = enableLocalVideoTransaction(
                                engine,
                                publish = true,
                            )
                            if (cameraCode != 0) {
                                Log.w(
                                    RTC_DIAGNOSTIC_TAG,
                                    "ARTC post-join camera enable result=$cameraCode; " +
                                        "continuing audio call",
                                )
                            }
                        } else {
                            val unpublishCode = runRtcOperation("keepVideoUnpublished") {
                                engine.publishLocalVideoStream(false)
                            }
                            if (unpublishCode != 0) {
                                Log.w(
                                    RTC_DIAGNOSTIC_TAG,
                                    "ARTC unable to confirm video unpublish result=$unpublishCode",
                                )
                            }
                        }
                    }
                }
            }

            override fun onLeaveChannelResult(resultCode: Int, stats: AliRtcEngine.AliRtcStats?) {
                if (!isCurrentRtcEngine(engine, generation)) return
                // Leave completion is the one lifecycle callback that must run
                // while shuttingDown=true. It never emits state back to Dart.
                mainHandler.post {
                    if (isCurrentRtcEngine(engine, generation)) finishDestroy(engine)
                }
            }

            override fun onConnectionLost() {
                if (!isCurrentRtcCallback(engine, generation)) return
                mainHandler.post {
                    if (!isCurrentRtcCallback(engine, generation)) return@post
                    cancelAudioPublishTimeout()
                    localAudioPublished = false
                    joinedStateEmitted = false
                    channel?.invokeMethod("state", mapOf("state" to "reconnecting"))
                }
            }

            override fun onConnectionRecovery() {
                if (!isCurrentRtcCallback(engine, generation)) return
                mainHandler.post {
                    if (!isCurrentRtcCallback(engine, generation)) return@post
                    joinedStateEmitted = false
                    localAudioPublished = false
                    audioPublishRequested = true
                    val publishCode = runRtcOperation("republishLocalAudio") {
                        engine.publishLocalAudioStream(true)
                    }
                    if (publishCode != 0) {
                        reportRtcErrorAndScheduleShutdown(
                            engine,
                            generation,
                            publishCode,
                            phase = "audio_republish",
                            category = "audio",
                        )
                        return@post
                    }
                    scheduleAudioPublishTimeout(engine, generation)
                }
            }

            override fun onOccurError(error: Int, message: String?) {
                if (!isCurrentRtcCallback(engine, generation)) return
                mainHandler.post {
                    if (!isCurrentRtcCallback(engine, generation)) return@post
                    if (rtcMediaType == RtcMediaType.VIDEO && isCameraRuntimeError(error)) {
                        val rollbackCode = rollbackLocalVideo(
                            engine,
                            "runtime_camera_rollback_failed",
                        )
                        if (rollbackCode == 0) {
                            Log.w(
                                RTC_DIAGNOSTIC_TAG,
                                "ARTC camera runtime error=$error rollback=0; " +
                                    "continuing audio call",
                            )
                            notifyCameraDisabled(error, "runtime_camera_error")
                        } else {
                            Log.e(
                                RTC_DIAGNOSTIC_TAG,
                                "ARTC camera runtime error=$error rollback=$rollbackCode; " +
                                    "camera safety shutdown requested",
                            )
                        }
                        return@post
                    }
                    if (rtcMediaType == RtcMediaType.VIDEO && isRemoteVideoRuntimeError(error)) {
                        val remoteUserId = activeRemoteUserId
                        activeRemoteUserId = null
                        if (!remoteUserId.isNullOrBlank()) {
                            val unbindCode = clearRemoteVideoRenderView(engine, remoteUserId)
                            if (unbindCode != 0) {
                                Log.w(
                                    RTC_DIAGNOSTIC_TAG,
                                    "ARTC remote video error=$error unbind=$unbindCode",
                                )
                            }
                        }
                        notifyVideoDegraded(error, "runtime_remote_video")
                        return@post
                    }
                    reportRtcErrorAndScheduleShutdown(
                        engine,
                        generation,
                        error,
                        phase = "runtime",
                        category = "service",
                        message = message,
                    )
                }
            }

            override fun onConnectionStatusChange(
                status: AliRtcEngine.AliRtcConnectionStatus?,
                reason: AliRtcEngine.AliRtcConnectionStatusChangeReason?,
            ) {
                if (!isCurrentRtcCallback(engine, generation)) return
                val terminal =
                    status == AliRtcEngine.AliRtcConnectionStatus.AliRtcConnectionStatusFailed ||
                        (
                            status ==
                                AliRtcEngine.AliRtcConnectionStatus.AliRtcConnectionStatusDisconnected &&
                                rtcChannelJoinedSuccessfully
                            )
                if (!terminal) {
                    return
                }
                mainHandler.post {
                    if (!isCurrentRtcCallback(engine, generation)) return@post
                    reportRtcErrorAndScheduleShutdown(
                        engine,
                        generation,
                        RTC_OPERATION_UNAVAILABLE,
                        phase = "connection_failed",
                        category = "network",
                        message = reason?.name,
                    )
                }
            }

            override fun onNetworkQualityChanged(
                remoteUserId: String?,
                upstreamQuality: AliRtcEngine.AliRtcNetworkQuality?,
                downstreamQuality: AliRtcEngine.AliRtcNetworkQuality?,
            ) {
                if (!isCurrentRtcCallback(engine, generation)) return
                Log.i(
                    RTC_DIAGNOSTIC_TAG,
                    "ARTC network quality userPresent=${!remoteUserId.isNullOrBlank()} " +
                        "upstream=$upstreamQuality downstream=$downstreamQuality",
                )
            }

            override fun OnLocalDeviceException(
                deviceType: AliRtcEngine.AliRtcEngineLocalDeviceType?,
                exceptionType: AliRtcEngine.AliRtcEngineLocalDeviceExceptionType?,
                message: String?,
            ) {
                if (!isCurrentRtcCallback(engine, generation)) return
                mainHandler.post {
                    if (!isCurrentRtcCallback(engine, generation)) return@post
                    val isVideoDevice =
                        deviceType ==
                            AliRtcEngine.AliRtcEngineLocalDeviceType.AliEngineLocalDeviceTypeCamera ||
                            deviceType ==
                            AliRtcEngine.AliRtcEngineLocalDeviceType.AliEngineLocalDeviceTypeDisplay ||
                            deviceType ==
                            AliRtcEngine.AliRtcEngineLocalDeviceType.AliEngineLocalDeviceTypeVideoDevice
                    if (isVideoDevice && rtcMediaType == RtcMediaType.VIDEO) {
                        val rollbackCode = rollbackLocalVideo(
                            engine,
                            "device_exception_rollback_failed",
                        )
                        if (rollbackCode == 0) {
                            Log.w(
                                RTC_DIAGNOSTIC_TAG,
                                "ARTC camera device exception=${exceptionType?.value} " +
                                    "rollback=0; continuing audio call",
                            )
                            notifyCameraDisabled(
                                exceptionType?.value ?: RTC_OPERATION_UNAVAILABLE,
                                "device_exception",
                            )
                        } else {
                            Log.e(
                                RTC_DIAGNOSTIC_TAG,
                                "ARTC camera device exception=${exceptionType?.value} " +
                                    "rollback=$rollbackCode; camera safety shutdown requested",
                            )
                        }
                        return@post
                    }
                    reportRtcErrorAndScheduleShutdown(
                        engine,
                        generation,
                        exceptionType?.value ?: RTC_OPERATION_UNAVAILABLE,
                        phase = "local_device",
                        category = "audio",
                        message = message,
                    )
                }
            }

            override fun onAudioPublishStateChanged(
                oldState: AliRtcEngine.AliRtcPublishState?,
                newState: AliRtcEngine.AliRtcPublishState?,
                elapsed: Int,
                channelName: String?,
            ) {
                handleLocalAudioPublishState(engine, generation, newState)
            }

            override fun onAudioPublishStateChanged(
                oldState: AliRtcEngine.AliRtcPublishState?,
                newState: AliRtcEngine.AliRtcPublishState?,
                elapsed: Int,
                channelName: String?,
                reason: AliRtcEngine.AliRtcPublishStateChangedReason?,
            ) {
                handleLocalAudioPublishState(engine, generation, newState)
            }

            override fun onAudioPublishStateChanged(
                audioTrack: AliRtcEngine.AliRtcAudioTrack?,
                oldState: AliRtcEngine.AliRtcPublishState?,
                newState: AliRtcEngine.AliRtcPublishState?,
                elapsed: Int,
                channelName: String?,
            ) {
                handleLocalAudioPublishState(engine, generation, newState)
            }

            override fun onAudioPublishStateChanged(
                audioTrack: AliRtcEngine.AliRtcAudioTrack?,
                oldState: AliRtcEngine.AliRtcPublishState?,
                newState: AliRtcEngine.AliRtcPublishState?,
                elapsed: Int,
                channelName: String?,
                reason: AliRtcEngine.AliRtcPublishStateChangedReason?,
            ) {
                handleLocalAudioPublishState(engine, generation, newState)
            }

            override fun onVideoPublishStateChanged(
                oldState: AliRtcEngine.AliRtcPublishState?,
                newState: AliRtcEngine.AliRtcPublishState?,
                elapsed: Int,
                channelName: String?,
            ) {
                handleLocalVideoPublishState(engine, generation, newState)
            }

            override fun onVideoPublishStateChanged(
                oldState: AliRtcEngine.AliRtcPublishState?,
                newState: AliRtcEngine.AliRtcPublishState?,
                elapsed: Int,
                channelName: String?,
                reason: AliRtcEngine.AliRtcPublishStateChangedReason?,
            ) {
                handleLocalVideoPublishState(engine, generation, newState)
            }

            override fun onAudioSubscribeStateChanged(
                remoteUserId: String?,
                oldState: AliRtcEngine.AliRtcSubscribeState?,
                newState: AliRtcEngine.AliRtcSubscribeState?,
                elapsed: Int,
                channelName: String?,
            ) {
                handleRemoteAudioSubscribeState(
                    engine,
                    generation,
                    remoteUserId,
                    newState,
                )
            }

            override fun onAudioSubscribeStateChanged(
                remoteUserId: String?,
                audioTrack: AliRtcEngine.AliRtcAudioTrack?,
                oldState: AliRtcEngine.AliRtcSubscribeState?,
                newState: AliRtcEngine.AliRtcSubscribeState?,
                elapsed: Int,
                channelName: String?,
            ) {
                if (
                    audioTrack == null ||
                    audioTrack == AliRtcEngine.AliRtcAudioTrack.AliRtcAudioTrackMic ||
                    audioTrack == AliRtcEngine.AliRtcAudioTrack.AliRtcAudioTrackBoth
                ) {
                    handleRemoteAudioSubscribeState(
                        engine,
                        generation,
                        remoteUserId,
                        newState,
                    )
                }
            }
        })
        engine.setRtcEngineNotify(object : AliRtcEngineNotify() {
            override fun onRtcLocalAudioStats(stats: AliRtcEngine.AliRtcLocalAudioStats?) {
                if (!isCurrentRtcCallback(engine, generation) || stats == null) return
                Log.i(
                    RTC_DIAGNOSTIC_TAG,
                    "ARTC local audio stats sampleRate=${stats.sentSamplerate} " +
                        "channels=${stats.numChannel} bitrate=${stats.sentBitrate} " +
                        "targetBitrate=${stats.targetEncodeBitrate} " +
                        "actualBitrate=${stats.actualEncodeBitrate} " +
                        "loss=${stats.sentLoss} rtt=${stats.rtt}",
                )
            }

            override fun onRtcRemoteAudioStats(stats: AliRtcEngine.AliRtcRemoteAudioStats?) {
                if (!isCurrentRtcCallback(engine, generation) || stats == null) return
                Log.i(
                    RTC_DIAGNOSTIC_TAG,
                    "ARTC remote audio stats userPresent=${!stats.userId.isNullOrBlank()} " +
                        "sampleRate=${stats.sampleRate} channels=${stats.channels} " +
                        "bitrate=${stats.rcvdBitrate} loss=${stats.audioLossRate} " +
                        "packetLoss=${stats.packetLossRate} frozenRate=${stats.audioTotalFrozenRate} " +
                        "networkDelay=${stats.network_transport_delay} " +
                        "jitterDelay=${stats.jitter_buffer_delay} e2eDelay=${stats.e2eDelay} " +
                        "rtt=${stats.rtt}",
                )
            }

            override fun onRtcAudioStutterStats(stats: AliRtcEngine.AliRtcAudioStutterStats?) {
                if (!isCurrentRtcCallback(engine, generation) || stats == null) return
                Log.w(
                    RTC_DIAGNOSTIC_TAG,
                    "ARTC audio stutter userPresent=${!stats.userId.isNullOrBlank()} " +
                        "track=${stats.audioTrack} module=${stats.reasonModule} " +
                        "description=${stats.desc}",
                )
            }

            override fun onAudioFocusChange(focusChange: Int) {
                if (!isCurrentRtcCallback(engine, generation)) return
                Log.i(RTC_DIAGNOSTIC_TAG, "ARTC audio focus changed value=$focusChange")
            }

            override fun onAudioRouteChanged(route: AliRtcEngine.AliRtcAudioRouteType?) {
                if (!isCurrentRtcCallback(engine, generation)) return
                Log.i(RTC_DIAGNOSTIC_TAG, "ARTC audio route changed route=$route")
            }

            override fun onRemoteUserOnLineNotify(remoteUserId: String?, elapsed: Int) {
                if (!isCurrentRtcCallback(engine, generation)) return
                Log.i(
                    RTC_DIAGNOSTIC_TAG,
                    "ARTC remote user online userPresent=${!remoteUserId.isNullOrBlank()} elapsed=$elapsed",
                )
                mainHandler.post {
                    if (!isCurrentRtcCallback(engine, generation)) return@post
                    if (remoteUserId.isNullOrBlank()) return@post
                    remoteOnlineUsers.add(remoteUserId)
                    // Audio and video subscriptions were configured before
                    // join. Do not repeat a per-user subscription here: a
                    // queued online callback can run after that user has
                    // already left and ARTC then reports SUBSCRIBE_INVALID.
                    emitPeerJoinedIfReady(remoteUserId)
                }
            }

            override fun onRemoteTrackAvailableNotify(
                remoteUserId: String?,
                audioTrack: AliRtcEngine.AliRtcAudioTrack?,
                videoTrack: AliRtcEngine.AliRtcVideoTrack?,
            ) {
                if (!isCurrentRtcCallback(engine, generation) || remoteUserId.isNullOrBlank()) {
                    return
                }
                val hasCamera =
                    videoTrack == AliRtcEngine.AliRtcVideoTrack.AliRtcVideoTrackCamera ||
                        videoTrack == AliRtcEngine.AliRtcVideoTrack.AliRtcVideoTrackBoth
                mainHandler.post {
                    if (!isCurrentRtcCallback(engine, generation)) return@post
                    if (rtcMediaType != RtcMediaType.VIDEO) return@post
                    if (hasCamera) {
                        if (remoteUserId !in remoteOnlineUsers) return@post
                        activeRemoteUserId = remoteUserId
                        val bindCode = bindRemoteVideoView(engine, remoteUserId)
                        if (bindCode != 0) {
                            notifyVideoDegraded(bindCode, "remote_video_render")
                        }
                    } else if (activeRemoteUserId == remoteUserId) {
                        val unbindCode = clearRemoteVideoRenderView(engine, remoteUserId)
                        if (unbindCode != 0) {
                            notifyVideoDegraded(unbindCode, "remote_video_unbind")
                        }
                    }
                }
            }

            override fun onRemoteUserOffLineNotify(
                remoteUserId: String?,
                reason: AliRtcEngine.AliRtcUserOfflineReason?,
            ) {
                if (!isCurrentRtcCallback(engine, generation)) return
                Log.i(
                    RTC_DIAGNOSTIC_TAG,
                    "ARTC remote user offline userPresent=${!remoteUserId.isNullOrBlank()} reason=$reason",
                )
                mainHandler.post {
                    if (!isCurrentRtcCallback(engine, generation)) return@post
                    if (!remoteUserId.isNullOrBlank()) {
                        remoteOnlineUsers.remove(remoteUserId)
                        remoteAudioSubscribedUsers.remove(remoteUserId)
                    }
                    if (activeRemoteUserId == remoteUserId) {
                        activeRemoteUserId = null
                        clearRemoteVideoRenderView(engine, remoteUserId)
                    }
                    if (!remoteUserId.isNullOrBlank() && announcedRemoteUsers.remove(remoteUserId)) {
                        channel?.invokeMethod("state", mapOf("state" to "peer_left"))
                    }
                }
            }

            override fun onAuthInfoWillExpire() {
                if (!isCurrentRtcCallback(engine, generation)) return
                mainHandler.post {
                    if (!isCurrentRtcCallback(engine, generation)) return@post
                    channel?.invokeMethod(
                        "state",
                        mapOf(
                            "state" to "credential_expiring",
                            "category" to "credential",
                            "phase" to "auth_will_expire",
                        ),
                    )
                }
            }

            override fun onAuthInfoExpired() {
                if (!isCurrentRtcCallback(engine, generation)) return
                mainHandler.post {
                    if (!isCurrentRtcCallback(engine, generation)) return@post
                    reportRtcErrorAndScheduleShutdown(
                        engine,
                        generation,
                        RTC_OPERATION_UNAVAILABLE,
                        phase = "auth_expired",
                        category = "credential",
                    )
                }
            }
        })
        // Observe a possible SDK default microphone publication from the very
        // first join callback. Explicit publish(true) after a successful join
        // remains the idempotent request for clients where it is not automatic.
        audioPublishRequested = true
        val code = runRtcOperation("joinChannel") {
            engine.joinChannel(token, channelId, userId, displayName)
        }
        Log.i(
            RTC_DIAGNOSTIC_TAG,
            "ARTC joinChannel syncResult=$code sdkVersion=${AliRtcEngine.getSdkVersion()}",
        )
        if (code != 0) {
            result.error(
                "RTC_JOIN_REJECTED",
                "ARTC SDK rejected credential or join parameters",
                mapOf(
                    "phase" to "sync_join",
                    "category" to "credential",
                    "code" to code,
                ),
            )
            shutdownRtc()
            return
        }
        scheduleJoinCallbackTimeout(engine, generation)
        result.success(code)
    }

    private fun scheduleJoinCallbackTimeout(engine: AliRtcEngine, generation: Long) {
        cancelJoinCallbackTimeout()
        val timeout = Runnable {
            joinCallbackTimeout = null
            if (
                !isCurrentRtcCallback(engine, generation) ||
                rtcChannelJoinedSuccessfully
            ) {
                return@Runnable
            }
            reportRtcErrorAndScheduleShutdown(
                engine,
                generation,
                RTC_OPERATION_UNAVAILABLE,
                phase = "async_join_timeout",
                category = "network",
            )
        }
        joinCallbackTimeout = timeout
        mainHandler.postDelayed(timeout, JOIN_CALLBACK_TIMEOUT_MS)
    }

    private fun cancelJoinCallbackTimeout() {
        joinCallbackTimeout?.let(mainHandler::removeCallbacks)
        joinCallbackTimeout = null
    }

    private fun handleLocalAudioPublishState(
        engine: AliRtcEngine,
        generation: Long,
        newState: AliRtcEngine.AliRtcPublishState?,
    ) {
        if (!audioPublishRequested || !isCurrentRtcCallback(engine, generation)) return
        Log.i(
            RTC_DIAGNOSTIC_TAG,
            "ARTC local audio publish state=$newState generation=$generation",
        )
        mainHandler.post {
            if (!audioPublishRequested || !isCurrentRtcCallback(engine, generation)) {
                return@post
            }
            when (newState) {
                AliRtcEngine.AliRtcPublishState.AliRtcStatsPublished -> {
                    cancelAudioPublishTimeout()
                    localAudioPublished = true
                    emitJoinedIfReady()
                    remoteOnlineUsers.toList().forEach(::emitPeerJoinedIfReady)
                }
                AliRtcEngine.AliRtcPublishState.AliRtcStatsNoPublish -> {
                    // NoPublish is also observed after muteLocalMic, and its
                    // delayed callback can arrive after an immediate unmute.
                    // Initial readiness remains bounded by the publish timeout;
                    // runtime loss is handled by connection/device callbacks.
                    Unit
                }
                else -> Unit
            }
        }
    }

    private fun scheduleAudioPublishTimeout(engine: AliRtcEngine, generation: Long) {
        cancelAudioPublishTimeout()
        val timeout = Runnable {
            audioPublishTimeout = null
            if (
                !isCurrentRtcCallback(engine, generation) ||
                !audioPublishRequested ||
                localAudioPublished
            ) {
                return@Runnable
            }
            reportRtcErrorAndScheduleShutdown(
                engine,
                generation,
                RTC_OPERATION_UNAVAILABLE,
                phase = "audio_publish_timeout",
                category = "audio",
            )
        }
        audioPublishTimeout = timeout
        mainHandler.postDelayed(timeout, MEDIA_PUBLISH_TIMEOUT_MS)
    }

    private fun cancelAudioPublishTimeout() {
        audioPublishTimeout?.let(mainHandler::removeCallbacks)
        audioPublishTimeout = null
    }

    private fun emitJoinedIfReady() {
        if (
            joinedStateEmitted ||
            !rtcChannelJoinedSuccessfully ||
            !localAudioPublished ||
            shuttingDown ||
            activityDestroyed
        ) {
            return
        }
        joinedStateEmitted = true
        channel?.invokeMethod(
            "state",
            mapOf(
                "state" to "joined",
                "code" to 0,
                "phase" to "audio_published",
                "category" to "none",
            ),
        )
    }

    private fun handleRemoteAudioSubscribeState(
        engine: AliRtcEngine,
        generation: Long,
        remoteUserId: String?,
        newState: AliRtcEngine.AliRtcSubscribeState?,
    ) {
        if (remoteUserId.isNullOrBlank() || !isCurrentRtcCallback(engine, generation)) return
        Log.i(
            RTC_DIAGNOSTIC_TAG,
            "ARTC remote audio subscribe state=$newState generation=$generation",
        )
        mainHandler.post {
            if (!isCurrentRtcCallback(engine, generation)) return@post
            when (newState) {
                AliRtcEngine.AliRtcSubscribeState.AliRtcStatsSubscribed -> {
                    remoteAudioSubscribedUsers.add(remoteUserId)
                    emitPeerJoinedIfReady(remoteUserId)
                }
                AliRtcEngine.AliRtcSubscribeState.AliRtcStatsNoSubscribe,
                AliRtcEngine.AliRtcSubscribeState.AliRtcStatsSubscribeIdle,
                -> {
                    remoteAudioSubscribedUsers.remove(remoteUserId)
                    // Remote mute/track interruption is not peer departure.
                    // Only onRemoteUserOffLineNotify emits peer_left.
                }
                else -> Unit
            }
        }
    }

    private fun emitPeerJoinedIfReady(remoteUserId: String) {
        if (
            !localAudioPublished ||
            remoteUserId !in remoteOnlineUsers ||
            remoteUserId !in remoteAudioSubscribedUsers ||
            shuttingDown ||
            activityDestroyed ||
            !announcedRemoteUsers.add(remoteUserId)
        ) {
            return
        }
        channel?.invokeMethod(
            "state",
            mapOf(
                "state" to "peer_joined",
                "phase" to "audio_subscribed",
            ),
        )
    }

    private fun handleLocalVideoPublishState(
        engine: AliRtcEngine,
        generation: Long,
        newState: AliRtcEngine.AliRtcPublishState?,
    ) {
        if (!isCurrentRtcCallback(engine, generation)) return
        mainHandler.post {
            if (!isCurrentRtcCallback(engine, generation)) return@post
            when (newState) {
                AliRtcEngine.AliRtcPublishState.AliRtcStatsPublished -> {
                    if (!cameraEnabled || !videoPublishRequested) {
                        // The callback is authoritative proof that a camera
                        // track reached the room. Preserve that fact through
                        // rollback so an unpublish failure forces engine
                        // destruction instead of relying on cameraOn alone.
                        localVideoPublished = true
                        val rollbackCode = rollbackLocalVideo(
                            engine,
                            "unexpected_publish_rollback_failed",
                        )
                        if (rollbackCode == 0) {
                            notifyCameraDisabled(
                                RTC_OPERATION_UNAVAILABLE,
                                "unexpected_publish",
                            )
                        }
                        return@post
                    }
                    cancelVideoPublishTimeout()
                    localVideoPublished = true
                }
                AliRtcEngine.AliRtcPublishState.AliRtcStatsNoPublish -> {
                    if (!videoPublishRequested) return@post
                    // Ignore the initial NoPublish edge; timeout proves that a
                    // requested publication never became usable.
                    if (!localVideoPublished) return@post
                    videoPublishRequested = false
                    localVideoPublished = false
                    cancelVideoPublishTimeout()
                    val rollbackCode = rollbackLocalVideo(
                        engine,
                        "publish_drop_rollback_failed",
                    )
                    if (rollbackCode == 0) {
                        notifyCameraDisabled(
                            RTC_OPERATION_UNAVAILABLE,
                            "publish_dropped",
                        )
                    }
                }
                else -> Unit
            }
        }
    }

    private fun requestLocalVideoPublish(
        engine: AliRtcEngine,
        generation: Long,
        failureReason: String,
    ): Int {
        if (!isCurrentRtcCallback(engine, generation) || !cameraEnabled) {
            return RTC_OPERATION_UNAVAILABLE
        }
        cancelVideoPublishTimeout()
        videoPublishRequested = true
        localVideoPublished = false
        val code = runRtcOperation("publishLocalVideo") {
            engine.publishLocalVideoStream(true)
        }
        if (code != 0) {
            videoPublishRequested = false
            val rollbackCode = rollbackLocalVideo(
                engine,
                "publish_rollback_failed",
            )
            if (rollbackCode == 0) notifyCameraDisabled(code, failureReason)
            return code
        }
        val timeout = Runnable {
            videoPublishTimeout = null
            if (
                !isCurrentRtcCallback(engine, generation) ||
                !videoPublishRequested ||
                localVideoPublished
            ) {
                return@Runnable
            }
            videoPublishRequested = false
            val rollbackCode = rollbackLocalVideo(
                engine,
                "publish_timeout_rollback_failed",
            )
            if (rollbackCode == 0) {
                notifyCameraDisabled(
                    RTC_OPERATION_UNAVAILABLE,
                    "publish_timeout",
                )
            }
        }
        videoPublishTimeout = timeout
        mainHandler.postDelayed(timeout, MEDIA_PUBLISH_TIMEOUT_MS)
        return 0
    }

    private fun cancelVideoPublishTimeout() {
        videoPublishTimeout?.let(mainHandler::removeCallbacks)
        videoPublishTimeout = null
    }

    private fun classifyAsyncJoinFailure(resultCode: Int): String = when (resultCode) {
        0 -> "none"
        33_620_481,
        33_620_482,
        33_620_483,
        33_620_484,
        33_620_485,
        33_620_486,
        16_974_081,
        17_314_049,
        -> "authentication"
        16_974_339,
        84_148_226,
        -> "account"
        16_908_804,
        17_301_508,
        16_974_338,
        17_317_890,
        17_105_409,
        17_105_410,
        17_105_411,
        16_908_812,
        -> "network"
        else -> "service"
    }

    private fun isCameraRuntimeError(code: Int): Boolean = when (code) {
        ERR_CAMERA_OPEN_FAIL,
        ERR_CAMERA_INTERRUPT,
        ERR_VIDEO_DISPLAY_OPEN_FAIL,
        ERR_VIDEO_DISPLAY_INTERRUPT,
        ERR_PUBLISH_VIDEO_STREAM_FAILED,
        ERR_PUBLISH_DUAL_STREAM_FAILED,
        -> true
        else -> false
    }

    private fun isRemoteVideoRuntimeError(code: Int): Boolean = when (code) {
        ERR_SUBSCRIBE_VIDEO_STREAM_FAILED,
        ERR_SUBSCRIBE_DUAL_STREAM_FAILED,
        -> true
        else -> false
    }

    private fun failInitialRtcSetup(
        result: MethodChannel.Result,
        engine: AliRtcEngine,
        code: Int,
        step: String,
    ) {
        Log.e(
            RTC_DIAGNOSTIC_TAG,
            "ARTC required setup failed step=$step result=$code",
        )
        result.error(
            "RTC_SETUP_FAILED",
            "RTC engine setup failed",
            mapOf(
                "phase" to "setup",
                "category" to "service",
                "code" to code,
                "step" to step,
            ),
        )
        if (rtcEngine === engine) shutdownRtc()
    }

    private fun reportRtcErrorAndScheduleShutdown(
        engine: AliRtcEngine,
        generation: Long,
        code: Int,
        phase: String,
        category: String,
        message: String? = null,
    ) {
        if (!isCurrentRtcCallback(engine, generation)) return
        Log.e(
            RTC_DIAGNOSTIC_TAG,
            "ARTC fatal error phase=$phase category=$category code=$code " +
                "messagePresent=${!message.isNullOrBlank()}",
        )
        deferredShutdownEngine = engine
        channel?.invokeMethod(
            "state",
            mapOf(
                "state" to "error",
                "code" to code,
                "message" to message,
                "phase" to phase,
                "category" to category,
            ),
        )
        // Always leave the SDK callback stack before leave/destroy. ARTC warns
        // that destroying an engine from one of its callbacks can deadlock.
        mainHandler.post {
            if (!isCurrentRtcEngine(engine, generation)) return@post
            if (deferredShutdownEngine === engine) deferredShutdownEngine = null
            if (!shuttingDown) shutdownRtc()
        }
    }

    private fun isCurrentRtcEngine(engine: AliRtcEngine, generation: Long): Boolean =
        rtcEngine === engine &&
            rtcGeneration == generation &&
            RtcEngineRegistry.isOwner(rtcOwnerToken, engine)

    private fun isCurrentRtcCallback(engine: AliRtcEngine, generation: Long): Boolean =
        isCurrentRtcEngine(engine, generation) &&
            !shuttingDown &&
            !activityDestroyed &&
            deferredShutdownEngine !== engine

    private fun stopRtcForegroundServiceIfIdle() {
        if (
            rtcEngine == null &&
            pendingJoin == null &&
            !shuttingDown &&
            !RtcEngineRegistry.isOwnedBy(rtcOwnerToken)
        ) {
            RtcCallForegroundService.stop(this, rtcOwnerToken)
        }
    }

    override fun onRtcVideoViewCreated(platformView: RtcVideoPlatformView) {
        runOnUiThread {
            val engine = rtcEngine
            when (platformView.role) {
                RtcVideoViewRole.LOCAL -> {
                    if (localVideoPlatformView !== platformView) {
                        localVideoPlatformView?.clearRenderView()
                        localVideoPlatformView = platformView
                        localRtcRenderView = null
                    }
                    if (
                        engine != null &&
                        rtcMediaType == RtcMediaType.VIDEO &&
                        cameraEnabled
                    ) {
                        val bindCode = bindLocalVideoView(engine)
                        if (bindCode != 0) {
                            val rollbackCode = rollbackLocalVideo(
                                engine,
                                "preview_bind_rollback_failed",
                            )
                            if (rollbackCode != 0) return@runOnUiThread
                            notifyCameraDisabled(bindCode, "preview_bind_failed")
                        }
                    }
                }
                RtcVideoViewRole.REMOTE -> {
                    if (remoteVideoPlatformView !== platformView) {
                        remoteVideoPlatformView?.clearRenderView()
                        remoteVideoPlatformView = platformView
                        remoteRtcRenderView = null
                        remoteRenderUserId = null
                    }
                    val remoteUserId = activeRemoteUserId
                    if (
                        engine != null &&
                        rtcMediaType == RtcMediaType.VIDEO &&
                        !remoteUserId.isNullOrBlank()
                    ) {
                        val bindCode = bindRemoteVideoView(engine, remoteUserId)
                        if (bindCode != 0 && !shuttingDown) {
                            notifyVideoDegraded(bindCode, "remote_video_render")
                        }
                    }
                }
            }
        }
    }

    override fun onRtcVideoViewDisposed(platformView: RtcVideoPlatformView) {
        runOnUiThread {
            when (platformView.role) {
                RtcVideoViewRole.LOCAL -> {
                    if (localVideoPlatformView === platformView) {
                        val engine = rtcEngine
                        if (engine != null && localRtcRenderView != null && !shuttingDown) {
                            val code = clearLocalVideoRenderView(engine)
                            if (code != 0) {
                                notifyVideoDegraded(code, "local_video_unbind")
                            }
                        }
                        localVideoPlatformView = null
                        localRtcRenderView = null
                    }
                }
                RtcVideoViewRole.REMOTE -> {
                    if (remoteVideoPlatformView === platformView) {
                        val engine = rtcEngine
                        val remoteUserId = remoteRenderUserId ?: activeRemoteUserId
                        if (
                            engine != null &&
                            remoteRtcRenderView != null &&
                            !remoteUserId.isNullOrBlank() &&
                            !shuttingDown
                        ) {
                            val code = clearRemoteVideoRenderView(engine, remoteUserId)
                            if (code != 0) {
                                notifyVideoDegraded(code, "remote_video_unbind")
                            }
                        }
                        remoteVideoPlatformView = null
                        remoteRtcRenderView = null
                        remoteRenderUserId = null
                    }
                }
            }
        }
    }

    private fun enableLocalVideoTransaction(
        engine: AliRtcEngine,
        publish: Boolean,
    ): Int {
        // A deliberate new camera operation supersedes any delayed check from
        // an earlier cleanup. Without this generation boundary, reopening the
        // camera during the 300 ms safety window could be mistaken for a
        // failed old shutdown and destroy an otherwise healthy call.
        invalidateCameraSafetyConfirmation()
        val steps = listOf<Pair<String, () -> Int>>(
            "bindPreview" to { bindLocalVideoView(engine) },
            "enableLocal" to { engine.enableLocalVideo(true) },
            "startPreview" to { engine.startPreview() },
        )
        for ((name, operation) in steps) {
            val code = runRtcOperation(name, operation)
            if (code != 0) {
                Log.w(RTC_DIAGNOSTIC_TAG, "ARTC local video enable failed step=$name code=$code")
                val rollbackCode = rollbackLocalVideo(engine, "enable_rollback_failed")
                if (rollbackCode == 0) {
                    notifyCameraDisabled(code, "enable_${name}_failed")
                }
                return code
            }
        }
        cameraEnabled = true
        if (publish) {
            val publishCode = requestLocalVideoPublish(
                engine,
                rtcGeneration,
                "publish_failed",
            )
            if (publishCode != 0) return publishCode
        }
        Log.i(RTC_DIAGNOSTIC_TAG, "ARTC local video enabled publish=$publish")
        return 0
    }

    private fun bindLocalVideoView(engine: AliRtcEngine): Int {
        if (rtcEngine !== engine || rtcMediaType != RtcMediaType.VIDEO || shuttingDown) {
            return RTC_OPERATION_UNAVAILABLE
        }
        val renderView = localRtcRenderView ?: try {
            engine.createRenderTextureView(this).also { localRtcRenderView = it }
        } catch (error: RuntimeException) {
            Log.e(RTC_DIAGNOSTIC_TAG, "ARTC local render view creation failed", error)
            return RTC_OPERATION_UNAVAILABLE
        }
        localVideoPlatformView?.attachRenderView(renderView)
        val canvas = AliRtcEngine.AliRtcVideoCanvas().apply {
            view = renderView
            renderMode = AliRtcEngine.AliRtcRenderMode.AliRtcRenderModeClip
            mirrorMode =
                AliRtcEngine.AliRtcRenderMirrorMode.AliRtcRenderMirrorModeOnlyFront
        }
        val code = runRtcOperation("setLocalView") {
            engine.setLocalViewConfig(
                canvas,
                AliRtcEngine.AliRtcVideoTrack.AliRtcVideoTrackCamera,
            )
        }
        Log.i(RTC_DIAGNOSTIC_TAG, "ARTC local video view bound result=$code")
        return code
    }

    private fun bindRemoteVideoView(engine: AliRtcEngine, remoteUserId: String): Int {
        if (rtcEngine !== engine || rtcMediaType != RtcMediaType.VIDEO || shuttingDown) {
            return RTC_OPERATION_UNAVAILABLE
        }
        // The Flutter PlatformView may be created a frame after the remote
        // track. Keep the user id and bind when onRtcVideoViewCreated arrives.
        val platformView = remoteVideoPlatformView ?: return 0
        val renderView = if (
            remoteRtcRenderView != null &&
            remoteRenderUserId == remoteUserId
        ) {
            remoteRtcRenderView!!
        } else {
            platformView.clearRenderView()
            val created = try {
                engine.createRenderTextureView(this)
            } catch (error: RuntimeException) {
                Log.e(RTC_DIAGNOSTIC_TAG, "ARTC remote render view creation failed", error)
                return RTC_OPERATION_UNAVAILABLE
            }
            created.also {
                remoteRtcRenderView = it
                remoteRenderUserId = remoteUserId
                platformView.attachRenderView(it)
            }
        }
        val canvas = AliRtcEngine.AliRtcVideoCanvas().apply {
            view = renderView
            renderMode = AliRtcEngine.AliRtcRenderMode.AliRtcRenderModeClip
            mirrorMode =
                AliRtcEngine.AliRtcRenderMirrorMode.AliRtcRenderMirrorModeAllDisable
        }
        val code = runRtcOperation("setRemoteView") {
            engine.setRemoteViewConfig(
                canvas,
                remoteUserId,
                AliRtcEngine.AliRtcVideoTrack.AliRtcVideoTrackCamera,
            )
        }
        Log.i(
            RTC_DIAGNOSTIC_TAG,
            "ARTC remote video view bound userPresent=true result=$code",
        )
        return code
    }

    private fun setCameraEnabled(enabled: Boolean): Int {
        val engine = rtcEngine ?: return RTC_OPERATION_UNAVAILABLE
        if (
            rtcMediaType != RtcMediaType.VIDEO ||
            activityDestroyed ||
            !RtcEngineRegistry.isOwner(rtcOwnerToken, engine) ||
            shuttingDown
        ) {
            return RTC_OPERATION_UNAVAILABLE
        }
        if (enabled) {
            if (!activityResumed) return RTC_OPERATION_UNAVAILABLE
            if (cameraEnabled) return 0
            val publish = try {
                engine.isInCall
            } catch (error: Exception) {
                Log.e(RTC_DIAGNOSTIC_TAG, "ARTC unable to determine video publish state", error)
                return RTC_OPERATION_UNAVAILABLE
            }
            val code = enableLocalVideoTransaction(engine, publish = publish)
            return code
        }
        if (!cameraEnabled) return 0
        val firstFailure = disableLocalVideoBestEffort(
            engine,
            fatalReason = "disable_unconfirmed",
        )
        Log.i(
            RTC_DIAGNOSTIC_TAG,
            "ARTC camera enabled=false requested=false result=$firstFailure",
        )
        return firstFailure
    }

    private fun disableLocalVideoBestEffort(
        engine: AliRtcEngine,
        publishBeforeJoin: Boolean = false,
        fatalReason: String,
    ): Int {
        val operationGeneration = invalidateCameraSafetyConfirmation()
        val publicationWasActive = videoPublishRequested || localVideoPublished
        videoPublishRequested = false
        localVideoPublished = false
        cancelVideoPublishTimeout()
        var firstFailure = 0
        var unpublishFailure = 0
        fun record(name: String, operation: () -> Int) {
            val code = runRtcOperation(name, operation)
            if (firstFailure == 0 && code != 0) firstFailure = code
            if (name == "unpublish" && code != 0) unpublishFailure = code
        }
        val isInCall = try {
            engine.isInCall
        } catch (error: Exception) {
            Log.e(RTC_DIAGNOSTIC_TAG, "ARTC unable to confirm in-call state", error)
            firstFailure = RTC_OPERATION_UNAVAILABLE
            // If the state cannot be read, make the conservative attempt to
            // unpublish before the engine is forcibly destroyed below.
            true
        }
        if (isInCall || publishBeforeJoin) {
            record("unpublish") { engine.publishLocalVideoStream(false) }
        }
        record("stopPreview") { engine.stopPreview() }
        record("disableLocal") { engine.enableLocalVideo(false) }
        cameraEnabled = false
        record("unbindLocalView") { clearLocalVideoRenderView(engine) }
        if (publicationWasActive && unpublishFailure != 0) {
            // Camera-off alone does not prove that an already published remote
            // track was withdrawn. Destroy is the only privacy-safe boundary.
            forceDestroyForCameraFailure(engine, unpublishFailure, fatalReason)
            return unpublishFailure
        }
        if (firstFailure != 0) {
            // ARTC camera shutdown is asynchronous. Re-check after the state
            // machine settles instead of destroying a healthy audio call on a
            // transient isCameraOn=true result.
            scheduleCameraSafetyConfirmation(
                engine,
                firstFailure,
                fatalReason,
                operationGeneration,
            )
            Log.w(
                RTC_DIAGNOSTIC_TAG,
                "ARTC camera cleanup had non-zero result=$firstFailure; " +
                    "scheduled safety confirmation",
            )
            return 0
        }
        return firstFailure
    }

    private fun scheduleCameraSafetyConfirmation(
        engine: AliRtcEngine,
        code: Int,
        reason: String,
        operationGeneration: Long,
    ) {
        lateinit var confirmation: Runnable
        confirmation = Runnable {
            if (cameraSafetyConfirmation === confirmation) {
                cameraSafetyConfirmation = null
            }
            if (
                cameraOperationGeneration != operationGeneration ||
                rtcEngine !== engine ||
                fatalCameraEngine === engine ||
                shuttingDown
            ) return@Runnable
            val cameraStillOn = try {
                engine.isCameraOn
            } catch (error: Exception) {
                Log.e(
                    RTC_DIAGNOSTIC_TAG,
                    "ARTC unable to verify camera state after delayed rollback",
                    error,
                )
                true
            }
            if (cameraStillOn) {
                forceDestroyForCameraFailure(engine, code, reason)
            } else {
                Log.i(
                    RTC_DIAGNOSTIC_TAG,
                    "ARTC delayed camera safety confirmation succeeded reason=$reason",
                )
            }
        }
        cameraSafetyConfirmation = confirmation
        mainHandler.postDelayed(confirmation, CAMERA_SHUTDOWN_CONFIRM_DELAY_MS)
    }

    private fun invalidateCameraSafetyConfirmation(): Long {
        cameraSafetyConfirmation?.let(mainHandler::removeCallbacks)
        cameraSafetyConfirmation = null
        cameraOperationGeneration += 1
        return cameraOperationGeneration
    }

    private fun rollbackLocalVideo(engine: AliRtcEngine, fatalReason: String): Int {
        val rollbackCode = disableLocalVideoBestEffort(
            engine,
            publishBeforeJoin = true,
            fatalReason = fatalReason,
        )
        Log.i(RTC_DIAGNOSTIC_TAG, "ARTC local video rollback result=$rollbackCode")
        return rollbackCode
    }

    private fun runRtcOperation(name: String, operation: () -> Int): Int = try {
        operation()
    } catch (error: Exception) {
        Log.e(RTC_DIAGNOSTIC_TAG, "ARTC operation failed name=$name", error)
        RTC_OPERATION_UNAVAILABLE
    }

    private fun notifyCameraDisabled(code: Int, reason: String) {
        if (shuttingDown) return
        channel?.invokeMethod(
            "state",
            mapOf(
                "state" to "camera_disabled",
                "category" to "camera",
                "code" to code,
                "reason" to reason,
            ),
        )
    }

    private fun notifyVideoDegraded(code: Int, phase: String) {
        if (shuttingDown) return
        Log.w(
            RTC_DIAGNOSTIC_TAG,
            "ARTC video degraded phase=$phase code=$code; continuing audio call",
        )
        channel?.invokeMethod(
            "state",
            mapOf(
                "state" to "video_degraded",
                "category" to "video",
                "phase" to phase,
                "code" to code,
            ),
        )
    }

    private fun forceDestroyForCameraFailure(
        engine: AliRtcEngine,
        code: Int,
        reason: String,
    ) {
        if (rtcEngine !== engine || fatalCameraEngine === engine) return

        // Invalidate every listener before touching the SDK. A late join,
        // recovery, track, or leave callback from this engine can no longer
        // overwrite the fatal camera state or affect a later RTC generation.
        fatalCameraEngine = engine
        ++rtcGeneration
        shuttingDown = true
        cancelJoinCallbackTimeout()
        cancelAudioPublishTimeout()
        cancelVideoPublishTimeout()
        invalidateCameraSafetyConfirmation()
        rtcChannelJoinedSuccessfully = false
        audioPublishRequested = false
        localAudioPublished = false
        videoPublishRequested = false
        localVideoPublished = false
        translationCaptureEnabled = false
        resetTranslationCaptureBuffer()
        stopTranslationAudio()
        cameraEnabled = false
        activeRemoteUserId = null
        rtcMediaType = RtcMediaType.AUDIO
        clearVideoRenderViews(null)
        leaveTimeout?.let(mainHandler::removeCallbacks)
        leaveTimeout = null

        Log.e(
            RTC_DIAGNOSTIC_TAG,
            "ARTC camera shutdown could not be confirmed; forcing engine destroy " +
                "reason=$reason code=$code",
        )
        channel?.invokeMethod(
            "state",
            mapOf(
                "state" to "error",
                "category" to "camera",
                "phase" to "camera_safety",
                "code" to code,
                "reason" to reason,
            ),
        )

        // Do not call leaveChannel or wait for its callback. destroy() is the
        // privacy boundary when the SDK cannot prove capture/publication off.
        // Posting also guarantees that destroy is never called from an ARTC
        // callback stack, which the vendor documents as a deadlock hazard.
        mainHandler.post {
            if (rtcEngine === engine) finishDestroy(engine)
        }
    }

    private fun switchCamera(): Int {
        val engine = rtcEngine ?: return RTC_OPERATION_UNAVAILABLE
        if (
            rtcMediaType != RtcMediaType.VIDEO ||
            !cameraEnabled ||
            !activityResumed ||
            activityDestroyed ||
            !RtcEngineRegistry.isOwner(rtcOwnerToken, engine) ||
            shuttingDown
        ) {
            return RTC_OPERATION_UNAVAILABLE
        }
        return runRtcOperation("switchCamera") { engine.switchCamera() }
    }

    private fun clearLocalVideoRenderView(engine: AliRtcEngine? = rtcEngine): Int {
        val code = if (engine != null && rtcEngine === engine && destroyingEngine !== engine) {
            runRtcOperation("unsetLocalView") {
                engine.setLocalViewConfig(
                    null,
                    AliRtcEngine.AliRtcVideoTrack.AliRtcVideoTrackCamera,
                )
            }
        } else {
            0
        }
        localVideoPlatformView?.clearRenderView()
        localRtcRenderView = null
        return code
    }

    private fun clearRemoteVideoRenderView(
        engine: AliRtcEngine? = rtcEngine,
        userId: String? = remoteRenderUserId ?: activeRemoteUserId,
    ): Int {
        val code = if (
            engine != null &&
            rtcEngine === engine &&
            destroyingEngine !== engine &&
            !userId.isNullOrBlank()
        ) {
            runRtcOperation("unsetRemoteView") {
                engine.setRemoteViewConfig(
                    null,
                    userId,
                    AliRtcEngine.AliRtcVideoTrack.AliRtcVideoTrackCamera,
                )
            }
        } else {
            0
        }
        remoteVideoPlatformView?.clearRenderView()
        remoteRtcRenderView = null
        remoteRenderUserId = null
        return code
    }

    private fun clearVideoRenderViews(engine: AliRtcEngine? = rtcEngine): Int {
        val localCode = clearLocalVideoRenderView(engine)
        val remoteCode = clearRemoteVideoRenderView(engine)
        return if (localCode != 0) localCode else remoteCode
    }

    private fun releaseVideoSession(engine: AliRtcEngine): Int {
        var disableCode = 0
        if (rtcMediaType == RtcMediaType.VIDEO) {
            disableCode = disableLocalVideoBestEffort(
                engine,
                publishBeforeJoin = true,
                fatalReason = "shutdown_disable_failed",
            )
        }
        val renderReleaseCode = clearVideoRenderViews(engine)
        if (renderReleaseCode != 0) {
            Log.w(
                RTC_DIAGNOSTIC_TAG,
                "ARTC video renderer detach failed result=$renderReleaseCode",
            )
        }
        activeRemoteUserId = null
        cameraEnabled = false
        rtcMediaType = RtcMediaType.AUDIO
        return disableCode
    }

    private fun setMuted(muted: Boolean): Int {
        val engine = controllableRtcEngine() ?: return RTC_OPERATION_UNAVAILABLE
        val code = runRtcOperation("muteLocalMic") {
            engine.muteLocalMic(
                muted,
                AliRtcEngine.AliRtcMuteLocalAudioMode.AliRtcMuteOnlyMicAudioMode,
            )
        }
        if (code == 0) localMicMuted = muted
        return code
    }

    private fun isRunningOnEmulator(): Boolean =
        Build.HARDWARE.equals("ranchu", ignoreCase = true) ||
            Build.PRODUCT.startsWith("sdk_", ignoreCase = true) ||
            Build.FINGERPRINT.contains("generic", ignoreCase = true)

    private fun setSpeakerEnabled(enabled: Boolean): Int {
        val engine = controllableRtcEngine() ?: return RTC_OPERATION_UNAVAILABLE
        return runRtcOperation("enableSpeakerphone") {
            engine.enableSpeakerphone(enabled)
        }
    }

    private fun controllableRtcEngine(): AliRtcEngine? {
        val engine = rtcEngine ?: return null
        return if (
            !activityDestroyed &&
            !shuttingDown &&
            RtcEngineRegistry.isOwner(rtcOwnerToken, engine)
        ) {
            engine
        } else {
            null
        }
    }

    private fun setTranslationMode(
        enabled: Boolean,
        muteRemoteAudio: Boolean = enabled,
    ): Int {
        val engine = controllableRtcEngine() ?: return RTC_OPERATION_UNAVAILABLE
        if (!enabled) {
            // Stop local capture/playback first even if restoring remote audio
            // fails; the returned SDK code lets Flutter handle that failure.
            translationCaptureEnabled = false
            resetTranslationCaptureBuffer()
            stopTranslationAudio()
            translationPlaybackWriteLogged = false
            val code = runRtcOperation("restoreRemoteAudioPlaying") {
                engine.muteAllRemoteAudioPlaying(false)
            }
            Log.i(
                RTC_DIAGNOSTIC_TAG,
                "ARTC translation mode enabled=false observer=" +
                    "$translationFrameObserverAvailable result=$code",
            )
            return code
        }
        if (!translationFrameObserverAvailable) {
            Log.w(
                RTC_DIAGNOSTIC_TAG,
                "ARTC translation mode rejected because frame observer is unavailable",
            )
            return RTC_OPERATION_UNAVAILABLE
        }
        val code = runRtcOperation("setTranslationRemoteAudio") {
            engine.muteAllRemoteAudioPlaying(muteRemoteAudio)
        }
        if (code == 0) {
            translationCaptureEnabled = true
            resetTranslationCaptureBuffer()
            translationPlaybackWriteLogged = false
        }
        Log.i(
            RTC_DIAGNOSTIC_TAG,
            "ARTC translation mode enabled=${code == 0} " +
                "muteRemoteAudio=$muteRemoteAudio " +
                "observer=$translationFrameObserverAvailable result=$code",
        )
        return code
    }

    private fun disableTranslationModeForShutdown(engine: AliRtcEngine) {
        translationCaptureEnabled = false
        translationFrameObserverAvailable = false
        resetTranslationCaptureBuffer()
        stopTranslationAudio()
        runRtcOperation("restoreRemoteAudioOnShutdown") {
            engine.muteAllRemoteAudioPlaying(false)
        }
    }

    private fun captureTranslationAudio(
        frame: AliRtcEngine.AliRtcAudioFrame,
        engine: AliRtcEngine,
        generation: Long,
    ) {
        if (
            !translationCaptureEnabled ||
            !isCurrentRtcCallback(engine, generation)
        ) {
            return
        }
        // AliRTC 7.11 populates samplesPerSec for observed audio frames while
        // sampleRate remains at its default value. Keep the fallback for SDK
        // variants that still expose only the legacy field.
        val sampleRate = frame.samplesPerSec.takeIf { it > 0 } ?: frame.sampleRate
        if (!translationCaptureMetadataLogged) {
            translationCaptureMetadataLogged = true
            Log.i(
                RTC_DIAGNOSTIC_TAG,
                "ARTC translation audio frame samplesPerSec=${frame.samplesPerSec} " +
                    "sampleRate=${frame.sampleRate} resolvedSampleRate=$sampleRate " +
                    "channels=${frame.numChannels} bytesPerSample=${frame.bytesPerSample} " +
                    "dataSize=${frame.dataSize} dataBytes=${frame.data?.size ?: 0}",
            )
        }
        if (sampleRate != 16_000 || frame.numChannels != 1) return
        val data = frame.data ?: return
        val size = min(frame.dataSize.takeIf { it > 0 } ?: data.size, data.size)
        if (size <= 0) return
        val chunks = mutableListOf<ByteArray>()
        synchronized(translationCaptureLock) {
            var sourceOffset = 0
            while (sourceOffset < size) {
                val copySize = min(
                    size - sourceOffset,
                    TRANSLATION_CAPTURE_CHUNK_BYTES - translationCaptureBufferSize,
                )
                data.copyInto(
                    translationCaptureBuffer,
                    destinationOffset = translationCaptureBufferSize,
                    startIndex = sourceOffset,
                    endIndex = sourceOffset + copySize,
                )
                translationCaptureBufferSize += copySize
                sourceOffset += copySize
                if (translationCaptureBufferSize == TRANSLATION_CAPTURE_CHUNK_BYTES) {
                    chunks.add(translationCaptureBuffer.copyOf())
                    translationCaptureBufferSize = 0
                }
            }
        }
        for (chunk in chunks) {
            mainHandler.post {
                if (translationCaptureEnabled && isCurrentRtcCallback(engine, generation)) {
                    val activeChannel = channel
                    if (activeChannel != null) {
                        if (!translationCaptureChunkLogged) {
                            translationCaptureChunkLogged = true
                            Log.i(
                                RTC_DIAGNOSTIC_TAG,
                                "ARTC translation audio chunk dispatched bytes=${chunk.size}",
                            )
                        }
                        activeChannel.invokeMethod("audioFrame", chunk)
                    }
                }
            }
        }
    }

    private fun resetTranslationCaptureBuffer() {
        synchronized(translationCaptureLock) {
            translationCaptureBufferSize = 0
            translationCaptureMetadataLogged = false
            translationCaptureChunkLogged = false
        }
    }

    private fun enqueueTranslationAudio(audio: ByteArray, sampleRate: Int): Int {
        if (
            !translationCaptureEnabled ||
            !localAudioPublished ||
            controllableRtcEngine() == null
        ) {
            return RTC_OPERATION_UNAVAILABLE
        }
        val generation = translationPlaybackGeneration
        try {
            translationPlaybackExecutor.execute {
                if (!translationCaptureEnabled || generation != translationPlaybackGeneration) {
                    return@execute
                }
                val track = synchronized(translationPlaybackLock) {
                    if (!translationCaptureEnabled || generation != translationPlaybackGeneration) {
                        null
                    } else {
                        ensureTranslationAudioTrack(sampleRate)
                    }
                }
                if (track == null) {
                    Log.w(
                        RTC_DIAGNOSTIC_TAG,
                        "ARTC translated audio track unavailable sampleRate=$sampleRate",
                    )
                    return@execute
                }
                if (!translationCaptureEnabled || generation != translationPlaybackGeneration) {
                    return@execute
                }
                try {
                    if (track.playState != AudioTrack.PLAYSTATE_PLAYING) track.play()
                    // Do not hold translationPlaybackLock across WRITE_BLOCKING.
                    // Teardown can detach/release the track immediately, which
                    // unblocks this write instead of delaying RTC destruction.
                    var offset = 0
                    while (
                        offset < audio.size &&
                        translationCaptureEnabled &&
                        generation == translationPlaybackGeneration
                    ) {
                        val written = track.write(
                            audio,
                            offset,
                            audio.size - offset,
                            AudioTrack.WRITE_BLOCKING,
                        )
                        if (written <= 0) {
                            Log.w(
                                RTC_DIAGNOSTIC_TAG,
                                "ARTC translated audio write failed result=$written " +
                                    "remaining=${audio.size - offset} sampleRate=$sampleRate " +
                                    "state=${track.state} playState=${track.playState} " +
                                    "underruns=${track.underrunCount}",
                            )
                            break
                        }
                        offset += written
                    }
                    if (offset == audio.size && !translationPlaybackWriteLogged) {
                        translationPlaybackWriteLogged = true
                        Log.i(
                            RTC_DIAGNOSTIC_TAG,
                            "ARTC first translated audio write bytes=${audio.size} " +
                                "sampleRate=$sampleRate underruns=${track.underrunCount}",
                        )
                    }
                } catch (error: IllegalStateException) {
                    // Teardown may release the track while a write is in flight.
                    Log.w(
                        RTC_DIAGNOSTIC_TAG,
                        "ARTC translated audio write interrupted " +
                            "type=${error.javaClass.simpleName}",
                    )
                }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            // The Activity is already being destroyed.
            return RTC_OPERATION_UNAVAILABLE
        }
        return 0
    }

    private fun ensureTranslationAudioTrack(sampleRate: Int): AudioTrack? {
        val current = translationAudioTrack
        if (
            current != null &&
            current.state == AudioTrack.STATE_INITIALIZED &&
            translationAudioSampleRate == sampleRate
        ) {
            return current
        }
        releaseTranslationAudioTrackLocked()
        val minimumBuffer = AudioTrack.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minimumBuffer <= 0) return null
        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build(),
            )
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(maxOf(minimumBuffer * 4, 19_200))
            .setSessionId(AudioManager.AUDIO_SESSION_ID_GENERATE)
            .build()
        if (track.state != AudioTrack.STATE_INITIALIZED) {
            track.release()
            return null
        }
        translationAudioTrack = track
        translationAudioSampleRate = sampleRate
        return track
    }

    private fun stopTranslationAudio() {
        ++translationPlaybackGeneration
        val track = synchronized(translationPlaybackLock) {
            val current = translationAudioTrack
            translationAudioTrack = null
            translationAudioSampleRate = 0
            current
        }
        if (track != null) releaseTranslationAudioTrack(track)
    }

    private fun releaseTranslationAudioTrackLocked() {
        translationAudioTrack?.let(::releaseTranslationAudioTrack)
        translationAudioTrack = null
        translationAudioSampleRate = 0
    }

    private fun releaseTranslationAudioTrack(track: AudioTrack) {
        try {
            track.pause()
            track.flush()
            track.stop()
        } catch (_: IllegalStateException) {
            // The stream may already be stopped while the RTC engine exits.
        }
        try {
            track.release()
        } catch (_: RuntimeException) {
            // A concurrent blocking write may already have observed release.
        }
    }

    private fun shutdownRtc(onComplete: (() -> Unit)? = null) {
        if (onComplete != null) shutdownCallbacks.add(onComplete)
        cancelJoinCallbackTimeout()
        invalidateCameraSafetyConfirmation()
        val engine = rtcEngine
        if (engine == null) {
            clearVideoRenderViews(null)
            activeRemoteUserId = null
            cameraEnabled = false
            rtcMediaType = RtcMediaType.AUDIO
            drainShutdownCallbacks()
            if (!activityDestroyed) startPendingJoinIfAllowed()
            stopRtcForegroundServiceIfIdle()
            return
        }
        if (!RtcEngineRegistry.isOwner(rtcOwnerToken, engine)) {
            // A stale Activity must never operate on a singleton that has
            // already moved to another process owner.
            cancelAudioPublishTimeout()
            cancelVideoPublishTimeout()
            translationCaptureEnabled = false
            resetTranslationCaptureBuffer()
            stopTranslationAudio()
            clearVideoRenderViews(null)
            rtcEngine = null
            destroyingEngine = null
            shuttingDown = false
            drainShutdownCallbacks()
            if (!activityDestroyed) startPendingJoinIfAllowed()
            stopRtcForegroundServiceIfIdle()
            return
        }
        if (shuttingDown) return
        shuttingDown = true
        cancelAudioPublishTimeout()
        cancelVideoPublishTimeout()
        rtcChannelJoinedSuccessfully = false
        audioPublishRequested = false
        localAudioPublished = false
        videoPublishRequested = false
        localVideoPublished = false
        deferredShutdownEngine = null
        disableTranslationModeForShutdown(engine)
        val videoReleaseCode = releaseVideoSession(engine)
        if (videoReleaseCode != 0 || destroyingEngine === engine) {
            // A camera safety failure already initiated immediate destruction.
            // Never follow it with leaveChannel or its three-second wait.
            return
        }
        runRtcOperation("abandonAudioFocus") { engine.abandonAudioFocus() }
        val inCall = try {
            engine.isInCall
        } catch (error: Exception) {
            Log.e(RTC_DIAGNOSTIC_TAG, "ARTC unable to determine shutdown state", error)
            false
        }
        val leaveCode = if (inCall) {
            runRtcOperation("leaveChannel") { engine.leaveChannel() }
        } else {
            RTC_OPERATION_UNAVAILABLE
        }
        if (inCall && leaveCode == 0) {
            val timeout = Runnable { finishDestroy(engine) }
            leaveTimeout = timeout
            mainHandler.postDelayed(timeout, 3_000)
            return
        }
        finishDestroy(engine)
    }

    private fun finishDestroy(engine: AliRtcEngine) {
        if (rtcEngine !== engine || destroyingEngine === engine) return
        if (!RtcEngineRegistry.markDestroying(rtcOwnerToken, engine)) {
            rtcEngine = null
            shuttingDown = false
            drainShutdownCallbacks()
            if (!activityDestroyed) startPendingJoinIfAllowed()
            stopRtcForegroundServiceIfIdle()
            return
        }
        destroyingEngine = engine
        leaveTimeout?.let(mainHandler::removeCallbacks)
        leaveTimeout = null
        try {
            engine.destroy(object : AliRtcEngine.AliRtcDestroyCompletionObserver {
                override fun OnDestroyCompletion() {
                    mainHandler.post {
                        if (rtcEngine !== engine && destroyingEngine !== engine) return@post
                        completeEngineDestroy(engine)
                    }
                }
            })
        } catch (error: RuntimeException) {
            Log.e(RTC_DIAGNOSTIC_TAG, "ARTC engine destroy failed", error)
            try {
                engine.destroy()
                completeEngineDestroy(engine)
            } catch (fallbackError: RuntimeException) {
                Log.e(RTC_DIAGNOSTIC_TAG, "ARTC fallback destroy failed", fallbackError)
                cancelPendingJoin(
                    "RTC_ENGINE_DESTROY_FAILED",
                    "RTC engine could not be safely restarted",
                )
                // Resolve callers, but retain the foreground notification and
                // engine reference: never pretend a failed destroy released
                // microphone/camera resources or start another singleton.
                drainShutdownCallbacks()
            }
        }
    }

    private fun completeEngineDestroy(engine: AliRtcEngine) {
        RtcEngineRegistry.release(rtcOwnerToken, engine)
        if (rtcEngine === engine) rtcEngine = null
        if (destroyingEngine === engine) destroyingEngine = null
        if (fatalCameraEngine === engine) fatalCameraEngine = null
        if (deferredShutdownEngine === engine) deferredShutdownEngine = null
        shuttingDown = false
        rtcChannelJoinedSuccessfully = false
        audioPublishRequested = false
        localAudioPublished = false
        videoPublishRequested = false
        localVideoPublished = false
        localMicMuted = false
        joinedStateEmitted = false
        cancelJoinCallbackTimeout()
        invalidateCameraSafetyConfirmation()
        remoteOnlineUsers.clear()
        remoteAudioSubscribedUsers.clear()
        announcedRemoteUsers.clear()
        drainShutdownCallbacks()
        if (!activityDestroyed) startPendingJoinIfAllowed()
        stopRtcForegroundServiceIfIdle()
    }

    private fun drainShutdownCallbacks() {
        val callbacks = shutdownCallbacks.toList()
        shutdownCallbacks.clear()
        callbacks.forEach { callback ->
            try {
                callback()
            } catch (error: RuntimeException) {
                Log.e(RTC_DIAGNOSTIC_TAG, "RTC shutdown completion failed", error)
            }
        }
    }

    override fun onDestroy() {
        activityDestroyed = true
        activityResumed = false
        ++activityGeneration
        cancelPendingJoin(
            "RTC_ACTIVITY_DESTROYED",
            "RTC join was cancelled because the activity was destroyed",
        )
        // Resolve any pending platform calls exactly once while the messenger
        // is still attached. No completion is retained past Activity teardown.
        drainShutdownCallbacks()
        channel?.setMethodCallHandler(null)
        channel = null
        audioCueChannel?.setMethodCallHandler(null)
        audioCueChannel = null
        stopRingbackTone()
        stopIncomingRingtone()
        shutdownRtc()
        translationPlaybackExecutor.shutdownNow()
        super.onDestroy()
    }

    private companion object {
        const val RTC_DIAGNOSTIC_TAG = "RuscnyARTC"
        const val RTC_VIDEO_VIEW_TYPE = "com.tooyei.translator/rtc_video"
        const val RTC_OPERATION_UNAVAILABLE = -1
        const val RTC_DEVICE_RECORDING_VOLUME = 100
        const val RTC_EMULATOR_RECORDING_VOLUME = 200
        const val ERR_CAMERA_OPEN_FAIL = 17_039_620
        const val ERR_CAMERA_INTERRUPT = 17_039_622
        const val ERR_VIDEO_DISPLAY_OPEN_FAIL = 17_039_873
        const val ERR_VIDEO_DISPLAY_INTERRUPT = 17_039_874
        const val ERR_PUBLISH_VIDEO_STREAM_FAILED = 16_843_857
        const val ERR_PUBLISH_DUAL_STREAM_FAILED = 16_843_858
        const val ERR_SUBSCRIBE_VIDEO_STREAM_FAILED = 16_844_114
        const val ERR_SUBSCRIBE_DUAL_STREAM_FAILED = 16_844_115
        const val GLOBAL_ENGINE_WAIT_TIMEOUT_MS = 6_000L
        const val GLOBAL_ENGINE_WAIT_POLL_MS = 100L
        const val JOIN_CALLBACK_TIMEOUT_MS = 15_000L
        const val MEDIA_PUBLISH_TIMEOUT_MS = 9_000L
        const val CAMERA_SHUTDOWN_CONFIRM_DELAY_MS = 300L
        const val TRANSLATION_CAPTURE_CHUNK_BYTES = 3_200
        const val MAX_TRANSLATION_AUDIO_BYTES = 384_000
        const val RINGBACK_VOLUME = 55
        const val RINGBACK_PULSE_MS = 1_000
        const val RINGBACK_INTERVAL_MS = 3_000L
        const val TALK_READY_VOLUME = 80
        const val TALK_READY_DURATION_MS = 180
        const val INCOMING_CALL_PREFERENCES = "incoming_call_actions"
        const val INCOMING_CALL_ACTION_KEY = "action"
        const val INCOMING_CALL_ID_KEY = "call_id"
    }
}
