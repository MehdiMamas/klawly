/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { basename, dirname, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { PlanArtifact } from '../../../../../platform/claude/common/claudePlan.js';
import { planFileKey, planFileName } from '../../../../../platform/claude/common/claudePlanDocument.js';
import { KLAWLY_PLANS_FOLDER, LEGACY_KLAWLY_PLANS_FOLDER } from '../../../../../platform/claude/common/claudePlanFiles.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { ActiveEditorContext } from '../../../../common/contextkeys.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../../services/editor/common/editorResolverService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IClaudePlanLinks } from '../../../../services/claude/common/claudePlanLinks.js';
import { CLAUDE_AGENT_ENABLED } from '../../common/claudeContextKeys.js';
import { KLAWLY_CATEGORY } from '../../common/claudeViews.js';
import { CLAUDE_BUILD_PLAN_COMMAND_ID, CLAUDE_OPEN_CHAT_PLAN_COMMAND_ID, CLAUDE_SAVE_PLAN_TO_WORKSPACE_COMMAND_ID, userPlansFolder } from './claudePlanCommands.js';
import { ClaudePlanEditor, ClaudePlanInput } from './claudePlanEditor.js';
import { ClaudePlanParallelBuilds, IClaudePlanParallelBuilds } from './claudePlanParallel.js';

/**
 * Plan files: `*.plan.md` anywhere, and any Markdown file in Klawly's or Claude Code's plans folder,
 * including the user plan folder of this build (`~/.klawly-dev/plans` in a dev build, issue 322).
 */
export function planEditorGlobs(dataFolderName: string): string[] {
	const globs = ['**/*.plan.md', `**/${KLAWLY_PLANS_FOLDER}/*.md`, `**/${LEGACY_KLAWLY_PLANS_FOLDER}/*.md`];
	const user = `**/${dataFolderName}/plans/*.md`;
	return globs.includes(user) ? globs : [...globs, user];
}

class ClaudePlanInputSerializer implements IEditorSerializer {
	canSerialize(editor: EditorInput): boolean {
		return editor instanceof ClaudePlanInput;
	}

	serialize(editor: EditorInput): string | undefined {
		return editor instanceof ClaudePlanInput ? editor.resource.toString() : undefined;
	}

	deserialize(instantiationService: IInstantiationService, serialized: string): EditorInput | undefined {
		try {
			return instantiationService.createInstance(ClaudePlanInput, URI.parse(serialized));
		} catch {
			return undefined;
		}
	}
}

/** Makes the plan editor the default editor of plan files. Open as Text still reaches the text editor. */
class ClaudePlanEditorResolver extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.klawlyPlanEditorResolver';

	constructor(
		@IEditorResolverService resolver: IEditorResolverService,
		@IFileService files: IFileService,
		@IInstantiationService instantiation: IInstantiationService,
		@IProductService product: IProductService,
	) {
		super();
		for (const glob of planEditorGlobs(product.dataFolderName)) {
			this._register(resolver.registerEditor(
				glob,
				{ id: ClaudePlanEditor.ID, label: localize('claudePlanEditorLabel', "Plan"), priority: RegisteredEditorPriority.default },
				{ singlePerResource: true, canSupportResource: resource => resource.scheme !== Schemas.untitled && files.hasProvider(resource) },
				{ createEditorInput: ({ resource, options }) => ({ editor: instantiation.createInstance(ClaudePlanInput, resource), options }) },
			));
		}
	}
}

/** The local workspace folders, where a plan saved to the workspace lives in `.claude/plans`. */
function localFolders(workspace: IWorkspaceContextService): IWorkspaceFolder[] {
	return workspace.getWorkspace().folders.filter(folder => folder.uri.scheme === Schemas.file);
}

/**
 * The plan file for a chat's plan, by the names it may have (the current name
 * first): a copy saved to a workspace folder's `.claude/plans` (or still in the
 * legacy `.klawly/plans`, or written there before issue 322) when one exists, else the file in Klawly's plan folder for
 * this user, which is new under the current name when none exists yet.
 */
export async function chatPlanFile(files: IFileService, folders: readonly IWorkspaceFolder[], userFolder: URI, names: readonly [string, ...string[]]): Promise<URI> {
	const workspaceFolders = folders.flatMap(({ uri }) => [KLAWLY_PLANS_FOLDER, LEGACY_KLAWLY_PLANS_FOLDER].map(plans => joinPath(uri, plans)));
	for (const folder of [...workspaceFolders, userFolder]) {
		for (const name of names) {
			const file = joinPath(folder, name);
			if (await files.exists(file)) {
				return file;
			}
		}
	}
	return joinPath(userFolder, names[0]);
}

/**
 * Open Plan on a plan card: writes the chat's plan to
 * `~/.klawly/plans/<title>-<key>.plan.md` the first time, links the chat
 * as its author and opens it in the plan editor. The key comes from the chat
 * and turn, so opening it again finds the same file, ticks and all, or the copy
 * saved to the workspace. Without a chat and turn (from the Command Palette) it
 * opens the current chat's latest plan.
 */
async function openChatPlan(accessor: ServicesAccessor, sessionArg: unknown, turnArg: unknown, notesArg: unknown, planArg: unknown): Promise<void> {
	const agent = accessor.get(IClaudeAgentService);
	let sessionId: string;
	let turnId: string;
	const notes = typeof notesArg === 'string' ? notesArg : '';
	const plan = isPlanArtifact(planArg) ? planArg : undefined;
	if (typeof sessionArg === 'string' && typeof turnArg === 'string') {
		sessionId = sessionArg;
		turnId = turnArg;
	} else {
		const current = agent.getCurrentSession();
		const latest = current && agent.getViewState(current.id).turns.findLast(turn => turn.plan);
		if (!current || !latest) {
			throw new Error(localize('claudeNoChatPlan', "This chat has no plan yet. Ask for one in Plan mode."));
		}
		sessionId = current.id;
		turnId = latest.id;
	}
	const files = accessor.get(IFileService);
	const links = accessor.get(IClaudePlanLinks);
	const editors = accessor.get(IEditorService);
	const folders = localFolders(accessor.get(IWorkspaceContextService));
	const userFolder = await userPlansFolder(accessor.get(IPathService), accessor.get(IProductService));
	const session = agent.getSessions().find(candidate => candidate.id === sessionId);
	const shown = plan ?? agent.getViewState(sessionId).turns.find(turn => turn.id === turnId)?.plan;
	if (!session || !shown) {
		throw new Error(localize('claudeSaveNoPlan', "That turn has no plan to save."));
	}
	const key = planFileKey(sessionId, turnId);
	// A plan opened before titles lost a leading "Plan:" has it in its file name: open that file, ticks and all.
	const target = await chatPlanFile(files, folders, userFolder, [planFileName(shown.title, key), planFileName(`Plan: ${shown.title}`, key)]);
	if (!await files.exists(target)) {
		await agent.writePlanFile(sessionId, turnId, target, notes, plan);
	}
	links.link(target, { sessionId, title: session.title, role: 'author' });
	await editors.openEditor({ resource: target, options: { override: ClaudePlanEditor.ID, pinned: true } });
}

/**
 * Save Plan to Workspace: puts a plan into the first local folder's
 * `.claude/plans` and swaps its open editors over. A plan from Klawly's plan
 * folder for this user moves there with its chat links, and the chat's Open
 * Plan finds the workspace copy after that. Any other plan file, such as one
 * in `~/.claude/plans` or another project, is copied and stays where it is.
 */
async function savePlanToWorkspace(accessor: ServicesAccessor, resourceArg: unknown): Promise<void> {
	const editors = accessor.get(IEditorService);
	const files = accessor.get(IFileService);
	const textFiles = accessor.get(ITextFileService);
	const links = accessor.get(IClaudePlanLinks);
	const dialogs = accessor.get(IDialogService);
	const notifications = accessor.get(INotificationService);
	const workspace = accessor.get(IWorkspaceContextService);
	const paths = accessor.get(IPathService);
	const product = accessor.get(IProductService);
	const uriIdentity = accessor.get(IUriIdentityService);
	const source = URI.isUri(resourceArg) ? resourceArg : editors.activeEditor?.resource;
	if (!source) {
		return;
	}
	if (workspace.isInsideWorkspace(source)) {
		notifications.info(localize('claudePlanAlreadyInWorkspace', "This plan is already in the workspace."));
		return;
	}
	const folder = localFolders(workspace)[0];
	if (!folder) {
		throw new Error(localize('claudePlanSaveNeedsFolder', "Open a local folder to save the plan in it."));
	}
	const target = joinPath(folder.uri, KLAWLY_PLANS_FOLDER, basename(source));
	if (textFiles.isDirty(source)) {
		await textFiles.save(source);
	}
	if (await files.exists(target)) {
		const { confirmed } = await dialogs.confirm({
			message: localize('claudePlanReplaceSaved', "Replace the plan {0} in the workspace?", basename(target)),
			detail: localize('claudePlanReplaceSavedDetail', "The workspace already has a plan with this name."),
			primaryButton: localize({ key: 'claudePlanReplace', comment: ['&& denotes a mnemonic'] }, "&&Replace"),
		});
		if (!confirmed) {
			return;
		}
	}
	// Only Klawly's own plans move; a plan file it does not own is never deleted. Compared as the file
	// system does, so a path Claude names with `c:\` still matches the home folder's `C:\`.
	const move = uriIdentity.extUri.isEqualOrParent(source, await userPlansFolder(paths, product));
	await files.copy(source, target, true);
	if (move) {
		links.move(source, target);
	} else {
		// Newest link first, as the source had them.
		for (const link of [...links.links(source)].reverse()) {
			links.link(target, link);
		}
	}
	const open = editors.findEditors(source);
	for (const { editor, groupId } of open) {
		await editors.replaceEditors([{ editor, replacement: { resource: target, options: { override: ClaudePlanEditor.ID, pinned: true } } }], groupId);
	}
	if (!open.length) {
		await editors.openEditor({ resource: target, options: { override: ClaudePlanEditor.ID, pinned: true } });
	}
	if (move) {
		await files.del(source);
	} else {
		notifications.info(localize('claudePlanCopiedToWorkspace', "Saved a copy of {0} in the workspace. The original is not in Klawly's plans folder, so it stays where it is.", basename(source)));
	}
}

/**
 * One-time migration (issue 973): moves the plans a workspace folder saved in
 * `.klawly/plans` into `.claude/plans`, so a project never gets a `.klawly`
 * folder. A plan whose name is taken in `.claude/plans` stays where it is, and
 * the legacy folder is removed only once it is empty. Chat links follow each
 * moved plan. Returns the plans it moved.
 */
export async function migrateLegacyPlans(files: IFileService, links: IClaudePlanLinks, folder: URI): Promise<URI[]> {
	const legacy = joinPath(folder, LEGACY_KLAWLY_PLANS_FOLDER);
	const target = joinPath(folder, KLAWLY_PLANS_FOLDER);
	if (!await files.exists(legacy)) {
		return [];
	}
	const moved: URI[] = [];
	for (const child of (await files.resolve(legacy)).children ?? []) {
		const destination = joinPath(target, child.name);
		if (await files.exists(destination)) {
			continue;
		}
		await files.move(child.resource, destination);
		if (!child.isDirectory) {
			links.move(child.resource, destination);
		}
		moved.push(destination);
	}
	if (!(await files.resolve(legacy)).children?.length) {
		await files.del(legacy, { recursive: true });
		const parent = dirname(legacy);
		if (!(await files.resolve(parent)).children?.length) {
			await files.del(parent);
		}
	}
	return moved;
}

/** Runs `migrateLegacyPlans` for each local workspace folder once the workbench has restored. */
class ClaudeLegacyPlansMigration implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.klawlyLegacyPlansMigration';

	constructor(
		@IFileService files: IFileService,
		@IClaudePlanLinks links: IClaudePlanLinks,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@ILogService log: ILogService,
	) {
		for (const { uri } of localFolders(workspace)) {
			migrateLegacyPlans(files, links, uri).catch(error => log.warn('[klawly] could not move .klawly/plans to .claude/plans', error));
		}
	}
}

function isPlanArtifact(value: unknown): value is PlanArtifact {
	return typeof value === 'object' && value !== null && typeof (value as Partial<PlanArtifact>).title === 'string' && Array.isArray((value as Partial<PlanArtifact>).steps);
}

export function registerClaudePlanEditor(): void {
	Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
		EditorPaneDescriptor.create(ClaudePlanEditor, ClaudePlanEditor.ID, localize('claudePlanEditor', "Plan")),
		[new SyncDescriptor(ClaudePlanInput)],
	);
	Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(ClaudePlanInput.ID, ClaudePlanInputSerializer);
	registerWorkbenchContribution2(ClaudePlanEditorResolver.ID, ClaudePlanEditorResolver, WorkbenchPhase.BlockStartup);
	registerWorkbenchContribution2(ClaudeLegacyPlansMigration.ID, ClaudeLegacyPlansMigration, WorkbenchPhase.Eventually);
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_OPEN_CHAT_PLAN_COMMAND_ID,
				title: localize2('claudeOpenChatPlan', "Open Chat Plan as File"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		run(accessor: ServicesAccessor, sessionId: unknown, turnId: unknown, notes: unknown, plan: unknown): Promise<void> {
			return openChatPlan(accessor, sessionId, turnId, notes, plan);
		}
	});
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_SAVE_PLAN_TO_WORKSPACE_COMMAND_ID,
				title: localize2('claudeSavePlanToWorkspace', "Save Plan to Workspace"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, ActiveEditorContext.isEqualTo(ClaudePlanEditor.ID)),
			});
		}

		run(accessor: ServicesAccessor, resource: unknown): Promise<void> {
			return savePlanToWorkspace(accessor, resource);
		}
	});
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_BUILD_PLAN_COMMAND_ID,
				title: localize2('claudeBuildPlan', "Build Plan"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, ActiveEditorContext.isEqualTo(ClaudePlanEditor.ID)),
				keybinding: {
					weight: KeybindingWeight.WorkbenchContrib,
					primary: KeyMod.CtrlCmd | KeyCode.Enter,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, ActiveEditorContext.isEqualTo(ClaudePlanEditor.ID)),
				},
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const pane = accessor.get(IEditorService).activeEditorPane;
			if (pane instanceof ClaudePlanEditor) {
				await pane.runBuild();
			}
		}
	});
}

// Issue 495: Build in Parallel runs a plan's independent to-dos as separate background agents.
registerSingleton(IClaudePlanParallelBuilds, ClaudePlanParallelBuilds, InstantiationType.Delayed);
