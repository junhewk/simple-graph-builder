#!/usr/bin/env node
/**
 * Test runner.
 *
 * There is no test framework here on purpose: the plugin ships its whole
 * bundle, and esbuild is already a dev dependency. Each *.test.ts is bundled
 * with `obsidian` aliased to a stub that captures outgoing requests, then run.
 * A file passes if it exits 0.
 *
 * These are wire-level tests. They assert the exact JSON each provider adapter
 * builds, because that is where the bugs were: parameters a model rejects,
 * results dropped from a tool loop, embeddings written at the wrong width.
 *
 *   npm test              run everything
 *   npm test -- gemini    run files matching a substring
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] ?? '';
const outDir = mkdtempSync(join(tmpdir(), 'sgb-tests-'));

const files = readdirSync(here)
	.filter((f) => f.endsWith('.test.ts'))
	.filter((f) => f.includes(filter))
	.sort();

if (files.length === 0) {
	console.error(filter ? `No test files match "${filter}".` : 'No test files found.');
	process.exit(1);
}

let failed = 0;

for (const file of files) {
	const name = file.replace('.test.ts', '');
	const bundle = join(outDir, `${name}.cjs`);

	try {
		execFileSync(
			'npx',
			[
				'esbuild',
				join(here, file),
				'--bundle',
				'--platform=node',
				'--format=cjs',
				`--alias:obsidian=${join(here, 'obsidian-stub.ts')}`,
				`--outfile=${bundle}`,
				'--log-level=error',
			],
			{ stdio: ['ignore', 'ignore', 'inherit'] }
		);
	} catch {
		console.error(`${name.padEnd(12)} BUILD FAILED`);
		failed++;
		continue;
	}

	try {
		// stderr is piped, not inherited: several suites deliberately exercise
		// paths that warn (downgrade retries, dropped schema violations), and
		// that output is expected rather than interesting on a passing run.
		const out = execFileSync('node', [bundle], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const summary = out.trim().split('\n').at(-1) ?? '';
		console.log(`${name.padEnd(12)} ${summary}`);
	} catch (e) {
		console.error(`${name.padEnd(12)} FAILED`);
		// Surface only the failing assertions, not the whole log.
		const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
		for (const line of out.split('\n')) {
			if (line.startsWith('FAIL') || line.includes('FAILURES')) console.error(`  ${line}`);
		}
		failed++;
	}
}

rmSync(outDir, { recursive: true, force: true });

console.log();
console.log(failed === 0 ? `All ${files.length} suites passed.` : `${failed} of ${files.length} suites FAILED.`);
process.exit(failed === 0 ? 0 : 1);
