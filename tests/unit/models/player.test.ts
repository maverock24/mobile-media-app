import { describe, it, expect, vi } from 'vitest';
import { createPlayer, type Player, type PlayerState } from '$lib/audio/player.svelte';
import type { StoredAudioFile } from '$lib/models/music';
import { musicSettings } from '$lib/stores/settings.svelte';

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

	it('reads the live selection-loop getter, not the snapshot from play()', async () => {
		let loop = false;
		const { player, audio, state } = makePlayer({
			settings: {
				lastTrackIndex: 0, lastTrackKey: '', lastTrackTimestamp: 0,
				isRepeat: true, isShuffle: false, rewindOnPrev: false, sortOrder: 'name',
			},
			isSelectionLoop: () => loop,
		});
		// The queue was loaded as a selection loop, but the MiniPlayer turned the
		// live flag off again: the getter is the source of truth.
		await player.play([mkSrc('a.mp3', 'a'), mkSrc('b.mp3', 'b')], 0, { selectionLoop: true });
		await flush();

		audio.currentTime = 10;
		audio.emit('ended');
		await flush();
		expect(state.currentIndex).toBe(0);
		expect(audio.currentTime).toBe(0);

		// Live flag on: the loop wins over repeat-one and the queue advances.
		loop = true;
		audio.emit('ended');
		await flush();
		expect(state.currentIndex).toBe(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Queue generation. A URL can land after the queue it was resolved for is gone
// (the user picked another folder while a Drive file was still downloading), so
// the module must not write it into the replacement queue.
// ─────────────────────────────────────────────────────────────────────────────
describe('player — in-flight resolves vs queue replacement', () => {
	it('drops a URL that resolved after the queue was replaced', async () => {
		const { player, state, resolveUrl } = makePlayer();
		const pending: Array<(url: string | null) => void> = [];
		resolveUrl.mockImplementation(() => new Promise<string | null>((resolve) => { pending.push(resolve); }));

		// The first queue's resolve is still in flight when the queue is replaced.
		const firstPlay = player.play([mkSrc('a.mp3', 'a')], 0);
		await flush();
		expect(pending).toHaveLength(1);

		player.load([mkSrc('b.mp3', 'b')], { startIndex: 0 });

		// The URL for 'a.mp3' arrives only now, after the replacement.
		pending[0]('blob:a.mp3');
		await firstPlay;
		await flush();

		expect(state.tracks.map((t) => t.filename)).toEqual(['b.mp3']);
		// The replacement queue's slot stays empty: no stale URL, no orphan blob.
		expect(state.tracks[0].url).toBe('');
		expect(state.tracks[0].cleanup).toBeUndefined();
	});

	it('keeps an in-flight resolve alive when files are appended', async () => {
		const { player, state, resolveUrl } = makePlayer();
		const pending: Array<(url: string | null) => void> = [];
		resolveUrl.mockImplementation(() => new Promise<string | null>((resolve) => { pending.push(resolve); }));

		const playing = player.play([mkSrc('a.mp3', 'a')], 0);
		await flush();

		// A streaming folder scan appends while 'a.mp3' is still resolving: this is
		// not a queue replacement, so its URL must still be adopted.
		player.append([mkSrc('b.mp3', 'b')]);
		pending[0]('blob:a.mp3');
		await playing;
		await flush();

		expect(state.tracks.map((t) => t.filename)).toEqual(['a.mp3', 'b.mp3']);
		expect(state.tracks.find((t) => t.filename === 'a.mp3')?.url).toBe('blob:a.mp3');
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

// ─────────────────────────────────────────────────────────────────────────────
// Skip results. The view claims the audio channel (stopping a YouTube panel or
// a podcast) only when the skip actually changes track and begins playback; the
// module reports that through next()/prev()'s resolved value.
// ─────────────────────────────────────────────────────────────────────────────
describe('player — skip results', () => {
	it('next resolves true when it changes track and begins playback', async () => {
		const { player, state } = makePlayer();
		await player.play([mkSrc('a.mp3', 'a'), mkSrc('b.mp3', 'b')], 0);
		await flush();

		await expect(player.next()).resolves.toBe(true);
		expect(state.currentIndex).toBe(1);
	});

	it('prev resolves true when it changes track and begins playback', async () => {
		const { player, state } = makePlayer();
		await player.play([mkSrc('a.mp3', 'a'), mkSrc('b.mp3', 'b')], 1);
		await flush();

		await expect(player.prev()).resolves.toBe(true);
		expect(state.currentIndex).toBe(0);
	});

	it('next resolves false when every track is broken', async () => {
		const { player, resolveUrl } = makePlayer();
		resolveUrl.mockResolvedValue(null);
		player.load([mkSrc('a.mp3', 'a'), mkSrc('b.mp3', 'b')], { startIndex: 0 });

		await expect(player.next()).resolves.toBe(false);
	});

	it('prev resolves false on the rewind-in-place branch', async () => {
		const { player, audio, state } = makePlayer({
			settings: {
				lastTrackIndex: 0, lastTrackKey: '', lastTrackTimestamp: 0,
				isRepeat: false, isShuffle: false, rewindOnPrev: true, sortOrder: 'name',
			},
		});
		await player.play([mkSrc('a.mp3', 'a'), mkSrc('b.mp3', 'b')], 0);
		await flush();
		audio.currentTime = 5;

		await expect(player.prev()).resolves.toBe(false);
		expect(state.currentIndex).toBe(0);
		expect(audio.currentTime).toBe(0);
	});

	it('prev from a paused deck loads the src without beginning playback', async () => {
		const { player, audio, state } = makePlayer();
		player.load([mkSrc('a.mp3', 'a'), mkSrc('b.mp3', 'b')], { startIndex: 1 });
		const playsBefore = audio.playCalls;

		await expect(player.prev()).resolves.toBe(false);
		expect(state.currentIndex).toBe(0);
		expect(state.tracks[0].url).toBe('blob:a.mp3');
		expect(audio.playCalls).toBe(playsBefore);
	});

	it('prev resolves false at the end of an empty queue', async () => {
		const { player } = makePlayer();
		await expect(player.prev()).resolves.toBe(false);
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

// ─────────────────────────────────────────────────────────────────────────────
// Queue API the view drives (ADR-0001 PR 2). The view hands whole file lists
// over and never touches the element itself, so these cover the seams the
// migration relies on: queue replacement without playback, append during a
// streaming folder scan, stopping while keeping the queue for cross-source
// exclusivity, favourites order, the selection-loop refresh hook, the per-deck
// element controls, and the object-URL cleanup path.
// ─────────────────────────────────────────────────────────────────────────────
describe('player — load (queue without playback)', () => {
	it('replaces the queue, selects startIndex and leaves the element running', async () => {
		const { player, audio, state, settings } = makePlayer();
		await player.play([mkSrc('a.mp3', 'a'), mkSrc('b.mp3', 'b')], 0);
		await flush();
		const pauseSpy = vi.spyOn(audio, 'pause');
		const srcBefore = audio.src;

		player.load([mkSrc('c.mp3', 'c'), mkSrc('d.mp3', 'd')], { startIndex: 1 });

		expect(state.tracks.map((t) => t.filename)).toEqual(['c.mp3', 'd.mp3']);
		expect(state.currentIndex).toBe(1);
		expect(settings.lastTrackIndex).toBe(1);
		expect(settings.lastTrackKey).toBeTruthy();
		expect(pauseSpy).not.toHaveBeenCalled();
		expect(audio.src).toBe(srcBefore);
	});

	it('keepCurrent keeps the selected track selected across a rebuild', async () => {
		const { player, state } = makePlayer();
		await player.play([mkSrc('a.mp3', 'a'), mkSrc('b.mp3', 'b'), mkSrc('c.mp3', 'c')], 1);
		await flush();
		expect(state.tracks[state.currentIndex].filename).toBe('b.mp3');

		// 'b' moved to the end of the new queue: the index must follow the file.
		player.load([mkSrc('a.mp3', 'a'), mkSrc('c.mp3', 'c'), mkSrc('b.mp3', 'b')], {
			selectionLoop: true,
			keepCurrent: true,
		});
		expect(state.currentIndex).toBe(2);
		expect(state.tracks[2].filename).toBe('b.mp3');

		// ... and when the selected track is gone, the queue falls back to the first.
		player.load([mkSrc('x.mp3', 'x'), mkSrc('y.mp3', 'y')], { selectionLoop: true, keepCurrent: true });
		expect(state.currentIndex).toBe(0);
	});

	it('clear drops the queue, unloads the element and releases its URLs', async () => {
		const { player, audio, state } = makePlayer();
		await player.play([mkSrc('a.mp3', 'a')], 0);
		await flush();

		player.clear();

		expect(state.tracks).toHaveLength(0);
		expect(state.currentIndex).toBe(-1);
		expect(audio.src).toBe('');
	});
});

describe('player — append', () => {
	it('merges new files, keeps loaded URLs and re-points the selected index', async () => {
		const { player, state } = makePlayer();
		await player.play([mkSrc('b.mp3', 'b'), mkSrc('c.mp3', 'c')], 0);
		await flush();
		const preloadedUrl = state.tracks.find((t) => t.filename === 'c.mp3')?.url;
		expect(preloadedUrl).toBe('blob:c.mp3');

		player.append([mkSrc('a.mp3', 'a')]);

		expect(state.tracks.map((t) => t.filename)).toEqual(['a.mp3', 'b.mp3', 'c.mp3']);
		expect(state.tracks.find((t) => t.filename === 'c.mp3')?.url).toBe(preloadedUrl);
		expect(state.tracks[state.currentIndex].filename).toBe('b.mp3');
	});

	it('ignores files that are already queued', async () => {
		const { player, state } = makePlayer();
		await player.play([mkSrc('a.mp3', 'a')], 0);
		await flush();

		player.append([mkSrc('a.mp3', 'a')]);

		expect(state.tracks).toHaveLength(1);
	});
});

describe('player — stop and resume (cross-source exclusivity)', () => {
	it('stop unloads the element but keeps the queue, so resume restarts the track', async () => {
		const { player, audio, state } = makePlayer();
		await player.play([mkSrc('a.mp3', 'a'), mkSrc('b.mp3', 'b')], 0);
		await flush();
		const playsBefore = audio.playCalls;

		player.stop();

		expect(audio.src).toBe('');
		expect(state.tracks).toHaveLength(2);
		expect(state.isPlaying).toBe(false);
		expect(state.isBuffering).toBe(false);

		await player.resume();
		await flush();

		expect(audio.src).toBe('blob:a.mp3');
		expect(audio.playCalls).toBeGreaterThan(playsBefore);
	});

	it('resume starts the selected track of a queue that was only loaded', async () => {
		const { player, audio, state } = makePlayer();
		player.load([mkSrc('a.mp3', 'a'), mkSrc('b.mp3', 'b')], { startIndex: 1 });
		expect(audio.src).toBe('');

		await player.resume();
		await flush();

		expect(audio.src).toBe('blob:b.mp3');
		expect(state.currentIndex).toBe(1);
	});

	it('clears the buffering state when resume cannot resolve a URL', async () => {
		const { player, state, resolveUrl } = makePlayer();
		resolveUrl.mockResolvedValue(null);
		player.load([mkSrc('a.mp3', 'a')], { startIndex: 0 });

		await player.resume();
		await flush();

		// The "Loading track…" overlay must not stick on a failed resolve.
		expect(state.isBuffering).toBe(false);
		expect(state.isPlaying).toBe(false);
	});

	it('clears a stale buffering flag when the queue is replaced mid-resolve', async () => {
		const { player, state, resolveUrl } = makePlayer();
		const pending: Array<(url: string | null) => void> = [];
		resolveUrl.mockImplementation(() => new Promise<string | null>((resolve) => { pending.push(resolve); }));

		player.load([mkSrc('a.mp3', 'a')], { startIndex: 0 });
		const resuming = player.resume();
		await flush();
		// The overlay is up while the selected track materializes.
		expect(state.isBuffering).toBe(true);

		// The listener picks another folder: the replacement owns the state now, and
		// the superseded resume must not be able to clear the flag itself.
		player.load([mkSrc('b.mp3', 'b')], { startIndex: 0 });
		expect(state.isBuffering).toBe(false);

		// The stale URL lands after the replacement and is dropped.
		pending[0]('blob:a.mp3');
		await resuming;
		await flush();
		expect(state.isBuffering).toBe(false);
		expect(state.isPlaying).toBe(false);
	});
});

describe('player — queue options', () => {
	it('preserveOrder keeps the caller order (favourites list)', async () => {
		const { player, state } = makePlayer();
		await player.play([mkSrc('z.mp3', 'z'), mkSrc('a.mp3', 'a')], 1, { preserveOrder: true });
		await flush();

		expect(state.tracks.map((t) => t.filename)).toEqual(['z.mp3', 'a.mp3']);
		expect(state.currentIndex).toBe(1);
		expect(state.tracks[1].filename).toBe('a.mp3');
	});

	it('calls onBeforeAdvance before reading the next index', async () => {
		let playerRef: Player | null = null;
		const onBeforeAdvance = vi.fn(() => {
			// What the view does: rebuild the queue from a changed loop selection.
			playerRef?.load([mkSrc('x.mp3', 'x'), mkSrc('y.mp3', 'y')], { startIndex: 0 });
		});
		const { player, audio, state } = makePlayer({ onBeforeAdvance });
		playerRef = player;
		await player.play([mkSrc('a.mp3', 'a'), mkSrc('b.mp3', 'b')], 0);
		await flush();

		audio.emit('ended');
		await flush();

		expect(onBeforeAdvance).toHaveBeenCalled();
		// The advance ran against the rebuilt queue, not the stale one.
		expect(state.tracks.map((t) => t.filename)).toEqual(['x.mp3', 'y.mp3']);
		expect(state.currentIndex).toBe(1);
	});
});

describe('player — element controls', () => {
	it('follows volume, mute and rate changes on the reactive controls', async () => {
		const before = {
			volume: musicSettings.deckBVolume,
			muted: musicSettings.isMuted,
			speed: musicSettings.deckBSpeed,
		};
		try {
			musicSettings.deckBVolume = 40;
			musicSettings.isMuted = false;
			musicSettings.deckBSpeed = 1.25;
			const { audio } = makePlayer({
				controls: {
					get volume() { return musicSettings.deckBVolume; },
					get muted() { return musicSettings.isMuted; },
					get playbackRate() { return musicSettings.deckBSpeed; },
				},
			});
			await flush();

			expect(audio.volume).toBeCloseTo(0.4);
			expect(audio.muted).toBe(false);
			expect(audio.playbackRate).toBeCloseTo(1.25);

			// The sliders write the store, so the element must follow live.
			musicSettings.deckBVolume = 5;
			musicSettings.isMuted = true;
			musicSettings.deckBSpeed = 0.5;
			await flush();

			expect(audio.volume).toBeCloseTo(0.05);
			expect(audio.muted).toBe(true);
			expect(audio.playbackRate).toBeCloseTo(0.5);
		} finally {
			musicSettings.deckBVolume = before.volume;
			musicSettings.isMuted = before.muted;
			musicSettings.deckBSpeed = before.speed;
			await flush();
		}
	});
});

describe('player — URL cleanup', () => {
	it('runs the queued track cleanup when the module releases its URL', async () => {
		const { player, audio, state } = makePlayer();
		await player.play([mkSrc('a.mp3', 'a'), mkSrc('b.mp3', 'b')], 0);
		await flush();
		// This is what the view's resolver sets on the queued track.
		const cleanup = vi.fn();
		state.tracks[0].cleanup = cleanup;

		audio.emit('ended');
		await flush();

		expect(cleanup).toHaveBeenCalled();
	});
});
