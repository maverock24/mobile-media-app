package com.maverock24.mobilemediaapp;

import android.content.ContentResolver;
import android.database.Cursor;
import android.provider.DocumentsContract;
import java.util.ArrayDeque;
import java.util.Deque;

@CapacitorPlugin(name = "DirectoryReader")
public class DirectoryReaderPlugin extends Plugin {
	private static final int MAX_FILES = 5000;

	private static class ScanTask {
		Uri parentUri;
		String documentId;
		String relativePath;

		ScanTask(Uri parentUri, String documentId, String relativePath) {
			this.parentUri = parentUri;
			this.documentId = documentId;
			this.relativePath = relativePath;
		}
	}

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
		String treeUriString = call.getString("treeUri");
		if (treeUriString == null || treeUriString.isEmpty()) {
			call.reject("treeUri is required.");
			return;
		}

		try {
			Uri treeUri = Uri.parse(treeUriString);
			String rootDocId = DocumentsContract.getTreeDocumentId(treeUri);
			String path = call.getString("path", "");
			String targetDocId = getDocumentIdForPath(treeUri, rootDocId, path);

			ContentResolver resolver = getContext().getContentResolver();
			Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, targetDocId);
			
			JSArray entries = new JSArray();

			try (Cursor cursor = resolver.query(childrenUri, new String[] {
				DocumentsContract.Document.COLUMN_DOCUMENT_ID,
				DocumentsContract.Document.COLUMN_DISPLAY_NAME,
				DocumentsContract.Document.COLUMN_MIME_TYPE,
				DocumentsContract.Document.COLUMN_LAST_MODIFIED
			}, null, null, null)) {

				if (cursor != null) {
					while (cursor.moveToNext()) {
						String docId = cursor.getString(0);
						String name = cursor.getString(1);
						String mime = cursor.getString(2);
						long modified = cursor.getLong(3);

						if (name == null || name.isEmpty()) continue;

						String relPath = path.isEmpty() ? name : path + "/" + name;
						JSObject obj = new JSObject();
						
						if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
							obj.put("kind", "folder");
							obj.put("name", name);
							obj.put("relativePath", relPath);
						} else if (name.toLowerCase().endsWith(".mp3")) {
							obj.put("kind", "file");
							obj.put("name", name);
							obj.put("path", DocumentsContract.buildDocumentUriUsingTree(treeUri, docId).toString());
							obj.put("relativePath", relPath);
							obj.put("mimeType", mime);
							obj.put("modifiedAt", modified);
						} else {
							continue;
						}
						entries.put(obj);
					}
				}
			}

			JSObject result = new JSObject();
			result.put("entries", entries);
			call.resolve(result);
		} catch (Exception exception) {
			call.reject(exception.getMessage());
		}
	}

	@PluginMethod
	public void listAudioFiles(PluginCall call) {
		String treeUriString = call.getString("treeUri");
		if (treeUriString == null || treeUriString.isEmpty()) {
			call.reject("treeUri is required.");
			return;
		}

		try {
			Uri treeUri = Uri.parse(treeUriString);
			String rootDocId = DocumentsContract.getTreeDocumentId(treeUri);
			String startPath = call.getString("path", "");
			String startDocId = getDocumentIdForPath(treeUri, rootDocId, startPath);

			ContentResolver resolver = getContext().getContentResolver();
			JSArray files = new JSArray();
			int fileCount = 0;
			boolean isTruncated = false;

			Deque<ScanTask> stack = new ArrayDeque<>();
			stack.push(new ScanTask(treeUri, startDocId, startPath));

			while (!stack.isEmpty()) {
				ScanTask current = stack.pop();
				Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(current.parentUri, current.documentId);

				try (Cursor cursor = resolver.query(childrenUri, new String[] {
					DocumentsContract.Document.COLUMN_DOCUMENT_ID,
					DocumentsContract.Document.COLUMN_DISPLAY_NAME,
					DocumentsContract.Document.COLUMN_MIME_TYPE,
					DocumentsContract.Document.COLUMN_LAST_MODIFIED
				}, null, null, null)) {

					if (cursor == null) continue;

					while (cursor.moveToNext()) {
						if (fileCount >= MAX_FILES) {
							isTruncated = true;
							break;
						}

						String docId = cursor.getString(0);
						String name = cursor.getString(1);
						String mime = cursor.getString(2);
						long modified = cursor.getLong(3);

						if (name == null || name.isEmpty()) continue;

						String relPath = current.relativePath.isEmpty() ? name : current.relativePath + "/" + name;

						if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
							stack.push(new ScanTask(current.parentUri, docId, relPath));
						} else if (name.toLowerCase().endsWith(".mp3")) {
							fileCount++;
							JSObject fileObj = new JSObject();
							fileObj.put("kind", "file");
							fileObj.put("name", name);
							fileObj.put("path", DocumentsContract.buildDocumentUriUsingTree(current.parentUri, docId).toString());
							fileObj.put("relativePath", relPath);
							fileObj.put("mimeType", mime);
							fileObj.put("modifiedAt", modified);
							files.put(fileObj);
						}
					}
				}
				if (isTruncated) break;
			}

			JSObject result = new JSObject();
			result.put("files", files);
			result.put("truncated", isTruncated);
			result.put("count", fileCount);
			call.resolve(result);
		} catch (Exception exception) {
			call.reject(exception.getMessage());
		}
	}

	private String getDocumentIdForPath(Uri treeUri, String rootDocId, String path) throws Exception {
		if (path == null || path.isEmpty()) {
			return rootDocId;
		}

		ContentResolver resolver = getContext().getContentResolver();
		String currentDocId = rootDocId;
		String[] segments = path.split("/");

		for (String segment : segments) {
			if (segment.isEmpty()) continue;

			Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, currentDocId);
			try (Cursor cursor = resolver.query(childrenUri, new String[] {
				DocumentsContract.Document.COLUMN_DOCUMENT_ID,
				DocumentsContract.Document.COLUMN_DISPLAY_NAME
			}, null, null, null)) {

				boolean found = false;
				if (cursor != null) {
					while (cursor.moveToNext()) {
						if (segment.equals(cursor.getString(1))) {
							currentDocId = cursor.getString(0);
							found = true;
							break;
						}
					}
				}
				if (!found) {
					throw new Exception("Path segment not found: " + segment);
				}
			}
		}
		return currentDocId;
	}

	@PluginMethod
	public void installApk(PluginCall call) {
		String filePath = call.getString("path");
		if (filePath == null || filePath.isEmpty()) {
			call.reject("path is required.");
			return;
		}

		try {
			java.io.File apkFile = new java.io.File(filePath);
			if (!apkFile.exists()) {
				call.reject("APK file not found at: " + filePath);
				return;
			}

			Uri apkUri = FileProvider.getUriForFile(
				getContext(),
				getContext().getPackageName() + ".fileprovider",
				apkFile
			);

			Intent intent = new Intent(Intent.ACTION_VIEW);
			intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
			intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
			intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
			getContext().startActivity(intent);
			call.resolve();
		} catch (Exception e) {
			call.reject("Failed to launch APK installer: " + e.getMessage(), e);
		}
	}
}