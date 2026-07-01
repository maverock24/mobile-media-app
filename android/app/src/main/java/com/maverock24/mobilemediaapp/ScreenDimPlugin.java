package com.maverock24.mobilemediaapp;

import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ScreenDim")
public class ScreenDimPlugin extends Plugin {
    private static final String KEY_DELAY_MS = "delayMs";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private long delayMs = 0;
    private boolean enabled = false;
    private View dimOverlay = null;

    @PluginMethod
    public void enable(PluginCall call) {
        long delay = call.getInt(KEY_DELAY_MS, 0);
        if (delay <= 0) {
            call.reject("delayMs must be > 0");
            return;
        }
        disableInternal();
        delayMs = delay;
        enabled = true;
        scheduleDim();
        call.resolve();
    }

    @PluginMethod
    public void disable(PluginCall call) {
        disableInternal();
        call.resolve();
    }

    @PluginMethod
    public void isEnabled(PluginCall call) {
        JSObject result = new JSObject();
        result.put("enabled", enabled);
        call.resolve(result);
    }

    private void disableInternal() {
        if (!enabled) return;
        enabled = false;
        handler.removeCallbacks(dimRunnable);
        removeOverlay();
        delayMs = 0;
    }

    private final Runnable dimRunnable = new Runnable() {
        @Override
        public void run() {
            showOverlay();
        }
    };

    private void scheduleDim() {
        if (!enabled || delayMs <= 0) return;
        handler.removeCallbacks(dimRunnable);
        handler.postDelayed(dimRunnable, delayMs);
    }

    private void showOverlay() {
        if (!enabled || dimOverlay != null) return;
        try {
            ViewGroup root = getActivity().findViewById(android.R.id.content);
            if (root == null) return;

            // Find or cast to FrameLayout (android.R.id.content is a FrameLayout)
            // Create a full-screen dark overlay
            dimOverlay = new View(getContext());
            dimOverlay.setBackgroundColor(Color.argb(220, 0, 0, 0)); // semi-transparent black
            dimOverlay.setLayoutParams(new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            ));
            dimOverlay.setClickable(true);
            dimOverlay.setFocusable(true);
            dimOverlay.setOnTouchListener(new View.OnTouchListener() {
                @Override
                public boolean onTouch(View v, MotionEvent event) {
                    if (event.getAction() == MotionEvent.ACTION_DOWN) {
                        handleUserInteraction();
                    }
                    // Consume the touch so it doesn't reach the WebView behind
                    return true;
                }
            });

            root.addView(dimOverlay);
        } catch (Exception e) {
            // Activity may be gone
        }
    }

    private void removeOverlay() {
        if (dimOverlay == null) return;
        try {
            ViewGroup root = getActivity().findViewById(android.R.id.content);
            if (root != null) {
                root.removeView(dimOverlay);
            }
        } catch (Exception e) {
            // Activity may be gone
        }
        dimOverlay = null;
    }

    private void handleUserInteraction() {
        if (!enabled) return;
        // Remove the dim overlay and reschedule the timer
        removeOverlay();
        scheduleDim();
    }
}
