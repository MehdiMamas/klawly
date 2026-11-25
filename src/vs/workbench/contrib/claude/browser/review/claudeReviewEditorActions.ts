/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { ActiveEditorContext } from '../../../../common/contextkeys.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { CLAUDE_AGENT_ENABLED } from '../../common/claudeContextKeys.js';
import { CLAUDE_OPEN_REVIEW_EDITOR_COMMAND_ID, KLAWLY_CATEGORY } from '../../common/claudeViews.js';
import { ClaudeReviewEditor, ClaudeReviewInput, ClaudeReviewScope } from './claudeReviewEditor.js';
import { CLAUDE_REVIEW_EDITOR, CLAUDE_REVIEW_FILE_STATE, ClaudeReviewSourceResolver } from './claudeReviewSource.js';

const CLAUDE_REVIEW_KEEP_FILE_COMMAND_ID = 'klawly.review.keepFile';
const CLAUDE_REVIEW_UNDO_FILE_COMMAND_ID = 'klawly.review.undoFile';
const CLAUDE_REVIEW_OPEN_FILE_COMMAND_ID = 'klawly.review.openFile';
const CLAUDE_REVIEW_ADD_COMMENT_COMMAND_ID = 'klawly.review.addComment';

interface SerializedReviewInput {
	readonly sessionId: string;
	readonly turnId?: string;
	readonly scope: ClaudeReviewScope;
}

class ClaudeReviewInputSerializer implements IEditorSerializer {
	canSerialize(editor: EditorInput): boolean {
		return editor instanceof ClaudeReviewInput;
	}

	serialize(editor: EditorInput): string | undefined {
		if (!(editor instanceof ClaudeReviewInput)) {
			return undefined;
		}
		const data: SerializedReviewInput = { sessionId: editor.sessionId, turnId: editor.turnId, scope: editor.scope };
		return JSON.stringify(data);
	}

	deserialize(instantiationService: IInstantiationService, serialized: string): EditorInput | undefined {
		try {
			const data = JSON.parse(serialized) as SerializedReviewInput;
			if (typeof data.sessionId !== 'string') {
				return undefined;
			}
			const input = instantiationService.createInstance(ClaudeReviewInput, data.sessionId, typeof data.turnId === 'string' ? data.turnId : undefined);
			input.show(input.turnId, data.scope === 'turn' ? 'turn' : 'all');
			return input;
		} catch {
			return undefined;
		}
	}
}

/**
 * Opens the review editor of a chat on one turn, or on every turn when no turn
 * is given. Without a chat it opens the current chat's review.
 */
async function openReviewEditor(accessor: ServicesAccessor, sessionArg: unknown, turnArg: unknown): Promise<void> {
	const agent = accessor.get(IClaudeAgentService);
	const editors = accessor.get(IEditorService);
	const sessionId = typeof sessionArg === 'string' ? sessionArg : agent.getCurrentSession()?.id;
	if (!sessionId) {
		throw new Error(localize('claudeReviewNoChat', "Start a chat before reviewing its changes."));
	}
	const turnId = typeof turnArg === 'string' ? turnArg : undefined;
	const input = accessor.get(IInstantiationService).createInstance(ClaudeReviewInput, sessionId, turnId);
	const pane = await editors.openEditor(input, { pinned: true });
	if (pane instanceof ClaudeReviewEditor && pane.input !== input) {
		// The chat's review tab was already open; point it at the turn asked for.
		input.dispose();
		await pane.show(turnId);
	}
}

/** The review editor that shows `uri`, preferring the active one. */
function reviewEditorFor(accessor: ServicesAccessor, uri: URI): ClaudeReviewEditor | undefined {
	const editors = accessor.get(IEditorService);
	for (const pane of [editors.activeEditorPane, ...editors.visibleEditorPanes]) {
		if (pane instanceof ClaudeReviewEditor && pane.entries.some(entry => isEqual(entry.uri, uri))) {
			return pane;
		}
	}
	return undefined;
}

export function registerClaudeReviewEditor(): void {
	Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
		EditorPaneDescriptor.create(ClaudeReviewEditor, ClaudeReviewEditor.ID, localize('claudeReviewEditor', "Review")),
		[new SyncDescriptor(ClaudeReviewInput)],
	);
	Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(ClaudeReviewInput.ID, ClaudeReviewInputSerializer);
	registerWorkbenchContribution2(ClaudeReviewSourceResolver.ID, ClaudeReviewSourceResolver, WorkbenchPhase.BlockRestore);

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_OPEN_REVIEW_EDITOR_COMMAND_ID,
				// One name per job (DL-30, issue 766): the agent's changes, as Keep All and Undo All call them.
				title: { ...localize2('claudeOpenReviewEditor', "Review Agent Changes"), original: 'Review Agent Changes (Review Chat Changes)' },
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		run(accessor: ServicesAccessor, sessionId: unknown, turnId: unknown): Promise<void> {
			return openReviewEditor(accessor, sessionId, turnId);
		}
	});

	const inReview = ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, CLAUDE_REVIEW_EDITOR);
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_REVIEW_KEEP_FILE_COMMAND_ID,
				title: localize2('claudeReviewKeepFile', "Keep"),
				icon: Codicon.check,
				precondition: CLAUDE_AGENT_ENABLED,
				menu: {
					id: MenuId.MultiDiffEditorFileToolbar,
					group: 'navigation',
					order: -20,
					when: ContextKeyExpr.and(inReview, CLAUDE_REVIEW_FILE_STATE.notEqualsTo('accepted')),
				},
			});
		}

		run(accessor: ServicesAccessor, uri: unknown): void {
			if (URI.isUri(uri)) {
				reviewEditorFor(accessor, uri)?.keepFile(uri);
			}
		}
	});
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_REVIEW_UNDO_FILE_COMMAND_ID,
				title: localize2('claudeReviewUndoFile', "Undo"),
				icon: Codicon.discard,
				precondition: CLAUDE_AGENT_ENABLED,
				menu: {
					id: MenuId.MultiDiffEditorFileToolbar,
					group: 'navigation',
					order: -10,
					when: inReview,
				},
			});
		}

		async run(accessor: ServicesAccessor, uri: unknown): Promise<void> {
			if (URI.isUri(uri)) {
				await reviewEditorFor(accessor, uri)?.undoFile(uri);
			}
		}
	});

	// issue 431: a comment on the selected lines goes to the tray, then to the agent.
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_REVIEW_ADD_COMMENT_COMMAND_ID,
				title: localize2('claudeReviewAddComment', "Comment for Claude"),
				category: KLAWLY_CATEGORY,
				icon: Codicon.comment,
				f1: true,
				precondition: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, ActiveEditorContext.isEqualTo(ClaudeReviewEditor.ID)),
				menu: {
					id: MenuId.EditorContext,
					group: '1_klawly',
					order: 0,
					when: inReview,
				},
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const pane = accessor.get(IEditorService).activeEditorPane;
			if (pane instanceof ClaudeReviewEditor) {
				await pane.addComment();
			}
		}
	});

	// issue 1078: the three exports are in the palette too, for an open review.
	for (const [id, format, title] of [
		['claude.review.exportMarkdown', 'markdown', localize2('claudeReviewPaletteExportMarkdown', "Export Review as Markdown")],
		['claude.review.exportSarif', 'sarif', localize2('claudeReviewPaletteExportSarif', "Export Review as SARIF 2.1")],
		['claude.review.copyPrComment', 'comment', localize2('claudeReviewPaletteCopyPrComment', "Copy Review as PR Comment")],
	] as const) {
		registerAction2(class extends Action2 {
			constructor() {
				super({
					id,
					title,
					category: KLAWLY_CATEGORY,
					f1: true,
					precondition: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, ActiveEditorContext.isEqualTo(ClaudeReviewEditor.ID)),
				});
			}

			async run(accessor: ServicesAccessor): Promise<void> {
				const pane = accessor.get(IEditorService).activeEditorPane;
				if (pane instanceof ClaudeReviewEditor) {
					await pane.exportReview(format);
				}
			}
		});
	}

	// issue 354: Open File after Keep and Undo, like the multi-diff editor's own.
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_REVIEW_OPEN_FILE_COMMAND_ID,
				title: localize2('claudeReviewOpenFile', "Open File"),
				icon: Codicon.goToFile,
				precondition: CLAUDE_AGENT_ENABLED,
				menu: {
					id: MenuId.MultiDiffEditorFileToolbar,
					group: 'navigation',
					order: 0,
					when: inReview,
				},
			});
		}

		async run(accessor: ServicesAccessor, uri: unknown): Promise<void> {
			if (!URI.isUri(uri)) {
				return;
			}
			const pane = reviewEditorFor(accessor, uri);
			if (pane) {
				await pane.openFile(uri);
			} else {
				await accessor.get(IEditorService).openEditor({ resource: uri, options: { pinned: true } });
			}
		}
	});
}
