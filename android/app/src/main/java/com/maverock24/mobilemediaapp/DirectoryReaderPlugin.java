package com.maverock24.mobilemediaapp;

import android.content.Intent;
import android.net.Uri;

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

@CapacitorPlugin(name = "DirectoryReader")
public class DirectoryReaderPlugin extends Plugin {
	private static final int DEFAULT_SCAN_BATCH_SIZE = 250;
	private static final Map<String, AudioScanSession> AUDIO_SCAN_SESSIONS = new ConcurrentHashMap<>();

	private static final class AudioScanNode {
		private final DocumentFile file;
		private final String relativePath;

		private AudioScanNode(DocumentFile file, String relativePath) {
			this.file = file;
			this.relativePath = relativePath;
		}
	}

	private static final class AudioScanSession {
		private final ArrayDeque<AudioScanNode> pendingNodes = new ArrayDeque<>();
		private final String folderName;
		private int foldersScanned = 0;

		private AudioScanSession(DocumentFile target, String basePath) {
			this.folderName = target.getName() != null ? target.getName() : "Selected Folder";
			this.pendingNodes.addLast(new AudioScanNode(target, basePath));
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
	public void startAudioScan(PluginCall call) {
		try {
			DocumentFile target = getTargetDirectory(call);
			String basePath = call.getString("path", "");
			AudioScanSession session = new AudioScanSession(target, basePath);
			String scanId = UUID.randomUUID().toString();
			AUDIO_SCAN_SESSIONS.put(scanId, session);

			JSObject result = new JSObject();
			result.put("scanId", scanId);
			result.put("folderName", session.folderName);
			result.put("foldersScanned", session.foldersScanned);
			result.put("foldersQueued", session.pendingNodes.size());
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

		JSArray files = new JSArray();
		int filesAdded = 0;

		while (filesAdded < batchSize && !session.pendingNodes.isEmpty()) {
			AudioScanNode node = session.pendingNodes.removeFirst();
			DocumentFile file = node.file;
			if (file == null || !file.exists()) {
				continue;
			}

			if (file.isDirectory()) {
				session.foldersScanned += 1;
				DocumentFile[] children = file.listFiles();
				if (children == null) {
					continue;
				}

				for (DocumentFile child : children) {
					if (child == null) continue;
					String childName = child.getName();
					if (childName == null || childName.isEmpty()) {
						continue;
					}

					session.pendingNodes.addLast(
						new AudioScanNode(child, buildRelativePath(node.relativePath, childName))
					);
				}
				continue;
			}

			String fileName = file.getName();
			if (fileName == null || fileName.isEmpty()) {
				continue;
			}

			if (!file.isFile() || !fileName.toLowerCase().endsWith(".mp3")) {
				continue;
			}

			files.put(createFileObject(file, node.relativePath));
			filesAdded += 1;
		}

		boolean done = session.pendingNodes.isEmpty();
		if (done) {
			AUDIO_SCAN_SESSIONS.remove(scanId);
		}

		JSObject result = new JSObject();
		result.put("files", files);
		result.put("foldersScanned", session.foldersScanned);
		result.put("foldersQueued", session.pendingNodes.size());
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
			DocumentFile target = getTargetDirectory(call);
			JSArray entries = new JSArray();

			DocumentFile[] children = target.listFiles();
			if (children != null) {
				for (DocumentFile child : children) {
					if (child == null) continue;
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
		DocumentFile[] children = directory.listFiles();
		if (children == null) return;
		for (DocumentFile child : children) {
			if (child == null) continue;
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