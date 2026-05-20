package com.maverock24.mobilemediaapp;

import android.app.Activity;
import android.content.Intent;
import android.content.IntentSender;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(name = "GoogleDriveNative")
public class GoogleDriveNativePlugin extends Plugin {
	private static final int GOOGLE_DRIVE_AUTH_REQUEST_CODE = 47028;

	@PluginMethod
	public void authorize(PluginCall call) {
		List<Scope> scopes = parseScopes(call.getArray("scopes"));
		if (scopes.isEmpty()) {
			call.reject("At least one Google Drive scope is required.");
			return;
		}

		boolean interactive = call.getBoolean("interactive", true);
		AuthorizationRequest request = AuthorizationRequest.builder()
			.setRequestedScopes(scopes)
			.build();

		Identity.getAuthorizationClient(getActivity())
			.authorize(request)
			.addOnSuccessListener(result -> handleAuthorizationResult(call, result, interactive))
			.addOnFailureListener(exception ->
				call.reject("Unable to authorize Google Drive access.", exception)
			);
	}

	private void handleAuthorizationResult(PluginCall call, AuthorizationResult result, boolean interactive) {
		if (result.hasResolution()) {
			if (!interactive) {
				call.reject("Silent Google authorization is unavailable.");
				return;
			}

			if (result.getPendingIntent() == null) {
				call.reject("Google authorization requires additional confirmation.");
				return;
			}

			saveCall(call);
			try {
				getActivity().startIntentSenderForResult(
					result.getPendingIntent().getIntentSender(),
					GOOGLE_DRIVE_AUTH_REQUEST_CODE,
					new Intent(),
					0,
					0,
					0,
					null
				);
			} catch (IntentSender.SendIntentException exception) {
				freeSavedCall();
				call.reject("Unable to launch Google authorization.", exception);
			}
			return;
		}

		resolveAuthorization(call, result);
	}

	private void resolveAuthorization(PluginCall call, AuthorizationResult result) {
		String accessToken = result.getAccessToken();
		if (accessToken == null || accessToken.isEmpty()) {
			call.reject("Google authorization did not return an access token.");
			return;
		}

		JSObject response = new JSObject();
		response.put("accessToken", accessToken);
		response.put("expiresIn", 3600);

		JSArray grantedScopes = new JSArray();
		List<String> scopes = result.getGrantedScopes();
		if (scopes != null) {
			for (String scope : scopes) {
				if (scope != null && !scope.isEmpty()) {
					grantedScopes.put(scope);
				}
			}
		}
		response.put("grantedScopes", grantedScopes);
		call.resolve(response);
	}

	@Override
	@Deprecated
	protected void handleOnActivityResult(int requestCode, int resultCode, Intent data) {
		if (requestCode != GOOGLE_DRIVE_AUTH_REQUEST_CODE) {
			return;
		}

		PluginCall savedCall = getSavedCall();
		if (savedCall == null) {
			return;
		}

		try {
			if (resultCode != Activity.RESULT_OK || data == null) {
				savedCall.reject("Google authorization was cancelled.");
				return;
			}

			AuthorizationResult result = Identity.getAuthorizationClient(getContext())
				.getAuthorizationResultFromIntent(data);
			resolveAuthorization(savedCall, result);
		} catch (ApiException exception) {
			savedCall.reject("Unable to finish Google authorization.", exception);
		} finally {
			freeSavedCall();
		}
	}

	private List<Scope> parseScopes(JSONArray rawScopes) {
		List<Scope> scopes = new ArrayList<>();
		if (rawScopes == null) {
			return scopes;
		}

		for (int index = 0; index < rawScopes.length(); index += 1) {
			String value = rawScopes.optString(index, "").trim();
			if (!value.isEmpty()) {
				scopes.add(new Scope(value));
			}
		}

		return scopes;
	}
}