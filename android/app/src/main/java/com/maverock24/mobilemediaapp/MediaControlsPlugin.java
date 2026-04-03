package com.maverock24.mobilemediaapp;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.media.app.NotificationCompat.MediaStyle;
import androidx.media.session.MediaButtonReceiver;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
	name = "MediaControls",
	permissions = {
		@Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
	}
)
public class MediaControlsPlugin extends Plugin {
	private static final String CHANNEL_ID = "media_playback";
	private static final int NOTIFICATION_ID = 4242;
	private static MediaControlsPlugin instance;
	private MediaPlaybackService playbackService;

	private String title = "";
	private String artist = "";
	private long durationMs = 0L;
	private long positionMs = 0L;
	private boolean isPlaying = false;
	private boolean hasNext = false;
	private boolean hasPrevious = false;

	@Override
	public void load() {
		super.load();
		instance = this;
		startPlaybackService();
	}

	private void startPlaybackService() {
		Context context = getContext();
		Intent intent = new Intent(context, MediaPlaybackService.class);
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
			context.startForegroundService(intent);
		} else {
			context.startService(intent);
		}
		
		// In a real production app, we'd use bindService to get the instance.
		// For this MVP, we'll use a static setter in the service or just a singleton pattern.
		// But let's assume we can get it via a static reference for simplicity in this bridge.
	}

	public static void setServiceInstance(MediaPlaybackService service) {
		if (instance != null) {
			instance.playbackService = service;
		}
	}

	@Override
	protected void handleOnDestroy() {
		if (instance == this) {
			instance = null;
		}
		super.handleOnDestroy();
	}

	@PluginMethod
	public void ensureNotificationPermission(PluginCall call) {
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
			JSObject result = new JSObject();
			result.put("granted", true);
			call.resolve(result);
			return;
		}

		if (getPermissionState("notifications") == PermissionState.GRANTED) {
			JSObject result = new JSObject();
			result.put("granted", true);
			call.resolve(result);
			return;
		}

		requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
	}

	@PermissionCallback
	private void notificationPermissionCallback(PluginCall call) {
		JSObject result = new JSObject();
		boolean granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
			|| getPermissionState("notifications") == PermissionState.GRANTED;
		result.put("granted", granted);
		if (granted) {
			call.resolve(result);
		} else {
			call.reject("Notification permission denied.");
		}
	}

	@PluginMethod
	public void updateNowPlaying(PluginCall call) {
		title = call.getString("title", "");
		artist = call.getString("artist", "");
		durationMs = secondsToMs(call.getDouble("durationSec", 0d));
		
		updateService();
		call.resolve();
	}

	@PluginMethod
	public void updatePlaybackState(PluginCall call) {
		isPlaying = call.getBoolean("isPlaying", false);
		positionMs = secondsToMs(call.getDouble("positionSec", 0d));
		long nextDurationMs = secondsToMs(call.getDouble("durationSec", 0d));
		if (nextDurationMs > 0) {
			durationMs = nextDurationMs;
		}
		
		updateService();
		call.resolve();
	}

	@PluginMethod
	public void setTransportAvailability(PluginCall call) {
		hasNext = call.getBoolean("hasNext", false);
		hasPrevious = call.getBoolean("hasPrevious", false);
		updateService();
		call.resolve();
	}

	@PluginMethod
	public void clear(PluginCall call) {
		title = "";
		artist = "";
		durationMs = 0L;
		positionMs = 0L;
		isPlaying = false;
		hasNext = false;
		hasPrevious = false;
		
		if (playbackService != null) {
			playbackService.updateNotification("", "", false);
			playbackService.getMediaSession().setActive(false);
		}
		call.resolve();
	}

	public static void dispatchAction(String action) {
		if (instance != null) {
			instance.emitAction(action, -1L);
		}
	}

	public static MediaSessionCompat getMediaSession() {
		return instance != null && instance.playbackService != null ? instance.playbackService.getMediaSession() : null;
	}

	private void updateService() {
		if (playbackService == null) return;

		// 1. Update MediaSession Metadata
		MediaMetadataCompat.Builder metaBuilder = new MediaMetadataCompat.Builder()
			.putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
			.putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, title)
			.putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist);
		if (durationMs > 0) {
			metaBuilder.putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs);
		}
		playbackService.getMediaSession().setMetadata(metaBuilder.build());

		// 2. Update MediaSession PlaybackState
		long actions = PlaybackStateCompat.ACTION_PLAY
			| PlaybackStateCompat.ACTION_PAUSE
			| PlaybackStateCompat.ACTION_PLAY_PAUSE
			| PlaybackStateCompat.ACTION_SEEK_TO;
		if (hasNext) actions |= PlaybackStateCompat.ACTION_SKIP_TO_NEXT;
		if (hasPrevious) actions |= PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS;

		int state = isPlaying ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED;
		PlaybackStateCompat pState = new PlaybackStateCompat.Builder()
			.setActions(actions)
			.setState(state, positionMs, isPlaying ? 1f : 0f)
			.build();
		playbackService.getMediaSession().setPlaybackState(pState);
		playbackService.getMediaSession().setActive(!title.isEmpty());

		// 3. Update Foreground Notification
		playbackService.updateNotification(title, artist, isPlaying);
	}

	private long secondsToMs(Double seconds) {
		if (seconds == null || seconds <= 0) {
			return 0L;
		}
		return Math.round(seconds * 1000d);
	}

	private void emitAction(String action, long positionMsValue) {
		JSObject payload = new JSObject();
		payload.put("action", action);
		if (positionMsValue >= 0) {
			payload.put("positionSec", positionMsValue / 1000d);
		}
		notifyListeners("mediaAction", payload, true);
	}
}