import { describe, it, expect } from 'vitest';
import { isValidAudioUrl } from '$lib/utils/validation';

describe('isValidAudioUrl', () => {
	it('accepts valid HTTPS URLs', () => {
		expect(isValidAudioUrl('https://example.com/audio.mp3')).toBe(true);
		expect(isValidAudioUrl('https://stream.example.com/path/to/stream')).toBe(true);
		expect(isValidAudioUrl('https://example.com')).toBe(true);
	});

	it('rejects HTTP URLs', () => {
		expect(isValidAudioUrl('http://example.com/audio.mp3')).toBe(false);
	});

	it('rejects non-HTTPS protocols', () => {
		expect(isValidAudioUrl('ftp://example.com/audio.mp3')).toBe(false);
		expect(isValidAudioUrl('file:///path/to/file.mp3')).toBe(false);
		expect(isValidAudioUrl('ws://example.com')).toBe(false);
	});

	it('rejects undefined', () => {
		expect(isValidAudioUrl(undefined)).toBe(false);
	});

	it('rejects null', () => {
		expect(isValidAudioUrl(null as unknown as string)).toBe(false);
	});

	it('rejects empty string', () => {
		expect(isValidAudioUrl('')).toBe(false);
	});

	it('rejects non-string values', () => {
		expect(isValidAudioUrl(42 as unknown as string)).toBe(false);
		expect(isValidAudioUrl(true as unknown as string)).toBe(false);
		expect(isValidAudioUrl({} as unknown as string)).toBe(false);
	});

	it('rejects relative URLs', () => {
		expect(isValidAudioUrl('/audio/stream.mp3')).toBe(false);
		expect(isValidAudioUrl('audio/stream.mp3')).toBe(false);
	});

	it('rejects malformed URLs', () => {
		expect(isValidAudioUrl('not-a-url')).toBe(false);
		expect(isValidAudioUrl('https://')).toBe(false);
	});

	it('accepts HTTPS URLs with query params', () => {
		expect(isValidAudioUrl('https://example.com/stream?token=abc123')).toBe(true);
	});

	it('accepts HTTPS URLs with port', () => {
		expect(isValidAudioUrl('https://example.com:8443/stream')).toBe(true);
	});

	it('accepts HTTPS URLs with IP address', () => {
		expect(isValidAudioUrl('https://192.168.1.1/stream')).toBe(true);
	});
});
