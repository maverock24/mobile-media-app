package com.maverock24.mobilemediaapp;

import android.media.AudioManager;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
	@Override
	public void onCreate(Bundle savedInstanceState) {
		registerPlugin(DirectoryReaderPlugin.class);
		registerPlugin(GoogleDriveNativePlugin.class);
		registerPlugin(MediaControlsPlugin.class);
		registerPlugin(ScreenDimPlugin.class);
		super.onCreate(savedInstanceState);
		setVolumeControlStream(AudioManager.STREAM_MUSIC);
	}
}
