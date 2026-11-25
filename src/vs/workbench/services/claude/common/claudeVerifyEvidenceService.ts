/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ClaudeBrowserImage } from '../../../../platform/claude/common/claudeBrowserTool.js';
import { addClaudeVerifyConsole, addClaudeVerifyShot, ClaudeVerifyEvidence, EMPTY_CLAUDE_VERIFY_EVIDENCE } from '../../../../platform/claude/common/claudeVerifyEvidence.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IClaudeVerifyEvidenceService = createDecorator<IClaudeVerifyEvidenceService>('claudeVerifyEvidenceService');

/**
 * What a turn collected while it verified a UI change (issue 1495): the screenshots and
 * console errors of the Agent Browser, kept as structured artifacts per turn so the
 * Review editor can show them next to the diff. Held in memory for the window.
 */
export interface IClaudeVerifyEvidenceService {
	readonly _serviceBrand: undefined;
	/** Fires with the session whose evidence changed. */
	readonly onDidChange: Event<string>;
	/** The evidence of a turn, or an empty one. */
	get(sessionId: string, turnId: string): ClaudeVerifyEvidence;
	/** The evidence of the newest turn that has any, for a review of the whole session. */
	getLatest(sessionId: string): { readonly turnId: string; readonly evidence: ClaudeVerifyEvidence } | undefined;
	/** Records a screenshot the browser tool took during the turn. */
	addScreenshot(sessionId: string, turnId: string, image: ClaudeBrowserImage): void;
	/** Records the output of a console read; only errors, warnings and page errors are kept. */
	addConsole(sessionId: string, turnId: string, text: string): void;
	/** Forgets the evidence of a closed session. */
	clear(sessionId: string): void;
}

export class ClaudeVerifyEvidenceService extends Disposable implements IClaudeVerifyEvidenceService {
	declare readonly _serviceBrand: undefined;

	private readonly _bySession = new Map<string, Map<string, ClaudeVerifyEvidence>>();
	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange = this._onDidChange.event;

	get(sessionId: string, turnId: string): ClaudeVerifyEvidence {
		return this._bySession.get(sessionId)?.get(turnId) ?? EMPTY_CLAUDE_VERIFY_EVIDENCE;
	}

	getLatest(sessionId: string): { readonly turnId: string; readonly evidence: ClaudeVerifyEvidence } | undefined {
		const turns = [...this._bySession.get(sessionId) ?? []];
		const last = turns[turns.length - 1];
		return last ? { turnId: last[0], evidence: last[1] } : undefined;
	}

	addScreenshot(sessionId: string, turnId: string, image: ClaudeBrowserImage): void {
		this.update(sessionId, turnId, evidence => addClaudeVerifyShot(evidence, image, Date.now()));
	}

	addConsole(sessionId: string, turnId: string, text: string): void {
		this.update(sessionId, turnId, evidence => addClaudeVerifyConsole(evidence, text));
	}

	clear(sessionId: string): void {
		if (this._bySession.delete(sessionId)) {
			this._onDidChange.fire(sessionId);
		}
	}

	private update(sessionId: string, turnId: string, change: (evidence: ClaudeVerifyEvidence) => ClaudeVerifyEvidence): void {
		let turns = this._bySession.get(sessionId);
		if (!turns) {
			this._bySession.set(sessionId, turns = new Map());
		}
		const before = turns.get(turnId) ?? EMPTY_CLAUDE_VERIFY_EVIDENCE;
		const after = change(before);
		if (after !== before) {
			// Re-insert so the newest turn is last.
			turns.delete(turnId);
			turns.set(turnId, after);
			this._onDidChange.fire(sessionId);
		}
	}
}

registerSingleton(IClaudeVerifyEvidenceService, ClaudeVerifyEvidenceService, InstantiationType.Delayed);
