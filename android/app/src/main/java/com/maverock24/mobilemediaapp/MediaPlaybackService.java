package com.maverock24.mobilemediaapp;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
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

	private MediaSessionCompat mediaSession;

	@Override
	public void onCreate() {
		super.onCreate();

		mediaSession = new MediaSessionCompat(this, "MediaHubSession");
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

		MediaControlsPlugin.setServiceInstance(this);
		createNotificationChannel();
	}

	@Override
	public int onStartCommand(Intent intent, int flags, int startId) {
		MediaButtonReceiver.handleIntent(mediaSession, intent);
		return super.onStartCommand(intent, flags, startId);
	}

	@Override
	public void onDestroy() {
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
		if (isPlaying) {
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
				startForeground(NOTIFICATION_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
			} else {
				startForeground(NOTIFICATION_ID, notification);
			}
		} else {
			stopForeground(false);
			NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
			if (manager != null) {
				manager.notify(NOTIFICATION_ID, notification);
			}
		}
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
