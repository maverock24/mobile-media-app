package com.maverock24.mobilemediaapp;

import android.net.Uri;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Native download for the YouTube → file save.
 *
 * The WebView cannot do this hop: googlevideo sends no CORS headers, so a
 * WebView fetch of the stream is blocked before it leaves the app, and pulling a
 * whole song into JS holds it in the WebView. This downloads to a cache file
 * with HttpURLConnection instead, and JS copies that file into the picked SAF
 * folder in bounded chunks.
 *
 * Two details of the old implementation are replaced here:
 *
 *  - It issued one bare GET per save, with no request headers and no range.
 *    youtubei.js's own downloader does both
 *    (node_modules/youtubei.js/dist/src/utils/FormatUtils.js): it sends
 *    `accept`/`origin`/`referer`, and it walks the file with the
 *    `range=<start>-<end>` query parameter rather than a Range header. This
 *    mirrors that, in 4 MB windows with a retry per window, and logs the URL's
 *    own `range` value so a device run can show whether YouTube ever hands out
 *    a partial one.
 *  - Every 128 KB crossed the Capacitor bridge as a progress event. Progress is
 *    now reported once per megabyte.
 *
 * Capacitor dispatches plugin methods on its own background thread, so the
 * blocking download does not touch the WebView UI thread.
 */
@CapacitorPlugin(name = "YoutubeAudio")
public class YoutubeAudioPlugin extends Plugin {

	private static final String TAG = "YoutubeAudio";
	/** Bytes per read from the socket. */
	private static final int DOWNLOAD_BUFFER_BYTES = 128 * 1024;
	/** Maximum bytes per request. Small enough to resume quickly after a stall. */
	private static final int RANGE_WINDOW_BYTES = 4 * 1024 * 1024;
	/** Attempts per window before the download is declared failed. */
	private static final int MAX_WINDOW_ATTEMPTS = 3;
	/** Bytes between progress events. Each event crosses the Capacitor bridge. */
	private static final long PROGRESS_STEP_BYTES = 1024 * 1024;
	/** A range that starts past the end of the stream, which is how a download
	 *  whose size is an exact multiple of the window discovers it is done. */
	private static final int HTTP_RANGE_NOT_SATISFIABLE = 416;
	private static final int CONNECT_TIMEOUT_MS = 15_000;
	private static final int READ_TIMEOUT_MS = 30_000;

	@PluginMethod
	public void download(PluginCall call) {
		String url = call.getString("url");
		String id = call.getString("id");
		if (url == null || url.isEmpty() || id == null || id.isEmpty()) {
			call.reject("url and id are required.");
			return;
		}
		Long expectedBytes = call.getLong("expectedBytes");
		logStreamRequest(id, url, expectedBytes);

		try {
			File target = new File(getContext().getCacheDir(), "yt-" + id + ".audio");
			//noinspection ResultOfMethodCallIgnored
			target.delete();

			long size = downloadToFile(url, target, expectedBytes);

			JSObject output = new JSObject();
			output.put("path", target.getAbsolutePath());
			output.put("size", size);
			call.resolve(output);
		} catch (Exception e) {
			call.reject("Failed to download audio: " + e.getMessage(), e);
		}
	}

	/** Read part of a downloaded file. The caller copies it into the picked folder. */
	@PluginMethod
	public void readFileChunk(PluginCall call) {
		String path = call.getString("path");
		Integer offsetValue = call.getInt("offset", 0);
		Integer lengthValue = call.getInt("length", 0);
		if (path == null || path.isEmpty()) {
			call.reject("path is required.");
			return;
		}

		long offset = offsetValue == null ? 0L : offsetValue.longValue();
		int length = lengthValue == null ? 0 : lengthValue;
		if (length <= 0) {
			call.reject("length must be greater than zero.");
			return;
		}

		try (RandomAccessFile file = new RandomAccessFile(new File(path), "r")) {
			long size = file.length();
			if (offset >= size) {
				JSObject output = new JSObject();
				output.put("data", "");
				output.put("bytesRead", 0);
				output.put("eof", true);
				call.resolve(output);
				return;
			}

			int toRead = (int) Math.min((long) length, size - offset);
			byte[] buffer = new byte[toRead];
			file.seek(offset);
			int read = file.read(buffer, 0, toRead);
			if (read < 0) read = 0;

			JSObject output = new JSObject();
			output.put("data", Base64.encodeToString(buffer, 0, read, Base64.NO_WRAP));
			output.put("bytesRead", read);
			output.put("eof", offset + read >= size);
			call.resolve(output);
		} catch (Exception e) {
			call.reject("Failed to read the downloaded file: " + e.getMessage(), e);
		}
	}

	/** Delete the cached file for one save. Safe to call more than once. */
	@PluginMethod
	public void release(PluginCall call) {
		String id = call.getString("id");
		if (id == null || id.isEmpty()) {
			call.reject("id is required.");
			return;
		}
		try {
			File cacheDir = getContext().getCacheDir();
			// The .src/.pcm names are from the decode pipeline this replaced;
			// deleting them clears leftovers from an earlier version.
			for (String suffix : new String[] { ".audio", ".src", ".pcm" }) {
				File file = new File(cacheDir, "yt-" + id + suffix);
				if (file.exists()) {
					//noinspection ResultOfMethodCallIgnored
					file.delete();
				}
			}
			call.resolve();
		} catch (Exception e) {
			call.reject("Failed to release the cached file: " + e.getMessage(), e);
		}
	}

	// ── Download ──────────────────────────────────────────────────────────
	/**
	 * Record what the resolver handed over. Whether YouTube's own URL already
	 * carries a `range` parameter decides whether a partial response is even
	 * possible, and this is the only place that can be observed.
	 */
	private void logStreamRequest(String id, String url, Long expectedBytes) {
		Uri parsed = Uri.parse(url);
		String urlRange = parsed.getQueryParameter("range");
		Log.i(TAG, "download id=" + id + " host=" + parsed.getHost()
			+ " expected=" + (expectedBytes == null ? "unknown" : expectedBytes.toString())
			+ " urlRange=" + (urlRange == null ? "none" : urlRange));
	}

	/**
	 * Fetch the stream into `destination` in windows, returning the byte count.
	 *
	 * Each window asks for `range=<start>-<end>`, which is how youtubei.js
	 * addresses this host, and is retried on its own so a stall costs one window
	 * rather than the whole download. A window that does not return exactly what
	 * was asked for marks the end of the stream, whether short (truncated) or
	 * long (the server ignored the range parameter).
	 */
	private long downloadToFile(String urlString, File destination, Long expectedBytes) throws Exception {
		long offset = 0L;
		long lastReported = 0L;
		int attempts = 0;

		try (FileOutputStream out = new FileOutputStream(destination)) {
			while (expectedBytes == null || offset < expectedBytes) {
				long windowStart = offset;
				long windowEnd = expectedBytes == null
					? windowStart + RANGE_WINDOW_BYTES - 1
					: Math.min(windowStart + RANGE_WINDOW_BYTES, expectedBytes) - 1;
				long requested = windowEnd - windowStart + 1;

				long written = 0L;
				try {
					written = fetchWindow(urlString, windowStart, windowEnd, out);
				} catch (IOException | RuntimeException error) {
					attempts++;
					Log.w(TAG, "range " + windowStart + "-" + windowEnd + " failed (attempt "
						+ attempts + "): " + error.getMessage());
					if (attempts >= MAX_WINDOW_ATTEMPTS) {
						throw new Exception("gave up at byte " + windowStart + " after "
							+ attempts + " attempts: " + error.getMessage(), error);
					}
					// The failed attempt wrote part of the window before it died. Drop
					// those bytes and put the retry back at the window's start, or the
					// two attempts would interleave.
					out.getChannel().truncate(windowStart);
					out.getChannel().position(windowStart);
					continue;
				}

				attempts = 0;
				offset += written;
				Log.i(TAG, "range " + windowStart + "-" + windowEnd + " + " + written
					+ " bytes, " + offset + " total");

				if (offset - lastReported >= PROGRESS_STEP_BYTES || written < requested) {
					lastReported = offset;
					notifyProgress(offset, expectedBytes == null ? -1L : expectedBytes);
				}
				if (written != requested) break;
			}
			out.flush();
		}

		if (expectedBytes != null && offset != expectedBytes) {
			throw new Exception("downloaded " + offset + " of " + expectedBytes + " bytes");
		}
		notifyProgress(offset, expectedBytes == null ? -1L : expectedBytes);
		Log.i(TAG, "download finished: " + offset + " bytes");
		return offset;
	}

	/** One range request, appended to the stream and closed by the caller. */
	private long fetchWindow(String urlString, long start, long end, OutputStream out) throws IOException {
		// YouTube uses its own `range` query parameter rather than a Range header;
		// youtubei.js appends it the same way and notes the difference.
		String separator = urlString.contains("?") ? "&" : "?";
		String windowUrl = urlString + separator + "range=" + start + "-" + end;

		if (!"https".equalsIgnoreCase(Uri.parse(windowUrl).getScheme())) {
			throw new IOException("refusing a non-HTTPS stream URL");
		}

		HttpURLConnection connection = (HttpURLConnection) new URL(windowUrl).openConnection();
		connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
		connection.setReadTimeout(READ_TIMEOUT_MS);
		connection.setInstanceFollowRedirects(true);
		// The same headers youtubei.js sends with a stream request. Without them
		// googlevideo is free to answer a partial or throttled response.
		connection.setRequestProperty("accept", "*/*");
		connection.setRequestProperty("origin", "https://www.youtube.com");
		connection.setRequestProperty("referer", "https://www.youtube.com");
		// Android's HttpURLConnection asks for gzip by default. Media is never
		// compressed, and asking for identity keeps the byte count honest.
		connection.setRequestProperty("accept-encoding", "identity");

		try {
			int status = connection.getResponseCode();
			if (status == HTTP_RANGE_NOT_SATISFIABLE) {
				// Asked for bytes past the end: the stream is already complete.
				return 0L;
			}
			if (status < 200 || status >= 300) {
				throw new IOException("HTTP " + status);
			}

			long written = 0L;
			byte[] buffer = new byte[DOWNLOAD_BUFFER_BYTES];
			try (InputStream in = connection.getInputStream()) {
				int read;
				while ((read = in.read(buffer)) != -1) {
					out.write(buffer, 0, read);
					written += read;
				}
			}
			return written;
		} finally {
			connection.disconnect();
		}
	}

	private void notifyProgress(long received, long total) {
		JSObject progress = new JSObject();
		progress.put("received", received);
		progress.put("total", total);
		notifyListeners("progress", progress, false);
	}
}
