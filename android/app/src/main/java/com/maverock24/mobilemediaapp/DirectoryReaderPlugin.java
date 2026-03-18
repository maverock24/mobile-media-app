package com.maverock24.mobilemediaapp;

import android.content.Intent;
import android.net.Uri;

import androidx.documentfile.provider.DocumentFile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "DirectoryReader")
public class DirectoryReaderPlugin extends Plugin {

	@PluginMethod
	public void rememberTreeUri(PluginCall call) {
		String treeUriString = call.getString("treeUri");
		if (treeUriString == null || treeUriString.isEmpty()) {
			call.reject("treeUri is required.");
			return;
		}

		try {
			Uri treeUri = Uri.parse(treeUriString);
			getContext()
				.getContentResolver()
				.takePersistableUriPermission(treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
			call.resolve();
		} catch (SecurityException exception) {
			call.reject("Unable to persist directory permission.", exception);
		} catch (Exception exception) {
			call.reject(exception.getMessage());
		}
	}

	@PluginMethod
	public void listEntries(PluginCall call) {
		try {
			DocumentFile target = getTargetDirectory(call);
			JSArray entries = new JSArray();

			for (DocumentFile child : target.listFiles()) {
				String childName = child.getName();
				if (childName == null || childName.isEmpty()) {
					continue;
				}

				String relativePath = buildRelativePath(call.getString("path", ""), childName);
				if (child.isDirectory()) {
					JSObject folder = new JSObject();
					folder.put("kind", "folder");
					folder.put("name", childName);
					folder.put("relativePath", relativePath);
					entries.put(folder);
					continue;
				}

				if (!child.isFile() || !childName.toLowerCase().endsWith(".mp3")) {
					continue;
				}

				entries.put(createFileObject(child, relativePath));
			}

			JSObject result = new JSObject();
			result.put("folderName", target.getName() != null ? target.getName() : "Selected Folder");
			result.put("entries", entries);
			call.resolve(result);
		} catch (Exception exception) {
			call.reject(exception.getMessage());
		}
	}

	@PluginMethod
	public void listAudioFiles(PluginCall call) {
		try {
			DocumentFile target = getTargetDirectory(call);
			String basePath = call.getString("path", "");
			JSArray files = new JSArray();
			collectFiles(target, basePath, files);

			JSObject result = new JSObject();
			result.put("folderName", target.getName() != null ? target.getName() : "Selected Folder");
			result.put("files", files);
			call.resolve(result);
		} catch (Exception exception) {
			call.reject(exception.getMessage());
		}
	}

	private DocumentFile getTargetDirectory(PluginCall call) throws Exception {
		String treeUriString = call.getString("treeUri");
		if (treeUriString == null || treeUriString.isEmpty()) {
			throw new Exception("treeUri is required.");
		}

		Uri treeUri = Uri.parse(treeUriString);
		DocumentFile root = DocumentFile.fromTreeUri(getContext(), treeUri);
		if (root == null || !root.exists() || !root.isDirectory()) {
			throw new Exception("Selected directory is not accessible.");
		}

		String relativePath = call.getString("path", "");
		if (relativePath == null || relativePath.isEmpty()) {
			return root;
		}

		DocumentFile current = root;
		String[] segments = relativePath.split("/");
		for (String segment : segments) {
			if (segment == null || segment.isEmpty()) {
				continue;
			}

			DocumentFile next = current.findFile(segment);
			if (next == null || !next.exists() || !next.isDirectory()) {
				throw new Exception("Selected directory is not accessible.");
			}
			current = next;
		}

		return current;
	}

	private void collectFiles(DocumentFile directory, String prefix, JSArray files) {
		for (DocumentFile child : directory.listFiles()) {
			String childName = child.getName();
			if (childName == null || childName.isEmpty()) {
				continue;
			}

			String relativePath = buildRelativePath(prefix, childName);

			if (child.isDirectory()) {
				collectFiles(child, relativePath, files);
				continue;
			}

			if (!child.isFile() || !childName.toLowerCase().endsWith(".mp3")) {
				continue;
			}

			files.put(createFileObject(child, relativePath));
		}
	}

	private String buildRelativePath(String prefix, String childName) {
		return prefix == null || prefix.isEmpty() ? childName : prefix + "/" + childName;
	}

	private JSObject createFileObject(DocumentFile file, String relativePath) {
		JSObject result = new JSObject();
		result.put("kind", "file");
		result.put("name", file.getName());
		result.put("path", file.getUri().toString());
		result.put("relativePath", relativePath);
		result.put("mimeType", file.getType());
		result.put("modifiedAt", file.lastModified());
		return result;
	}
}