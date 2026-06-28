package com.maverock24.mobilemediaapp;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.support.v4.media.MediaBrowserCompat;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.media.MediaBrowserServiceCompat;
import androidx.media.app.NotificationCompat.MediaStyle;
import androidx.media.session.MediaButtonReceiver;

import java.util.ArrayList;
import java.util.List;

public class MediaPlaybackService extends MediaBrowserServiceCompat {
	private static final String CHANNEL_ID = "media_playback";
	private static final int NOTIFICATION_ID = 4242;
	private static final String WAKELOCK_TAG = "mediaHub:audioPlayback";

	private MediaSessionCompat mediaSession;
	private AudioManager audioManager;
	private PowerManager.WakeLock wakeLock;
	private AudioFocusRequest focusRequest;
	// True only while this service holds audio focus. Guards requestAudioFocus() /
	// abandonAudioFocus() so they act on the play/pause TRANSITION rather than on
	// every updateService() call — see requestAudioFocus() for why re-requesting
	// GAIN 4×/sec auto-pauses the WebView <audio> element.
	private boolean focusHeld = false;

	// Audio focus is requested/abandoned to cooperate with other apps, but we do
	// NOT let focus changes drive the WebView's play/pause state. The WebView owns
	// the actual <audio> elements and MediaSession; having this native listener
	// dispatch pause/play back into JS caused a race where starting radio/podcast
	// (or MP3) while another source was stopping delivered a spurious
	// AUDIOFOCUS_LOSS that paused the just-started stream — "stops immediately"
	// on Android, fixed only by switching back and forth until the focus churn
	// settled. Removing the dispatch keeps focus cooperation without the fight.
	private final AudioManager.OnAudioFocusChangeListener focusListener = focusChange -> {
		// Intentionally empty: see comment above. Focus changes are informational
		// only; the WebView decides when to play/pause.
	};

	@Override
	public void onCreate() {
		super.onCreate();

		audioManager = (AudioManager) getSystemService(AUDIO_SERVICE);

		mediaSession = new MediaSessionCompat(this, "MediaHubSession");
		mediaSession.setFlags(
			MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS
				| MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS
		);
		mediaSession.setPlaybackToLocal(AudioManager.STREAM_MUSIC);
		setSessionToken(mediaSession.getSessionToken());

		mediaSession.setCallback(new MediaSessionCompat.Callback() {
			@Override
			public void onPlay() {
				MediaControlsPlugin.dispatchAction("play");
			}

			@Override
			public void onPause() {
				MediaControlsPlugin.dispatchAction("pause");
			}

			@Override
			public void onSkipToNext() {
				MediaControlsPlugin.dispatchAction("nexttrack");
			}

			@Override
			public void onSkipToPrevious() {
				MediaControlsPlugin.dispatchAction("previoustrack");
			}

			@Override
			public void onSeekTo(long pos) {
				MediaControlsPlugin.dispatchAction("seekto", pos);
			}
		});

		acquireWakeLock();
		createNotificationChannel();
		// Mark the session active early so Android 14+ accepts foreground promotion
		// for a mediaPlayback service even before the first track's metadata arrives.
		try { mediaSession.setActive(true); } catch (Exception ignored) {}
		MediaControlsPlugin.setServiceInstance(this);
	}

	@Override
	public int onStartCommand(Intent intent, int flags, int startId) {
		// Satisfy the startForegroundService() contract: promote to foreground
		// IMMEDIATELY with a placeholder notification. If startForeground() isn't
		// called within ~5s of startForegroundService(), the system throws
		// ForegroundServiceDidNotStartInTimeException and kills the process — a
		// primary cause of the app dying when the screen is locked. The real
		// metadata/notification is refreshed shortly after by updateNotification().
		promoteToForeground();
		MediaButtonReceiver.handleIntent(mediaSession, intent);
		// Re-create the plugin link in case the OS killed and restarted the service
		// while the plugin still held a stale reference. Ensures updateService()
		// dispatches to this live instance instead of a destroyed one.
		MediaControlsPlugin.setServiceInstance(this);
		// START_STICKY: if the system kills the process under memory pressure, ask
		// Android to recreate the service so playback state can be restored.
		return START_STICKY;
	}

	@Override
	public void onDestroy() {
		abandonAudioFocus();
		releaseWakeLock();
		// Detach from the plugin so it doesn't call into a destroyed service.
		// The OS kills background media services under memory pressure (common in
		// the car with Maps + Android Auto running); without this the plugin keeps a
		// stale reference and crashes on the next updateService() call.
		MediaControlsPlugin.clearServiceInstance(this);
		mediaSession.release();
		super.onDestroy();
	}

	@Nullable
	@Override
	public BrowserRoot onGetRoot(@NonNull String clientPackageName, int clientUid, @Nullable Bundle rootHints) {
		return new BrowserRoot("root", null);
	}

	@Override
	public void onLoadChildren(@NonNull String parentId, @NonNull Result<List<MediaBrowserCompat.MediaItem>> result) {
		// Return empty list (Android Auto requires non-null result to confirm connection)
		result.sendResult(new ArrayList<>());
	}

	public void requestAudioFocus() {
		if (audioManager == null) return;
		// Transition-only: requesting AUDIOFOCUS_GAIN while already holding it
		// makes Android dispatch a transient AUDIOFOCUS_LOSS to the WebView's own
		// <audio> element focus holder, which AUTO-PAUSES that element 2-3s after
		// play starts (the Android "stops shortly after play" bug for MP3/Podcast).
		// updateServiceInternal() calls this on every JS updatePlaybackState; the
		// MP3/Podcast position pushes fire that 4×/sec via mediaEngine.updateTime.
		// Hold focus once per play transition, not once per position tick.
		if (focusHeld) return;
		try {
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
				AudioAttributes attrs = new AudioAttributes.Builder()
					.setUsage(AudioAttributes.USAGE_MEDIA)
					.setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
					.build();
				focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
					.setAudioAttributes(attrs)
					.setOnAudioFocusChangeListener(focusListener)
					.build();
				audioManager.requestAudioFocus(focusRequest);
			} else {
				audioManager.requestAudioFocus(
					focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
			}
			focusHeld = true;
		} catch (Exception e) {
			// Audio focus not critical for playback
		}
	}

	public void abandonAudioFocus() {
		if (audioManager == null) return;
		if (!focusHeld) return;
		try {
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focusRequest != null) {
				audioManager.abandonAudioFocusRequest(focusRequest);
			} else {
				audioManager.abandonAudioFocus(focusListener);
			}
		} catch (Exception e) {
			// Audio focus not critical for playback
		}
		focusHeld = false;
	}

	private void acquireWakeLock() {
		PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
		if (pm != null) {
			wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG);
			wakeLock.setReferenceCounted(false);
		}
	}

	public void holdWakeLock() {
		if (wakeLock != null && !wakeLock.isHeld()) {
			wakeLock.acquire();
		}
	}

	public void releaseWakeLock() {
		if (wakeLock != null && wakeLock.isHeld()) {
			wakeLock.release();
		}
	}

	private void createNotificationChannel() {
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
			NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
			if (manager != null) {
				NotificationChannel channel = new NotificationChannel(
					CHANNEL_ID, "Media playback", NotificationManager.IMPORTANCE_LOW);
				channel.setDescription("Media playback controls");
				manager.createNotificationChannel(channel);
			}
		}
	}

	public void updateNotification(String title, String artist, String album, boolean isPlaying) {
		String subtext = artist;
		if (album != null && !album.isEmpty()) {
			subtext = artist + " — " + album;
		}

		NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
			.setSmallIcon(R.mipmap.ic_launcher)
			.setContentTitle(title)
			.setContentText(subtext)
			.setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
			.setOnlyAlertOnce(true)
			.setShowWhen(false)
			.setOngoing(isPlaying)
			.setStyle(new MediaStyle()
				.setMediaSession(mediaSession.getSessionToken())
				.setShowActionsInCompactView(0, 1, 2));

		PendingIntent previousIntent = buildActionIntent(MediaControlsReceiver.ACTION_PREVIOUS, 1);
		PendingIntent playPauseIntent = buildActionIntent(
			isPlaying ? MediaControlsReceiver.ACTION_PAUSE : MediaControlsReceiver.ACTION_PLAY, 2);
		PendingIntent nextIntent = buildActionIntent(MediaControlsReceiver.ACTION_NEXT, 3);

		builder.addAction(android.R.drawable.ic_media_previous, "Previous", previousIntent);
		builder.addAction(
			isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
			isPlaying ? "Pause" : "Play", playPauseIntent);
		builder.addAction(android.R.drawable.ic_media_next, "Next", nextIntent);

		Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
		if (launchIntent != null) {
			builder.setContentIntent(PendingIntent.getActivity(
				this, 4, launchIntent, pendingIntentFlags(PendingIntent.FLAG_UPDATE_CURRENT)));
		}

		Notification notification = builder.build();
		// Keep the service in FOREGROUND state whether playing OR paused, as long as
		// a track is loaded. Calling stopForeground() on pause (the old behaviour)
		// instantly makes the process killable — locking the phone while paused was
		// killing the WebView. Only stopPlayback() (triggered by clear()) drops
		// foreground state. Re-calling startForeground() with an updated notification
		// is the documented way to refresh a foreground service's notification.
		try {
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
				startForeground(NOTIFICATION_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
			} else {
				startForeground(NOTIFICATION_ID, notification);
			}
		} catch (Exception e) {
			// Foreground promotion denied (ForegroundServiceStartNotAllowedException,
			// ForegroundServiceTypeNotAllowedException, …). Fall back to posting the
			// notification without promoting the service to foreground.
			try {
				NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
				if (manager != null) manager.notify(NOTIFICATION_ID, notification);
			} catch (Exception ignored) {
				// NotificationManager can also fail in edge cases; nothing more to do.
			}
		}
	}

	/** Promote to foreground with a minimal notification. Used at service start to
	 *  satisfy the startForegroundService() 5-second contract before real metadata
	 *  arrives. Safe to call repeatedly. */
	private void promoteToForeground() {
		Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
			.setSmallIcon(R.mipmap.ic_launcher)
			.setContentTitle("Media Hub")
			.setContentText("Ready")
			.setOngoing(true)
			.setShowWhen(false)
			.build();
		try {
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
				startForeground(NOTIFICATION_ID, n, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
			} else {
				startForeground(NOTIFICATION_ID, n);
			}
		} catch (Exception ignored) {
			// If the system rejects foreground promotion here there is nothing more we
			// can do; updateNotification() will retry once metadata arrives.
		}
	}

	/** Explicitly stop playback and tear down the foreground service. Called by
	 *  the plugin's clear() when the user stops/empties the queue — this is the
	 *  ONLY path that should drop foreground state. */
	public void stopPlayback() {
		try {
			mediaSession.setActive(false);
		} catch (Exception ignored) {}
		try {
			stopForeground(true);
		} catch (Exception ignored) {}
		// Release audio focus + wakelock promptly (onDestroy() also does this, but
		// clear() nulls the plugin's service reference immediately after this call,
		// so releasing here avoids leaving focus held across a stop→restart cycle).
		abandonAudioFocus();
		releaseWakeLock();
		stopSelf();
	}

	private PendingIntent buildActionIntent(String action, int requestCode) {
		Intent intent = new Intent(this, MediaControlsReceiver.class);
		intent.setAction(action);
		intent.setPackage(getPackageName());
		return PendingIntent.getBroadcast(this, requestCode, intent, pendingIntentFlags(PendingIntent.FLAG_UPDATE_CURRENT));
	}

	private int pendingIntentFlags(int baseFlags) {
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
			return baseFlags | PendingIntent.FLAG_IMMUTABLE;
		}
		return baseFlags;
	}

	public MediaSessionCompat getMediaSession() {
		return mediaSession;
	}
}
