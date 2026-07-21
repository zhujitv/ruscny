package com.tooyei.translator

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log

/** Keeps an explicitly started RTC call and microphone capture foreground. */
class RtcCallForegroundService : Service() {
    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_NOT_STICKY

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "实时通话",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "显示正在进行的实时通话"
                setSound(null, null)
                enableVibration(false)
            },
        )
    }

    private fun buildNotification(): Notification {
        val openAppIntent = packageManager.getLaunchIntentForPackage(packageName)
            ?: Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            openAppIntent.apply {
                addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle("实时通话进行中")
            .setContentText("点击返回通话页面")
            .setContentIntent(pendingIntent)
            .setCategory(Notification.CATEGORY_CALL)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }

    companion object {
        private const val TAG = "RuscnyRtcService"
        private const val CHANNEL_ID = "ruscny_rtc_call"
        private const val NOTIFICATION_ID = 4_016
        private val ownerLock = Any()
        private var activeOwnerToken: Long? = null

        fun start(context: Context, ownerToken: Long): Boolean {
            val previousOwner = synchronized(ownerLock) {
                activeOwnerToken.also { activeOwnerToken = ownerToken }
            }
            val intent = Intent(context, RtcCallForegroundService::class.java)
            return try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
                true
            } catch (error: RuntimeException) {
                synchronized(ownerLock) {
                    if (activeOwnerToken == ownerToken) activeOwnerToken = previousOwner
                }
                Log.e(TAG, "Unable to start RTC foreground service", error)
                false
            }
        }

        fun stop(context: Context, ownerToken: Long) {
            synchronized(ownerLock) {
                if (activeOwnerToken != ownerToken) return
                activeOwnerToken = null
            }
            try {
                context.stopService(Intent(context, RtcCallForegroundService::class.java))
            } catch (error: RuntimeException) {
                synchronized(ownerLock) {
                    if (activeOwnerToken == null) activeOwnerToken = ownerToken
                }
                Log.e(TAG, "Unable to stop RTC foreground service", error)
            }
        }
    }
}
