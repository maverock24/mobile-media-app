package com.maverock24.mobilemediaapp;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
	@Override
	public void onCreate(Bundle savedInstanceState) {
		registerPlugin(DirectoryReaderPlugin.class);
		registerPlugin(MediaControlsPlugin.class);
		super.onCreate(savedInstanceState);
	}
}
