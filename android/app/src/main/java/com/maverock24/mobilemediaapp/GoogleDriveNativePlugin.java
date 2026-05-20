package com.maverock24.mobilemediaapp;

import android.app.Activity;
import android.content.IntentSender;

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
import com.google.android.gms.common.api.Scope;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(name = "GoogleDriveNative")
public class GoogleDriveNativePlugin extends Plugin {
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

			pendingAuthorizationCallId = call.getCallbackId();
			bridge.saveCall(call);
			try {
				authorizationLauncher.launch(
					new IntentSenderRequest.Builder(result.getPendingIntent().getIntentSender())
						.build()
				);
			} catch (IntentSender.SendIntentException exception) {
				releasePendingAuthorizationCall();
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

	private void handleAuthorizationActivityResult(ActivityResult activityResult) {
		PluginCall savedCall = pendingAuthorizationCallId == null
			? null
			: bridge.getSavedCall(pendingAuthorizationCallId);
		if (savedCall == null) {
			pendingAuthorizationCallId = null;
			return;
		}

		try {
			if (activityResult.getResultCode() != Activity.RESULT_OK || activityResult.getData() == null) {
				savedCall.reject("Google authorization was cancelled.");
				return;
			}

			AuthorizationResult result = Identity.getAuthorizationClient(getContext())
				.getAuthorizationResultFromIntent(activityResult.getData());
			resolveAuthorization(savedCall, result);
		} catch (ApiException exception) {
			savedCall.reject("Unable to finish Google authorization.", exception);
		} finally {
			releasePendingAuthorizationCall();
		}
	}

	private void releasePendingAuthorizationCall() {
		if (pendingAuthorizationCallId != null) {
			bridge.releaseCall(pendingAuthorizationCallId);
			pendingAuthorizationCallId = null;
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