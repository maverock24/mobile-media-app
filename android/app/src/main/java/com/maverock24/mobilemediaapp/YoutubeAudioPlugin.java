package com.maverock24.mobilemediaapp;

import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;

/**
 * Native download + AAC/Opus decode for the YouTube → MP3 save.
 *
 * The WebView path (fetch the stream, then AudioContext.decodeAudioData) needs
 * the whole track in RAM and runs through the WebView media decoder, which
 * crashed the app on device. This downloads to a cache file and decodes it to
 * 16-bit PCM with MediaExtractor/MediaCodec, so JS only ever pulls bounded PCM
 * chunks to feed the LAME encoder.
 *
 * Capacitor dispatches plugin methods on its own background thread, so the
 * blocking download and decode do not touch the WebView UI thread.
 */
@CapacitorPlugin(name = "YoutubeAudio")
public class YoutubeAudioPlugin extends Plugin {

	private static final int DOWNLOAD_BUFFER_BYTES = 128 * 1024;
	private static final long DEQUEUE_TIMEOUT_US = 10_000L;

	@PluginMethod
	public void preparePcm(PluginCall call) {
		String url = call.getString("url");
		String id = call.getString("id");
		if (url == null || url.isEmpty() || id == null || id.isEmpty()) {
			call.reject("url and id are required.");
			return;
		}

		try {
			File cacheDir = getContext().getCacheDir();
			File source = new File(cacheDir, "yt-" + id + ".src");
			File pcm = new File(cacheDir, "yt-" + id + ".pcm");

			downloadToFile(url, source, id);

			DecodeResult result = decodeToPcm(source, pcm);
			// The encoded stream is large and unneeded now; the PCM file is all
			// JS reads from here on.
			//noinspection ResultOfMethodCallIgnored
			source.delete();

			JSObject output = new JSObject();
			output.put("path", pcm.getAbsolutePath());
			output.put("sampleRate", result.sampleRate);
			output.put("channels", result.channels);
			output.put("samples", result.samples);
			call.resolve(output);
		} catch (Exception e) {
			call.reject("Failed to prepare audio: " + e.getMessage(), e);
		}
	}

	@PluginMethod
	public void readPcmChunk(PluginCall call) {
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
			output.put("eof", offset + read >= size);
			call.resolve(output);
		} catch (Exception e) {
			call.reject("Failed to read PCM chunk: " + e.getMessage(), e);
		}
	}

	/** Delete the temp files for one save. Safe to call more than once. */
	@PluginMethod
	public void release(PluginCall call) {
		String id = call.getString("id");
		if (id == null || id.isEmpty()) {
			call.reject("id is required.");
			return;
		}
		try {
			File cacheDir = getContext().getCacheDir();
			for (String suffix : new String[] { ".src", ".pcm" }) {
				File file = new File(cacheDir, "yt-" + id + suffix);
				if (file.exists()) {
					//noinspection ResultOfMethodCallIgnored
					file.delete();
				}
			}
			call.resolve();
		} catch (Exception e) {
			call.reject("Failed to release temp files: " + e.getMessage(), e);
		}
	}

	// ── Download ──────────────────────────────────────────────────────────
	private void downloadToFile(String urlString, File destination, String id) throws Exception {
		HttpURLConnection connection = (HttpURLConnection) new URL(urlString).openConnection();
		connection.setConnectTimeout(15_000);
		connection.setReadTimeout(30_000);
		connection.setInstanceFollowRedirects(true);
		try {
			int status = connection.getResponseCode();
			if (status < 200 || status >= 300) {
				throw new Exception("Download failed (HTTP " + status + ").");
			}

			long total = connection.getContentLengthLong();
			long received = 0L;
			byte[] buffer = new byte[DOWNLOAD_BUFFER_BYTES];
			try (InputStream in = connection.getInputStream();
				 FileOutputStream out = new FileOutputStream(destination)) {
				int read;
				while ((read = in.read(buffer)) != -1) {
					out.write(buffer, 0, read);
					received += read;
					notifyProgress("download", received, total);
				}
				out.flush();
			}
		} finally {
			connection.disconnect();
		}
	}

	private void notifyProgress(String phase, long received, long total) {
		JSObject progress = new JSObject();
		progress.put("phase", phase);
		progress.put("received", received);
		progress.put("total", total);
		notifyListeners("progress", progress, false);
	}

	// ── Decode ────────────────────────────────────────────────────────────
	private static final class DecodeResult {
		int sampleRate;
		int channels;
		long samples;
	}

	private DecodeResult decodeToPcm(File source, File pcmFile) throws Exception {
		MediaExtractor extractor = new MediaExtractor();
		MediaCodec codec = null;
		try {
			extractor.setDataSource(source.getAbsolutePath());

			int trackIndex = -1;
			MediaFormat inputFormat = null;
			for (int index = 0; index < extractor.getTrackCount(); index++) {
				MediaFormat format = extractor.getTrackFormat(index);
				String mime = format.getString(MediaFormat.KEY_MIME);
				if (mime != null && mime.startsWith("audio/")) {
					trackIndex = index;
					inputFormat = format;
					break;
				}
			}
			if (trackIndex < 0 || inputFormat == null) {
				throw new Exception("No audio track found in the stream.");
			}
			extractor.selectTrack(trackIndex);

			String mime = inputFormat.getString(MediaFormat.KEY_MIME);
			codec = MediaCodec.createDecoderByType(mime);
			codec.configure(inputFormat, null, null, 0);
			codec.start();

			int sampleRate = inputFormat.containsKey(MediaFormat.KEY_SAMPLE_RATE)
				? inputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE) : 44100;
			int channels = inputFormat.containsKey(MediaFormat.KEY_CHANNEL_COUNT)
				? inputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT) : 2;

			MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
			boolean inputDone = false;
			boolean outputDone = false;

			try (FileOutputStream out = new FileOutputStream(pcmFile)) {
				while (!outputDone) {
					if (!inputDone) {
						int inputIndex = codec.dequeueInputBuffer(DEQUEUE_TIMEOUT_US);
						if (inputIndex >= 0) {
							ByteBuffer inputBuffer = codec.getInputBuffer(inputIndex);
							int size = inputBuffer == null ? -1 : extractor.readSampleData(inputBuffer, 0);
							if (size < 0) {
								codec.queueInputBuffer(inputIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
								inputDone = true;
							} else {
								codec.queueInputBuffer(inputIndex, 0, size, extractor.getSampleTime(), 0);
								extractor.advance();
							}
						}
					}

					int outputIndex = codec.dequeueOutputBuffer(info, DEQUEUE_TIMEOUT_US);
					if (outputIndex >= 0) {
						if (info.size > 0) {
							ByteBuffer outputBuffer = codec.getOutputBuffer(outputIndex);
							if (outputBuffer != null) {
								byte[] data = new byte[info.size];
								outputBuffer.position(info.offset);
								outputBuffer.limit(info.offset + info.size);
								outputBuffer.get(data);
								out.write(data);
							}
						}
						codec.releaseOutputBuffer(outputIndex, false);
						if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
							outputDone = true;
						}
					} else if (outputIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
						MediaFormat outputFormat = codec.getOutputFormat();
						if (outputFormat.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
							sampleRate = outputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE);
						}
						if (outputFormat.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
							channels = outputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
						}
					}
				}
				out.flush();
			}

			DecodeResult result = new DecodeResult();
			result.sampleRate = sampleRate;
			result.channels = channels;
			int bytesPerFrame = 2 * channels;
			result.samples = bytesPerFrame > 0 ? pcmFile.length() / bytesPerFrame : 0;
			return result;
		} finally {
			if (codec != null) {
				try { codec.stop(); } catch (Exception ignored) { /* already stopped */ }
				codec.release();
			}
			extractor.release();
		}
	}
}
