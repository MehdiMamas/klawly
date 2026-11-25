/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What a Canvas page may load (issue 493): its own inline scripts and styles,
 * and images, fonts and media from data: and blob: URIs. No network, no frames,
 * no forms that post anywhere.
 */
export const CLAUDE_CANVAS_CSP = [
	`default-src 'none'`,
	`script-src 'unsafe-inline'`,
	`style-src 'unsafe-inline'`,
	`img-src data: blob:`,
	`font-src data:`,
	`media-src data: blob:`,
	`form-action 'none'`,
	`base-uri 'none'`,
].join('; ');

/**
 * The page a Canvas tab shows: the file as Claude wrote it, with the sealed CSP
 * first, before anything in the file can run. A second policy in the file can
 * only narrow it, never widen it.
 */
export function claudeCanvasDocument(html: string): string {
	const meta = `<meta http-equiv="Content-Security-Policy" content="${CLAUDE_CANVAS_CSP}">`;
	const doctype = /^\uFEFF?\s*<!doctype[^>]*>/i.exec(html);
	return doctype
		? `${doctype[0]}${meta}${html.slice(doctype[0].length)}`
		: `<!DOCTYPE html>${meta}${html}`;
}

/**
 * The page as a file to hand to someone else (issue 885): the sealed policy is
 * written into it, so it stays sealed wherever it is opened. A file that carries
 * the policy already (an export exported again) is returned as it is.
 */
export function claudeCanvasStandalone(html: string): string {
	return html.includes(`content="${CLAUDE_CANVAS_CSP}"`) ? html : claudeCanvasDocument(html);
}
