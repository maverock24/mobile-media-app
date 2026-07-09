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

    // Intercepting touch listener that resets the dim timer on every user interaction.
    // We can't use setOnTouchListener on the decor view directly — ViewGroup.dispatchTouchEvent only
    // calls super.dispatchTouchEvent (which checks the listener) when NO child consumed the touch.
    // Since the WebView consumes touches, a decor-view listener would never fire.
    // Instead we add a transparent, non-clickable overlay on top that intercepts touches,
    // resets the timer, and returns false so the touch falls through to the WebView below.
    private final View.OnTouchListener interceptTouchListener = new View.OnTouchListener() {
        @Override
        public boolean onTouch(View v, MotionEvent event) {
            if (event.getAction() == MotionEvent.ACTION_DOWN) {
                scheduleDim();
            }
            // Don't consume — let touches fall through to child views
            return false;
        }
    };

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
        installActivityTouchListener();
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
        uninstallActivityTouchListener();
        delayMs = 0;
    }

    private void installActivityTouchListener() {
        try {
            ViewGroup root = getActivity().findViewById(android.R.id.content);
            if (root == null) return;
            // Only add if not already present
            for (int i = 0; i < root.getChildCount(); i++) {
                View child = root.getChildAt(i);
                if (child.getTag() != null && "dim-touch-interceptor".equals(child.getTag().toString())) {
                    return; // already installed
                }
            }
            View touchInterceptor = new View(getContext());
            touchInterceptor.setTag("dim-touch-interceptor");
            touchInterceptor.setLayoutParams(new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            ));
            touchInterceptor.setBackgroundColor(Color.TRANSPARENT);
            touchInterceptor.setClickable(false);
            touchInterceptor.setFocusable(false);
            touchInterceptor.setOnTouchListener(interceptTouchListener);
            root.addView(touchInterceptor);
        } catch (Exception e) {
            // Activity may be gone
        }
    }

    private void uninstallActivityTouchListener() {
        try {
            ViewGroup root = getActivity().findViewById(android.R.id.content);
            if (root == null) return;
            View toRemove = null;
            for (int i = 0; i < root.getChildCount(); i++) {
                View child = root.getChildAt(i);
                if (child.getTag() != null && "dim-touch-interceptor".equals(child.getTag().toString())) {
                    toRemove = child;
                    break;
                }
            }
            if (toRemove != null) {
                root.removeView(toRemove);
            }
        } catch (Exception e) {
            // Activity may be gone
        }
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
        // Remove the dim overlay (user touched the dim screen) and reschedule timer
        removeOverlay();
        scheduleDim();
    }
}
