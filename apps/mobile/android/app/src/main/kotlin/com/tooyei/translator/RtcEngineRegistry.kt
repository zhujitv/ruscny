package com.tooyei.translator

import com.alivc.rtc.AliRtcEngine
import java.util.concurrent.atomic.AtomicLong

/**
 * Process-wide ownership for AliRtcEngine's singleton.
 *
 * FlutterActivity can be recreated while the vendor's asynchronous destroy is
 * still running. Activity-local references alone cannot prevent the new
 * Activity from acquiring the same singleton, or the old Activity from later
 * destroying it. This registry keeps one owner until destroy completion.
 */
internal object RtcEngineRegistry {
    internal sealed interface Claim {
        data class Acquired(val engine: AliRtcEngine) : Claim
        data class Busy(val requestRelease: () -> Unit) : Claim
    }

    private data class Owner(
        val token: Long,
        val engine: AliRtcEngine,
        val requestRelease: () -> Unit,
        var destroying: Boolean = false,
    )

    private val nextToken = AtomicLong(0L)
    private var owner: Owner? = null

    fun newOwnerToken(): Long = nextToken.incrementAndGet()

    @Synchronized
    fun claim(
        token: Long,
        createEngine: () -> AliRtcEngine,
        requestRelease: () -> Unit,
    ): Claim {
        val current = owner
        if (current != null) {
            return if (current.token == token && !current.destroying) {
                Claim.Acquired(current.engine)
            } else {
                Claim.Busy(current.requestRelease)
            }
        }
        val engine = createEngine()
        owner = Owner(
            token = token,
            engine = engine,
            requestRelease = requestRelease,
        )
        return Claim.Acquired(engine)
    }

    @Synchronized
    fun isOwner(token: Long, engine: AliRtcEngine): Boolean {
        val current = owner
        return current?.token == token && current.engine === engine
    }

    @Synchronized
    fun markDestroying(token: Long, engine: AliRtcEngine): Boolean {
        val current = owner
        if (current?.token != token || current.engine !== engine) return false
        current.destroying = true
        return true
    }

    @Synchronized
    fun release(token: Long, engine: AliRtcEngine): Boolean {
        val current = owner
        if (current?.token != token || current.engine !== engine) return false
        owner = null
        return true
    }

    @Synchronized
    fun isOwnedBy(token: Long): Boolean = owner?.token == token
}
