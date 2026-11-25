/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode, getTotalHeight } from '../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { claudeVerifyRecording, ClaudeVerifyEvidence, ClaudeVerifyShot, ClaudeVerifyShotLabel, isClaudeVerifyEvidenceEmpty } from '../../../../../platform/claude/common/claudeVerifyEvidence.js';

/**
 * What the Agent Browser collected while verifying a UI change (issue 1495): the
 * before and after screenshots, the frames of the recording and the console errors,
 * as a card between the summary and the findings. It hides without evidence.
 */
export class ClaudeReviewEvidenceCard extends Disposable {
	private readonly _node: HTMLElement;

	constructor(container: HTMLElement) {
		super();
		this._node = append(container, $('.claude-review-evidence-card.is-empty'));
		this._node.setAttribute('role', 'region');
		this._node.setAttribute('aria-label', localize('claudeReviewEvidenceRegion', "Verification Evidence"));
	}

	/** Height the card takes above the diff; 0 while it is hidden. */
	get height(): number {
		return this._node.classList.contains('is-empty') ? 0 : getTotalHeight(this._node);
	}

	/** Shows `evidence`; `undefined` or an empty one hides the card. */
	render(evidence: ClaudeVerifyEvidence | undefined): void {
		clearNode(this._node);
		const empty = !evidence || isClaudeVerifyEvidenceEmpty(evidence);
		this._node.classList.toggle('is-empty', empty);
		if (!evidence || empty) {
			return;
		}
		const head = append(this._node, $('.claude-review-evidence-head'));
		append(head, $('span.title')).textContent = localize('claudeReviewEvidenceTitle', "Verification");
		append(head, $('span.counts')).textContent = this.counts(evidence);
		const body = append(this._node, $('.claude-review-evidence-body'));
		const pair = this.pair(evidence.shots);
		if (pair.length > 0) {
			const row = append(body, $('.claude-review-evidence-pair'));
			for (const shot of pair) {
				this.figure(row, shot, this.labelText(shot.label));
			}
		}
		const frames = claudeVerifyRecording(evidence);
		if (frames.length > 0) {
			append(body, $('.claude-review-evidence-section')).textContent = localize('claudeReviewEvidenceRecording', "Recording, {0} Frames", frames.length);
			const strip = append(body, $('.claude-review-evidence-strip'));
			strip.setAttribute('role', 'list');
			frames.forEach((shot, index) => this.figure(strip, shot, String(index + 1)));
		}
		if (evidence.consoleErrors.length > 0) {
			append(body, $('.claude-review-evidence-section')).textContent = localize('claudeReviewEvidenceConsole', "Console Errors");
			const list = append(body, $('ul.claude-review-evidence-console'));
			for (const line of evidence.consoleErrors) {
				append(list, $('li')).textContent = line;
			}
		}
	}

	/** The first screenshot and the newest, or the only one. */
	private pair(shots: readonly ClaudeVerifyShot[]): readonly ClaudeVerifyShot[] {
		return shots.length > 1 ? [shots[0], shots[shots.length - 1]] : shots;
	}

	private counts(evidence: ClaudeVerifyEvidence): string {
		const parts: string[] = [];
		const shots = evidence.shots.length;
		if (shots > 0) {
			parts.push(shots === 1 ? localize('claudeReviewEvidenceOneShot', "1 screenshot") : localize('claudeReviewEvidenceShots', "{0} screenshots", shots));
		}
		const errors = evidence.consoleErrors.length;
		parts.push(errors === 0 ? localize('claudeReviewEvidenceNoErrors', "no console errors") : errors === 1 ? localize('claudeReviewEvidenceOneError', "1 console error") : localize('claudeReviewEvidenceErrors', "{0} console errors", errors));
		return parts.join(' · ');
	}

	private labelText(label: ClaudeVerifyShotLabel): string {
		switch (label) {
			case 'before': return localize('claudeReviewEvidenceBefore', "Before");
			case 'after': return localize('claudeReviewEvidenceAfter', "After");
			default: return localize('claudeReviewEvidenceStep', "Step");
		}
	}

	private figure(parent: HTMLElement, shot: ClaudeVerifyShot, caption: string): void {
		const figure = append(parent, $('figure.claude-review-evidence-shot'));
		figure.setAttribute('role', 'listitem');
		const image = append(figure, $<HTMLImageElement>('img'));
		image.src = `data:${shot.mimeType};base64,${shot.data}`;
		image.alt = localize('claudeReviewEvidenceAlt', "{0} Screenshot", this.labelText(shot.label));
		append(figure, $('figcaption')).textContent = caption;
	}
}
