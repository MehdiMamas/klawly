/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Source maps never ship in Klawly (issue 548). Each release build saves them instead as a private
// release asset, `klawly-sourcemaps-<platform>-<arch>-<version>.zip` (package.yml), and this script
// turns a stack trace from a bug report or a Send Feedback log back into source lines.
// Usage:
//   node build/klawly/sourcemaps.ts collect <out folder, e.g. out-vscode-min> <zip>
//   node build/klawly/sourcemaps.ts decode <maps zip or folder> [stack trace file; stdin when absent]
// Download the maps of a release with:
//   gh release download <tag> -R MehdiMamas/klawly-ide -p "klawly-sourcemaps-*"

import { existsSync, readdirSync, readFileSync, statSync, createWriteStream } from 'fs';
import { join, relative, resolve } from 'path';
import { SourceMapConsumer, type RawSourceMap } from 'source-map';
import yauzl from 'yauzl';
import yazl from 'yazl';

/** Every `*.map` file under `folder`, as forward-slash paths relative to it. */
function listMaps(folder: string): string[] {
	const maps: string[] = [];
	const visit = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(full);
			} else if (entry.name.endsWith('.map')) {
				maps.push(relative(folder, full).replace(/\\/g, '/'));
			}
		}
	};
	visit(folder);
	return maps.sort();
}

/** Zips every source map of a build output folder; the paths in the zip match `out/` in the app. */
export async function collect(folder: string, zipFile: string): Promise<number> {
	const maps = listMaps(folder);
	if (!maps.length) {
		throw new Error(`No source maps under ${folder}`);
	}
	const zip = new yazl.ZipFile();
	for (const map of maps) {
		zip.addFile(join(folder, map), map);
	}
	zip.end();
	await new Promise<void>((done, fail) => {
		const output = createWriteStream(zipFile);
		output.on('close', () => done());
		output.on('error', fail);
		zip.outputStream.on('error', fail);
		zip.outputStream.pipe(output);
	});
	return maps.length;
}

/** Reads the maps from a zip or a folder, keyed by their path relative to `out/`. */
async function loadMaps(source: string): Promise<Map<string, string>> {
	const maps = new Map<string, string>();
	if (statSync(source).isDirectory()) {
		for (const map of listMaps(source)) {
			maps.set(map, readFileSync(join(source, map), 'utf8'));
		}
		return maps;
	}
	const zip = await new Promise<yauzl.ZipFile>((done, fail) => yauzl.open(source, { lazyEntries: true }, (error, file) => error || !file ? fail(error ?? new Error(`Cannot open ${source}`)) : done(file)));
	await new Promise<void>((done, fail) => {
		zip.on('error', fail);
		zip.on('end', () => done());
		zip.on('entry', (entry: yauzl.Entry) => {
			if (!entry.fileName.endsWith('.map')) {
				zip.readEntry();
				return;
			}
			zip.openReadStream(entry, (error, stream) => {
				if (error || !stream) {
					fail(error ?? new Error(`Cannot read ${entry.fileName}`));
					return;
				}
				const chunks: Buffer[] = [];
				stream.on('data', (chunk: Buffer) => chunks.push(chunk));
				stream.on('end', () => {
					maps.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
					zip.readEntry();
				});
			});
		});
		zip.readEntry();
	});
	return maps;
}

const frame = /(?<file>[^\s()'"]*?[\\/]out[\\/](?<path>[^\s()'":]+?\.js)):(?<line>\d+):(?<column>\d+)/g;

/** Rewrites each `.../out/<path>.js:<line>:<column>` in `trace` to its original source position. */
export function decodeTrace(trace: string, maps: ReadonlyMap<string, string>): string {
	const consumers = new Map<string, SourceMapConsumer | undefined>();
	const consumer = (path: string) => {
		if (!consumers.has(path)) {
			const raw = maps.get(`${path}.map`);
			consumers.set(path, raw ? new SourceMapConsumer(JSON.parse(raw) as RawSourceMap) : undefined);
		}
		return consumers.get(path);
	};
	return trace.replace(frame, (match, _file, path: string, line: string, column: string) => {
		const original = consumer(path.replace(/\\/g, '/'))?.originalPositionFor({ line: Number(line), column: Number(column) - 1 });
		if (!original?.source) {
			return match;
		}
		const source = original.source.replace(/^(\.\.\/)+/, '').replace(/^.*?\/src\/vs\//, 'src/vs/');
		return `${source}:${original.line}:${(original.column ?? 0) + 1}${original.name ? ` (${original.name})` : ''}`;
	});
}

async function main(): Promise<void> {
	const [command, first, second] = process.argv.slice(2);
	if (command === 'collect' && first && second) {
		const count = await collect(resolve(first), resolve(second));
		console.log(`[sourcemaps] ${count} maps from ${first} -> ${second} (${Math.round(statSync(second).size / 2 ** 20)} MB)`);
		return;
	}
	if (command === 'decode' && first && existsSync(first)) {
		const trace = second ? readFileSync(second, 'utf8') : readFileSync(0, 'utf8');
		process.stdout.write(decodeTrace(trace, await loadMaps(resolve(first))));
		return;
	}
	console.error('Usage:\n  node build/klawly/sourcemaps.ts collect <out folder> <zip>\n  node build/klawly/sourcemaps.ts decode <maps zip or folder> [trace file]');
	process.exit(2);
}

if (import.meta.main) {
	main().catch(error => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
