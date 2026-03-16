package com.maverock24.mobilemediaapp;

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
	public void listFiles(PluginCall call) {
		String treeUriString = call.getString("treeUri");
		if (treeUriString == null || treeUriString.isEmpty()) {
			call.reject("treeUri is required.");
			return;
		}

		Uri treeUri = Uri.parse(treeUriString);
		DocumentFile root = DocumentFile.fromTreeUri(getContext(), treeUri);
		if (root == null || !root.exists() || !root.isDirectory()) {
			call.reject("Selected directory is not accessible.");
			return;
		}

		JSArray files = new JSArray();
		collectFiles(root, "", files);

		JSObject result = new JSObject();
		result.put("folderName", root.getName() != null ? root.getName() : "Selected Folder");
		result.put("files", files);
		call.resolve(result);
	}

	private void collectFiles(DocumentFile directory, String prefix, JSArray files) {
		for (DocumentFile child : directory.listFiles()) {
			String childName = child.getName();
			if (childName == null || childName.isEmpty()) {
				continue;
			}

			String relativePath = prefix.isEmpty() ? childName : prefix + "/" + childName;

			if (child.isDirectory()) {
				collectFiles(child, relativePath, files);
				continue;
			}

			if (!child.isFile()) {
				continue;
			}

			JSObject file = new JSObject();
			file.put("name", childName);
			file.put("path", child.getUri().toString());
			file.put("relativePath", relativePath);
			file.put("mimeType", child.getType());
			file.put("modifiedAt", child.lastModified());
			files.put(file);
		}
	}
}