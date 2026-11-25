/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** How far inside the timeline's top and bottom edges, in pixels, a selecting drag starts to scroll. */
export const SELECTION_SCROLL_EDGE = 16;

/** The most a selecting drag scrolls the timeline in one frame, in pixels. */
export const SELECTION_SCROLL_MAX_STEP = 28;

/**
 * How many pixels a selecting drag scrolls the timeline this frame (issue 468): none while the
 * pointer is clear of the edges, and more the further it goes past one, up to
 * `SELECTION_SCROLL_MAX_STEP`. Negative scrolls up.
 */
export function selectionScrollStep(pointerY: number, top: number, bottom: number): number {
	const above = top + SELECTION_SCROLL_EDGE - pointerY;
	if (above > 0) {
		return -Math.min(SELECTION_SCROLL_MAX_STEP, Math.ceil(above / 3));
	}
	const below = pointerY - (bottom - SELECTION_SCROLL_EDGE);
	if (below > 0) {
		return Math.min(SELECTION_SCROLL_MAX_STEP, Math.ceil(below / 3));
	}
	return 0;
}

/**
 * Selected chat text as a Markdown quote for the composer (Quote in Reply, issue 468). Blank
 * lines at either end are dropped and Windows line ends are normalized; an empty selection
 * gives an empty string.
 */
export function quoteForReply(text: string): string {
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	while (lines.length && !lines[0].trim()) {
		lines.shift();
	}
	while (lines.length && !lines[lines.length - 1].trim()) {
		lines.pop();
	}
	if (!lines.length) {
		return '';
	}
	return lines.map(line => line.trim() ? `> ${line.trimEnd()}` : '>').join('\n') + '\n\n';
}
