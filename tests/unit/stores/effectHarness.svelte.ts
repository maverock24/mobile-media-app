/**
 * Runs one function inside an `$effect`, exactly the way a component view
 * registers things (`$effect(() => register...(…))` in `Mp3PlayerView`).
 *
 * Lives in a `.svelte.ts` file because the runes are only compiled there; a
 * plain `.test.ts` cannot call `$effect.root`. The caller drives the flush with
 * `await tick()` + `flushSync()`, because an effect created outside a component
 * is scheduled for the next batch rather than run eagerly.
 */
export function runInEffect(fn: () => void | (() => void)): { destroy: () => void } {
	return {
		destroy: $effect.root(() => {
			$effect(() => fn());
		}),
	};
}
