/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { renderMarkdown } from '../../../../../base/browser/markdownRenderer.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { CLAUDE_CANVAS_TOOL_ID, readClaudeCanvasResult } from '../../../../../platform/claude/common/claudeCanvas.js';
import { CLAUDE_CI_WAIT_TOOL_ID } from '../../../../../platform/claude/common/claudeNoModelTools.js';
import { CLAUDE_REPRODUCE_TOOL_ID, readClaudeReproductionSent } from '../../../../../platform/claude/common/claudeDebugMode.js';
import { CLAUDE_TERMINAL_TOOL_ID } from '../../../../../platform/claude/common/claudeTerminalRun.js';
import { ReviewFile } from '../../../../services/claude/common/claudeReview.js';
import { COMMAND_OUTPUT_LINE_HEIGHT, nextCommandScroll, NotebookCellEdit, ToolCardModel, visibleLineWindow } from '../../../../services/claude/common/claudeToolCards.js';
import { appendDiffStat } from '../review/claudeChangesCard.js';
import { describeExit, describeMatchCount, hiddenCommandLines, miniDiffRows, OutputRow, outputRows, searchResultRows, splitPath } from '../../common/claudeTimelineModel.js';

/** Search results shown before "+ N more". */
const SEARCH_ROWS = 6;

export interface ClaudeCommandScroll {
	scrollTop: number;
	scrollLeft: number;
	follow: boolean;
}

/** Interactive commands Claude handed to the user in a terminal (issue 452). */
export interface ClaudeToolTerminalRuns {
	readonly onDidChange: Event<void>;
	/** The run of this chat that waits for the user on `command`, if any. */
	find(command: string): { readonly requestId: string; readonly reason?: string } | undefined;
	open(requestId: string): void;
	cancel(requestId: string): void;
}

/** Debug mode's reproductions of this chat that wait for the user (issue 484). */
export interface ClaudeToolReproductions {
	readonly onDidChange: Event<void>;
	/** The reproduction of this chat that waits for the user, if any. */
	find(): { readonly requestId: string; readonly steps?: string; readonly capturing: boolean } | undefined;
	start(requestId: string): void;
	finish(requestId: string): void;
	cancel(requestId: string): void;
}

/** What a tool card can ask the timeline to do. */
export interface ClaudeToolCardActions {
	toggle(cardId: string): void;
	/** Shows a path relative to the workspace when it is inside it. */
	displayPath(path: string): string;
	openFile(path: string, line: number | undefined): void;
	/** The name of an image the user attached when `path` is one, so its Read folds (issue 744). */
	attachedImage?(path: string): string | undefined;
	copyCommand(command: string): void;
	rerunCommand(command: string, cwd: string | undefined): void;
	openCommandLog(): void;
	openInTerminal(cwd: string | undefined): void;
	fixCommandError?(card: ToolCardModel): void;
	/** Keeps the file's changes in `turnId`, the turn that drew the card. */
	keepFile?(turnId: string, uri: URI): void;
	/** Undoes the file's changes in `turnId`, the turn that drew the card. */
	undoFile?(turnId: string, uri: URI): void;
	openDiff?(turnId: string, uri: URI, conflict: boolean): void;
	/** Command preview scroll by card id, so a repaint does not jump to the first line. */
	readonly commandScroll: Map<string, ClaudeCommandScroll>;
	readonly terminalRuns?: ClaudeToolTerminalRuns;
	readonly reproductions?: ClaudeToolReproductions;
	/** An SVG file Claude wrote, as a data URI an image can show (issue 494). Undefined when it cannot be read. */
	previewImage?(path: string): Promise<string | undefined>;
	/** Saves a copy of the image where the user picks. */
	saveImageAs?(path: string): void;
	/** Opens the canvas a `klawly_canvas` call saved (issue 493). */
	openCanvas?(path: string, title: string): void;
	/** Draws the MCP App an MCP tool names, at the end of `container` (issue 513). */
	mountMcpApp?(container: HTMLElement, card: ToolCardModel): ClaudeMcpAppMount;
}

/** An MCP App under an MCP tool's card, which follows the call as it runs and ends. */
export interface ClaudeMcpAppMount extends IDisposable {
	update(card: ToolCardModel): void;
}

/** True for a write or edit of an SVG file, which the card also shows as an image (issue 494). */
export function isClaudeSvgCard(card: ToolCardModel): boolean {
	return card.kind === 'edit' && !!card.file && /\.svg$/i.test(card.file);
}

function toolStateLabel(state: ToolCardModel['state'], name?: string): string {
	switch (state) {
		case 'running': return name === CLAUDE_CI_WAIT_TOOL_ID ? localize('claudeToolStateWaitingOnCi', "Waiting on CI") : localize('claudeToolStateRunning', "running");
		case 'failed': return localize('claudeToolStateFailed', "failed");
		case 'interrupted': return localize('claudeToolStateInterrupted', "interrupted");
		case 'cancelled': return localize('claudeToolStateCancelled', "cancelled");
		case 'success': return localize('claudeToolStateDone', "done");
	}
}

export function claudeToolIcon(card: ToolCardModel): ThemeIcon {
	switch (card.kind) {
		case 'file': return Codicon.file;
		case 'search': return card.name === 'Glob' ? Codicon.listTree : Codicon.searchCompact;
		case 'edit': return card.notebook ? Codicon.notebook : card.name === 'Write' ? Codicon.newFile : Codicon.editCompact;
		case 'command': return Codicon.terminalCompact;
		case 'skill': return Codicon.book;
		case 'mcp': return Codicon.plug;
		case 'web': return Codicon.globe;
		default: return Codicon.tools;
	}
}

/**
 * True when the card has something to show below its row. An edit has its
 * mini-diff, Keep and Undo only once the edit has landed and its review is loaded.
 */
export function claudeToolExpandable(card: ToolCardModel, reviewFile: ReviewFile | undefined): boolean {
	switch (card.kind) {
		case 'command': return true;
		case 'search': return card.lines.some(line => line.trim().length > 0) || !!card.error;
		case 'edit': return (card.state === 'success' && (!!reviewFile || !!card.notebook)) || !!card.error;
		// Issue 1061: a captured reproduction opens to the exact lines Claude read.
		default: return !!card.error || (card.name === CLAUDE_REPRODUCE_TOOL_ID && card.state === 'success' && !!readClaudeReproductionSent(card.lines.join('\n')));
	}
}

/**
 * One tool call in the timeline. The row element, its summary button and a
 * running command's output element stay in place: an update patches them, so
 * hover, focus and scroll survive streaming.
 */
export class ClaudeToolCardView extends Disposable {
	readonly element: HTMLElement;
	private readonly _summary: HTMLButtonElement;
	private readonly _bodyStore = this._register(new DisposableStore());
	private _card: ToolCardModel | undefined;
	private _reviewFile: ReviewFile | undefined;
	private _bodyKey: string | undefined;
	private _command: ClaudeCommandOutputView | undefined;
	private _footerKey: string | undefined;
	/** Command cards whose output shows in full height (issue 745). */
	private readonly _expandedOutput = new Set<string>();
	private readonly _footerStore = this._register(new DisposableStore());
	private _waitKey: string | undefined;
	private readonly _waitStore = this._register(new DisposableStore());
	private readonly _waitListener = this._register(new MutableDisposable());
	private _imageKey: string | undefined;
	private readonly _imageStore = this._register(new DisposableStore());
	private readonly _mcpImageStore = this._register(new DisposableStore());
	private _mcpImageKey: string | undefined;
	private _canvasKey: string | undefined;
	private readonly _canvasStore = this._register(new DisposableStore());
	private _reproduceKey: string | undefined;
	private readonly _reproduceStore = this._register(new DisposableStore());
	private readonly _mcpApp = this._register(new MutableDisposable<ClaudeMcpAppMount>());

	/**
	 * @param _turnId The turn that draws this card. Keep, Undo and Open Diff act on that turn's review.
	 */
	constructor(parent: HTMLElement, private readonly _turnId: string, private readonly _actions: ClaudeToolCardActions) {
		super();
		this.element = append(parent, $('.claude-tool'));
		this._summary = append(this.element, $<HTMLButtonElement>('button.claude-tool-row'));
		this._summary.type = 'button';
		this._register(addDisposableListener(this._summary, EventType.CLICK, event => {
			event.preventDefault();
			if (this._card && claudeToolExpandable(this._card, this._reviewFile)) {
				this._actions.toggle(this._card.id);
			} else if (this._card?.file && this.attachedImage(this._card)) {
				this._actions.openFile(this._card.file, undefined);
			}
		}));
	}

	update(card: ToolCardModel, open: boolean, landedReviewFile: ReviewFile | undefined): void {
		// Only an edit that landed is described by the review of its file: a running edit has not
		// landed yet, and a failed, cancelled or interrupted one changed nothing (a retry may have).
		const reviewFile = card.state === 'success' ? landedReviewFile : undefined;
		const expandable = claudeToolExpandable(card, reviewFile);
		const shown = open && expandable;
		this._card = card;
		this._reviewFile = reviewFile;
		const state = card.state === 'running' ? 'is-running' : card.state === 'failed' ? 'is-failed' : card.state === 'interrupted' ? 'is-interrupted' : card.state === 'success' ? 'is-success' : 'is-cancelled';
		this.element.className = ['claude-tool', `is-${card.kind}`, state, card.kind === 'command' ? 'is-boxed' : '', shown ? 'is-open' : ''].filter(Boolean).join(' ');
		this.element.setAttribute('data-tool-id', card.id);
		this.paintSummary(card, expandable, shown, reviewFile);
		this.paintTerminalWait(card);
		this.paintBody(card, shown, reviewFile);
		this.paintImage(card, reviewFile);
		this.paintCanvas(card);
		this.paintReproduceSent(card, shown);
		this.paintMcpApp(card);
		this.paintMcpImages(card);
	}

	/** Issue 493, DL-64: a canvas Claude saved shows its title under its row, with Open Canvas and Edit Source. */
	private paintCanvas(card: ToolCardModel): void {
		const canvas = card.name === CLAUDE_CANVAS_TOOL_ID && card.state === 'success' && this._actions.openCanvas ? readClaudeCanvasResult(card.lines.join('\n')) : undefined;
		const key = canvas ? `${canvas.path}|${canvas.title}` : undefined;
		if (key === this._canvasKey) {
			return;
		}
		this._canvasStore.clear();
		this._canvasKey = key;
		if (!canvas) {
			return;
		}
		const row = append(this.element, $('.claude-tool-canvas'));
		this._canvasStore.add({ dispose: () => row.remove() });
		append(row, $('span.title')).textContent = canvas.title;
		textButton(row, 'button.claude-btn.is-small', localize('claudeToolCanvasOpen', "Open Canvas"), this._canvasStore, () => this._actions.openCanvas?.(canvas.path, canvas.title));
		textButton(row, 'button.claude-btn.is-small.is-ghost', localize('claudeToolCanvasSource', "Edit Source"), this._canvasStore, () => this._actions.openFile(canvas.path, undefined));
	}

	/**
	 * Issue 1061, DL-50: a captured reproduction says under its row how many
	 * lines of each source Claude read, with a button that shows them.
	 */
	private paintReproduceSent(card: ToolCardModel, shown: boolean): void {
		const sent = card.name === CLAUDE_REPRODUCE_TOOL_ID && card.state === 'success' ? readClaudeReproductionSent(card.lines.join('\n')) : undefined;
		const key = sent ? `${JSON.stringify(sent)}|${shown}` : undefined;
		if (key === this._reproduceKey) {
			return;
		}
		this._reproduceStore.clear();
		this._reproduceKey = key;
		if (!sent) {
			return;
		}
		const row = append(this.element, $('.claude-tool-reproduce-sent'));
		this._reproduceStore.add({ dispose: () => row.remove() });
		append(row, $('span.title')).textContent = sent.dropped
			? localize('claudeReproduceSentDropped', "Sent: {0} instrumentation, {1} debug, {2} terminal, {3} console lines ({4} older dropped)", sent.instrumentation, sent.debug, sent.terminal, sent.console, sent.dropped)
			: localize('claudeReproduceSent', "Sent: {0} instrumentation, {1} debug, {2} terminal, {3} console lines", sent.instrumentation, sent.debug, sent.terminal, sent.console);
		const view = textButton(row, 'button.claude-btn.is-small.is-ghost', shown ? localize('claudeReproduceHideLines', "Hide Lines") : localize('claudeReproduceViewLines', "View Lines"), this._reproduceStore, () => this._actions.toggle(card.id));
		view.setAttribute('aria-expanded', shown ? 'true' : 'false');
	}

	/** Issue 513: an MCP tool's card draws the app the tool names, if any, under its row. */
	private paintMcpApp(card: ToolCardModel): void {
		if (card.kind !== 'mcp' || !this._actions.mountMcpApp) {
			this._mcpApp.clear();
			return;
		}
		if (this._mcpApp.value) {
			this._mcpApp.value.update(card);
		} else {
			this._mcpApp.value = this._actions.mountMcpApp(this.element, card);
		}
	}

	/**
	 * Issue 897: the raster images an MCP tool returned (a generated picture, a
	 * chart) show under its row. They are data URIs in an image element, so
	 * nothing in them runs, and only the types the protocol allows reach here.
	 */
	private paintMcpImages(card: ToolCardModel): void {
		const images = card.kind === 'mcp' && card.state === 'success' ? card.mcpImages : undefined;
		const key = images?.length ? images.map(image => `${image.mimeType}:${image.data.length}`).join('|') : undefined;
		if (key === this._mcpImageKey) {
			return;
		}
		this._mcpImageStore.clear();
		this._mcpImageKey = key;
		if (!images?.length) {
			return;
		}
		const frame = append(this.element, $('.claude-tool-image'));
		this._mcpImageStore.add({ dispose: () => frame.remove() });
		for (const source of images) {
			const image = append(frame, $<HTMLImageElement>('img'));
			image.alt = localize('claudeToolMcpImageAlt', "Image returned by {0}", card.name);
			image.src = `data:${source.mimeType};base64,${source.data}`;
		}
	}

	/**
	 * Issue 494: an SVG file Claude wrote also shows as an image under its row, with
	 * Save To and Open. It is shown in an image element, so scripts in it never run.
	 */
	private paintImage(card: ToolCardModel, reviewFile: ReviewFile | undefined): void {
		const preview = this._actions.previewImage;
		const file = card.file;
		const key = preview && file && isClaudeSvgCard(card) && card.state === 'success' ? `${file}|${reviewSignature(reviewFile)}` : undefined;
		if (key === this._imageKey) {
			return;
		}
		this._imageStore.clear();
		this._imageKey = key;
		if (!key || !preview || !file) {
			return;
		}
		const frame = append(this.element, $('.claude-tool-image'));
		this._imageStore.add({ dispose: () => frame.remove() });
		const image = append(frame, $<HTMLImageElement>('img'));
		image.alt = localize('claudeToolImageAlt', "Image Claude wrote: {0}", this._actions.displayPath(file));
		frame.hidden = true;
		const actions = append(frame, $('.claude-tool-image-actions'));
		if (this._actions.saveImageAs) {
			textButton(actions, 'button.claude-btn.is-small.is-ghost', localize('claudeToolImageSave', "Save To..."), this._imageStore, () => this._actions.saveImageAs?.(file));
		}
		textButton(actions, 'button.claude-btn.is-small.is-ghost', localize('claudeToolImageOpen', "Open"), this._imageStore, () => this._actions.openFile(file, undefined));
		void preview(file).then(source => {
			if (this._imageKey === key && source) {
				image.src = source;
				frame.hidden = false;
			}
		});
	}

	/**
	 * DL-50: a run_in_terminal call that waits for the user says so under its row,
	 * with Open Terminal and Cancel, until the command ends (issue 452).
	 */
	private paintTerminalWait(card: ToolCardModel): void {
		if (card.name === CLAUDE_REPRODUCE_TOOL_ID) {
			this.paintReproduceWait(card);
			return;
		}
		const runs = this._actions.terminalRuns;
		if (!runs || card.name !== CLAUDE_TERMINAL_TOOL_ID || card.state !== 'running') {
			this._waitListener.clear();
			this.clearTerminalWait();
			return;
		}
		if (!this._waitListener.value) {
			this._waitListener.value = runs.onDidChange(() => {
				if (this._card) {
					this.paintTerminalWait(this._card);
				}
			});
		}
		const run = card.command ? runs.find(card.command) : undefined;
		const key = run ? `${run.requestId}|${run.reason ?? ''}` : undefined;
		if (key === this._waitKey) {
			return;
		}
		this.clearTerminalWait();
		this._waitKey = key;
		if (!run) {
			return;
		}
		const wait = $('.claude-terminal-wait');
		this._summary.after(wait);
		this._waitStore.add({ dispose: () => wait.remove() });
		wait.setAttribute('role', 'status');
		append(wait, $(ThemeIcon.asCSSSelector(Codicon.terminal) + '.icon'));
		const text = append(wait, $('.text'));
		append(text, $('strong')).textContent = localize('claudeTerminalWaiting', "Waiting for you in the terminal");
		if (run.reason) {
			const reason = append(text, $('span.reason'));
			reason.textContent = run.reason;
			reason.title = run.reason;
		}
		textButton(wait, 'button.claude-btn.is-small.is-primary', localize('claudeTerminalOpen', "Open Terminal"), this._waitStore, () => runs.open(run.requestId)).title = localize('claudeTerminalOpenTitle', "Show the terminal");
		textButton(wait, 'button.claude-btn.is-small.is-ghost', localize('claudeTerminalCancel', "Cancel"), this._waitStore, () => runs.cancel(run.requestId)).title = localize('claudeTerminalCancelTitle', "Stop the command and tell Claude");
	}

	/**
	 * DL-50: Debug mode's request_reproduction call waits under its row with the
	 * steps, Start Capturing, then I Reproduced It; Cancel throughout (issue 484).
	 * The captured lines come back as the tool's result, in the card's body.
	 */
	private paintReproduceWait(card: ToolCardModel): void {
		const reproductions = this._actions.reproductions;
		if (!reproductions || card.state !== 'running') {
			this._waitListener.clear();
			this.clearTerminalWait();
			return;
		}
		if (!this._waitListener.value) {
			this._waitListener.value = reproductions.onDidChange(() => {
				if (this._card) {
					this.paintTerminalWait(this._card);
				}
			});
		}
		const view = reproductions.find();
		const key = view ? `${view.requestId}|${view.capturing}` : undefined;
		if (key === this._waitKey) {
			return;
		}
		this.clearTerminalWait();
		this._waitKey = key;
		if (!view) {
			return;
		}
		const wait = $('.claude-terminal-wait.is-reproduce');
		this._summary.after(wait);
		this._waitStore.add({ dispose: () => wait.remove() });
		wait.setAttribute('role', 'status');
		append(wait, $(ThemeIcon.asCSSSelector(view.capturing ? Codicon.record : Codicon.bug) + '.icon'));
		const text = append(wait, $('.text'));
		append(text, $('strong')).textContent = view.capturing
			? localize('claudeReproduceCapturing', "Capturing logs. Reproduce the bug now.")
			: localize('claudeReproduceTitle', "Claude needs you to reproduce the bug");
		if (view.steps) {
			append(text, $('span.reason')).textContent = view.steps;
		}
		if (view.capturing) {
			textButton(wait, 'button.claude-btn.is-small.is-primary', localize('claudeReproduceDone', "I Reproduced It"), this._waitStore, () => reproductions.finish(view.requestId)).title = localize('claudeReproduceDoneTitle', "Send the captured log lines to Claude");
		} else {
			textButton(wait, 'button.claude-btn.is-small.is-primary', localize('claudeReproduceStart', "Start Capturing"), this._waitStore, () => reproductions.start(view.requestId)).title = localize('claudeReproduceStartTitle', "Keep what the instrumentation logs from now on");
		}
		textButton(wait, 'button.claude-btn.is-small.is-ghost', localize('claudeReproduceCancel', "Cancel"), this._waitStore, () => reproductions.cancel(view.requestId)).title = localize('claudeReproduceCancelTitle', "Tell Claude you will not reproduce it now");
	}

	private clearTerminalWait(): void {
		this._waitStore.clear();
		this._waitKey = undefined;
	}

	private attachedImage(card: ToolCardModel): string | undefined {
		return card.kind === 'file' && card.file ? this._actions.attachedImage?.(card.file) : undefined;
	}

	private paintSummary(card: ToolCardModel, expandable: boolean, shown: boolean, reviewFile: ReviewFile | undefined): void {
		const summary = this._summary;
		clearNode(summary);
		if (expandable) {
			summary.setAttribute('aria-expanded', shown ? 'true' : 'false');
		} else {
			summary.removeAttribute('aria-expanded');
			summary.removeAttribute('aria-controls');
		}
		const running = card.state === 'running';
		const attached = this.attachedImage(card);
		// Row glyphs are drawn at the compact size, so they use the compact glyphs.
		const icon = running ? Codicon.loadingCompact : card.state === 'failed' && card.kind !== 'command' ? Codicon.errorCompact : card.state === 'interrupted' ? Codicon.warningCompact : attached ? Codicon.fileMedia : claudeToolIcon(card);
		append(summary, $(ThemeIcon.asCSSSelector(icon) + '.status' + (running ? '.codicon-modifier-spin' : '')));
		if (attached) {
			// Claude looking at an image the user attached: said in words, with the image's own name (issue 744).
			append(summary, $('span.verb')).textContent = localize('claudeVerbViewedAttachedImage', "Viewed attached image");
			summary.append(' ');
			append(summary, $('span.target')).textContent = attached;
		} else if (card.kind === 'command') {
			// "Running" while it runs, then "Ran"; the exit badge says how it ended.
			append(summary, $('span.verb')).textContent = card.state === 'failed' ? localize('claudeVerbRanFailed', "Ran") : card.verb;
			summary.append(' ');
			// DL-75: what the command does, in words, when Claude said it; the opened card shows the full command (issue 745).
			const target = append(summary, $(card.description ? 'span.target' : 'span.target.claude-mono'));
			target.textContent = card.description ?? card.target;
			target.title = card.command ?? card.target;
		} else {
			append(summary, $('span.verb')).textContent = card.verb;
			summary.append(' ');
			if ((card.kind === 'file' || card.kind === 'edit') && card.file) {
				// The file name leads and its folder follows, dim, so a long path never cuts the name off.
				const { name, folder } = splitPath(this._actions.displayPath(card.file));
				append(summary, $('span.target')).textContent = name;
				if (folder) {
					summary.append(' ');
					append(summary, $('span.folder')).textContent = folder;
				}
				if (reviewFile?.isNew) {
					append(summary, $('span.claude-new-pill')).textContent = localize('claudeNewFile', "new");
				}
			} else {
				append(summary, $('span.target')).textContent = card.target;
			}
		}
		const meta = append(summary, $('span.meta'));
		this.paintMeta(meta, card, reviewFile);
		if (expandable) {
			append(meta, $(ThemeIcon.asCSSSelector(Codicon.chevronRightCompact) + '.chev'));
		}
		// The status icon is decorative; screen readers get the state in words.
		// A running command's verb already says it ("Running").
		if (card.kind !== 'command' || !running) {
			append(summary, $('span.claude-sr-only')).textContent = ` ${toolStateLabel(card.state, card.name)}`;
		}
	}

	private paintMeta(meta: HTMLElement, card: ToolCardModel, reviewFile: ReviewFile | undefined): void {
		if (card.kind === 'command') {
			if (card.state === 'running') {
				append(meta, $('span.claude-faint')).textContent = localize('claudeCommandRunning', "running");
			} else if (card.exitCode !== undefined) {
				const ok = card.exitCode === 0;
				const badge = append(meta, $('span.claude-badge' + (ok ? '.is-success' : '.is-error')));
				append(badge, $(ThemeIcon.asCSSSelector(ok ? Codicon.checkCompact : Codicon.closeCompact)));
				append(badge, $('span')).textContent = describeExit(card.exitCode);
			} else if (card.state !== 'success') {
				append(meta, $('span.claude-faint')).textContent = toolStateLabel(card.state, card.name);
			}
			return;
		}
		// A notebook's JSON line counts mean little; its cell card says which cell changed (issue 526).
		if (card.kind === 'edit' && !card.notebook && reviewFile && (reviewFile.added > 0 || reviewFile.removed > 0)) {
			appendDiffStat(meta, reviewFile.added, reviewFile.removed);
			return;
		}
		if (card.meta) {
			append(meta, $('span.text')).textContent = card.meta;
		}
	}

	private paintBody(card: ToolCardModel, shown: boolean, reviewFile: ReviewFile | undefined): void {
		if (!shown) {
			this.clearBody();
			return;
		}
		if (card.kind === 'command') {
			if (!this._command) {
				this.clearBody();
				this._command = this._bodyStore.add(new ClaudeCommandOutputView(this.element, card.id, this._actions.commandScroll));
				this._bodyKey = 'command';
				this.linkBody(this._command.scroller);
			}
			this._command.setExpanded(this._expandedOutput.has(card.id));
			this._command.update(card);
			this.paintCommandFooter(card);
			return;
		}
		const key = card.kind === 'edit' ? `${card.state}|${card.error ?? ''}|${reviewSignature(reviewFile)}` : `${card.state}|${card.error ?? ''}|${card.lines.length}`;
		if (key === this._bodyKey) {
			return;
		}
		this.clearBody();
		this._bodyKey = key;
		const body = append(this.element, $('.claude-tool-body'));
		this._bodyStore.add({ dispose: () => body.remove() });
		this.linkBody(body);
		if (card.kind === 'search' && card.lines.length > 0) {
			this.paintSearchResults(body, card);
		} else if (card.kind === 'edit' && card.notebook && card.state === 'success') {
			this.paintNotebookCell(body, card.notebook);
			if (reviewFile) {
				this.paintEditFooter(body, reviewFile);
			}
		} else if (card.kind === 'edit' && reviewFile) {
			this.paintEdit(body, reviewFile);
		} else if (card.name === CLAUDE_REPRODUCE_TOOL_ID && !card.error) {
			body.classList.add('is-reproduce-lines');
			body.textContent = card.lines.join('\n');
		} else if (card.error) {
			body.textContent = card.error;
		}
	}

	private clearBody(): void {
		this._bodyStore.clear();
		this._footerStore.clear();
		this._footerKey = undefined;
		this._command = undefined;
		this._bodyKey = undefined;
	}

	/** Points the row's button at the region it shows (`aria-controls`). */
	private linkBody(body: HTMLElement): void {
		if (!this._card) {
			return;
		}
		body.id = `claude-tool-${this._card.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
		this._summary.setAttribute('aria-controls', body.id);
	}

	private paintSearchResults(body: HTMLElement, card: ToolCardModel): void {
		const rows = searchResultRows(card.lines, card.countsMatches === true);
		const list = append(body, $('ul.claude-result-list'));
		for (const row of rows.slice(0, SEARCH_ROWS)) {
			const item = append(list, $('li'));
			const link = append(item, $<HTMLButtonElement>('button.claude-result-link'));
			link.type = 'button';
			const { name, folder } = splitPath(this._actions.displayPath(row.path));
			const lines = row.count !== undefined ? describeMatchCount(row.count) : row.lines.map(line => `:${line}`).join(', ');
			link.setAttribute('aria-label', localize('claudeOpenResult', "Open {0}{1}", this._actions.displayPath(row.path), row.lines[0] !== undefined ? `:${row.lines[0]}` : ''));
			// Grep and Glob list files, including ones with no extension (Makefile, LICENSE).
			append(link, $(ThemeIcon.asCSSSelector(Codicon.file)));
			append(link, $('span.file')).textContent = name;
			if (lines) {
				append(link, $('span.line')).textContent = lines;
			}
			if (folder) {
				append(link, $('span.folder')).textContent = folder;
			}
			this._bodyStore.add(addDisposableListener(link, EventType.CLICK, event => {
				event.preventDefault();
				event.stopPropagation();
				this._actions.openFile(row.path, row.lines[0]);
			}));
		}
		if (rows.length > SEARCH_ROWS) {
			append(list, $('li.claude-faint')).textContent = localize('claudeMoreResults', "+ {0} more", rows.length - SEARCH_ROWS);
		}
	}

	private paintEdit(body: HTMLElement, file: ReviewFile): void {
		body.classList.add('is-diff');
		const diff = append(body, $('.claude-mini-diff'));
		diff.setAttribute('role', 'group');
		diff.setAttribute('aria-label', localize('claudeMiniDiff', "Changes in {0}", file.name));
		for (const row of miniDiffRows(file.originalText, file.hunks)) {
			const line = append(diff, $(`div.${row.kind}`));
			if (row.kind === 'fold') {
				line.textContent = row.count === 1
					? localize('claudeOneUnchangedLine', "1 unchanged line")
					: localize('claudeUnchangedLines', "{0} unchanged lines", row.count ?? 0);
				continue;
			}
			append(line, $('span.ln')).textContent = row.line !== undefined ? String(row.line) : '';
			append(line, $('span.sign')).textContent = row.kind === 'ins' ? '+' : row.kind === 'del' ? '\u2212' : ' ';
			append(line, $('span.code')).textContent = row.text;
		}
		this.paintEditFooter(body, file);
	}

	/**
	 * A notebook edit as a cell: its type, and its new source rendered the way the
	 * notebook shows it (Markdown rendered, code in the editor font). Issue 526.
	 */
	private paintNotebookCell(body: HTMLElement, edit: NotebookCellEdit): void {
		// The same inner card as a text edit's mini-diff, so Keep and Undo sit in one place (DL-59).
		body.classList.add('is-diff', 'is-notebook');
		const markdown = edit.cellType === 'markdown';
		const cell = append(body, $('.claude-notebook-cell' + (markdown ? '.is-markdown' : '.is-code') + (edit.mode === 'delete' ? '.is-deleted' : '')));
		const head = append(cell, $('.head'));
		append(head, $(ThemeIcon.asCSSSelector(markdown ? Codicon.markdown : Codicon.code)));
		append(head, $('span.type')).textContent = markdown ? localize('claudeNotebookMarkdown', "Markdown") : edit.cellType === 'code' ? localize('claudeNotebookCode', "Code") : localize('claudeNotebookCellType', "Cell");
		if (edit.cell) {
			append(head, $('span.id')).textContent = edit.cell;
		}
		if (edit.mode === 'delete') {
			append(cell, $('.source.claude-faint')).textContent = localize('claudeNotebookCellDeleted', "Claude deleted this cell.");
			return;
		}
		if (edit.lines.length === 0) {
			append(cell, $('.source.claude-faint')).textContent = localize('claudeNotebookCellEmpty', "Empty cell");
			return;
		}
		const text = edit.lines.join('\n');
		if (markdown) {
			const rendered = this._bodyStore.add(renderMarkdown(new MarkdownString(text), { sanitizerConfig: { remoteImageIsAllowed: () => false } }));
			append(cell, $('.source.is-rendered')).appendChild(rendered.element);
		} else {
			append(cell, $('pre.source.claude-mono')).textContent = text;
		}
		if (edit.droppedLines > 0) {
			append(cell, $('.more.claude-faint')).textContent = edit.droppedLines === 1
				? localize('claudeNotebookOneMoreLine', "1 more line")
				: localize('claudeNotebookMoreLines', "{0} more lines", edit.droppedLines);
		}
	}

	/** Review state, Keep and Undo, and Open Diff under an edit. */
	private paintEditFooter(body: HTMLElement, file: ReviewFile): void {
		const footer = append(body, $('.claude-tool-footer'));
		const reviewed = file.state === 'accepted' ? localize('claudeKept', "Kept")
			: file.state === 'rejected' ? localize('claudeUndone', "Undone")
				: file.state === 'conflicted' ? localize('claudeEditedAfter', "edited by you after the agent")
					: localize('claudePendingReview', "Pending review");
		append(footer, $('span.state')).textContent = reviewed;
		append(footer, $('span.spacer'));
		if (file.state === 'pending' || file.state === 'mixed') {
			if (this._actions.undoFile) {
				textButton(footer, 'button.claude-btn.is-small.is-ghost', localize('claudeUndoFile', "Undo"), this._bodyStore, () => this._actions.undoFile?.(this._turnId, file.uri));
			}
			if (this._actions.keepFile) {
				textButton(footer, 'button.claude-btn.is-small', localize('claudeKeepFile', "Keep"), this._bodyStore, () => this._actions.keepFile?.(this._turnId, file.uri));
			}
		}
		if (this._actions.openDiff) {
			const conflict = file.state === 'conflicted';
			iconButton(footer, Codicon.goToFile, conflict ? localize('claudeResolve', "Resolve") : localize('claudeOpenDiff', "Open Diff"), this._bodyStore, () => this._actions.openDiff?.(this._turnId, file.uri, conflict));
		}
	}

	/**
	 * The footer of an open command card: copy, re-run, terminal and log icons,
	 * then the working folder. A failed command adds a quiet Fix this error.
	 */
	private paintCommandFooter(card: ToolCardModel): void {
		const failed = card.state === 'failed' && !!this._actions.fixCommandError;
		const hasLog = card.lines.length > 0 || card.droppedLines > 0;
		const expanded = this._expandedOutput.has(card.id);
		// A finished command whose output scrolls can show it in full; a running one shows its tail.
		const canExpand = card.state !== 'running' && (expanded || !!this._command?.overflows());
		const key = `${failed}|${card.cwd ?? ''}|${card.command ?? ''}|${hasLog}|${canExpand}|${expanded}`;
		if (key === this._footerKey) {
			return;
		}
		this._footerStore.clear();
		this._footerKey = key;
		const footer = append(this.element, $('.claude-tool-footer.is-command'));
		this._footerStore.add({ dispose: () => footer.remove() });
		const actions = append(footer, $('.actions'));
		actions.setAttribute('role', 'toolbar');
		actions.setAttribute('aria-label', localize('claudeCommandActions', "Command actions"));
		if (card.command) {
			const command = card.command;
			iconButton(actions, Codicon.copy, localize('claudeCopyCommand', "Copy command"), this._footerStore, () => this._actions.copyCommand(command));
			iconButton(actions, Codicon.debugRestart, localize('claudeRerun', "Re-run"), this._footerStore, () => this._actions.rerunCommand(command, card.cwd));
		}
		iconButton(actions, Codicon.terminal, localize('claudeOpenTerminal', "Open in Terminal"), this._footerStore, () => this._actions.openInTerminal(card.cwd));
		if (hasLog) {
			iconButton(actions, Codicon.output, localize('claudeOpenFullLog', "Open full log"), this._footerStore, () => this._actions.openCommandLog());
		}
		if (canExpand) {
			const toggle = iconButton(actions, expanded ? Codicon.fold : Codicon.unfold, expanded ? localize('claudeCollapseOutput', "Collapse Output") : localize('claudeExpandOutput', "Expand Output"), this._footerStore, () => {
				if (expanded) {
					this._expandedOutput.delete(card.id);
				} else {
					this._expandedOutput.add(card.id);
				}
				this.paintBody(card, true, undefined);
			});
			toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
		}
		append(footer, $('span.spacer'));
		if (card.cwd) {
			const cwd = append(footer, $('span.cwd'));
			cwd.textContent = card.cwd;
			cwd.title = card.cwd;
		}
		if (failed) {
			textButton(footer, 'button.claude-btn.is-small.is-ghost.claude-fix-error', localize('claudeFixThisError', "Fix this error"), this._footerStore, () => this._actions.fixCommandError?.(card));
		}
	}
}

/**
 * The output of a command card. One scroller element lives as long as the
 * card is open; only the visible rows are in the DOM. Long lines wrap into
 * rows of the measured width, so every row keeps the fixed row height. The
 * width is measured when the output is laid out and when it is resized, not
 * on every streamed chunk.
 */
class ClaudeCommandOutputView extends Disposable {
	readonly scroller: HTMLElement;
	private readonly _promptLine: HTMLElement;
	private readonly _promptText: HTMLElement;
	private readonly _truncated: HTMLElement;
	private readonly _top: HTMLElement;
	private readonly _pre: HTMLElement;
	private readonly _bottom: HTMLElement;
	private _rows: readonly OutputRow[] = [];
	private _lines: readonly string[] = [];
	private _columns = 0;
	private _charWidth = 0;
	private _observedWidth = -1;
	private readonly _relayout = this._register(new MutableDisposable());
	private _scrollTop = 0;
	private _pendingScroll = 0;
	private _running = false;

	constructor(parent: HTMLElement, private readonly _cardId: string, private readonly _scroll: Map<string, ClaudeCommandScroll>) {
		super();
		// DL-75: the command reads as a prompt line, in full, above its output.
		this._promptLine = append(parent, $('.claude-terminal-command.claude-mono'));
		append(this._promptLine, $('span.prompt')).textContent = '$';
		this._promptText = append(this._promptLine, $('span.text'));
		this._truncated = append(parent, $('.claude-terminal-truncated'));
		this._truncated.hidden = true;
		this.scroller = append(parent, $('.claude-terminal'));
		this.scroller.tabIndex = 0;
		this.scroller.setAttribute('role', 'log');
		this.scroller.setAttribute('aria-label', localize('claudeCommandOutput', "Command output"));
		this._top = append(this.scroller, $('div'));
		this._pre = append(this.scroller, $('pre'));
		this._bottom = append(this.scroller, $('div'));
		this._register({ dispose: () => { this._promptLine.remove(); this._truncated.remove(); this.scroller.remove(); } });
		this._register(addDisposableListener(this.scroller, EventType.SCROLL, () => {
			if (this._pendingScroll > 0) {
				this._pendingScroll--;
				return;
			}
			this._scrollTop = this.scroller.scrollTop;
			const next = nextCommandScroll(this.scroller.scrollHeight, this.viewport(), undefined, this._running, true, this._scrollTop);
			this._scroll.set(this._cardId, { scrollTop: next.scrollTop, scrollLeft: 0, follow: next.follow });
			this.paintRows();
		}));
		// Only a width change re-wraps, and the re-wrap waits for the next frame:
		// painting inside the observer callback would resize what it observes.
		const observer = new (getWindow(this.scroller).ResizeObserver)(entries => {
			const width = entries[entries.length - 1]?.contentRect.width ?? 0;
			if (width === this._observedWidth) {
				return;
			}
			this._observedWidth = width;
			this._relayout.value = scheduleAtNextAnimationFrame(getWindow(this.scroller), () => this.relayout());
		});
		observer.observe(this.scroller);
		this._register({ dispose: () => observer.disconnect() });
	}

	update(card: ToolCardModel): void {
		this._running = card.state === 'running';
		this._promptLine.hidden = !card.command;
		this._promptText.textContent = card.command ?? '';
		const hidden = hiddenCommandLines(card);
		this._truncated.hidden = hidden === 0;
		this._truncated.textContent = hidden > 0 ? localize('claudeOutputTruncated', "... {0} earlier lines hidden", hidden) : '';
		// Until the output is laid out there is no width; the resize observer wraps it then.
		const columns = this._columns > 0 ? this._columns : this.measureColumns();
		if (card.lines !== this._lines || columns !== this._columns) {
			this._lines = card.lines;
			this._columns = columns;
			this._rows = outputRows(card.lines, columns);
		}
		const saved = this._scroll.get(this._cardId);
		this._scrollTop = saved?.scrollTop ?? this._scrollTop;
		this.paintRows();
		const placed = nextCommandScroll(this.scroller.scrollHeight, this.scroller.clientHeight, saved, this._running, false, saved?.scrollTop ?? 0);
		const max = Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight);
		this.moveTo(placed.follow ? max : Math.min(placed.scrollTop, max));
		this.paintRows();
		this._scroll.set(this._cardId, { scrollTop: this._scrollTop, scrollLeft: 0, follow: placed.follow });
	}

	/** Lets the output grow to its taller cap, or back to the preview height. */
	setExpanded(expanded: boolean): void {
		this.scroller.classList.toggle('is-expanded', expanded);
	}

	/** Whether the output is taller than the space it shows in. */
	overflows(): boolean {
		return this.scroller.scrollHeight > this.scroller.clientHeight + 1;
	}

	/** Re-wraps the output when its width changed. */
	private relayout(): void {
		const columns = this.measureColumns();
		if (columns === this._columns) {
			return;
		}
		this._columns = columns;
		this._rows = outputRows(this._lines, columns);
		this.paintRows();
		// The row count changed, so a following log re-pins to the bottom and a scrolled one stays in range.
		const follow = this._scroll.get(this._cardId)?.follow ?? this._running;
		const max = Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight);
		this.moveTo(follow ? max : Math.min(this._scrollTop, max));
		this.paintRows();
		this._scroll.set(this._cardId, { scrollTop: this._scrollTop, scrollLeft: 0, follow });
	}

	private viewport(): number {
		return this.scroller.clientHeight || 180;
	}

	private moveTo(top: number): void {
		if (this.scroller.scrollTop !== top) {
			this._pendingScroll++;
			this.scroller.scrollTop = top;
		}
		this._scrollTop = this.scroller.scrollTop;
	}

	private paintRows(): void {
		const window = visibleLineWindow(this._rows.length, this._scrollTop, this.viewport(), COMMAND_OUTPUT_LINE_HEIGHT);
		this._top.style.height = `${window.start * COMMAND_OUTPUT_LINE_HEIGHT}px`;
		this._bottom.style.height = `${Math.max(0, this._rows.length - window.end) * COMMAND_OUTPUT_LINE_HEIGHT}px`;
		clearNode(this._pre);
		const rows = this._rows.slice(window.start, window.end);
		rows.forEach((row, index) => {
			for (const segment of row) {
				this._pre.append(styledRun(segment));
			}
			if (index < rows.length - 1) {
				this._pre.append('\n');
			}
		});
	}

	/** Characters that fit on one row, or 0 when the output is not laid out yet. */
	private measureColumns(): number {
		const width = this._pre.clientWidth;
		if (width <= 0) {
			return 0;
		}
		if (this._charWidth <= 0) {
			const probe = append(this._pre, $('span'));
			probe.textContent = '0000000000';
			this._charWidth = probe.getBoundingClientRect().width / 10;
			probe.remove();
		}
		return this._charWidth > 0 ? Math.max(20, Math.floor(width / this._charWidth)) : 0;
	}
}

/** One run of command output: plain text, or a span in its ANSI color from the terminal theme (DL-75). */
function styledRun(segment: OutputRow[number]): Node | string {
	if (segment.color === undefined && !segment.bold && !segment.dim) {
		return segment.text;
	}
	const span = $('span');
	span.textContent = segment.text;
	if (typeof segment.color === 'number') {
		span.classList.add(`ansi-${segment.color}`);
	} else if (segment.color) {
		span.style.color = segment.color;
	}
	span.classList.toggle('is-bold', !!segment.bold);
	span.classList.toggle('is-dim', !!segment.dim);
	return span;
}

/** A stable key for the parts of a review file a card shows. */
export function reviewSignature(file: ReviewFile | undefined): string {
	if (!file) {
		return '';
	}
	return `${file.uri.toString()}|${file.state}|${file.added}|${file.removed}|${file.hunks.map(hunk => `${hunk.id}:${hunk.state}`).join(',')}`;
}

function textButton(parent: HTMLElement, className: string, label: string, store: DisposableStore, run: () => void): HTMLButtonElement {
	const button = append(parent, $<HTMLButtonElement>(className));
	button.type = 'button';
	button.textContent = label;
	store.add(addDisposableListener(button, EventType.CLICK, event => {
		event.preventDefault();
		event.stopPropagation();
		run();
	}));
	return button;
}

function iconButton(parent: HTMLElement, icon: ThemeIcon, label: string, store: DisposableStore, run: () => void): HTMLButtonElement {
	const button = append(parent, $<HTMLButtonElement>('button.claude-icon-btn'));
	button.type = 'button';
	button.title = label;
	button.setAttribute('aria-label', label);
	append(button, $(ThemeIcon.asCSSSelector(icon)));
	store.add(addDisposableListener(button, EventType.CLICK, event => {
		event.preventDefault();
		event.stopPropagation();
		run();
	}));
	return button;
}

