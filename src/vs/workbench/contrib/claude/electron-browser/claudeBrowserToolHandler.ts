/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeBase64 } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { getAgentBrowserViewCreationDefaults } from '../../../../platform/browserView/common/browserView.js';
import { IPlaywrightService } from '../../../../platform/browserView/common/playwrightService.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { clipClaudeBrowserText, ClaudeBrowserImage, ClaudeBrowserToolArgs, ClaudeBrowserToolRequest, ClaudeBrowserToolResult, isClaudeBrowserLocalUrl } from '../../../../platform/claude/common/claudeBrowserTool.js';
import { IAgentNetworkFilterService } from '../../../../platform/networkFilter/common/networkFilterService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { IClaudeVerifyEvidenceService } from '../../../services/claude/common/claudeVerifyEvidenceService.js';
import { BrowserEditorInput } from '../../browserView/common/browserEditorInput.js';
import { IBrowserViewWorkbenchService } from '../../browserView/common/browserView.js';
import { getBrowserNetworkPolicyError, playwrightInvokeRaw } from '../../browserView/electron-browser/tools/browserToolHelpers.js';

// eslint-disable-next-line local/code-import-patterns
import type { Page } from 'playwright-core';

const OPEN_PAGE_READY_TIMEOUT_MS = 30_000;
const ENTRY_LIMIT = 200;

interface OpenPage {
	readonly input: BrowserEditorInput;
	readonly pageId: string;
}

type PageCall = <T>(fn: (page: Page, ...args: any[]) => Promise<T>, ...args: unknown[]) => Promise<T>;

/**
 * Answers Klawly's Agent Browser tool (issue 466) for the chats this window
 * owns. The page opens in an editor tab beside the chat in the agent's own
 * storage scope, so the user can watch it and take over. Every address outside
 * this machine is checked against the network allow list again here, after the
 * permission card.
 */
export class ClaudeBrowserToolHandler extends Disposable {
	private readonly _pages = new Map<string, OpenPage>();

	constructor(
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IBrowserViewWorkbenchService private readonly _browserViews: IBrowserViewWorkbenchService,
		@IPlaywrightService private readonly _playwright: IPlaywrightService,
		@IAgentNetworkFilterService private readonly _network: IAgentNetworkFilterService,
		@IEditorGroupsService private readonly _groups: IEditorGroupsService,
		@IClaudeVerifyEvidenceService private readonly _evidence: IClaudeVerifyEvidenceService,
	) {
		super();
		const onRequest = this._runtime.onDidRequestBrowser;
		if (onRequest) {
			this._register(onRequest(request => void this.handle(request)));
		}
	}

	private async handle(request: ClaudeBrowserToolRequest): Promise<void> {
		// Another window owns the session: it answers.
		if (!this._agent.getSessions().some(session => this._agent.getRuntimeSessionId(session.id) === request.sessionId)) {
			return;
		}
		let result: ClaudeBrowserToolResult;
		try {
			result = await this.run(request.sessionId, request);
		} catch (error) {
			result = { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
		}
		await this._runtime.resolveBrowserRequest?.(request.sessionId, request.requestId, result);
	}

	private async run(sessionId: string, args: ClaudeBrowserToolArgs): Promise<ClaudeBrowserToolResult> {
		if (args.action === 'open' || args.action === 'navigate') {
			if (!args.url) {
				return { kind: 'failed', message: localize('claude.browser.noUrl', "The {0} action needs a url.", args.action) };
			}
			const refused = this.checkUrl(args.url);
			if (refused) {
				return { kind: 'refused', message: refused };
			}
		}
		if (args.action === 'close') {
			return this.close(sessionId);
		}
		if (args.action === 'open' || (args.action === 'navigate' && !this._pages.has(sessionId))) {
			return this.open(sessionId, args.url!, args.keep === true);
		}
		const page = this._pages.get(sessionId);
		if (!page) {
			return { kind: 'failed', message: localize('claude.browser.notOpen', "No page is open. Use the open action with a url first.") };
		}
		return this.act(sessionId, page, args);
	}

	private checkUrl(url: string): string | undefined {
		if (!/^https?:/i.test(url)) {
			return localize('claude.browser.scheme', "Only http and https addresses can be opened.");
		}
		if (isClaudeBrowserLocalUrl(url)) {
			return undefined;
		}
		return getBrowserNetworkPolicyError(url, this._network);
	}

	private async open(sessionId: string, url: string, keep: boolean): Promise<ClaudeBrowserToolResult> {
		const existing = this._pages.get(sessionId);
		if (existing && !keep) {
			this.closePage(existing);
		}
		const input = await this._browserViews.createBrowserView({
			...getAgentBrowserViewCreationDefaults(sessionId, undefined),
			initialUrl: url,
			openSource: 'cdpCreated',
		}, { preserveFocus: true });
		const page: OpenPage = { input, pageId: input.id };
		this._pages.set(sessionId, page);
		const summary = await this._playwright.waitForPageAndGetSummary(sessionId, page.pageId, url, OPEN_PAGE_READY_TIMEOUT_MS);
		await this.listen(sessionId, page);
		const image = await this.shot(page);
		this.record(sessionId, image);
		return { kind: 'done', text: clipClaudeBrowserText(localize('claude.browser.opened', "Opened {0} in the Agent Browser.\n\n{1}", url, summary)), ...(image ? { image } : {}) };
	}

	private close(sessionId: string): ClaudeBrowserToolResult {
		const page = this._pages.get(sessionId);
		if (!page) {
			return { kind: 'done', text: localize('claude.browser.alreadyClosed', "No page was open.") };
		}
		this.closePage(page);
		this._pages.delete(sessionId);
		void this._playwright.disposeSession(sessionId);
		return { kind: 'done', text: localize('claude.browser.closed', "Closed the Agent Browser page.") };
	}

	private closePage(page: OpenPage): void {
		for (const group of this._groups.groups) {
			if (group.contains(page.input)) {
				void group.closeEditor(page.input);
			}
		}
	}

	/** Starts collecting console messages, page errors and requests on the page object, so later reads can drain them. */
	private listen(sessionId: string, page: OpenPage): Promise<void> {
		return playwrightInvokeRaw(this._playwright, sessionId, page.pageId, async (p: Page, limit: number) => {
			const holder = p as unknown as { __klawly?: { console: string[]; network: string[] } };
			if (holder.__klawly) {
				return;
			}
			const log: { console: string[]; network: string[] } = holder.__klawly = { console: [], network: [] };
			const push = (list: string[], line: string) => {
				list.push(line);
				if (list.length > limit) {
					list.shift();
				}
			};
			p.on('console', m => push(log.console, `[${m.type()}] ${m.text()}`));
			p.on('pageerror', e => push(log.console, `[pageerror] ${e.message}`));
			p.on('requestfailed', r => push(log.network, `FAILED ${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`));
			p.on('response', r => push(log.network, `${r.status()} ${r.request().method()} ${r.url()}`));
		}, ENTRY_LIMIT);
	}

	private async act(sessionId: string, page: OpenPage, args: ClaudeBrowserToolArgs): Promise<ClaudeBrowserToolResult> {
		const call: PageCall = (fn, ...a) => playwrightInvokeRaw(this._playwright, sessionId, page.pageId, fn, ...a);
		let text: string;
		switch (args.action) {
			case 'navigate':
				await call(async (p, url: string) => { await p.goto(url, { waitUntil: 'load' }); }, args.url);
				await this.listen(sessionId, page);
				text = localize('claude.browser.navigated', "Navigated to {0}.", args.url!);
				break;
			case 'click':
				if (!args.selector && !args.text) {
					return { kind: 'failed', message: localize('claude.browser.noTarget', "The click action needs a selector or text.") };
				}
				await call(async (p, selector: string | undefined, label: string | undefined) => {
					await (selector ? p.locator(selector) : p.getByText(label!)).first().click({ timeout: 10_000 });
				}, args.selector, args.text);
				text = localize('claude.browser.clicked', "Clicked.");
				break;
			case 'type':
				if (!args.selector) {
					return { kind: 'failed', message: localize('claude.browser.noSelector', "The type action needs a selector.") };
				}
				await call(async (p, selector: string, value: string, submit: boolean) => {
					await p.locator(selector).first().fill(value, { timeout: 10_000 });
					if (submit) {
						await p.keyboard.press('Enter');
					}
				}, args.selector, args.text ?? '', args.submit === true);
				text = localize('claude.browser.typed', "Typed.");
				break;
			case 'scroll':
				await call(async (p, selector: string | undefined, x: number, y: number) => {
					if (selector) {
						await p.locator(selector).first().scrollIntoViewIfNeeded({ timeout: 10_000 });
					} else {
						await p.mouse.wheel(x, y);
					}
				}, args.selector, args.x ?? 0, args.y ?? 0);
				text = localize('claude.browser.scrolled', "Scrolled.");
				break;
			case 'snapshot':
				text = await call(async (p, html: boolean) => html ? await p.content() : await p.locator('body').ariaSnapshot(), args.format === 'html');
				break;
			case 'console':
				text = await this.drain(call, 'console');
				this.recordConsole(sessionId, text);
				break;
			case 'network':
				text = await this.drain(call, 'network');
				break;
			case 'evaluate':
				if (!args.expression) {
					return { kind: 'failed', message: localize('claude.browser.noExpression', "The evaluate action needs an expression.") };
				}
				text = await call(async (p, expression: string) => {
					const value = await p.evaluate(expression);
					return typeof value === 'string' ? value : JSON.stringify(value) ?? 'undefined';
				}, args.expression);
				break;
			case 'resize':
				await call(async (p, width: number, height: number) => { await p.setViewportSize({ width, height }); }, args.width ?? 1280, args.height ?? 800);
				text = localize('claude.browser.resized', "Resized the viewport to {0} by {1}.", args.width ?? 1280, args.height ?? 800);
				break;
			case 'screenshot':
				text = localize('claude.browser.shot', "Screenshot of the page.");
				break;
			default:
				return { kind: 'failed', message: localize('claude.browser.unknown', "Unknown action {0}.", String(args.action)) };
		}
		const textOnly = args.action === 'snapshot' || args.action === 'console' || args.action === 'network' || args.action === 'evaluate';
		const image = textOnly ? undefined : await this.shot(page);
		this.record(sessionId, image);
		return { kind: 'done', text: clipClaudeBrowserText(text), ...(image ? { image } : {}) };
	}

	private async drain(call: PageCall, kind: 'console' | 'network'): Promise<string> {
		const lines = await call(async (p, which: 'console' | 'network') => {
			const log = (p as unknown as { __klawly?: Record<string, string[]> }).__klawly;
			return log ? log[which].splice(0) : [];
		}, kind);
		return lines.length > 0 ? lines.join('\n') : localize('claude.browser.nothingNew', "Nothing new since the last read.");
	}

	/** The chat and running turn a runtime session belongs to; evidence is filed under them (issue 1495). */
	private turnOf(runtimeSessionId: string): { sessionId: string; turnId: string } | undefined {
		const session = this._agent.getSessions().find(candidate => this._agent.getRuntimeSessionId(candidate.id) === runtimeSessionId);
		const turnId = session ? this._agent.getViewState(session.id).turns.at(-1)?.id : undefined;
		return session && turnId ? { sessionId: session.id, turnId } : undefined;
	}

	private record(runtimeSessionId: string, image: ClaudeBrowserImage | undefined): void {
		const turn = image ? this.turnOf(runtimeSessionId) : undefined;
		if (image && turn) {
			this._evidence.addScreenshot(turn.sessionId, turn.turnId, image);
		}
	}

	private recordConsole(runtimeSessionId: string, text: string): void {
		const turn = this.turnOf(runtimeSessionId);
		if (turn) {
			this._evidence.addConsole(turn.sessionId, turn.turnId, text);
		}
	}

	private async shot(page: OpenPage): Promise<ClaudeBrowserImage | undefined> {
		try {
			const model = await page.input.resolve();
			const buffer = await model.captureScreenshot({ quality: 70, format: 'jpeg' });
			return { mimeType: 'image/jpeg', data: encodeBase64(buffer) };
		} catch {
			return undefined;
		}
	}

	override dispose(): void {
		for (const [sessionId, page] of this._pages) {
			this.closePage(page);
			void this._playwright.disposeSession(sessionId);
		}
		this._pages.clear();
		super.dispose();
	}
}

/** Starts the Agent Browser tool handler once the workbench has restored. */
export class ClaudeBrowserToolContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeBrowserTool';

	constructor(
		@IClaudeRuntimeService runtime: IClaudeRuntimeService,
		@IClaudeAgentService agent: IClaudeAgentService,
		@IBrowserViewWorkbenchService views: IBrowserViewWorkbenchService,
		@IPlaywrightService playwright: IPlaywrightService,
		@IAgentNetworkFilterService network: IAgentNetworkFilterService,
		@IEditorGroupsService groups: IEditorGroupsService,
		@IClaudeVerifyEvidenceService evidence: IClaudeVerifyEvidenceService,
	) {
		super();
		this._register(new ClaudeBrowserToolHandler(runtime, agent, views, playwright, network, groups, evidence));
	}
}
