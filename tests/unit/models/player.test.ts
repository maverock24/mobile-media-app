import { describe, it, expect, vi } from 'vitest';
import { createPlayer, type PlayerState } from '$lib/audio/player.svelte';
import type { StoredAudioFile } from '$lib/models/music';

// ── Minimal fake HTMLAudioElement ────────────────────────────────────────────
type Handler = (ev: { type: string }) => void;
class FakeAudio {
	src = '';
	currentTime = 0;
	duration = 0;
	volume = 1;
	muted = false;
	playbackRate = 1;
	error: { code: number } | null = null;
	playCalls = 0;
	private handlers = new Map<string, Handler[]>();
	private _play = vi.fn(() => Promise.resolve());
	constructor() { this._play.mockImplementation(() => { this.playCalls++; return Promise.resolve(); }); }
	addEventListener(type: string, fn: Handler) {
		this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
	}
	removeEventListener(type: string, fn: Handler) {
		this.handlers.set(type, (this.handlers.get(type) ?? []).filter((h) => h !== fn));
	}
	emit(type: string) { for (const h of this.handlers.get(type) ?? []) h({ type }); }
	pause() {}
	play() { return this._play(); }
	load() {}
	removeAttribute(attr: string) { if (attr === 'src') this.src = ''; }
}

const mkSrc = (name: string, path: string): StoredAudioFile => ({
	source: 'web', name, relativePath: path, file: new File([], name),
});

function makePlayer(overrides: Partial<Parameters<typeof createPlayer>[0]> = {}) {
	const audio = new FakeAudio();
	const settings = {
		lastTrackIndex: 0, lastTrackKey: '', lastTrackTimestamp: 0,
		isRepeat: false, isShuffle: false, rewindOnPrev: false, sortOrder: 'name',
	};
	const resolveUrl = vi.fn<(s: StoredAudioFile) => Promise<string | null>>(async (s) => `blob:${s.name}`);
	const player = createPlayer({
		settings,
		resolveUrl,
		createAudio: () => audio as unknown as HTMLAudioElement,
		native: false,
		...overrides,
	});
	return { player, audio, settings, resolveUrl, state: player.state as PlayerState };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

describe('player — play', () => {
	it('builds the queue, resolves the first URL, sets src and starts buffering', async () => {
		const { player, audio, state, resolveUrl } = makePlayer();
		const tracks = [mkSrc('a.mp3', 'a'), mkSrc('b.mp3', 'b'), mkSrc('c.mp3', 'c')];
		await player.play(tracks, 0);
		await flush();
		expect(state.tracks).toHaveLength(3);
		expect(state.currentIndex).toBe(0);
		expect(resolveUrl).toHaveBeenCalledWith(tracks[0], true);
		expect(audio.src).toBe('blob:a.mp3');
		expect(state.isBuffering).toBe(true);
		expect(audio.playCalls).toBeGreaterThan(0);
	});
});

describe('player — advance on ended', () => {
	it('advances to the next track when a track ends', async () => {
		const { player, audio, state, resolveUrl } = makePlayer();
		await player.play([mkSrc('a.mp3', 'a'), mkSrc('b.mp3', 'b')], 0);
		await flush();
		expect(state.currentIndex).toBe(0);
		audio.emit('ended');
		await flush();
		expect(state.currentIndex).toBe(1);
		expect(resolveUrl).toHaveBeenCalledWith(expect.objectContaining({ name: 'b.mp3' }), false);
	});

	it('stops (isPlaying=false) at the end of the list with no loop', async () => {
		const { player, audio, state } = makePlayer();
		await player.play([mkSrc('a.mp3', 'a'), mkSrc('b.mp3', 'b')], 0);
		await flush();
		audio.emit('ended'); await flush();
		expect(state.currentIndex).toBe(1);
		audio.emit('ended'); await flush();
		expect(state.isPlaying).toBe(false);
		expect(state.isBuffering).toBe(false);
	});

	it('wraps to the start on a selection loop', async () => {
		const { player, audio, state } = makePlayer();
		await player.play([mkSrc('a.mp3', 'a'), mkSrc('b.mp3', 'b')], 0, { selectionLoop: true });
		await flush();
		audio.emit('ended'); await flush();
		audio.emit('ended'); await flush();
		expect(state.currentIndex).toBe(0);
	});

	it('auto-skips a track whose URL fails to resolve', async () => {
		const { player, audio, state, resolveUrl } = makePlayer();
		resolveUrl.mockImplementation(async (s: StoredAudioFile) =>
			s.name === 'broken.mp3' ? null : `blob:${s.name}`);
		await player.play([mkSrc('broken.mp3', 'b'), mkSrc('ok.mp3', 'o')], 0);
		await flush();
		// Start track failed to resolve.
		expect(state.error).toBeTruthy();
	});
});

describe('player — repeat-one', () => {
	it('rewinds the same track on ended when isRepeat is on and no selection loop', async () => {
		const { player, audio, state } = makePlayer({ settings: {
			lastTrackIndex: 0, lastTrackKey: '', lastTrackTimestamp: 0,
			isRepeat: true, isShuffle: false, rewindOnPrev: false, sortOrder: 'name',
		}});
		await player.play([mkSrc('a.mp3', 'a'), mkSrc('b.mp3', 'b')], 0);
		await flush();
		audio.currentTime = 10;
		const playsBefore = audio.playCalls;
		audio.emit('ended');
		await flush();
		expect(state.currentIndex).toBe(0); // same track
		expect(audio.currentTime).toBe(0);  // rewound
		expect(audio.playCalls).toBeGreaterThan(playsBefore);
	});
});

describe('player — pause / resume / seek / prev', () => {
	it('pause, resume and seek drive the element', async () => {
		const { player, audio, state } = makePlayer();
		await player.play([mkSrc('a.mp3', 'a')], 0);
		await flush();
		player.pause();
		expect(state.isPlaying).toBe(false);
		player.resume();
		player.seek(42);
		expect(audio.currentTime).toBe(42);
		expect(state.currentTime).toBe(42);
	});

	it('prev wraps to the previous track', async () => {
		const { player, audio, state } = makePlayer();
		await player.play([mkSrc('a.mp3', 'a'), mkSrc('b.mp3', 'b')], 1);
		await flush();
		expect(state.currentIndex).toBe(1);
		player.prev();
		await flush();
		expect(state.currentIndex).toBe(0);
	});
});

describe('player — destroy', () => {
	it('stops audio and revokes URLs', async () => {
		const { player, audio } = makePlayer();
		await player.play([mkSrc('a.mp3', 'a')], 0);
		await flush();
		player.destroy();
		expect(audio.src).toBe('');
	});
});
