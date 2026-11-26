/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, EventType, addDisposableListener } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ClaudeAgent, claudeCompare, claudeGroupTitle, IClaudeMultitask } from '../../../../platform/claude/common/claudeAgents.js';
import { IClaudeAgentsService } from '../../../services/claude/browser/claudeAgentsService.js';

/** The chat of a Run Parallel Agents task: one card per attempt (v5-S28) and the Compare view (v5-S30). */
export class ClaudeAttemptsView {

	private compare = false;
	/** What Apply this one answered, per attempt: the applied note or the conflict message. */
	private readonly applied = new Map<ClaudeAgent, { readonly ok: boolean; readonly text: string }>();
	private shownGroup: IClaudeMultitask | undefined;

	constructor(private readonly service: IClaudeAgentsService, private readonly onChange: () => void) { }

	render(parent: HTMLElement, group: IClaudeMultitask, store: DisposableStore): void {
		if (group !== this.shownGroup) {
			this.shownGroup = group;
			this.compare = false;
		}
		const root = append(parent, $('.claude-attempts'));
		const head = append(root, $('.claude-attempts-head'));
		append(head, $('.claude-attempts-title')).textContent = claudeGroupTitle(group);
		if (this.compare) {
			this.renderCompare(root, group, store);
		} else {
			this.renderCards(root, group, store);
		}
	}

	private button(parent: HTMLElement, text: string, className: string, store: DisposableStore, run: () => void, disabled = false): void {
		const button = append(parent, $('button.claude-button' + className)) as HTMLButtonElement;
		button.textContent = text;
		button.disabled = disabled;
		store.add(addDisposableListener(button, EventType.CLICK, run));
	}

	private modelOf(attempt: ClaudeAgent): string {
		return attempt.conversation.model ?? attempt.model ?? localize('claude.attempt.defaultModel', "default model");
	}

	private renderCards(root: HTMLElement, group: IClaudeMultitask, store: DisposableStore): void {
		const passed = group.attempts.filter(a => a.passed && a.diff).length;
		for (const attempt of group.attempts) {
			const card = append(root, $('.claude-attempt'));
			card.setAttribute('role', 'group');
			const failed = attempt.status === 'done' && attempt.failure;
			card.classList.toggle('failed', !!failed);
			append(card, $('.claude-attempt-title')).textContent = failed
				? localize('claude.attempt.failed', "Attempt {0} · failed at turn {1}", attempt.attempt, attempt.failure?.turn)
				: localize('claude.attempt.title', "Attempt {0} · {1}", attempt.attempt, this.modelOf(attempt));
			const buttons = append(card, $('.claude-permission-buttons'));
			if (failed) {
				append(card, $('code.claude-attempt-error')).textContent = attempt.failure?.message ?? '';
				this.button(buttons, localize('claude.attempt.retry', "Retry"), '.claude-primary', store, () => this.service.retry(group, attempt));
				this.button(buttons, localize('claude.attempt.log', "Open log"), '', store, () => this.service.select(attempt));
			} else if (attempt.status === 'done') {
				const diff = attempt.diff;
				append(card, $('.claude-attempt-stat')).textContent = diff
					? localize('claude.attempt.stat', "+{0} \u2212{1} · {2} files", diff.added, diff.removed, diff.files)
					: localize('claude.attempt.reading', "Reading the changes");
				this.button(buttons, localize('claude.attempt.compare', "Compare"), '.claude-primary', store, () => { this.compare = true; this.onChange(); }, !passed);
			} else {
				append(card, $('.claude-attempt-stat')).textContent = attempt.statusLine(Date.now());
				this.button(buttons, localize('claude.attempt.open', "Open"), '', store, () => this.service.select(attempt));
			}
		}
	}

	private renderCompare(root: HTMLElement, group: IClaudeMultitask, store: DisposableStore): void {
		const { passed, smallest, headline } = claudeCompare(group);
		const top = append(root, $('.claude-compare-head'));
		this.button(top, localize('claude.compare.back', "Attempts"), '.claude-ghost', store, () => { this.compare = false; this.onChange(); });
		append(top, $('.claude-compare-headline')).textContent = headline;
		for (const attempt of passed) {
			const card = append(root, $('.claude-attempt'));
			card.setAttribute('role', 'group');
			card.classList.toggle('smallest', attempt === smallest);
			append(card, $('.claude-attempt-title')).textContent = localize('claude.compare.attempt', "Attempt {0}", attempt.attempt);
			const diff = attempt.diff;
			append(card, $('.claude-attempt-stat')).textContent = diff ? localize('claude.compare.stat', "+{0} \u2212{1} · {2} files", diff.added, diff.removed, diff.files) : '';
			if (diff?.firstLine) {
				append(card, $('code.claude-attempt-line')).textContent = diff.firstLine;
			}
			const result = this.applied.get(attempt);
			if (result) {
				const note = append(card, $('.claude-attempt-result'));
				note.classList.toggle('error', !result.ok);
				append(note, $('span' + ThemeIcon.asCSSSelector(result.ok ? Codicon.check : Codicon.error)));
				append(note, $('span')).textContent = result.text;
			}
			const buttons = append(card, $('.claude-permission-buttons'));
			this.button(buttons, localize('claude.compare.apply', "Apply this one"), '.claude-primary', store, async () => {
				try {
					await this.service.applyAttempt(attempt);
					this.applied.set(attempt, { ok: true, text: localize('claude.compare.applied', "Applied to {0}", this.service.folderName) });
				} catch (error) {
					this.applied.set(attempt, { ok: false, text: localize('claude.compare.conflict', "Not applied, nothing changed: {0}", (error instanceof Error ? error.message : String(error)).split('\n')[0]) });
				}
				this.onChange();
			});
		}
	}
}
