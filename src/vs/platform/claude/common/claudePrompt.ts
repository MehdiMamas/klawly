/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentActionId, ActionResolution } from './claudeActions.js';
import { ChatReferenceInput } from './claudeChatReference.js';
import { AgentMode, ContextAttachment, GitDiffScope, SerializedRange } from './claudeContext.js';
import { CLAUDE_DEBUG_MODE_INSTRUCTION } from './claudeDebugMode.js';
import { ClaudeAutoModelPick } from './claudeAutoModel.js';

/** How many characters of one file or selection body are compiled into the prompt. */
export const CLAUDE_ATTACHMENT_CHAR_LIMIT = 12_000;

/** Terminal tail attached when the user asks for terminal context. */
export const CLAUDE_TERMINAL_LINE_LIMIT = 200;

export interface DiagnosticSummary {
	readonly uri?: string;
	readonly path?: string;
	readonly severity: string;
	readonly message: string;
	readonly line?: number;
	readonly column?: number;
	readonly source?: string;
	readonly code?: string;
}

export interface ActiveFileContext {
	readonly relativePath: string;
	readonly cursorLine: number;
	readonly selection?: string;
}

export type ResolvedAttachment =
	| { kind: 'file'; path: string; languageId?: string; content?: string; unsaved: boolean; truncated: boolean }
	| { kind: 'folder'; path: string }
	| { kind: 'symbol'; path: string; name: string; range: SerializedRange; content: string; truncated: boolean }
	| { kind: 'selection'; path: string; languageId?: string; range: SerializedRange; content: string; stale: boolean; truncated: boolean }
	| { kind: 'diagnostics'; items: readonly DiagnosticSummary[] }
	| { kind: 'git-diff'; scope: GitDiffScope; ref?: string; stat: string; patch: string; truncated: boolean }
	| { kind: 'terminal'; title: string; lines: string; truncated: boolean }
	| { kind: 'image'; path: string }
	| { kind: 'pasted-text'; text: string; lineCount: number; truncated: boolean; label?: string }
	| { kind: 'chat'; sessionId: string; reference?: ChatReferenceInput; large?: boolean };

export interface AgentEnvelope {
	readonly userText: string;
	readonly mode: AgentMode;
	readonly workspaceRoot: string;
	readonly activeFile?: ActiveFileContext;
	readonly attachments: readonly ResolvedAttachment[];
	readonly diagnostics: readonly DiagnosticSummary[];
	readonly instructionFiles: readonly string[];
	/** Klawly's plan folder for this user as an absolute path, which Plan mode names as the place for plan files (issue 322). */
	readonly planFolder?: string;
}

/** An image sent with a turn: its stored copy and the name the user knows it by (issue 744). */
export interface SentImage {
	readonly uri: string;
	readonly name?: string;
}

export interface SentPromptRecord {
	readonly compiled: string;
	readonly resolution?: ActionResolution;
	readonly modelId?: string;
	readonly mode: AgentMode;
	readonly allowedTools?: readonly string[];
	readonly additionalDirectories?: readonly string[];
	/** What Auto model chose for this turn (issue 521). Absent when the user picked the model. */
	readonly auto?: ClaudeAutoModelPick;
	/** Images attached to the turn, which its prompt shows (issue 744). */
	readonly images?: readonly SentImage[];
	/** The other chips attached to the turn (files, folders, symbols, terminals), which its message shows (issue 759). */
	readonly chips?: readonly SentChip[];
}

/** A chip a turn was sent with, as its message shows it: the kind picks the icon (issue 759). */
export interface SentChip {
	readonly kind: ContextAttachment['kind'];
	readonly label: string;
}

/** The last path segment of a stored uri or path. */
function lastSegment(value: string): string {
	return decodeURIComponent(value.split(/[\/]/).filter(part => part.length).pop() ?? value);
}

/** The chips of a turn other than images and pasted text, for its message to show (issue 759). */
export function sentChips(attachments: readonly ContextAttachment[] | undefined): SentChip[] | undefined {
	const chips: SentChip[] = [];
	for (const attachment of attachments ?? []) {
		switch (attachment.kind) {
			case 'file':
			case 'folder':
			case 'symbol':
			case 'selection':
				chips.push({ kind: attachment.kind, label: attachment.kind === 'symbol' ? attachment.name : lastSegment(attachment.uri) });
				break;
			case 'git-diff':
				chips.push({ kind: attachment.kind, label: attachment.title ?? (attachment.path ? lastSegment(attachment.path) : attachment.scope) });
				break;
			case 'terminal':
			case 'chat':
				if (attachment.title) {
					chips.push({ kind: attachment.kind, label: attachment.title });
				}
				break;
		}
	}
	return chips.length ? chips : undefined;
}

/** The image attachments of a turn, for its prompt to show (issue 744). */
export function sentImages(attachments: readonly ContextAttachment[] | undefined): SentImage[] | undefined {
	const images = (attachments ?? []).flatMap(attachment => attachment.kind === 'image' ? [{ uri: attachment.localUri, ...(attachment.name ? { name: attachment.name } : {}) }] : []);
	return images.length ? images : undefined;
}

export interface ActionCatalog {
	readonly slashCommands: readonly string[];
	readonly skills: readonly string[];
	/** When false, resolve always uses the built-in template. */
	readonly preferClaudeCommands: boolean;
}

interface ActionPreference {
	readonly label: string;
	readonly commands: readonly string[];
	readonly skills: readonly string[];
	readonly templateId: string;
	/** Chip-only actions do not send a turn. */
	readonly sends: boolean;
}

const ACTION_PREFERENCES: Record<AgentActionId, ActionPreference> = {
	addSelection: { label: 'Add selection', commands: [], skills: [], templateId: 'add-selection', sends: false },
	explainSelection: { label: 'Explain selection', commands: [], skills: ['explain'], templateId: 'explain-selection', sends: true },
	reviewChanges: { label: 'Review changes', commands: ['review'], skills: ['code-review', 'review'], templateId: 'review-changes', sends: true },
	reviewTurnChanges: { label: 'Review changes', commands: ['review'], skills: ['code-review', 'review'], templateId: 'review-turn-changes', sends: true },
	securityReviewChanges: { label: 'Security review', commands: ['security-review'], skills: ['security-review'], templateId: 'security-review-changes', sends: true },
	generateCommitMessage: { label: 'Generate commit message', commands: [], skills: [], templateId: 'generate-commit-message', sends: true },
	explainDiff: { label: 'Explain diff', commands: [], skills: ['explain'], templateId: 'explain-diff', sends: true },
	explainCommit: { label: 'Explain commit', commands: [], skills: ['explain'], templateId: 'explain-commit', sends: true },
	resolveConflicts: { label: 'Resolve conflicts', commands: ['resolve', 'resolve-conflicts'], skills: ['resolve', 'resolve-conflicts', 'merge-conflicts'], templateId: 'resolve-conflicts', sends: true },
	splitPullRequests: { label: 'Split into pull requests', commands: ['split-to-prs'], skills: ['split-to-prs', 'split-prs'], templateId: 'split-pull-requests', sends: true },
	generateReviewKnowledge: { label: 'Generate review knowledge', commands: [], skills: [], templateId: 'generate-review-knowledge', sends: true },
	fixProblems: { label: 'Fix problems', commands: [], skills: ['fix'], templateId: 'fix-problems', sends: true },
	fixTerminalError: { label: 'Fix this error', commands: [], skills: [], templateId: 'fix-terminal-error', sends: true },
	fixPreviewElement: { label: 'Fix preview element', commands: [], skills: [], templateId: 'fix-preview-element', sends: true },
};

const TEMPLATES: Record<string, string> = {
	'explain-selection': 'Explain the attached selection. Say what it does and anything that looks risky. Do not edit files.',
	'add-selection': '',
	'review-changes': 'Review the attached changes.',
	'review-turn-changes': 'Review the changes from this turn.',
	'security-review-changes': 'Review the attached changes for security problems: injection, unsafe input handling, leaked secrets, and auth or permission mistakes. Name the file and line of each problem. Do not edit files.',
	'generate-commit-message': 'Write a commit message for the attached diff. Reply with the message only.',
	'explain-diff': 'Explain the attached diff. Say what changed and anything that looks risky. Do not edit files.',
	'explain-commit': 'Explain the commit in the request. Inspect it with a read-only git show. Say what changed and why. Do not edit files or change the repository.',
	'resolve-conflicts': 'Resolve the merge conflicts in the attached files. Edit each working file so no conflict markers remain, keeping what both sides meant where you can, and explain each choice in one line. Read more with read-only git commands only (git show :1:<path> is the merge base, :2: ours, :3: theirs; git log). Do not stage, commit, continue or abort the merge, or run anything else that changes the repository.',
	// Issue 504: grouping is read-only and confirmed by the user; the current checkout is never touched, and nothing is pushed without asking.
	'split-pull-requests': 'Split the uncommitted changes in the attached diff into separate pull requests, one per purpose. First, without changing anything, group the changed hunks by purpose and show the groups: for each, a short title, a branch name and the files and hunks it takes. Then ask me with a question to confirm the groups or say what to move or rename, and wait for my answer. For each confirmed group, create its branch from the base branch in its own git worktree, apply only the hunks of that group there and make one commit. Never switch branches, reset, stash or commit in the current checkout. Ask me again before you push. When I approve, push each branch and open each pull request as a draft with gh pr create --draft, then list the branches and the pull request URLs.',
	// Issue 933: the full instructions come with the request (claudeReviewKnowledgePrompt); the template is only the fallback text.
	'generate-review-knowledge': 'Write the review knowledge file .claude/review-knowledge.md for this repository.',
	'fix-problems': 'Fix the attached problems.',
	'fix-terminal-error': 'Fix the error in the attached terminal output.',
	'fix-preview-element': 'Fix this element in the local preview.',
};

/** Phase 8 sends these. Later phases register the rest. */
export const PHASE_8_ACTION_IDS: readonly AgentActionId[] = ['addSelection', 'explainSelection'];

/** Changed-files card and the review editor. */
export const PHASE_12_ACTION_IDS: readonly AgentActionId[] = ['reviewTurnChanges', 'securityReviewChanges'];

/** Source Control review, commit message, and explain diff or commit. */
export const PHASE_16_ACTION_IDS: readonly AgentActionId[] = ['reviewChanges', 'generateCommitMessage', 'explainDiff', 'explainCommit', 'resolveConflicts', 'splitPullRequests', 'generateReviewKnowledge'];

/** Problems and failed-command gestures. */
export const PHASE_15_ACTION_IDS: readonly AgentActionId[] = ['fixProblems', 'fixTerminalError'];

export function actionSends(id: AgentActionId): boolean {
	return ACTION_PREFERENCES[id].sends;
}

/** Git and review actions carry their own context and do not need an editor selection. */
export function actionNeedsEditorSelection(id: AgentActionId): boolean {
	return id !== 'fixPreviewElement' && !PHASE_12_ACTION_IDS.includes(id) && !PHASE_16_ACTION_IDS.includes(id) && !PHASE_15_ACTION_IDS.includes(id);
}

export function actionTemplate(templateId: string): string {
	return TEMPLATES[templateId] ?? '';
}

export function actionLabel(id: AgentActionId): string {
	return ACTION_PREFERENCES[id].label;
}

/**
 * Command, then skill, then the built-in template. Lookup uses the session
 * init catalog. With preferClaudeCommands off, the template is always used.
 */
export function resolveAgentAction(id: AgentActionId, catalog: ActionCatalog): ActionResolution {
	const preference = ACTION_PREFERENCES[id];
	// A loaded `commit` skill can stage and commit. This action only writes a message.
	if (id === 'generateCommitMessage') {
		return { kind: 'prompt', templateId: preference.templateId };
	}
	if (catalog.preferClaudeCommands) {
		const command = preference.commands.find(name => catalog.slashCommands.includes(name));
		if (command) {
			return { kind: 'claude-command', command };
		}
		const skill = preference.skills.find(name => catalog.skills.includes(name));
		if (skill) {
			return { kind: 'skill', skill };
		}
	}
	return { kind: 'prompt', templateId: preference.templateId };
}

/** Outline symbols carry a name range and a full range. Chips use the full range. */
export function symbolChipRange(symbol: { readonly range: SerializedRange; readonly selectionRange?: SerializedRange }): SerializedRange {
	return symbol.range;
}

export function actionAvailable(id: AgentActionId): boolean {
	return PHASE_8_ACTION_IDS.includes(id) || PHASE_12_ACTION_IDS.includes(id) || PHASE_15_ACTION_IDS.includes(id) || PHASE_16_ACTION_IDS.includes(id) || id === 'fixPreviewElement';
}

export type PasteDecision = 'image' | 'plain' | 'selection-chip' | 'paste-pill' | 'insert';

/** A paste of this many lines or more becomes a pill in the message, whatever its length (issue 737). */
export const CLAUDE_PASTE_PILL_LINES = 5;

/**
 * `asReference: false` (`claude.composer.pasteAsReference`) inserts copied code
 * and long text as typed text instead of a selection chip or a pasted-text pill.
 * Long text is {@link CLAUDE_PASTE_PILL_LINES} lines or more, or `longPasteCharacters`.
 */
export function decidePaste(input: { readonly plain: boolean; readonly hasImage: boolean; readonly text: string; readonly copied: boolean; readonly longPasteCharacters: number; readonly asReference?: boolean }): PasteDecision {
	if (!input.plain && input.hasImage) {
		return 'image';
	}
	if (!input.text) {
		return 'insert';
	}
	if (input.plain) {
		return 'plain';
	}
	if (input.asReference === false) {
		return 'insert';
	}
	if (input.text && input.copied) {
		return 'selection-chip';
	}
	if (input.text.length >= input.longPasteCharacters || input.text.trim().split('\n').length >= CLAUDE_PASTE_PILL_LINES) {
		return 'paste-pill';
	}
	return 'insert';
}

export type WorkspaceDropDecision = 'ask' | 'image' | 'folder' | 'file';

export function decideWorkspaceDrop(insideWorkspace: boolean, imageName: boolean, directory: boolean): WorkspaceDropDecision {
	if (!insideWorkspace) {
		return 'ask';
	}
	if (imageName) {
		return 'image';
	}
	return directory ? 'folder' : 'file';
}

/** A selection chip is stale once the buffer's version is no longer the copied one. */
export function selectionIsStale(recordedVersion: number, modelVersion: number | undefined): boolean {
	return modelVersion !== undefined && modelVersion !== recordedVersion;
}

export function formatSentPrompt(sent: SentPromptRecord): string {
	const lines = [
		sent.compiled,
		'',
		`mode: ${sent.mode}`,
		`model: ${sent.modelId ?? ''}`,
		...(sent.auto ? [`auto: ${sent.auto.complexity}, ${sent.auto.modelId} ${sent.auto.effort ?? ''}`.trimEnd()] : []),
		`additional directories: ${(sent.additionalDirectories ?? []).join(', ')}`,
	];
	if (sent.resolution) {
		lines.push(`action: ${sent.resolution.kind} ${resolutionTarget(sent.resolution)}`);
	}
	return lines.join('\n');
}

function resolutionTarget(resolution: ActionResolution): string {
	switch (resolution.kind) {
		case 'claude-command':
			return resolution.command;
		case 'skill':
			return resolution.skill;
		case 'prompt':
			return resolution.templateId;
	}
}

/** Visible turn label, for example `Explain selection · via /explain`. */
export function actionTurnLabel(id: AgentActionId, resolution: ActionResolution): string {
	const label = actionLabel(id);
	switch (resolution.kind) {
		case 'claude-command':
			return `${label} · via /${resolution.command.replace(/^\//, '')}`;
		case 'skill':
			return `${label} · via /${resolution.skill.replace(/^\//, '')}`;
		case 'prompt':
			return `${label} · via template`;
	}
}

/** Visible request text. Explain commit names the commit and a read-only git show; Split into pull requests carries the groups confirmed in the split editor. */
export function actionRequestText(id: AgentActionId, resolution: ActionResolution, args?: Readonly<Record<string, string>>): string {
	const base = userTextForResolution(id, resolution);
	if (id === 'splitPullRequests' && args?.plan) {
		// The groups were confirmed in the split editor (splitPlanPrompt); Claude uses them as given.
		return `${base}

${args.plan}`;
	}
	if (id === 'generateReviewKnowledge' && args?.prompt) {
		return args.prompt;
	}
	if (id !== 'explainCommit' || !args) {
		return base;
	}
	const sha = typeof args.sha === 'string' && /^[0-9a-f]{7,64}$/i.test(args.sha) ? args.sha : undefined;
	const lines = [sha, args.subject, args.message].filter((line): line is string => !!line && line.length > 0);
	const inspect = sha
		? `Inspect commit ${sha} with a read-only git command: git show --stat --patch ${sha}. Do not edit files, stage, commit, or run a command that changes the repository.`
		: 'Do not edit files or change the repository.';
	const body = lines.length > 0 ? `${base}\n\n${lines.join('\n')}` : base;
	return `${body}\n\n${inspect}`;
}

export function userTextForResolution(id: AgentActionId, resolution: ActionResolution): string {
	switch (resolution.kind) {
		case 'claude-command':
			return `/${resolution.command.replace(/^\//, '')}`;
		case 'skill':
			return `/${resolution.skill.replace(/^\//, '')}`;
		case 'prompt':
			return actionTemplate(resolution.templateId) || actionLabel(id);
	}
}

/**
 * The command or skill pinned to a chat, as the resolution `compileSubmission` puts first (issue 488).
 * Claude Code runs a skill by its slash name too. A message that starts with its own slash command runs that one instead.
 */
export function pinnedCommandResolution(pinnedCommand: string | undefined, userText: string): ActionResolution | undefined {
	return pinnedCommand && !userText.trimStart().startsWith('/') ? { kind: 'claude-command', command: pinnedCommand } : undefined;
}

/** A prompt that is only a slash command, which Claude Code dispatches itself. */
export function isBareSlashCommand(text: string): boolean {
	return /^\/[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(text.trim());
}

/** One line per limited mode. The IDE enforces the limit; this only saves the model a refused call. */
const MODE_INSTRUCTIONS: Partial<Record<AgentMode, string>> = {
	debug: CLAUDE_DEBUG_MODE_INSTRUCTION,
	ask: 'Ask mode never changes files. Read, search, use the web, and run commands (the user approves each command) to answer. Do not write or edit any file.',
	plan: 'Plan mode does not change project files. Read, search, use the web, and run commands (the user approves each command) to inspect the code, then reply with a "# " title, then the details of the plan (what you found, the approach and why, and how each part changes, with files in backticks; use paragraphs, sub-headings and bullets as needed), and last a "## To-dos" heading over a numbered list of short tasks, one line each, with no explanation in the items since the details above carry it.',
};

/**
 * The instructions for `mode`. Plan mode names the folder plan files go in:
 * `planFolder` when the caller knows it, else Klawly's plans folder in the
 * user's home directory, which is what the tool policy lets Plan mode write.
 */
function modeInstruction(mode: AgentMode, planFolder?: string): string | undefined {
	const instruction = MODE_INSTRUCTIONS[mode];
	if (mode !== 'plan' || !instruction) {
		return instruction;
	}
	const folder = planFolder ? `Klawly's plans folder for this user, ${planFolder}` : 'the Klawly plans folder in your home directory (~/.klawly/plans)';
	return `${instruction} The only files you may write are plan files, and your reply is the plan, so you need none. If you write one, put it in ${folder}, not in the project, unless the user asks for it there; then use a *.plan.md file or the project's .claude/plans/ folder.`;
}

/**
 * Re-targets a prompt that `compilePrompt` built for another mode: the request
 * tag names `mode` and the mode instructions match it. Attachments and context
 * blocks stay as sent. A bare slash command has no tags and is returned as is.
 * Used by Switch to Agent and Retry on a write that Plan or Ask blocked.
 */
export function retargetCompiledPrompt(compiled: string, mode: AgentMode, planFolder?: string): string {
	const opening = /^<ide_request mode="[^"]*">/;
	const closing = '\n\n</ide_request>';
	const end = compiled.indexOf(closing);
	if (!opening.test(compiled) || end < 0) {
		return compiled;
	}
	const head = compiled.slice(0, end + closing.length).replace(opening, `<ide_request mode="${escapeAttr(mode)}">`);
	const rest = compiled.slice(end + closing.length).replace(/^\n\n<mode_instructions>\n[\s\S]*?\n<\/mode_instructions>/, '');
	const instruction = modeInstruction(mode, planFolder);
	return instruction ? `${head}\n\n<mode_instructions>\n${instruction}\n</mode_instructions>${rest}` : `${head}${rest}`;
}

export function compilePrompt(envelope: AgentEnvelope): string {
	const blocks: string[] = [];
	blocks.push(`<ide_request mode="${escapeAttr(envelope.mode)}">`);
	blocks.push(escapeBody(envelope.userText));
	blocks.push('</ide_request>');
	const instruction = modeInstruction(envelope.mode, envelope.planFolder);
	if (instruction) {
		blocks.push(`<mode_instructions>\n${instruction}\n</mode_instructions>`);
	}

	if (envelope.activeFile) {
		const file = envelope.activeFile;
		blocks.push(`<active_editor path="${escapeAttr(file.relativePath)}" cursor_line="${file.cursorLine}">`);
		const alreadyAttached = !!file.selection && envelope.attachments.some(attachment => attachment.kind === 'selection' && attachment.content === file.selection);
		if (file.selection && !alreadyAttached) {
			blocks.push(escapeBody(file.selection));
		}
		blocks.push('</active_editor>');
	}

	for (const attachment of envelope.attachments) {
		const rendered = renderAttachment(attachment);
		if (rendered) {
			blocks.push(rendered);
		}
	}
	if (envelope.diagnostics.length > 0) {
		blocks.push(renderDiagnostics(envelope.diagnostics));
	}
	return blocks.join('\n\n');
}

/**
 * Bare slash commands with no attachments stay raw so Claude Code can dispatch
 * them. Everything else is tagged blocks. A resolved command or skill is the
 * first line when the prompt also carries context.
 */
export function compileSubmission(envelope: AgentEnvelope, resolution?: ActionResolution): string {
	const bare = isBareSlashCommand(envelope.userText)
		&& envelope.attachments.length === 0
		&& !envelope.activeFile?.selection
		&& envelope.diagnostics.length === 0;
	if (bare && !resolution) {
		return envelope.userText.trim();
	}
	const body = compilePrompt(envelope);
	if (!resolution || resolution.kind === 'prompt') {
		return bare ? envelope.userText.trim() : body;
	}
	const command = resolution.kind === 'claude-command' ? resolution.command : resolution.skill;
	const slash = `/${command.replace(/^\//, '')}`;
	if (bare) {
		return slash;
	}
	return `${slash}\n\n${body}`;
}

export function renderAttachment(attachment: ResolvedAttachment): string {
	switch (attachment.kind) {
		case 'file':
			return block(
				`attachment kind="file" path="${escapeAttr(attachment.path)}"${attachment.languageId ? ` language="${escapeAttr(attachment.languageId)}"` : ''}${attachment.unsaved ? ' unsaved="true"' : ''}${attachment.truncated ? ' truncated="true"' : ''}`,
				attachment.content,
			);
		case 'folder':
			return `<attachment kind="folder" path="${escapeAttr(attachment.path)}"></attachment>`;
		case 'symbol':
			return block(
				`attachment kind="symbol" path="${escapeAttr(attachment.path)}" name="${escapeAttr(attachment.name)}" range="${escapeAttr(formatRange(attachment.range))}"${attachment.truncated ? ' truncated="true"' : ''}`,
				attachment.content,
			);
		case 'selection':
			return block(
				`attachment kind="selection" path="${escapeAttr(attachment.path)}"${attachment.languageId ? ` language="${escapeAttr(attachment.languageId)}"` : ''} range="${escapeAttr(formatRange(attachment.range))}"${attachment.stale ? ' stale="true"' : ''}${attachment.truncated ? ' truncated="true"' : ''}`,
				attachment.content,
			);
		case 'diagnostics':
			return renderDiagnostics(attachment.items);
		case 'git-diff':
			return block(
				`attachment kind="git-diff" scope="${escapeAttr(attachment.scope)}"${attachment.ref ? ` ref="${escapeAttr(attachment.ref)}"` : ''}${attachment.truncated ? ' truncated="true"' : ''}`,
				`${attachment.stat}\n${attachment.patch}`.trim(),
			);
		case 'terminal':
			return block(
				`attachment kind="terminal" title="${escapeAttr(attachment.title)}"${attachment.truncated ? ' truncated="true"' : ''}`,
				attachment.lines,
			);
		case 'image':
			return `<attachment kind="image" path="${escapeAttr(attachment.path)}"></attachment>`;
		case 'pasted-text':
			return block(
				`attachment kind="pasted-text"${attachment.label ? ` name="${escapeAttr(attachment.label)}"` : ''} lines="${attachment.lineCount}"${attachment.truncated ? ' truncated="true"' : ''}`,
				attachment.text,
			);
		case 'chat':
			return renderChatReferenceBlock(attachment.reference)?.text ?? '';
	}
}

/** User-visible chat mention. A deleted chat is omitted from the prompt. */
export function renderChatReferenceBlock(input: ChatReferenceInput | undefined, inlineLimit = CLAUDE_ATTACHMENT_CHAR_LIMIT): { readonly text: string; readonly large: boolean } | undefined {
	if (!input || input.deleted) {
		return undefined;
	}
	const turns = `${input.turnStart}-${input.turnEnd}`;
	const workspace = input.otherWorkspace && input.workspaceName ? ` workspace="${escapeAttr(input.workspaceName)}"` : '';
	const full = input.scope === 'full' ? clipText(input.fullTranscript ?? input.summary, inlineLimit) : undefined;
	const body = full ? full.text : `Summary: ${input.summary}`;
	const large = !!full?.truncated || (input.fullTranscript ?? '').length > inlineLimit;
	const truncated = full?.truncated ? ' truncated="true"' : '';
	const text = `<chat_reference title="${escapeAttr(input.title)}" turns="${escapeAttr(turns)}" as_of_turn="${input.asOfTurn}" path="${escapeAttr(input.path)}" scope="${input.scope}"${workspace}${truncated}>\n${escapeBody(body)}\n</chat_reference>`;
	return { text, large };
}

export function formatRange(range: SerializedRange): string {
	return `${range.startLine}:${range.startColumn}-${range.endLine}:${range.endColumn}`;
}

/** Hover text: the source and range that send will resolve, plus a short snippet. */
export function describeResolved(attachment: ResolvedAttachment): string {
	switch (attachment.kind) {
		case 'file':
			return `${attachment.path}${attachment.unsaved ? ' · unsaved' : ''}${attachment.truncated ? ' · truncated' : ''}${attachment.content ? `\n${firstLines(attachment.content)}` : ''}`;
		case 'folder':
			return attachment.path;
		case 'symbol':
			return `${attachment.path} · ${attachment.name} · ${formatRange(attachment.range)}\n${firstLines(attachment.content)}`;
		case 'selection':
			return `${attachment.path} · ${formatRange(attachment.range)}${attachment.stale ? ' · file changed, current text will be sent' : ''}\n${firstLines(attachment.content)}`;
		case 'diagnostics':
			return attachment.items.map(item => `${item.severity} ${item.path ?? item.uri ?? 'workspace'}${item.line ? `:${item.line}` : ''}${item.column ? `:${item.column}` : ''}${item.code ? ` [${item.code}]` : ''}: ${item.message}`).join('\n') || 'No problems';
		case 'git-diff':
			return `${attachment.scope}${attachment.ref ? ` ${attachment.ref}` : ''}\n${firstLines(attachment.stat)}\n${firstLines(attachment.patch)}`;
		case 'terminal':
			return `${attachment.title}\n${firstLines(attachment.lines)}`;
		case 'image':
			return attachment.path;
		case 'pasted-text':
			return `${attachment.label ?? `Pasted text · ${attachment.lineCount} lines`}\n${firstLines(attachment.text)}`;
		case 'chat': {
			const reference = attachment.reference;
			if (!reference || reference.deleted) {
				return `Chat ${attachment.sessionId} · deleted`;
			}
			const where = reference.otherWorkspace && reference.workspaceName ? ` · ${reference.workspaceName}` : '';
			return `${reference.title} · turns ${reference.turnStart}-${reference.turnEnd} · as of turn ${reference.asOfTurn}${where}\n${reference.summary}`;
		}
	}
}

function firstLines(text: string, count = 8): string {
	return text.split('\n').slice(0, count).join('\n');
}

export function clipText(text: string, limit = CLAUDE_ATTACHMENT_CHAR_LIMIT): { text: string; truncated: boolean } {
	if (text.length <= limit) {
		return { text, truncated: false };
	}
	return { text: text.slice(0, limit), truncated: true };
}

/** Higher is a better match. Zero means the query is not a subsequence. */
export function rankContextCandidate(query: string, label: string): number {
	const needle = query.trim().toLowerCase();
	if (!needle) {
		return 1;
	}
	const hay = label.toLowerCase();
	if (hay.startsWith(needle)) {
		return 300 - hay.length;
	}
	const at = hay.indexOf(needle);
	if (at >= 0) {
		return 200 - at;
	}
	let from = 0;
	for (const char of needle) {
		const next = hay.indexOf(char, from);
		if (next < 0) {
			return 0;
		}
		from = next + 1;
	}
	return 100 - Math.min(hay.length, 80);
}

export function escapeAttr(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

/** File bodies are context. Escaping stops them from closing the surrounding tag. */
export function escapeBody(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function renderDiagnostics(items: readonly DiagnosticSummary[]): string {
	const lines = items.map(item => {
		const attrs = [`severity="${escapeAttr(item.severity)}"`];
		if (item.uri) {
			attrs.push(`uri="${escapeAttr(item.uri)}"`);
		}
		if (item.path) {
			attrs.push(`path="${escapeAttr(item.path)}"`);
		}
		if (item.line !== undefined) {
			attrs.push(`line="${item.line}"`);
		}
		if (item.column !== undefined) {
			attrs.push(`column="${item.column}"`);
		}
		if (item.source) {
			attrs.push(`source="${escapeAttr(item.source)}"`);
		}
		if (item.code) {
			attrs.push(`code="${escapeAttr(item.code)}"`);
		}
		attrs.push(`message="${escapeAttr(item.message)}"`);
		return attrs.join(' ');
	});
	return block('attachment kind="diagnostics"', lines.join('\n'));
}

function block(attrs: string, body: string | undefined): string {
	if (!body) {
		return `<${attrs}></attachment>`;
	}
	return `<${attrs}>\n${escapeBody(body)}\n</attachment>`;
}
