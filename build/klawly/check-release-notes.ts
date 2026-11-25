/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Fails when a bullet under `## What's new` in an alpha's release notes does not end with the
// issues it covers, such as `(#1190)` or `(#1190, #1201)` (docs/relay.md, Publishing an alpha).
//
// Usage: node build/klawly/check-release-notes.ts <tag>     reads the notes of that GitHub release
//        node build/klawly/check-release-notes.ts --file <notes.md>
// Env (tag form): GH_TOKEN or GITHUB_TOKEN, GITHUB_REPOSITORY (default MehdiMamas/klawly-ide).
// The Package workflow runs it for every alpha before it packages, so a bad note blocks the publish.

import { readFileSync } from 'fs';

const ISSUES_AT_END = /\(#\d+(?:,\s*#\d+)*\)[.\s]*$/;

/** The `## What's new` bullets that do not end with issue numbers. Continuation lines belong to their bullet. */
export function unlinkedBullets(notes: string): string[] {
	const bullets: string[] = [];
	let inSection = false;
	for (const line of notes.split(/\r?\n/)) {
		if (/^##\s/.test(line)) {
			inSection = /^##\s+What['’]s new\s*$/i.test(line);
		} else if (inSection && /^\s*[-*]\s/.test(line)) {
			bullets.push(line.trim().replace(/^[-*]\s+/, ''));
		} else if (inSection && bullets.length && /^\s+\S/.test(line)) {
			bullets[bullets.length - 1] += ' ' + line.trim();
		}
	}
	return bullets.filter(bullet => !ISSUES_AT_END.test(bullet));
}

export function hasWhatsNew(notes: string): boolean {
	return /^##\s+What['’]s new\s*$/im.test(notes);
}

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	let notes: string;
	if (args[0] === '--file' && args[1]) {
		notes = readFileSync(args[1], 'utf8');
	} else if (args[0] && !args[0].startsWith('-')) {
		const repo = process.env.GITHUB_REPOSITORY || 'MehdiMamas/klawly-ide';
		const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
		// The tag lookup (releases/tags/<tag>) skips drafts, and a release is a draft until its files are attached,
		// so the list is read and the tag found in it (as package.yml does).
		const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
			headers: { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) },
		});
		if (!response.ok) {
			console.error(`GET releases: ${response.status} ${await response.text()}`);
			return 2;
		}
		const release = ((await response.json()) as { tag_name: string; body: string | null }[]).find(item => item.tag_name === args[0]);
		if (!release) {
			console.error(`No release with tag ${args[0]}`);
			return 2;
		}
		notes = release.body ?? '';
	} else {
		console.error('Usage: node build/klawly/check-release-notes.ts <tag> | --file <notes.md>');
		return 2;
	}
	if (!hasWhatsNew(notes)) {
		console.error('The release notes have no "## What\'s new" section.');
		return 1;
	}
	const bad = unlinkedBullets(notes);
	if (bad.length) {
		console.error(`${bad.length} "What's new" bullet(s) do not end with their issue numbers, such as (#1190) or (#1190, #1201):`);
		for (const bullet of bad) {
			console.error(`  - ${bullet}`);
		}
		return 1;
	}
	console.log('Every "What\'s new" bullet ends with its issue numbers.');
	return 0;
}

if (import.meta.filename === process.argv[1]) {
	main().then(code => { process.exitCode = code; }, error => { console.error(error); process.exitCode = 2; });
}
