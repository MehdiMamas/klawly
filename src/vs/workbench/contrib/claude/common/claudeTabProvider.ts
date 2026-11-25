/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { Range } from '../../../../editor/common/core/range.js';
import { IPosition } from '../../../../editor/common/core/position.js';
import { InlineCompletionContext, InlineCompletionEndOfLifeReason, InlineCompletionEndOfLifeReasonKind, InlineCompletions, InlineCompletionsDisposeReason, InlineCompletionsProvider } from '../../../../editor/common/languages.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { localize } from '../../../../nls.js';
import { ContextKeyExpr, ContextKeyExpression } from '../../../../platform/contextkey/common/contextkey.js';
import { CLAUDE_AUTOCOMPLETE_PREFIX_CHARS, CLAUDE_AUTOCOMPLETE_SUFFIX_CHARS, CompletionInput, inlineInsertText, isSkippedCompletionScheme, nextEditPreviewRange } from '../../../../platform/claude/common/claudeAutocomplete.js';
import { IClaudeAutocompleteService } from '../../../services/claude/common/claudeAutocompleteService.js';
import { ATTRIBUTION_TAB_SOURCE, IClaudeAttributionService, tabAcceptedSpan } from '../../../services/claude/common/claudeAttribution.js';

export const CLAUDE_TAB_FILE_HASH_LIMIT = 256_000;

/** Tab accepts a next-edit jump only when ghost text, suggest, snippet, and find are idle. */
export function claudeTabAcceptWhen(): ContextKeyExpression {
	return tabWhen();
}

/** Esc dismisses a next-edit jump only when ghost text, suggest, snippet, and find are idle. */
export function claudeTabDismissWhen(): ContextKeyExpression {
	return tabWhen();
}

/**
 * The editor is leaving `previous`. Returns that URI so the caller can drop
 * the editor's cursor. The same URI means the model did not change.
 */
export function tabModelHandoff(previous: URI | undefined, next: URI | undefined): URI | undefined {
	if (!previous) {
		return undefined;
	}
	if (next && previous.toString() === next.toString()) {
		return undefined;
	}
	return previous;
}

function tabWhen(): ContextKeyExpression {
	const parts = [
		ContextKeyExpr.has('klawly.tab.nextEdit'),
		ContextKeyExpr.has('editorTextFocus'),
		ContextKeyExpr.not('inlineSuggestionVisible'),
		ContextKeyExpr.not('suggestWidgetVisible'),
		ContextKeyExpr.not('inSnippetMode'),
		ContextKeyExpr.not('findWidgetVisible'),
		ContextKeyExpr.not('findInputFocussed'),
	];
	const when = ContextKeyExpr.and(...parts);
	if (!when) {
		throw new Error('Tab when-clause is empty');
	}
	return when;
}

/**
 * Inline completions for Klawly Tab. Ghost text is the editor's own rendering.
 * A cross-file result does not insert text here. A next-edit preview replaces
 * the target line instead of inserting at column 1.
 */
export class ClaudeTabCompletionProvider implements InlineCompletionsProvider {
	readonly displayName = localize('claudeTab.provider', "Klawly Tab");
	readonly groupId = 'klawly.tab';
	/** The service debounces with `claude.autocomplete.debounceMs`. */
	readonly debounceDelayMs = 0;

	private readonly _models = new WeakMap<InlineCompletions, ITextModel>();

	constructor(
		private readonly _autocomplete: IClaudeAutocompleteService,
		private readonly _attribution?: IClaudeAttributionService,
	) { }

	async provideInlineCompletions(model: ITextModel, position: IPosition, _context: InlineCompletionContext, token: CancellationToken): Promise<InlineCompletions | undefined> {
		if (isSkippedCompletionScheme(model.uri.scheme) || !this._autocomplete.enabled()) {
			return undefined;
		}
		const versionId = model.getVersionId();
		const preview = this._autocomplete.consumePreview(model.uri, versionId, position.lineNumber);
		if (token.isCancellationRequested || model.getVersionId() !== versionId) {
			return undefined;
		}
		if (preview) {
			if (preview.lineNumber < 1 || preview.lineNumber > model.getLineCount()) {
				return undefined;
			}
			const range = nextEditPreviewRange(preview.lineNumber, model.getLineMaxColumn(preview.lineNumber));
			return this._tracked(model, {
				enableForwardStability: true,
				items: [{ insertText: preview.text, range }],
			});
		}
		const input = completionInput(model, position, this._autocomplete.snapshotRecentEdits());
		const result = await this._autocomplete.provideCompletion(input, token);
		if (!result || token.isCancellationRequested || model.getVersionId() !== versionId) {
			return undefined;
		}
		const noted = this._autocomplete.notedPosition(model.uri);
		if (noted && (noted.lineNumber !== position.lineNumber || noted.column !== position.column)) {
			return undefined;
		}
		const insertText = inlineInsertText(result);
		if (insertText === undefined) {
			return undefined;
		}
		return this._tracked(model, ghostText(insertText, position));
	}

	handleEndOfLifetime(completions: InlineCompletions, item: InlineCompletions['items'][number], reason: InlineCompletionEndOfLifeReason): void {
		const model = this._models.get(completions);
		this._models.delete(completions);
		if (!model || model.isDisposed() || reason.kind !== InlineCompletionEndOfLifeReasonKind.Accepted || typeof item.insertText !== 'string') {
			return;
		}
		const range = item.range ?? { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
		this._autocomplete.recordRecentEdit({
			uri: model.uri.toString(),
			before: '',
			after: item.insertText,
			range: {
				startLineNumber: range.startLineNumber,
				startColumn: range.startColumn,
				endLineNumber: range.endLineNumber,
				endColumn: range.endColumn,
			},
			ageMs: 0,
		});
		this.recordAttribution(model, range.startLineNumber, item.insertText);
		const noted = this._autocomplete.notedPosition(model.uri);
		if (!noted || (noted.lineNumber !== range.startLineNumber && noted.lineNumber !== range.endLineNumber)) {
			return;
		}
		void this._autocomplete.prefetchCompletion(completionInput(model, noted, this._autocomplete.snapshotRecentEdits()), CancellationToken.None);
	}

	/**
	 * The editor ends the completion's life after it applied the edit, so the lines the completion wrote are in the model
	 * now. The ledger drops the owner of every line the completion replaced, like any other edit.
	 */
	private recordAttribution(model: ITextModel, startLine: number, insertText: string): void {
		if (!this._attribution || startLine < 1) {
			return;
		}
		const span = tabAcceptedSpan(startLine, insertText);
		if (!span || span.endLine > model.getLineCount()) {
			return;
		}
		const lastWritten = insertText.replace(/\n$/, '').split('\n').pop() ?? '';
		if (!model.getLineContent(span.endLine).includes(lastWritten)) {
			return;
		}
		this._attribution.recordAccepted(model.uri, ATTRIBUTION_TAB_SOURCE, model.getLinesContent(), [span]);
	}

	disposeInlineCompletions(completions: InlineCompletions, _reason: InlineCompletionsDisposeReason): void {
		this._models.delete(completions);
	}

	private _tracked(model: ITextModel, completions: InlineCompletions): InlineCompletions {
		this._models.set(completions, model);
		return completions;
	}
}

function ghostText(insertText: string, position: IPosition): InlineCompletions {
	return {
		enableForwardStability: true,
		items: [{
			insertText,
			range: {
				startLineNumber: position.lineNumber,
				startColumn: position.column,
				endLineNumber: position.lineNumber,
				endColumn: position.column,
			},
		}],
	};
}

export function completionInput(model: ITextModel, position: IPosition, recentEdits: CompletionInput['recentEdits']): CompletionInput {
	const offset = model.getOffsetAt(position);
	const start = Math.max(0, offset - CLAUDE_AUTOCOMPLETE_PREFIX_CHARS);
	const prefix = model.getValueInRange(Range.fromPositions(model.getPositionAt(start), position));
	const endOffset = Math.min(model.getValueLength(), offset + CLAUDE_AUTOCOMPLETE_SUFFIX_CHARS);
	const suffix = model.getValueInRange(Range.fromPositions(position, model.getPositionAt(endOffset)));
	const fileText = model.getValueLength() > CLAUDE_TAB_FILE_HASH_LIMIT
		? `${model.uri.toString()}:${model.getVersionId()}`
		: model.getValue();
	return {
		uri: model.uri,
		languageId: model.getLanguageId(),
		prefix,
		suffix,
		recentEdits,
		relatedSnippets: [],
		versionId: model.getVersionId(),
		position: { lineNumber: position.lineNumber, column: position.column },
		fileText,
		lineText: model.getLineContent(position.lineNumber),
		uriPath: model.uri.path,
	};
}
