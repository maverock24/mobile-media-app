package com.maverock24.mobilemediaapp;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
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

	private MediaSessionCompat mediaSession;
	private NotificationManagerCompat notificationManager;
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
		notificationManager = NotificationManagerCompat.from(getContext());
		createNotificationChannel();
		ensureSession();
	}

	@Override
	protected void handleOnDestroy() {
		if (instance == this) {
			instance = null;
		}
		releaseSession();
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
		durationMs = secondsToMs(call.getDouble("durationSec", 0));
		ensureSession();
		updateMetadata();
		updatePlaybackState();
		updateNotification();
		call.resolve();
	}

	@PluginMethod
	public void updatePlaybackState(PluginCall call) {
		isPlaying = call.getBoolean("isPlaying", false);
		positionMs = secondsToMs(call.getDouble("positionSec", 0));
		long nextDurationMs = secondsToMs(call.getDouble("durationSec", 0));
		if (nextDurationMs > 0) {
			durationMs = nextDurationMs;
		}
		ensureSession();
		updateMetadata();
		updatePlaybackState();
		updateNotification();
		call.resolve();
	}

	@PluginMethod
	public void setTransportAvailability(PluginCall call) {
		hasNext = call.getBoolean("hasNext", false);
		hasPrevious = call.getBoolean("hasPrevious", false);
		updatePlaybackState();
		updateNotification();
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
		if (mediaSession != null) {
			mediaSession.setMetadata(null);
			mediaSession.setPlaybackState(null);
			mediaSession.setActive(false);
		}
		notificationManager.cancel(NOTIFICATION_ID);
		call.resolve();
	}

	public static void dispatchAction(String action) {
		if (instance != null) {
			instance.emitAction(action, -1L);
		}
	}

	private void ensureSession() {
		if (mediaSession != null) {
			return;
		}

		mediaSession = new MediaSessionCompat(getContext(), "MediaHubSession");
		mediaSession.setFlags(
			MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS |
			MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS
		);
		mediaSession.setCallback(new MediaSessionCompat.Callback() {
			@Override
			public void onPlay() {
				emitAction("play", -1L);
			}

			@Override
			public void onPause() {
				emitAction("pause", -1L);
			}

			@Override
			public void onSkipToNext() {
				emitAction("nexttrack", -1L);
			}

			@Override
			public void onSkipToPrevious() {
				emitAction("previoustrack", -1L);
			}

			@Override
			public void onSeekTo(long pos) {
				emitAction("seekto", pos);
			}
		});

		Intent launchIntent = getContext().getPackageManager().getLaunchIntentForPackage(getContext().getPackageName());
		if (launchIntent != null) {
			launchIntent.setPackage(getContext().getPackageName());
			PendingIntent sessionActivity = PendingIntent.getActivity(
				getContext(),
				0,
				launchIntent,
				pendingIntentFlags(PendingIntent.FLAG_UPDATE_CURRENT)
			);
			mediaSession.setSessionActivity(sessionActivity);
		}
	}

	private void releaseSession() {
		if (mediaSession != null) {
			mediaSession.release();
			mediaSession = null;
		}
	}

	private void createNotificationChannel() {
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
			return;
		}

		NotificationManager manager = getContext().getSystemService(NotificationManager.class);
		if (manager == null) {
			return;
		}

		NotificationChannel channel = new NotificationChannel(
			CHANNEL_ID,
			"Media playback",
			NotificationManager.IMPORTANCE_LOW
		);
		channel.setDescription("Media playback controls");
		manager.createNotificationChannel(channel);
	}

	private void updateMetadata() {
		if (mediaSession == null) {
			return;
		}

		MediaMetadataCompat.Builder builder = new MediaMetadataCompat.Builder()
			.putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
			.putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, title)
			.putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist);

		if (durationMs > 0) {
			builder.putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs);
		}

		mediaSession.setMetadata(builder.build());
	}

	private void updatePlaybackState() {
		if (mediaSession == null) {
			return;
		}

		long actions = PlaybackStateCompat.ACTION_PLAY
			| PlaybackStateCompat.ACTION_PAUSE
			| PlaybackStateCompat.ACTION_PLAY_PAUSE
			| PlaybackStateCompat.ACTION_SEEK_TO;

		if (hasNext) {
			actions |= PlaybackStateCompat.ACTION_SKIP_TO_NEXT;
		}
		if (hasPrevious) {
			actions |= PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS;
		}

		int state = isPlaying ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED;
		float speed = isPlaying ? 1f : 0f;

		PlaybackStateCompat playbackState = new PlaybackStateCompat.Builder()
			.setActions(actions)
			.setState(state, positionMs, speed)
			.build();

		mediaSession.setPlaybackState(playbackState);
		mediaSession.setActive(title != null && !title.isEmpty());
	}

	private void updateNotification() {
		if (title == null || title.isEmpty()) {
			notificationManager.cancel(NOTIFICATION_ID);
			return;
		}

		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
			&& getPermissionState("notifications") != PermissionState.GRANTED) {
			return;
		}

		ensureSession();

		NotificationCompat.Builder builder = new NotificationCompat.Builder(getContext(), CHANNEL_ID)
			.setSmallIcon(R.mipmap.ic_launcher)
			.setContentTitle(title)
			.setContentText(artist)
			.setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
			.setOnlyAlertOnce(true)
			.setShowWhen(false)
			.setOngoing(isPlaying)
			.setStyle(new MediaStyle()
				.setMediaSession(mediaSession.getSessionToken())
				.setShowActionsInCompactView(0, 1, 2));

		PendingIntent previousIntent = buildActionIntent(MediaControlsReceiver.ACTION_PREVIOUS, 1);
		PendingIntent playPauseIntent = buildActionIntent(
			isPlaying ? MediaControlsReceiver.ACTION_PAUSE : MediaControlsReceiver.ACTION_PLAY,
			2
		);
		PendingIntent nextIntent = buildActionIntent(MediaControlsReceiver.ACTION_NEXT, 3);

		builder.addAction(android.R.drawable.ic_media_previous, "Previous", previousIntent);
		builder.addAction(
			isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
			isPlaying ? "Pause" : "Play",
			playPauseIntent
		);
		builder.addAction(android.R.drawable.ic_media_next, "Next", nextIntent);

		Intent launchIntent = getContext().getPackageManager().getLaunchIntentForPackage(getContext().getPackageName());
		if (launchIntent != null) {
			launchIntent.setPackage(getContext().getPackageName());
			builder.setContentIntent(PendingIntent.getActivity(
				getContext(),
				4,
				launchIntent,
				pendingIntentFlags(PendingIntent.FLAG_UPDATE_CURRENT)
			));
		}

		notificationManager.notify(NOTIFICATION_ID, builder.build());
	}

	private PendingIntent buildActionIntent(String action, int requestCode) {
		Intent intent = new Intent(getContext(), MediaControlsReceiver.class);
		intent.setAction(action);
		intent.setPackage(getContext().getPackageName());
		return PendingIntent.getBroadcast(
			getContext(),
			requestCode,
			intent,
			pendingIntentFlags(PendingIntent.FLAG_UPDATE_CURRENT)
		);
	}

	private int pendingIntentFlags(int baseFlags) {
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
			return baseFlags | PendingIntent.FLAG_IMMUTABLE;
		}
		return baseFlags;
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