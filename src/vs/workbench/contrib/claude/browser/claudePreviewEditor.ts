/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/claudePreview.css';
import { getZoomFactor } from '../../../../base/browser/browser.js';
import { $, addDisposableListener, append, Dimension, EventType, getDomNodePagePosition, getWindow, isHTMLInputElement } from '../../../../base/browser/dom.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { createSimpleKeybinding } from '../../../../base/common/keybindings.js';
import { OS } from '../../../../base/common/platform.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { CLAUDE_AGENT_ENABLED_SETTING, readClaudeAgentEnabled } from '../../../../platform/claude/common/claudeConfiguration.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IClaudeActionService } from '../../../../platform/claude/common/claudeActions.js';
import { ContextAttachment } from '../../../../platform/claude/common/claudeContext.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { IWebviewElement, IWebviewService, WebviewContentPurpose } from '../../webview/browser/webview.js';
import { webviewGenericCspSource } from '../../webview/common/webview.js';
import { CLAUDE_AGENT_VIEW_ID } from '../common/claudeViews.js';
import { previewElementCropRect, previewSelectionLabel, PreviewSelection } from '../common/claudePreviewDesign.js';
import { firePreviewConsole, acceptPreviewRelay, buildPreviewDocument, consoleErrorsAttachment, elementAttachment, parsePreviewUrl, PREVIEW_DEVICES, previewChromeStatus, previewFixRequest, previewNoConsoleMessage, previewNoElementMessage, previewRejectedMessage, PreviewConsoleBuffer, PreviewBounds, PreviewDevice, PreviewNavigation, previewPageBridgeSource, scalePreviewCaptureRect, previewViewportSize } from '../common/claudePreview.js';
import { IClaudePreviewAttachmentService } from './claudePreviewAttachments.js';
import { IClaudePreviewCapture } from './claudePreviewCapture.js';
import { ClaudePreviewFreezeFrame } from './claudePreviewFreeze.js';

export class ClaudePreviewInput extends EditorInput {

	static readonly ID = 'workbench.input.claudePreview';

	private _url: string;
	private readonly _resource: URI;

	constructor(url: string) {
		super();
		const href = parsePreviewUrl(url);
		if (!href) {
			throw new Error('Preview URL is not a local address.');
		}
		this._url = href;
		this._resource = URI.from({ scheme: 'klawly-preview', path: `/${generateUuid()}` });
	}

	override get typeId(): string {
		return ClaudePreviewInput.ID;
	}

	override get editorId(): string | undefined {
		return ClaudePreviewEditor.ID;
	}

	override get resource(): URI {
		return this._resource;
	}

	get url(): string {
		return this._url;
	}

	setUrl(url: string): void {
		const href = parsePreviewUrl(url);
		if (!href || href === this._url) {
			return;
		}
		this._url = href;
		this._onDidChangeLabel.fire();
	}

	override getName(): string {
		return localize('claudePreviewName', "Preview {0}", new URL(this._url).host);
	}

	override getIcon(): ThemeIcon {
		return Codicon.globe;
	}

	override matches(other: EditorInput | unknown): boolean {
		return other instanceof ClaudePreviewInput && other.resource.toString() === this.resource.toString();
	}
}

export class ClaudePreviewEditor extends EditorPane {

	static readonly ID = 'workbench.editor.claudePreview';

	private _root!: HTMLElement;
	private _chrome!: HTMLElement;
	private _status!: HTMLElement;
	private _stage!: HTMLElement;
	private _viewport!: HTMLElement;
	private _urlInput!: InputBox;
	private _back!: HTMLButtonElement;
	private _forward!: HTMLButtonElement;
	private readonly _deviceButtons: { device: PreviewDevice; button: HTMLButtonElement }[] = [];
	/** Buttons that hand something to the agent. Hidden while `claude.agent.enabled` is off. */
	private readonly _agentButtons: HTMLButtonElement[] = [];
	private _webview: IWebviewElement | undefined;
	private _navigation = new PreviewNavigation();
	private _console = new PreviewConsoleBuffer();
	private readonly _selection = new PreviewSelection();
	private _design = false;
	private _designButton!: HTMLButtonElement;
	private _freeze: ClaudePreviewFreezeFrame | undefined;
	private _frameLoaded = false;
	private _bridgeSeen = false;
	private _device: PreviewDevice = PREVIEW_DEVICES[0];
	private _dimension: Dimension | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService private readonly _webviews: IWebviewService,
		@IContextViewService private readonly _contextViewService: IContextViewService,
		@INotificationService private readonly _notifications: INotificationService,
		@IClipboardService private readonly _clipboard: IClipboardService,
		@IClaudePreviewCapture private readonly _capture: IClaudePreviewCapture,
		@IClaudePreviewAttachmentService private readonly _attachments: IClaudePreviewAttachmentService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IClaudeActionService private readonly _actions: IClaudeActionService,
		@IViewsService private readonly _views: IViewsService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IKeybindingService private readonly _keybindings: IKeybindingService,
		@ILogService private readonly _log: ILogService,
	) {
		super(ClaudePreviewEditor.ID, group, telemetryService, themeService, storageService);
		this._register(this._configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CLAUDE_AGENT_ENABLED_SETTING)) {
				this.updateAgentButtons();
			}
		}));
	}

	protected override createEditor(parent: HTMLElement): void {
		this._root = append(parent, $('.claude-preview'));
		this._chrome = append(this._root, $('.claude-preview-toolbar'));
		this._urlInput = this._register(new InputBox(append(this._chrome, $('.claude-preview-url')), this._contextViewService, {
			placeholder: localize('claudePreviewUrlPlaceholder', "http://localhost:3000"),
			ariaLabel: localize('claudePreviewUrl', "Preview URL"),
			inputBoxStyles: defaultInputBoxStyles,
		}));
		this._register(addDisposableListener(this._chrome, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter' && isHTMLInputElement(event.target)) {
				this.navigate(this._urlInput.value);
			}
		}));
		this._back = this.button(this._chrome, localize('claudePreviewBack', "Back"), () => this.back());
		this._forward = this.button(this._chrome, localize('claudePreviewForward', "Forward"), () => this.forward());
		this.button(this._chrome, localize('claudePreviewRefresh', "Refresh"), () => this.refresh());
		for (const device of PREVIEW_DEVICES) {
			const button = this.button(this._chrome, device.label, () => this.setDevice(device.id));
			button.setAttribute('aria-pressed', String(device.id === this._device.id));
			this._deviceButtons.push({ device, button });
		}
		this._agentButtons.push(
			this.button(this._chrome, localize('claudePreviewScreenshot', "Add screenshot to Agent"), () => this.addScreenshot()),
			this.button(this._chrome, localize('claudePreviewConsole', "Add console errors to Agent"), () => this.addConsoleErrors()),
		);
		this.button(this._chrome, localize('claudePreviewPick', "Pick element"), () => this.armPicker());
		this._designButton = this.button(this._chrome, localize('claudePreviewDesign', "Design"), () => this.toggleDesignMode());
		this._designButton.setAttribute('aria-pressed', 'false');
		this._agentButtons.push(
			this.button(this._chrome, localize('claudePreviewFreeze', "Draw on Preview and Add to Agent"), () => this.freezeFrame()),
			this.button(this._chrome, localize('claudePreviewElement', "Add selected element to Agent"), () => this.addElement()),
			this.fixButton(),
		);
		this.updateAgentButtons();
		this.button(this._chrome, localize('claudePreviewCopyConsole', "Copy console errors"), () => this.copyConsoleErrors());
		this.button(this._chrome, localize('claudePreviewCopyBridge', "Copy page bridge"), () => this.copyBridge());
		this._status = append(this._root, $('.claude-preview-status'));
		this._status.setAttribute('role', 'status');
		this._status.setAttribute('aria-live', 'polite');
		this._stage = append(this._root, $('.claude-preview-stage'));
		this._viewport = append(this._stage, $('.claude-preview-viewport'));
		this._webview = this._register(this._webviews.createWebviewElement({
			title: localize('claudePreviewWebview', "Local preview"),
			options: { purpose: WebviewContentPurpose.CustomEditor },
			contentOptions: {
				allowScripts: true,
				allowForms: false,
				enableCommandUris: false,
				localResourceRoots: [],
				forwardUntrustedKeypressEvents: true,
			},
			extension: undefined,
		}));
		this._webview.mountTo(this._viewport, this.window);
		this._register(this._webview.onMessage(event => this.onPreviewMessage(event.message)));
		this.updateChrome();
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!(input instanceof ClaudePreviewInput) || token.isCancellationRequested) {
			return;
		}
		this._navigation = new PreviewNavigation();
		const href = this._navigation.open(input.url);
		if (href) {
			this.render(href);
		}
	}

	override clearInput(): void {
		super.clearInput();
		this._navigation = new PreviewNavigation();
		this._console.clear();
		this._selection.clear();
		this._frameLoaded = false;
		this._bridgeSeen = false;
		this._freeze?.close();
		this._webview?.setHtml('');
		this.updateChrome();
	}

	override layout(dimension: Dimension): void {
		this._dimension = dimension;
		this._root.style.width = `${dimension.width}px`;
		this._root.style.height = `${dimension.height}px`;
		this.layoutViewport();
	}

	override focus(): void {
		this._urlInput.focus();
	}

	navigate(raw: string): void {
		const href = parsePreviewUrl(raw);
		if (!href) {
			this._notifications.warn(previewRejectedMessage());
			return;
		}
		if (href === this._navigation.current) {
			this.refresh();
			return;
		}
		this._navigation.open(href);
		this.render(href);
	}

	back(): void {
		const href = this._navigation.back();
		if (href) {
			this.render(href);
		}
	}

	forward(): void {
		const href = this._navigation.forward();
		if (href) {
			this.render(href);
		}
	}

	refresh(): void {
		const href = this._navigation.current;
		if (!href || !this._webview) {
			return;
		}
		this._console.clear();
		this._selection.clear();
		this._frameLoaded = false;
		this._bridgeSeen = false;
		this.updateStatus();
		this._webview.postMessage({ channel: 'klawly-preview-host', type: 'reload' });
	}

	setDevice(id: PreviewDevice['id']): void {
		const device = PREVIEW_DEVICES.find(candidate => candidate.id === id);
		if (!device) {
			return;
		}
		this._device = device;
		for (const item of this._deviceButtons) {
			item.button.setAttribute('aria-pressed', String(item.device.id === id));
		}
		this.layoutViewport();
	}

	armPicker(): void {
		this._status.textContent = localize('claudePreviewArm', "Click an element in the preview. The page must include the preview bridge.");
		this._webview?.postMessage({ channel: 'klawly-preview-host', type: 'arm-picker' });
	}

	/**
	 * Design mode (issue 485): every click in the page picks an element, and
	 * Shift-click adds to the picks. The page bridge sends styles, XPath, outer
	 * HTML and the owning component with each pick.
	 */
	toggleDesignMode(): void {
		this._design = !this._design;
		this._designButton.setAttribute('aria-pressed', String(this._design));
		this.postDesignMode();
		this._status.textContent = this._design
			? localize('claudePreviewDesignOn', "Design mode: click an element in the preview, Shift-click or Shift-drag to add more.")
			: previewChromeStatus(this._frameLoaded, this._bridgeSeen, this._console.errors, previewSelectionLabel(this._selection.elements));
	}

	/**
	 * Freeze Frame (issue 886): freeze the preview as an image, draw pen strokes and
	 * boxes over it, and add the flattened PNG to the composer. Closing discards it.
	 */
	async freezeFrame(): Promise<void> {
		if (this._freeze) {
			return;
		}
		const bytes = await this.captureViewport();
		if (!bytes) {
			this._notifications.warn(localize('claudePreviewNoFreeze', "The preview did not return a frame to draw on."));
			return;
		}
		if (this._freeze) {
			return;
		}
		const undoHint = this._keybindings.resolveKeybinding(createSimpleKeybinding(KeyMod.CtrlCmd | KeyCode.KeyZ, OS).toKeybinding())[0]?.getLabel() ?? 'Ctrl+Z';
		this._freeze = new ClaudePreviewFreezeFrame(this._viewport, bytes, async png => {
			try {
				const session = this.session();
				this.append(await this._attachments.storeImage(session.id, png));
				await this._views.openView(CLAUDE_AGENT_VIEW_ID, true);
				const added = localize('claudeFreezeAdded', "Added the drawing to the chat \"{0}\".", session.title || localize('claudeFreezeNewChat', "New chat"));
				this._status.textContent = added;
				this._notifications.info(added);
			} catch (error) {
				this._log.error('[claude.preview] Freeze Frame could not add the drawing', error);
				throw error;
			}
		}, () => {
			this._freeze = undefined;
		}, {
			undoHint,
			notify: (message, severity) => severity === 'error' ? this._notifications.error(message) : this._notifications.info(message),
		});
	}

	async addScreenshot(): Promise<void> {
		const bytes = await this.captureViewport();
		if (!bytes) {
			this._notifications.warn(localize('claudePreviewNoShot', "The preview did not return a screenshot."));
			return;
		}
		try {
			const session = this.session();
			const attachment = await this._attachments.storeImage(session.id, bytes);
			this.append(attachment);
			await this._views.openView(CLAUDE_AGENT_VIEW_ID, true);
		} catch (error) {
			this._notifications.error(error instanceof Error ? error.message : localize('claudePreviewShotFailed', "Could not store the preview screenshot."));
		}
	}

	async addConsoleErrors(): Promise<void> {
		const attachment = consoleErrorsAttachment(generateUuid(), this._console.errors);
		if (!attachment) {
			this._notifications.info(previewNoConsoleMessage());
			return;
		}
		this.append(attachment);
		await this._views.openView(CLAUDE_AGENT_VIEW_ID, true);
	}

	async addElement(): Promise<void> {
		const attachments = await this.elementChips();
		if (attachments.length === 0) {
			this._notifications.info(previewNoElementMessage());
			return;
		}
		for (const attachment of attachments) {
			this.append(attachment);
		}
		await this._views.openView(CLAUDE_AGENT_VIEW_ID, true);
	}

	async fixElement(): Promise<void> {
		const request = previewFixRequest(await this.elementChips());
		if (!request) {
			this._notifications.info(previewNoElementMessage());
			return;
		}
		try {
			await this._views.openView(CLAUDE_AGENT_VIEW_ID, true);
			await this._actions.run(request);
		} catch (error) {
			this._notifications.error(error instanceof Error ? error.message : localize('claudePreviewFixFailed', "Could not send the element to the agent."));
		}
	}

	async copyConsoleErrors(): Promise<void> {
		const text = this._console.errors.join('\n');
		if (!text) {
			this._notifications.info(previewNoConsoleMessage());
			return;
		}
		await this._clipboard.writeText(text);
	}

	async copyBridge(): Promise<void> {
		await this._clipboard.writeText(previewPageBridgeSource());
		this._status.textContent = localize('claudePreviewBridgeCopied', "Copied the preview bridge. Add it to the local page, then pick an element.");
	}

	private render(href: string): void {
		this._urlInput.value = href;
		if (this.input instanceof ClaudePreviewInput) {
			this.input.setUrl(href);
		}
		this._console.clear();
		this._selection.clear();
		this._frameLoaded = false;
		this._bridgeSeen = false;
		this.updateStatus();
		const nonce = generateUuid().replace(/-/g, '');
		this._webview?.setHtml(buildPreviewDocument(href, nonce, webviewGenericCspSource));
		this.updateChrome();
	}

	private onPreviewMessage(message: unknown): void {
		const relay = acceptPreviewRelay(message);
		if (!relay) {
			return;
		}
		if (relay.kind === 'frame-loaded') {
			this._frameLoaded = true;
			this.updateStatus();
			return;
		}
		if (relay.kind === 'ready') {
			this._bridgeSeen = true;
			if (this._design) {
				this.postDesignMode();
			}
			this.updateStatus();
			return;
		}
		this._bridgeSeen = true;
		if (relay.kind === 'console') {
			this._console.add(relay.message);
			firePreviewConsole(relay.message);
		} else {
			this._selection.pick(relay.element, relay.append);
		}
		this.updateStatus();
	}

	private async captureViewport(): Promise<Uint8Array | undefined> {
		const rect = getDomNodePagePosition(this._viewport);
		if (rect.width < 2 || rect.height < 2) {
			return undefined;
		}
		return this._capture.capture(scalePreviewCaptureRect({
			x: rect.left,
			y: rect.top,
			width: rect.width,
			height: rect.height,
		}, getZoomFactor(getWindow(this._viewport))));
	}

	/** One text chip per picked element, each followed by a crop of the element when the capture works. */
	private async elementChips(): Promise<ContextAttachment[]> {
		const href = this._navigation.current;
		if (!href) {
			return [];
		}
		const chips: ContextAttachment[] = [];
		for (const element of this._selection.elements) {
			const chip = elementAttachment(generateUuid(), href, element);
			if (!chip) {
				continue;
			}
			chips.push(chip);
			const crop = await this.captureElement(element.bounds);
			if (crop) {
				chips.push(crop);
			}
		}
		return chips;
	}

	private async captureElement(bounds: PreviewBounds): Promise<ContextAttachment | undefined> {
		const position = getDomNodePagePosition(this._viewport);
		const rect = previewElementCropRect({ x: position.left, y: position.top, width: position.width, height: position.height }, bounds);
		if (!rect) {
			return undefined;
		}
		try {
			const bytes = await this._capture.capture(scalePreviewCaptureRect(rect, getZoomFactor(getWindow(this._viewport))));
			return bytes ? await this._attachments.storeImage(this.session().id, bytes) : undefined;
		} catch {
			return undefined;
		}
	}

	private postDesignMode(): void {
		this._webview?.postMessage({ channel: 'klawly-preview-host', type: 'design-mode', on: this._design });
	}

	private session() {
		return this._agent.getCurrentSession() ?? this._agent.createSession();
	}

	private append(attachment: ContextAttachment): void {
		const session = this.session();
		this._agent.setAttachments(session.id, [...session.attachments, attachment]);
	}

	private updateStatus(): void {
		this._status.textContent = previewChromeStatus(this._frameLoaded, this._bridgeSeen, this._console.errors, previewSelectionLabel(this._selection.elements));
	}

	private updateChrome(): void {
		this._back.disabled = !this._navigation.canGoBack;
		this._forward.disabled = !this._navigation.canGoForward;
		this._urlInput.value = this._navigation.current ?? this._urlInput.value;
	}

	private layoutViewport(): void {
		if (!this._dimension) {
			return;
		}
		const chrome = this._chrome.offsetHeight + this._status.offsetHeight;
		const size = previewViewportSize(this._device, {
			width: this._dimension.width,
			height: Math.max(1, this._dimension.height - chrome),
		});
		this._viewport.style.width = `${size.width}px`;
		this._viewport.style.height = `${size.height}px`;
		this._freeze?.layout();
	}

	private updateAgentButtons(): void {
		const hidden = !readClaudeAgentEnabled(this._configuration.getValue(CLAUDE_AGENT_ENABLED_SETTING));
		for (const button of this._agentButtons) {
			button.hidden = hidden;
		}
	}

	private fixButton(): HTMLButtonElement {
		const button = this.button(this._chrome, localize('claudePreviewFix', "Fix with Agent"), () => this.fixElement());
		button.title = localize('claudePreviewFixTooltip', "Send the selected element to the agent to fix");
		return button;
	}

	private button(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
		const button = append(parent, $('button.claude-preview-button')) as HTMLButtonElement;
		button.type = 'button';
		button.textContent = label;
		button.setAttribute('aria-label', label);
		this._register(addDisposableListener(button, EventType.CLICK, event => {
			event.preventDefault();
			onClick();
		}));
		return button;
	}
}
