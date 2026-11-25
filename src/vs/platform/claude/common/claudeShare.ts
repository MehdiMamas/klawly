/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { removeClaudeSecrets, scanClaudeSecrets } from './claudeSecretScan.js';

/**
 * Sharing a chat (issue 490). Copy Chat as Markdown puts the redacted transcript
 * on the clipboard. Share Link, off until this setting is on, publishes the same
 * Markdown as a secret GitHub gist through the user's own GitHub CLI: there is no
 * Klawly server, and a secret gist is unlisted but readable by anyone with the link.
 */
export const CLAUDE_SHARE_LINKS_SETTING = 'claude.share.links';

export interface ClaudeGistRequest {
	readonly filename: string;
	readonly description: string;
	readonly content: string;
}

export type ClaudeGistResult =
	| { readonly kind: 'created'; readonly url: string }
	| { readonly kind: 'failed'; readonly problem: 'ghMissing' | 'signedOut' | 'failed'; readonly message: string };

/** What a shared chat sends: the export with every secret the guard finds removed, and how many it removed. */
export function claudeShareContent(markdown: string): { readonly content: string; readonly removed: number } {
	return { content: removeClaudeSecrets(markdown), removed: scanClaudeSecrets(markdown).length };
}

/** A gist file name from the chat's title: letters, digits, dots and dashes, at most 60 characters, ending in `.md`. */
export function claudeGistFilename(title: string): string {
	const base = title.replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'klawly-chat';
	return `${base}.md`;
}

/** `gh gist create` makes a secret gist unless `--public` is passed, and Klawly never passes it. The content goes on stdin. */
export function claudeGistArgs(request: ClaudeGistRequest): string[] {
	return ['gist', 'create', '--filename', claudeGistFilename(request.filename.replace(/\.md$/, '')), '--desc', request.description.replace(/[\r\n]+/g, ' ').slice(0, 200), '-'];
}

/** The gist's URL from what `gh gist create` printed: its last https://gist.github.com line. */
export function readClaudeGistUrl(stdout: string): string | undefined {
	return stdout.split(/\r?\n/).map(line => line.trim()).reverse().find(line => /^https:\/\/gist\.github\.com\/[\w./-]+$/.test(line));
}

export type ClaudeGistReadResult =
	| { readonly kind: 'read'; readonly content: string }
	| { readonly kind: 'failed'; readonly problem: 'ghMissing' | 'signedOut' | 'failed'; readonly message: string };

/** The gist id from a pasted gist link or a bare id (issue 684); undefined when it is neither. Only gist.github.com links count. */
export function parseClaudeGistId(text: string): string | undefined {
	const value = text.trim();
	const link = /^https:\/\/gist\.github\.com\/(?:[\w-]+\/)?(?<id>[0-9a-f]{8,40})(?:[/?#].*)?$/i.exec(value);
	return link?.groups?.id ?? (/^[0-9a-f]{20,40}$/i.test(value) ? value : undefined);
}

/** `gh gist view <id> --raw` prints the gist's first file. */
export function claudeGistReadArgs(id: string): string[] {
	return ['gist', 'view', id, '--raw'];
}
