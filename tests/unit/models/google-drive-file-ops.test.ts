import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	GOOGLE_DRIVE_AUTH_SCOPE,
	GOOGLE_DRIVE_FULL_SCOPE,
	copyGoogleDriveFile,
	moveGoogleDriveFile,
	trashGoogleDriveFile,
	uniqueFileName,
} from '$lib/google-drive';

function fakeResponse(ok: boolean, data: unknown, status = 200) {
	return {
		ok,
		status,
		json: vi.fn(async () => data),
		text: vi.fn(async () => (ok ? '' : 'boom')),
	} as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchMock = vi.fn();
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe('T1 — Drive scope widened for file management', () => {
	it('auth scope includes the full drive scope', () => {
		expect(GOOGLE_DRIVE_FULL_SCOPE).toBe('https://www.googleapis.com/auth/drive');
		expect(GOOGLE_DRIVE_AUTH_SCOPE).toContain(GOOGLE_DRIVE_FULL_SCOPE);
	});
});

describe('copyGoogleDriveFile', () => {
	it('POSTs to /files/{id}/copy with destination parent and name', async () => {
		fetchMock.mockResolvedValue(fakeResponse(true, { id: 'copy1', name: 'song.mp3', mimeType: 'audio/mpeg' }));
		const result = await copyGoogleDriveFile({
			accessToken: 'tok', fileId: 'f1', parentFolderId: 'dest', name: 'song.mp3',
		});
		expect(result.id).toBe('copy1');
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe('https://www.googleapis.com/drive/v3/files/f1/copy?fields=id,name,mimeType');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body)).toEqual({ parents: ['dest'], name: 'song.mp3' });
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
	});

	it('throws on a non-ok response', async () => {
		fetchMock.mockResolvedValue(fakeResponse(false, null, 403));
		await expect(copyGoogleDriveFile({ accessToken: 't', fileId: 'f', parentFolderId: 'd' }))
			.rejects.toThrow();
	});
});

describe('moveGoogleDriveFile', () => {
	it('PATCHes the file to replace its parents with the destination folder', async () => {
		fetchMock.mockResolvedValue(fakeResponse(true, { id: 'f1', name: 'a.mp3', parents: ['dest'] }));
		const result = await moveGoogleDriveFile({ accessToken: 'tok', fileId: 'f1', newParentFolderId: 'dest' });
		expect(result.id).toBe('f1');
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toContain('/drive/v3/files/f1');
		expect(String(url)).toContain('fields=id,name,parents');
		expect(init.method).toBe('PATCH');
		expect(JSON.parse(init.body)).toEqual({ parents: ['dest'] });
	});
});

describe('trashGoogleDriveFile', () => {
	it('PATCHes the file with trashed:true', async () => {
		fetchMock.mockResolvedValue(fakeResponse(true, { id: 'f1', name: 'a.mp3', trashed: true }));
		const result = await trashGoogleDriveFile({ accessToken: 'tok', fileId: 'f1' });
		expect(result.trashed).toBe(true);
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toContain('/drive/v3/files/f1');
		expect(init.method).toBe('PATCH');
		expect(JSON.parse(init.body)).toEqual({ trashed: true });
	});
});

describe('uniqueFileName (auto-rename on clash)', () => {
	it('returns the name unchanged when there is no clash', () => {
		expect(uniqueFileName('song.mp3', ['other.mp3', 'voice.wav'])).toBe('song.mp3');
	});
	it('appends (1) on a clash', () => {
		expect(uniqueFileName('song.mp3', ['song.mp3'])).toBe('song (1).mp3');
	});
	it('increments on repeated clashes', () => {
		expect(uniqueFileName('song.mp3', ['song.mp3', 'song (1).mp3'])).toBe('song (2).mp3');
	});
	it('keeps the extension outside the suffix', () => {
		expect(uniqueFileName('song.flac', ['song.flac'])).toBe('song (1).flac');
	});
});
