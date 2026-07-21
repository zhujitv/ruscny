package com.tooyei.translator

import android.content.Context
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import io.flutter.plugin.common.StandardMessageCodec
import io.flutter.plugin.platform.PlatformView
import io.flutter.plugin.platform.PlatformViewFactory

enum class RtcVideoViewRole {
    LOCAL,
    REMOTE,
}

interface RtcVideoViewHost {
    fun onRtcVideoViewCreated(platformView: RtcVideoPlatformView)

    fun onRtcVideoViewDisposed(platformView: RtcVideoPlatformView)
}

/**
 * Stable Flutter PlatformView container for an ARTC render view.
 *
 * Flutter may create the widget before the RTC engine exists. Keeping a plain
 * container here lets MainActivity attach the SDK TextureView as soon as the
 * engine is ready without requiring the Dart widget to be recreated.
 */
class RtcVideoPlatformView(
    context: Context,
    val role: RtcVideoViewRole,
    private val host: RtcVideoViewHost,
) : PlatformView {
    private val container = FrameLayout(context).apply {
        setBackgroundColor(Color.BLACK)
        clipChildren = true
        clipToPadding = true
    }
    private var renderView: View? = null
    private var disposed = false

    init {
        host.onRtcVideoViewCreated(this)
    }

    override fun getView(): View = container

    override fun dispose() {
        if (disposed) return
        disposed = true
        host.onRtcVideoViewDisposed(this)
        clearRenderView()
    }

    fun attachRenderView(view: View) {
        if (disposed || renderView === view) return
        (view.parent as? ViewGroup)?.removeView(view)
        container.removeAllViews()
        container.addView(
            view,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        renderView = view
    }

    fun clearRenderView() {
        container.removeAllViews()
        renderView = null
    }
}

internal class RtcVideoViewFactory(
    private val host: RtcVideoViewHost,
) : PlatformViewFactory(StandardMessageCodec.INSTANCE) {
    override fun create(context: Context, viewId: Int, args: Any?): PlatformView {
        val roleValue = (args as? Map<*, *>)?.get("role") as? String
        val role = when (roleValue?.lowercase()) {
            "local" -> RtcVideoViewRole.LOCAL
            "remote" -> RtcVideoViewRole.REMOTE
            else -> throw IllegalArgumentException(
                "RTC video PlatformView requires role 'local' or 'remote'",
            )
        }
        return RtcVideoPlatformView(context, role, host)
    }
}
