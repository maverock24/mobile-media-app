package com.maverock24.mobilemediaapp;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;

import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;

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
import com.google.android.gms.common.api.CommonStatusCodes;
import com.google.android.gms.common.api.Scope;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

@CapacitorPlugin(name = "GoogleDriveNative")
public class GoogleDriveNativePlugin extends Plugin {
	private static final String PENDING_AUTH_PREFS = "google_drive_native_auth";
	private static final String PENDING_AUTH_ACCESS_TOKEN_KEY = "pending_access_token";
	private static final String PENDING_AUTH_EXPIRES_AT_KEY = "pending_expires_at";
	private static final String PENDING_AUTH_GRANTED_SCOPES_KEY = "pending_granted_scopes";
	private static final long DEFAULT_EXPIRES_IN_SECONDS = 3600L;

	private ActivityResultLauncher<IntentSenderRequest> authorizationLauncher;
	private String pendingAuthorizationCallId;

	@Override
	public void load() {
		super.load();
		authorizationLauncher = bridge.registerForActivityResult(
			new ActivityResultContracts.StartIntentSenderForResult(),
			this::handleAuthorizationActivityResult
		);
	}

	@PluginMethod
	public void authorize(PluginCall call) {
		clearPendingAuthorizationResult();

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
			.addOnFailureListener(exception -> {
				if (exception instanceof ApiException apiException) {
					call.reject(describeApiException("Unable to authorize Google Drive access.", apiException), apiException);
					return;
				}

				call.reject("Unable to authorize Google Drive access.", exception);
			});
	}

	@PluginMethod
	public void consumePendingAuthorizationResult(PluginCall call) {
		JSObject response = readPendingAuthorizationResult();
		if (response == null) {
			call.resolve(new JSObject());
			return;
		}

		clearPendingAuthorizationResult();
		call.resolve(response);
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

			pendingAuthorizationCallId = call.getCallbackId();
			bridge.saveCall(call);
			try {
				authorizationLauncher.launch(
					new IntentSenderRequest.Builder(result.getPendingIntent().getIntentSender()).build()
				);
			} catch (RuntimeException exception) {
				releasePendingAuthorizationCall();
				call.reject("Unable to launch Google authorization.", exception);
			}
			return;
		}

		resolveAuthorization(call, result);
	}

	private void resolveAuthorization(PluginCall call, AuthorizationResult result) {
		JSObject response = createAuthorizationResponse(result);
		if (response == null) {
			call.reject("Google authorization did not return an access token. If this only fails in the APK, verify the Android OAuth client package name and signing certificate in Google Cloud.");
			return;
		}
		call.resolve(response);
	}

	private void handleAuthorizationActivityResult(ActivityResult activityResult) {
		PluginCall savedCall = pendingAuthorizationCallId == null
			? null
			: bridge.getSavedCall(pendingAuthorizationCallId);

		try {
			if (activityResult.getResultCode() != Activity.RESULT_OK || activityResult.getData() == null) {
				clearPendingAuthorizationResult();
				if (savedCall != null) {
					savedCall.reject("Google authorization was cancelled.");
				}
				return;
			}

			AuthorizationResult result = Identity.getAuthorizationClient(getContext())
				.getAuthorizationResultFromIntent(activityResult.getData());

			persistPendingAuthorizationResult(result);

			if (savedCall == null) {
				return;
			}

			resolveAuthorization(savedCall, result);
		} catch (ApiException exception) {
			clearPendingAuthorizationResult();
			if (savedCall != null) {
				savedCall.reject(describeApiException("Unable to finish Google authorization.", exception), exception);
			}
		} finally {
			releasePendingAuthorizationCall();
		}
	}

	private String describeApiException(String prefix, ApiException exception) {
		int statusCode = exception.getStatusCode();
		String statusName = CommonStatusCodes.getStatusCodeString(statusCode);
		String statusMessage = exception.getStatusMessage();

		if (statusCode == CommonStatusCodes.CANCELED) {
			return "Google authorization was cancelled.";
		}

		if (statusCode == CommonStatusCodes.DEVELOPER_ERROR) {
			return prefix + " (status 10: DEVELOPER_ERROR). This APK's Android OAuth client or signing certificate does not match Google Cloud configuration. Add or update the Android OAuth client for package " + getContext().getPackageName() + " with the SHA-1/SHA-256 of the key used to sign this APK.";
		}

		if (statusCode == CommonStatusCodes.NETWORK_ERROR) {
			return prefix + " (status 7: NETWORK_ERROR). Check the device connection and Google Play services, then try again.";
		}

		if (statusCode == CommonStatusCodes.SIGN_IN_REQUIRED) {
			return prefix + " (status 4: SIGN_IN_REQUIRED). Choose a Google account and try again.";
		}

		if (statusMessage != null && !statusMessage.isEmpty() && !statusMessage.equals(statusName)) {
			return prefix + " (status " + statusCode + ": " + statusName + ", " + statusMessage + ").";
		}

		return prefix + " (status " + statusCode + ": " + statusName + ").";
	}

	private void releasePendingAuthorizationCall() {
		if (pendingAuthorizationCallId != null) {
			bridge.releaseCall(pendingAuthorizationCallId);
			pendingAuthorizationCallId = null;
		}
	}

	private JSObject createAuthorizationResponse(AuthorizationResult result) {
		String accessToken = result.getAccessToken();
		if (accessToken == null || accessToken.isEmpty()) {
			return null;
		}

		JSObject response = new JSObject();
		response.put("accessToken", accessToken);
		response.put("expiresIn", resolveExpiresInSeconds(result));

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
		return response;
	}

	private long resolveExpiresInSeconds(AuthorizationResult result) {
		Bundle tokenResponseParams = result.getTokenResponseParams();
		if (tokenResponseParams == null) {
			return DEFAULT_EXPIRES_IN_SECONDS;
		}

		Object rawExpiresIn = tokenResponseParams.get("expires_in");
		if (rawExpiresIn instanceof Number) {
			return Math.max(1L, ((Number) rawExpiresIn).longValue());
		}

		if (rawExpiresIn instanceof String) {
			try {
				return Math.max(1L, Long.parseLong((String) rawExpiresIn));
			} catch (NumberFormatException ignored) {}
		}

		return DEFAULT_EXPIRES_IN_SECONDS;
	}

	private SharedPreferences getPendingAuthorizationPreferences() {
		return getContext().getSharedPreferences(PENDING_AUTH_PREFS, Context.MODE_PRIVATE);
	}

	private void persistPendingAuthorizationResult(AuthorizationResult result) {
		String accessToken = result.getAccessToken();
		if (accessToken == null || accessToken.isEmpty()) {
			clearPendingAuthorizationResult();
			return;
		}

		long expiresAt = System.currentTimeMillis() + (resolveExpiresInSeconds(result) * 1000L);
		Set<String> grantedScopes = new HashSet<>();
		List<String> scopes = result.getGrantedScopes();
		if (scopes != null) {
			for (String scope : scopes) {
				if (scope != null && !scope.isEmpty()) {
					grantedScopes.add(scope);
				}
			}
		}

		SharedPreferences.Editor editor = getPendingAuthorizationPreferences().edit();
		editor.putString(PENDING_AUTH_ACCESS_TOKEN_KEY, accessToken);
		editor.putLong(PENDING_AUTH_EXPIRES_AT_KEY, expiresAt);
		editor.putStringSet(PENDING_AUTH_GRANTED_SCOPES_KEY, grantedScopes);
		editor.apply();
	}

	private JSObject readPendingAuthorizationResult() {
		SharedPreferences preferences = getPendingAuthorizationPreferences();
		String accessToken = preferences.getString(PENDING_AUTH_ACCESS_TOKEN_KEY, "");
		if (accessToken == null || accessToken.isEmpty()) {
			return null;
		}

		long expiresAt = preferences.getLong(PENDING_AUTH_EXPIRES_AT_KEY, 0L);
		long now = System.currentTimeMillis();
		if (expiresAt > 0L && expiresAt <= now) {
			clearPendingAuthorizationResult();
			return null;
		}

		long expiresInSeconds = expiresAt > 0L
			? Math.max(1L, (expiresAt - now + 999L) / 1000L)
			: DEFAULT_EXPIRES_IN_SECONDS;

		JSObject response = new JSObject();
		response.put("accessToken", accessToken);
		response.put("expiresIn", expiresInSeconds);

		JSArray grantedScopes = new JSArray();
		Set<String> scopes = preferences.getStringSet(PENDING_AUTH_GRANTED_SCOPES_KEY, null);
		if (scopes != null) {
			for (String scope : scopes) {
				if (scope != null && !scope.isEmpty()) {
					grantedScopes.put(scope);
				}
			}
		}
		response.put("grantedScopes", grantedScopes);
		return response;
	}

	private void clearPendingAuthorizationResult() {
		getPendingAuthorizationPreferences().edit().clear().apply();
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
