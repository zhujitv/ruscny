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
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import com.alivc.rtc.AliRtcEngine
import com.alivc.rtc.AliRtcEngineEventListener
import com.alivc.rtc.AliRtcEngineNotify
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.ByteArrayOutputStream
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
    private var audioPublishTimeout: Runnable? = null
    @Volatile private var videoPublishRequested = false
    @Volatile private var localVideoPublished = false
    private var videoPublishTimeout: Runnable? = null
    private val remoteOnlineUsers = mutableSetOf<String>()
    private val remoteAudioSubscribedUsers = mutableSetOf<String>()
    private val announcedRemoteUsers = mutableSetOf<String>()
    private var leaveTimeout: Runnable? = null
    private val translationCaptureLock = Any()
    private val translationCaptureBuffer = ByteArrayOutputStream(6_400)
    private val translationPlaybackLock = Any()
    private val translationPlaybackExecutor = Executors.newSingleThreadExecutor()
    @Volatile private var translationPlaybackGeneration = 0L
    @Volatile private var translationCaptureEnabled = false
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
        val mediaType = request.mediaType
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
        cancelAudioPublishTimeout()
        videoPublishRequested = false
        localVideoPublished = false
        cancelVideoPublishTimeout()
        rtcMediaType = mediaType
        // This becomes true only after every preparation step succeeds.
        cameraEnabled = false
        activeRemoteUserId = null
        remoteRenderUserId = null
        remoteOnlineUsers.clear()
        remoteAudioSubscribedUsers.clear()
        announcedRemoteUsers.clear()
        translationCaptureEnabled = false
        resetTranslationCaptureBuffer()
        val setupSteps = listOf<Pair<String, () -> Int>>(
            "setAudioOnlyMode" to {
                engine.setAudioOnlyMode(mediaType == RtcMediaType.AUDIO)
            },
            "setDefaultRemoteVideo" to {
                engine.setDefaultSubscribeAllRemoteVideoStreams(mediaType == RtcMediaType.VIDEO)
            },
            "setDefaultRemoteAudio" to {
                engine.setDefaultSubscribeAllRemoteAudioStreams(true)
            },
            "setDefaultAudioRoute" to {
                engine.setDefaultAudioRoutetoSpeakerphone(true)
            },
            "prejoinUnpublishLocalAudio" to {
                engine.publishLocalAudioStream(false)
            },
            "prejoinUnpublishLocalVideo" to {
                engine.publishLocalVideoStream(false)
            },
        )
        for ((step, operation) in setupSteps) {
            val code = runRtcOperation(step, operation)
            if (code != 0) {
                failInitialRtcSetup(result, engine, code, step)
                return
            }
        }
        val enableInitialCamera = initialCameraEnabled && activityResumed
        if (enableInitialCamera) {
            val prepareCode = prepareLocalVideo(engine)
            if (prepareCode != 0) {
                cameraEnabled = false
                if (!isCurrentRtcCallback(engine, generation)) {
                    failJoinForCameraSafety(result, prepareCode, "prepare_rollback_failed")
                    return
                }
                notifyCameraDisabled(prepareCode, "prepare_failed")
            }
        } else {
            if (mediaType == RtcMediaType.VIDEO) {
                // A video call may be accepted without camera permission. Do
                // not rely on SDK defaults: explicitly keep local capture and
                // publication off while still allowing remote video playback.
                val disableCode = disableLocalVideoBestEffort(
                    engine,
                    publishBeforeJoin = true,
                    fatalReason = "prejoin_disable_failed",
                )
                Log.i(
                    RTC_DIAGNOSTIC_TAG,
                    "ARTC local camera disabled before join result=$disableCode",
                )
                if (disableCode != 0) {
                    failJoinForCameraSafety(result, disableCode, "prejoin_disable_failed")
                    return
                }
            }
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
        if (audioObserverCode != 0) {
            failInitialRtcSetup(
                result,
                engine,
                audioObserverCode,
                "enableAudioFrameObserver",
            )
            return
        }
        engine.setRtcEngineEventListener(object : AliRtcEngineEventListener() {
            override fun onJoinChannelResult(resultCode: Int, channelName: String?, joinedUserId: String?, elapsed: Int) {
                if (!isCurrentRtcCallback(engine, generation)) return
                mainHandler.post {
                    if (!isCurrentRtcCallback(engine, generation)) return@post
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
                    val focusCode = runRtcOperation("requestAudioFocus") {
                        engine.requestAudioFocus()
                    }
                    if (focusCode != 0) {
                        reportRtcErrorAndScheduleShutdown(
                            engine,
                            generation,
                            focusCode,
                            phase = "audio_focus",
                            category = "audio",
                        )
                        return@post
                    }
                    audioPublishRequested = true
                    val audioPublishCode = runRtcOperation("publishLocalAudio") {
                        engine.publishLocalAudioStream(true)
                    }
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
                    scheduleAudioPublishTimeout(engine, generation)
                    if (rtcMediaType == RtcMediaType.VIDEO) {
                        val subscribeCode = runRtcOperation("subscribeAllRemoteVideo") {
                            engine.subscribeAllRemoteVideoStreams(true)
                        }
                        if (subscribeCode != 0) {
                            reportRtcErrorAndScheduleShutdown(
                                engine,
                                generation,
                                subscribeCode,
                                phase = "video_subscribe",
                                category = "video",
                            )
                            return@post
                        }
                        if (cameraEnabled) {
                            requestLocalVideoPublish(engine, generation, "publish_failed")
                        } else {
                            val unpublishCode = runRtcOperation("keepVideoUnpublished") {
                                engine.publishLocalVideoStream(false)
                            }
                            if (unpublishCode != 0) {
                                forceDestroyForCameraFailure(
                                    engine,
                                    unpublishCode,
                                    "joined_unpublish_failed",
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
                            notifyCameraDisabled(
                                exceptionType?.value ?: RTC_OPERATION_UNAVAILABLE,
                                "device_exception",
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
                    val audioSubscribeCode = runRtcOperation("subscribeRemoteAudio") {
                        engine.subscribeRemoteAudioStream(remoteUserId, true)
                    }
                    if (audioSubscribeCode != 0) {
                        reportRtcErrorAndScheduleShutdown(
                            engine,
                            generation,
                            audioSubscribeCode,
                            phase = "remote_audio_subscribe",
                            category = "audio",
                        )
                        return@post
                    }
                    if (rtcMediaType == RtcMediaType.VIDEO && !remoteUserId.isNullOrBlank()) {
                        activeRemoteUserId = remoteUserId
                        val bindCode = bindRemoteVideoView(engine, remoteUserId)
                        if (bindCode != 0) {
                            reportRtcErrorAndScheduleShutdown(
                                engine,
                                generation,
                                bindCode,
                                phase = "remote_video_render",
                                category = "video",
                            )
                            return@post
                        }
                        val subscribeCode = runRtcOperation("subscribeRemoteVideo") {
                            engine.subscribeRemoteVideoStream(
                                remoteUserId,
                                AliRtcEngine.AliRtcVideoTrack.AliRtcVideoTrackCamera,
                                true,
                            )
                        }
                        if (subscribeCode != 0) {
                            reportRtcErrorAndScheduleShutdown(
                                engine,
                                generation,
                                subscribeCode,
                                phase = "remote_video_subscribe",
                                category = "video",
                            )
                            return@post
                        }
                    }
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
                        activeRemoteUserId = remoteUserId
                        val bindCode = bindRemoteVideoView(engine, remoteUserId)
                        if (bindCode != 0) {
                            reportRtcErrorAndScheduleShutdown(
                                engine,
                                generation,
                                bindCode,
                                phase = "remote_video_render",
                                category = "video",
                            )
                            return@post
                        }
                        val subscribeCode = runRtcOperation("subscribeRemoteVideo") {
                            engine.subscribeRemoteVideoStream(
                                remoteUserId,
                                AliRtcEngine.AliRtcVideoTrack.AliRtcVideoTrackCamera,
                                true,
                            )
                        }
                        if (subscribeCode != 0) {
                            reportRtcErrorAndScheduleShutdown(
                                engine,
                                generation,
                                subscribeCode,
                                phase = "remote_video_subscribe",
                                category = "video",
                            )
                        }
                    } else if (activeRemoteUserId == remoteUserId) {
                        val unbindCode = clearRemoteVideoRenderView(engine, remoteUserId)
                        if (unbindCode != 0) {
                            reportRtcErrorAndScheduleShutdown(
                                engine,
                                generation,
                                unbindCode,
                                phase = "remote_video_unbind",
                                category = "video",
                            )
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
        result.success(code)
    }

    private fun handleLocalAudioPublishState(
        engine: AliRtcEngine,
        generation: Long,
        newState: AliRtcEngine.AliRtcPublishState?,
    ) {
        if (!audioPublishRequested || !isCurrentRtcCallback(engine, generation)) return
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

    private fun failInitialRtcSetup(
        result: MethodChannel.Result,
        engine: AliRtcEngine,
        code: Int,
        step: String,
    ) {
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
                            reportRtcErrorAndScheduleShutdown(
                                engine,
                                rtcGeneration,
                                bindCode,
                                phase = "remote_video_render",
                                category = "video",
                            )
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
                                reportRtcErrorAndScheduleShutdown(
                                    engine,
                                    rtcGeneration,
                                    code,
                                    phase = "local_video_unbind",
                                    category = "video",
                                )
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
                                reportRtcErrorAndScheduleShutdown(
                                    engine,
                                    rtcGeneration,
                                    code,
                                    phase = "remote_video_unbind",
                                    category = "video",
                                )
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

    private fun prepareLocalVideo(engine: AliRtcEngine): Int =
        enableLocalVideoTransaction(engine, publish = false)

    private fun enableLocalVideoTransaction(
        engine: AliRtcEngine,
        publish: Boolean,
    ): Int {
        val steps = listOf<Pair<String, () -> Int>>(
            "enableLocal" to { engine.enableLocalVideo(true) },
            "enableCapture" to { engine.enableVideoCapture(true) },
            "bindPreview" to { bindLocalVideoView(engine) },
            "startPreview" to { engine.startPreview() },
        )
        for ((name, operation) in steps) {
            val code = runRtcOperation(name, operation)
            if (code != 0) {
                Log.w(RTC_DIAGNOSTIC_TAG, "ARTC local video enable failed step=$name code=$code")
                rollbackLocalVideo(engine, "enable_rollback_failed")
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
                forceDestroyForCameraFailure(
                    engine,
                    RTC_OPERATION_UNAVAILABLE,
                    "enable_state_unknown",
                )
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
        videoPublishRequested = false
        localVideoPublished = false
        cancelVideoPublishTimeout()
        var firstFailure = 0
        fun record(name: String, operation: () -> Int) {
            val code = runRtcOperation(name, operation)
            if (firstFailure == 0 && code != 0) firstFailure = code
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
        record("disableCapture") { engine.enableVideoCapture(false) }
        record("disableLocal") { engine.enableLocalVideo(false) }
        cameraEnabled = false
        record("unbindLocalView") { clearLocalVideoRenderView(engine) }
        if (firstFailure != 0) {
            forceDestroyForCameraFailure(engine, firstFailure, fatalReason)
        }
        return firstFailure
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

    private fun failJoinForCameraSafety(
        result: MethodChannel.Result,
        code: Int,
        reason: String,
    ) {
        result.error(
            "RTC_CAMERA_SAFETY_FAILURE",
            "Unable to confirm that the local camera is disabled",
            mapOf(
                "phase" to "camera_safety",
                "category" to "camera",
                "code" to code,
                "reason" to reason,
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
        cancelAudioPublishTimeout()
        cancelVideoPublishTimeout()
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
            return runRtcOperation("restoreRemoteAudioPlaying") {
                engine.muteAllRemoteAudioPlaying(false)
            }
        }
        val code = runRtcOperation("setTranslationRemoteAudio") {
            engine.muteAllRemoteAudioPlaying(muteRemoteAudio)
        }
        if (code == 0) {
            translationCaptureEnabled = true
            resetTranslationCaptureBuffer()
        }
        return code
    }

    private fun disableTranslationModeForShutdown(engine: AliRtcEngine) {
        translationCaptureEnabled = false
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
            !isCurrentRtcCallback(engine, generation) ||
            frame.sampleRate != 16_000 ||
            frame.numChannels != 1
        ) {
            return
        }
        val data = frame.data ?: return
        val size = min(frame.dataSize.takeIf { it > 0 } ?: data.size, data.size)
        if (size <= 0) return
        val chunks = mutableListOf<ByteArray>()
        synchronized(translationCaptureLock) {
            translationCaptureBuffer.write(data, 0, size)
            val buffered = translationCaptureBuffer.toByteArray()
            var offset = 0
            while (buffered.size - offset >= TRANSLATION_CAPTURE_CHUNK_BYTES) {
                chunks.add(
                    buffered.copyOfRange(
                        offset,
                        offset + TRANSLATION_CAPTURE_CHUNK_BYTES,
                    ),
                )
                offset += TRANSLATION_CAPTURE_CHUNK_BYTES
            }
            translationCaptureBuffer.reset()
            if (offset < buffered.size) {
                translationCaptureBuffer.write(buffered, offset, buffered.size - offset)
            }
        }
        for (chunk in chunks) {
            mainHandler.post {
                if (translationCaptureEnabled && isCurrentRtcCallback(engine, generation)) {
                    channel?.invokeMethod("audioFrame", chunk)
                }
            }
        }
    }

    private fun resetTranslationCaptureBuffer() {
        synchronized(translationCaptureLock) {
            translationCaptureBuffer.reset()
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
                } ?: return@execute
                if (!translationCaptureEnabled || generation != translationPlaybackGeneration) {
                    return@execute
                }
                try {
                    if (track.playState != AudioTrack.PLAYSTATE_PLAYING) track.play()
                    // Do not hold translationPlaybackLock across WRITE_BLOCKING.
                    // Teardown can detach/release the track immediately, which
                    // unblocks this write instead of delaying RTC destruction.
                    track.write(audio, 0, audio.size, AudioTrack.WRITE_BLOCKING)
                } catch (_: IllegalStateException) {
                    // Teardown may release the track while a write is in flight.
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
        const val GLOBAL_ENGINE_WAIT_TIMEOUT_MS = 6_000L
        const val GLOBAL_ENGINE_WAIT_POLL_MS = 100L
        const val MEDIA_PUBLISH_TIMEOUT_MS = 9_000L
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
