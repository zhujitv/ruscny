package com.tooyei.translator

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build

object IncomingCallNotification {
    const val EXTRA_CALL_ID = "friend_call_id"
    const val EXTRA_ACTION = "friend_call_action"

    private const val CHANNEL_ID = "friend_incoming_calls_v1"
    private const val CHANNEL_NAME = "好友语音来电"
    private const val NOTIFICATION_TIMEOUT_MS = 60_000L

    fun show(
        context: Context,
        callId: String,
        callerName: String,
        title: String,
        answerLabel: String,
        declineLabel: String,
    ) {
        val manager = context.getSystemService(NotificationManager::class.java)
        ensureChannel(manager)
        val fullScreenIntent = actionIntent(context, callId, "show", 0)
        val answerIntent = actionIntent(context, callId, "answer", 1)
        val declineIntent = actionIntent(context, callId, "decline", 2)

        val builder = Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(callerName)
            .setCategory(Notification.CATEGORY_CALL)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setTimeoutAfter(NOTIFICATION_TIMEOUT_MS)
            .setContentIntent(fullScreenIntent)
            .setFullScreenIntent(fullScreenIntent, true)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val person = Person.Builder().setName(callerName).setImportant(true).build()
            builder.setStyle(
                Notification.CallStyle.forIncomingCall(
                    person,
                    declineIntent,
                    answerIntent,
                ),
            )
        } else {
            builder
                .setPriority(Notification.PRIORITY_MAX)
                .addAction(0, declineLabel, declineIntent)
                .addAction(0, answerLabel, answerIntent)
        }

        val notification = builder.build().apply {
            flags = flags or Notification.FLAG_INSISTENT
        }
        manager.notify(notificationId(callId), notification)
    }

    fun cancel(context: Context, callId: String) {
        context.getSystemService(NotificationManager::class.java)
            .cancel(notificationId(callId))
    }

    private fun ensureChannel(manager: NotificationManager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val ringtone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        val audioAttributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        val channel = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "显示好友实时翻译语音来电"
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 700, 350, 700)
            setSound(ringtone, audioAttributes)
        }
        manager.createNotificationChannel(channel)
    }

    private fun actionIntent(
        context: Context,
        callId: String,
        action: String,
        requestOffset: Int,
    ): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_CLEAR_TOP or
                Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(EXTRA_CALL_ID, callId)
            putExtra(EXTRA_ACTION, action)
        }
        return PendingIntent.getActivity(
            context,
            notificationId(callId) + requestOffset,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun notificationId(callId: String): Int =
        0x43000000 or (callId.hashCode() and 0x00ffffff)
}
