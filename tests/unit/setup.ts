/**
 * Vitest global setup.
 *  - fake-indexeddb: installed on the global scope so src/lib/utils/idb.ts
 *    (and any IDB-touching code) works under jsdom without a real browser.
 *  - AudioContext stub: jsdom has no Web Audio; equalizer/store tests that
 *    build filter chains get a minimal stand-in.
 */
import 'fake-indexeddb/auto';

// Minimal AudioContext stub for tests touching Web Audio (equalizer, mediaEngine).
class FakeAudioParam {
	value = 0;
	setValueAtTime(_v: number, _t: number) { /* no-op */ }
}
class FakeAudioNode {
	connect(_target: unknown) { return _target; }
	disconnect() { /* no-op */ }
}
class FakeBiquadFilter extends FakeAudioNode {
	type = 'peaking';
	frequency = new FakeAudioParam();
	gain = new FakeAudioParam();
	Q = new FakeAudioParam();
}
class FakeAudioContext {
	state: AudioContextState = 'running';
	destination = new FakeAudioNode();
	createBiquadFilter() { return new FakeBiquadFilter(); }
	createMediaElementSource(_el: unknown) { return new FakeAudioNode(); }
	createGain() { return new FakeAudioNode(); }
	resume() { return Promise.resolve(); }
	close() { return Promise.resolve(); }
	addEventListener() { /* no-op */ }
	removeEventListener() { /* no-op */ }
}

// @ts-expect-error — install a stub where Web Audio is unavailable under jsdom.
(globalThis as { AudioContext: typeof FakeAudioContext }).AudioContext = FakeAudioContext;
// Some code reads the prefixed name defensively.
(globalThis as { webkitAudioContext?: typeof FakeAudioContext }).webkitAudioContext = FakeAudioContext;
