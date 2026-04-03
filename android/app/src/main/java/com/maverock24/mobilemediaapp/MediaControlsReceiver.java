package com.maverock24.mobilemediaapp;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.view.KeyEvent;
import androidx.media.session.MediaButtonReceiver;
import android.support.v4.media.session.MediaSessionCompat;

public class MediaControlsReceiver extends BroadcastReceiver {
	public static final String ACTION_PLAY = "com.maverock24.mobilemediaapp.media.PLAY";
	public static final String ACTION_PAUSE = "com.maverock24.mobilemediaapp.media.PAUSE";
	public static final String ACTION_NEXT = "com.maverock24.mobilemediaapp.media.NEXT";
	public static final String ACTION_PREVIOUS = "com.maverock24.mobilemediaapp.media.PREVIOUS";

	@Override
	public void onReceive(Context context, Intent intent) {
		if (intent == null || intent.getAction() == null) {
			return;
		}
		
		if (Intent.ACTION_MEDIA_BUTTON.equals(intent.getAction())) {
			MediaSessionCompat session = MediaControlsPlugin.getMediaSession();
			if (session != null) {
				MediaButtonReceiver.handleIntent(session, intent);
			}
			return;
		}

		switch (intent.getAction()) {
			case ACTION_PLAY:
				MediaControlsPlugin.dispatchAction("play");
				break;
			case ACTION_PAUSE:
				MediaControlsPlugin.dispatchAction("pause");
				break;
			case ACTION_NEXT:
				MediaControlsPlugin.dispatchAction("nexttrack");
				break;
			case ACTION_PREVIOUS:
				MediaControlsPlugin.dispatchAction("previoustrack");
				break;
			default:
				break;
		}
	}
}