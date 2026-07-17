package com.maverock24.mobilemediaapp;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;

import androidx.core.content.FileProvider;
import androidx.documentfile.provider.DocumentFile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayDeque;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Fast SAF directory reader.
 *
 * Performance note: this plugin deliberately avoids DocumentFile traversal
 * (listFiles()/getName()/isDirectory()/lastModified()) because every one of
 * those calls is a separate ContentResolver IPC query — a full library scan
 * with DocumentFile costs thousands of round-trips. Instead we use
 * DocumentsContract child-document cursor queries: ONE query per directory
 * returns id, name, mime type and mtime for every child at once (10-50x
 * faster on real libraries).
 */
@CapacitorPlugin(name = "DirectoryReader")
public class DirectoryReaderPlugin extends Plugin {
	private static final int DEFAULT_SCAN_BATCH_SIZE = 250;
	private static final Map<String, AudioScanSession> AUDIO_SCAN_SESSIONS = new ConcurrentHashMap<>();

	private static final String[] CHILD_PROJECTION = new String[] {
		DocumentsContract.Document.COLUMN_DOCUMENT_ID,
		DocumentsContract.Document.COLUMN_DISPLAY_NAME,
		DocumentsContract.Document.COLUMN_MIME_TYPE,
		DocumentsContract.Document.COLUMN_LAST_MODIFIED,
	};

	/** A directory queued for scanning: its SAF document id + path relative to the scan root. */
	private static final class DirNode {
		private final String documentId;
		private final String relativePath;

		private DirNode(String documentId, String relativePath) {
			this.documentId = documentId;
			this.relativePath = relativePath;
		}
	}

	private static final class AudioScanSession {
		private final ArrayDeque<DirNode> pendingDirs = new ArrayDeque<>();
		private final Uri treeUri;
		private final String folderName;
		private int foldersScanned = 0;

		private AudioScanSession(Uri treeUri, String startDocumentId, String basePath, String folderName) {
			this.treeUri = treeUri;
			this.folderName = folderName;
			this.pendingDirs.addLast(new DirNode(startDocumentId, basePath == null ? "" : basePath));
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
				.takePersistableUriPermission(treeUri,
					Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
			call.resolve();
		} catch (SecurityException exception) {
			call.reject("Unable to persist directory permission.", exception);
		} catch (Exception exception) {
			call.reject(exception.getMessage());
		}
	}

	@PluginMethod
	public void startAudioScan(PluginCall call) {
		try {
			String treeUriString = call.getString("treeUri");
			if (treeUriString == null || treeUriString.isEmpty()) {
				call.reject("treeUri is required.");
				return;
			}
			Uri treeUri = Uri.parse(treeUriString);
			String basePath = call.getString("path", "");

			String startDocId = resolveDocumentId(treeUri, basePath);
			if (startDocId == null) {
				call.reject("Selected directory is not accessible.");
				return;
			}

			String folderName = queryDisplayName(treeUri, startDocId);
			if (folderName == null || folderName.isEmpty()) {
				folderName = "Selected Folder";
			}

			AudioScanSession session = new AudioScanSession(treeUri, startDocId, basePath, folderName);
			String scanId = UUID.randomUUID().toString();
			AUDIO_SCAN_SESSIONS.put(scanId, session);

			JSObject result = new JSObject();
			result.put("scanId", scanId);
			result.put("folderName", session.folderName);
			result.put("foldersScanned", session.foldersScanned);
			result.put("foldersQueued", session.pendingDirs.size());
			call.resolve(result);
		} catch (Exception exception) {
			call.reject(exception.getMessage());
		}
	}

	@PluginMethod
	public void getAudioScanBatch(PluginCall call) {
		String scanId = call.getString("scanId");
		if (scanId == null || scanId.isEmpty()) {
			call.reject("scanId is required.");
			return;
		}

		AudioScanSession session = AUDIO_SCAN_SESSIONS.get(scanId);
		if (session == null) {
			call.reject("Audio scan session not found.");
			return;
		}

		int batchSize = call.getInt("batchSize", DEFAULT_SCAN_BATCH_SIZE);
		if (batchSize <= 0) {
			batchSize = DEFAULT_SCAN_BATCH_SIZE;
		}

		ContentResolver resolver = getContext().getContentResolver();
		JSArray files = new JSArray();
		int filesAdded = 0;

		// Process whole directories (one cursor query each) until we've emitted
		// at least batchSize files or the queue is drained. A directory's files
		// are never split across batches — cheap, since one dir = one query.
		while (filesAdded < batchSize && !session.pendingDirs.isEmpty()) {
			DirNode dir = session.pendingDirs.removeFirst();
			session.foldersScanned += 1;

			Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(session.treeUri, dir.documentId);
			try (Cursor cursor = resolver.query(childrenUri, CHILD_PROJECTION, null, null, null)) {
				if (cursor == null) continue;
				while (cursor.moveToNext()) {
					String docId = cursor.getString(0);
					String name = cursor.getString(1);
					String mime = cursor.getString(2);
					long modified = cursor.isNull(3) ? 0L : cursor.getLong(3);
					if (docId == null || name == null || name.isEmpty()) continue;

					if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
						session.pendingDirs.addLast(new DirNode(docId, buildRelativePath(dir.relativePath, name)));
						continue;
					}

					if (!name.toLowerCase().endsWith(".mp3")) continue;

					Uri docUri = DocumentsContract.buildDocumentUriUsingTree(session.treeUri, docId);
					files.put(createFileObject(name, docUri.toString(),
						buildRelativePath(dir.relativePath, name), mime, modified));
					filesAdded += 1;
				}
			} catch (Exception ignored) {
				// Unreadable directory (revoked permission, removed media) — skip it.
			}
		}

		boolean done = session.pendingDirs.isEmpty();
		if (done) {
			AUDIO_SCAN_SESSIONS.remove(scanId);
		}

		JSObject result = new JSObject();
		result.put("files", files);
		result.put("foldersScanned", session.foldersScanned);
		result.put("foldersQueued", session.pendingDirs.size());
		result.put("done", done);
		call.resolve(result);
	}

	@PluginMethod
	public void cancelAudioScan(PluginCall call) {
		String scanId = call.getString("scanId");
		if (scanId != null && !scanId.isEmpty()) {
			AUDIO_SCAN_SESSIONS.remove(scanId);
		}
		call.resolve();
	}

	@PluginMethod
	public void listEntries(PluginCall call) {
		try {
			String treeUriString = call.getString("treeUri");
			if (treeUriString == null || treeUriString.isEmpty()) {
				call.reject("treeUri is required.");
				return;
			}
			Uri treeUri = Uri.parse(treeUriString);
			String basePath = call.getString("path", "");

			String dirDocId = resolveDocumentId(treeUri, basePath);
			if (dirDocId == null) {
				call.reject("Selected directory is not accessible.");
				return;
			}

			JSArray entries = new JSArray();
			ContentResolver resolver = getContext().getContentResolver();
			Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, dirDocId);
			try (Cursor cursor = resolver.query(childrenUri, CHILD_PROJECTION, null, null, null)) {
				if (cursor != null) {
					while (cursor.moveToNext()) {
						String docId = cursor.getString(0);
						String name = cursor.getString(1);
						String mime = cursor.getString(2);
						long modified = cursor.isNull(3) ? 0L : cursor.getLong(3);
						if (docId == null || name == null || name.isEmpty()) continue;

						String relativePath = buildRelativePath(basePath, name);
						if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
							JSObject folder = new JSObject();
							folder.put("kind", "folder");
							folder.put("name", name);
							folder.put("relativePath", relativePath);
							entries.put(folder);
							continue;
						}

						if (!name.toLowerCase().endsWith(".mp3")) continue;

						Uri docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
						entries.put(createFileObject(name, docUri.toString(), relativePath, mime, modified));
					}
				}
			}

			String folderName = queryDisplayName(treeUri, dirDocId);
			JSObject result = new JSObject();
			result.put("folderName", folderName != null && !folderName.isEmpty() ? folderName : "Selected Folder");
			result.put("entries", entries);
			call.resolve(result);
		} catch (Exception exception) {
			call.reject(exception.getMessage());
		}
	}

	@PluginMethod
	public void listAudioFiles(PluginCall call) {
		try {
			String treeUriString = call.getString("treeUri");
			if (treeUriString == null || treeUriString.isEmpty()) {
				call.reject("treeUri is required.");
				return;
			}
			Uri treeUri = Uri.parse(treeUriString);
			String basePath = call.getString("path", "");

			String startDocId = resolveDocumentId(treeUri, basePath);
			if (startDocId == null) {
				call.reject("Selected directory is not accessible.");
				return;
			}

			JSArray files = new JSArray();
			ContentResolver resolver = getContext().getContentResolver();
			ArrayDeque<DirNode> queue = new ArrayDeque<>();
			queue.addLast(new DirNode(startDocId, basePath == null ? "" : basePath));

			while (!queue.isEmpty()) {
				DirNode dir = queue.removeFirst();
				Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, dir.documentId);
				try (Cursor cursor = resolver.query(childrenUri, CHILD_PROJECTION, null, null, null)) {
					if (cursor == null) continue;
					while (cursor.moveToNext()) {
						String docId = cursor.getString(0);
						String name = cursor.getString(1);
						String mime = cursor.getString(2);
						long modified = cursor.isNull(3) ? 0L : cursor.getLong(3);
						if (docId == null || name == null || name.isEmpty()) continue;

						if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
							queue.addLast(new DirNode(docId, buildRelativePath(dir.relativePath, name)));
							continue;
						}

						if (!name.toLowerCase().endsWith(".mp3")) continue;

						Uri docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
						files.put(createFileObject(name, docUri.toString(),
							buildRelativePath(dir.relativePath, name), mime, modified));
					}
				} catch (Exception ignored) {
					// Skip unreadable directory
				}
			}

			String folderName = queryDisplayName(treeUri, startDocId);
			JSObject result = new JSObject();
			result.put("folderName", folderName != null && !folderName.isEmpty() ? folderName : "Selected Folder");
			result.put("files", files);
			call.resolve(result);
		} catch (Exception exception) {
			call.reject(exception.getMessage());
		}
	}

	/**
	 * Resolve the SAF document id for a relative path under the tree root.
	 * One children-cursor query per path segment (name match), instead of
	 * DocumentFile.findFile() which materialises every sibling.
	 */
	private String resolveDocumentId(Uri treeUri, String relativePath) {
		String docId = DocumentsContract.getTreeDocumentId(treeUri);
		if (relativePath == null || relativePath.isEmpty()) {
			return docId;
		}

		ContentResolver resolver = getContext().getContentResolver();
		for (String segment : relativePath.split("/")) {
			if (segment == null || segment.isEmpty()) continue;

			String matchedId = null;
			Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, docId);
			try (Cursor cursor = resolver.query(childrenUri, new String[] {
					DocumentsContract.Document.COLUMN_DOCUMENT_ID,
					DocumentsContract.Document.COLUMN_DISPLAY_NAME,
					DocumentsContract.Document.COLUMN_MIME_TYPE,
				}, null, null, null)) {
				if (cursor != null) {
					while (cursor.moveToNext()) {
						String childId = cursor.getString(0);
						String childName = cursor.getString(1);
						String childMime = cursor.getString(2);
						if (segment.equals(childName)
							&& DocumentsContract.Document.MIME_TYPE_DIR.equals(childMime)) {
							matchedId = childId;
							break;
						}
					}
				}
			} catch (Exception exception) {
				return null;
			}

			if (matchedId == null) {
				return null;
			}
			docId = matchedId;
		}

		return docId;
	}

	/** Fetch the display name of a single document (one query). */
	private String queryDisplayName(Uri treeUri, String documentId) {
		Uri docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId);
		try (Cursor cursor = getContext().getContentResolver().query(docUri,
			new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
			if (cursor != null && cursor.moveToFirst()) {
				return cursor.getString(0);
			}
		} catch (Exception ignored) {
			// Fall through
		}
		return null;
	}

	private String buildRelativePath(String prefix, String childName) {
		return prefix == null || prefix.isEmpty() ? childName : prefix + "/" + childName;
	}

	private JSObject createFileObject(String name, String uriString, String relativePath, String mimeType, long modifiedAt) {
		JSObject result = new JSObject();
		result.put("kind", "file");
		result.put("name", name);
		result.put("path", uriString);
		result.put("relativePath", relativePath);
		result.put("mimeType", mimeType);
		result.put("modifiedAt", modifiedAt);
		return result;
	}

	@PluginMethod
	public void writeFile(PluginCall call) {
		try {
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

			DocumentFile target = root;
			String relativePath = call.getString("path", "");
			if (relativePath != null && !relativePath.isEmpty()) {
				for (String segment : relativePath.split("/")) {
					if (segment == null || segment.isEmpty()) continue;
					DocumentFile next = target.findFile(segment);
					if (next == null || !next.exists() || !next.isDirectory()) {
						call.reject("Selected directory is not accessible.");
						return;
					}
					target = next;
				}
			}

			String fileName = call.getString("fileName");
			if (fileName == null || fileName.isEmpty()) {
				call.reject("fileName is required.");
				return;
			}

			String mimeType = call.getString("mimeType", "application/octet-stream");
			String base64Data = call.getString("data");
			if (base64Data == null || base64Data.isEmpty()) {
				call.reject("data is required.");
				return;
			}

			byte[] bytes = android.util.Base64.decode(base64Data, android.util.Base64.DEFAULT);

			// Create or overwrite the file under the SAF tree URI
			DocumentFile existing = target.findFile(fileName);
			if (existing != null && existing.isFile()) {
				existing.delete();
			}
			DocumentFile newFile = target.createFile(mimeType, fileName);
			if (newFile == null) {
				call.reject("Unable to create file: " + fileName);
				return;
			}

			java.io.OutputStream out = getContext().getContentResolver().openOutputStream(newFile.getUri());
			if (out == null) {
				call.reject("Unable to open output stream for: " + fileName);
				return;
			}
			try {
				out.write(bytes);
				out.flush();
			} finally {
				out.close();
			}

			JSObject result = new JSObject();
			result.put("path", newFile.getUri().toString());
			call.resolve(result);
		} catch (Exception e) {
			call.reject("Failed to write file: " + e.getMessage(), e);
		}
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
