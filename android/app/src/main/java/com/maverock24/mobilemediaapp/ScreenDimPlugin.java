package com.maverock24.mobilemediaapp;

import android.os.Handler;
import android.os.Looper;
import android.view.MotionEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ScreenDim")
public class ScreenDimPlugin extends Plugin {
    private static final float DIM_BRIGHTNESS = 0.01f;
    private static final String KEY_DELAY_MS = "delayMs";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private float savedBrightness = -1f;
    private long delayMs = 0;
    private boolean enabled = false;
    private boolean dimmed = false;

    // Runnable executed after inactivity timeout
    private Runnable dimRunnable;

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
        dimRunnable = new Runnable() {
            @Override
            public void run() {
                dimScreen();
            }
        };
        setupTouchListener();
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
        dimRunnable = null;
        restoreBrightness();
        delayMs = 0;
        savedBrightness = -1f;
    }

    private void scheduleDim() {
        if (!enabled || delayMs <= 0) return;
        handler.removeCallbacks(dimRunnable);
        handler.postDelayed(dimRunnable, delayMs);
    }

    private void dimScreen() {
        if (!enabled || dimmed) return;
        dimmed = true;
        try {
            Window window = getActivity().getWindow();
            WindowManager.LayoutParams layoutParams = window.getAttributes();
            // Save current brightness only once (first dim)
            if (savedBrightness < 0f) {
                savedBrightness = layoutParams.screenBrightness;
            }
            layoutParams.screenBrightness = DIM_BRIGHTNESS;
            window.setAttributes(layoutParams);
        } catch (Exception e) {
            // Activity may be gone — suppress
        }
    }

    private void restoreBrightness() {
        if (!dimmed) return;
        dimmed = false;
        try {
            Window window = getActivity().getWindow();
            WindowManager.LayoutParams layoutParams = window.getAttributes();
            layoutParams.screenBrightness = savedBrightness;
            window.setAttributes(layoutParams);
            savedBrightness = -1f;
        } catch (Exception e) {
            // Activity may be gone — suppress
        }
    }

    private void setupTouchListener() {
        try {
            View rootView = getActivity().getWindow().getDecorView();
            rootView.setOnTouchListener(new View.OnTouchListener() {
                @Override
                public boolean onTouch(View v, MotionEvent event) {
                    if (event.getAction() == MotionEvent.ACTION_DOWN) {
                        handleUserInteraction();
                    }
                    // Return false so touch events continue to children
                    return false;
                }
            });
        } catch (Exception e) {
            // Activity may be gone
        }
    }

    private void handleUserInteraction() {
        if (!enabled) return;
        if (dimmed) {
            // Screen was dimmed — restore brightness and reschedule
            restoreBrightness();
        }
        // Reschedule the dim timer after any user interaction
        scheduleDim();
    }
}
