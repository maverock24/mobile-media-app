#!/usr/bin/env node
/**
 * Run only the unit tests a change can affect.
 *
 *   pnpm test:changed              # uncommitted changes (against HEAD)
 *   pnpm test:changed origin/main  # everything since a ref
 *   pnpm test:changed --full       # skip scoping, run the whole suite
 *
 * Selection comes from `vitest related`, which reads Vite's real module graph,
 * so there is no hand-maintained source-to-test map to drift. Dynamic
 * `await import('$lib/...')` inside a test body is tracked too.
 *
 * A scoped run must never be green having executed nothing: when a changed
 * file has no unit test covering it, this falls back to the full suite and
 * says why. View and route changes have no unit coverage by design, and this
 * script does not run the Playwright suite: use `pnpm check:boot` for that.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const forceFull = args.includes('--full');
const help = args.includes('--help') || args.includes('-h');
const ref = args.find((arg) => !arg.startsWith('-')) ?? 'HEAD';

if (help) {
	console.log('Usage: pnpm test:changed [ref] [--full]');
	process.exit(0);
}

function git(gitArgs) {
	return execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' });
}

/** Vitest's `include` patterns from vite.config.ts, as a file walk. */
function countTestFiles() {
	const matches = (name) => /\.(test|spec)\.(ts|js)$/.test(name);
	let count = 0;
	const walk = (dir) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== 'node_modules') walk(path);
			} else if (matches(entry.name)) {
				count += 1;
			}
		}
	};
	walk(join(ROOT, 'src'));
	walk(join(ROOT, 'tests/unit'));
	return count;
}

function vitestBinary() {
	const local = join(ROOT, 'node_modules/.bin/vitest');
	return existsSync(local) ? local : 'vitest';
}

function runVitest(vitestArgs) {
	return spawnSync(vitestBinary(), vitestArgs, { cwd: ROOT, stdio: 'inherit' }).status ?? 1;
}

const totalTestFiles = countTestFiles();

try {
	git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
} catch {
	console.error(`[test:changed] unknown git ref: ${ref}`);
	process.exit(2);
}

// Committed-and-working-tree changes against the ref, plus untracked files.
// Deleted files are skipped: there is nothing left for `vitest related` to
// resolve, and their tests are already in the graph of whatever replaced them.
const changed = [
	...git(['diff', '--name-only', '--diff-filter=ACMR', ref]).split('\n'),
	...git(['ls-files', '--others', '--exclude-standard']).split('\n')
]
	.filter((file) => file.startsWith('src/'))
	.filter((file) => existsSync(join(ROOT, file)));

const unique = [...new Set(changed)].sort();

if (unique.length === 0 && !forceFull) {
	console.log(`[test:changed] no source changes against ${ref}; nothing to run.`);
	process.exit(0);
}

if (forceFull) {
	console.log(`[test:changed] --full: running all ${totalTestFiles} test files.`);
	process.exit(runVitest(['run']));
}

console.log(`[test:changed] ${unique.length} changed source file(s) against ${ref}:`);
for (const file of unique) console.log(`  - ${file}`);

const reportPath = join(tmpdir(), `test-changed-${process.pid}.json`);
rmSync(reportPath, { force: true });

const status = runVitest([
	'related',
	...unique,
	'--reporter=default',
	'--reporter=json',
	`--outputFile.json=${reportPath}`
]);

let ranFiles = null;
try {
	ranFiles = JSON.parse(readFileSync(reportPath, 'utf8')).testResults.length;
} catch {
	// No readable report means we cannot prove what ran.
	ranFiles = null;
} finally {
	rmSync(reportPath, { force: true });
}

if (ranFiles === 0) {
	console.log('');
	console.log('[test:changed] No unit test imports the changed files, so the scoped run executed nothing.');
	console.log(`[test:changed] Falling back to the full unit suite (${totalTestFiles} test files).`);
	console.log('[test:changed] View and route changes are covered by Playwright: pnpm check:boot');
	process.exit(runVitest(['run']));
}

if (ranFiles === null) {
	console.log('[test:changed] Could not read the run report, so the scoped selection is unproven.');
	process.exit(1);
}

console.log(`[test:changed] ran ${ranFiles} of ${totalTestFiles} test files.`);
process.exit(status);
