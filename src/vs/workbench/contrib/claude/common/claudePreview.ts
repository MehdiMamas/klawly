/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { AgentActionRequest } from '../../../../platform/claude/common/claudeActions.js';
import { ContextAttachment } from '../../../../platform/claude/common/claudeContext.js';
import { PREVIEW_MAX_PICKS, PreviewDesignDetails, previewDesignDetailLines, previewDesignPageSource, readPreviewDesignDetails } from './claudePreviewDesign.js';

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_CONSOLE_ERRORS = 80;

export const FIX_ELEMENT_TEXT = 'Fix this element in the local preview.';

export interface PreviewDevice {
	readonly id: 'desktop' | 'tablet' | 'mobile';
	readonly label: string;
	readonly width: number;
	readonly height: number;
}

export const PREVIEW_DEVICES: readonly PreviewDevice[] = [
	{ id: 'desktop', label: localize('claudePreviewDeviceDesktop', "Desktop"), width: 1280, height: 800 },
	{ id: 'tablet', label: localize('claudePreviewDeviceTablet', "Tablet"), width: 768, height: 1024 },
	{ id: 'mobile', label: localize('claudePreviewDeviceMobile', "Mobile"), width: 390, height: 844 },
];

export function previewRejectedMessage(): string {
	return localize('claudePreviewRejected', "Browser preview only opens http://localhost, 127.0.0.1, or [::1].");
}

export function previewNoElementMessage(): string {
	return localize('claudePreviewNoElement', "Pick an element in the preview first.");
}

export function previewNoConsoleMessage(): string {
	return localize('claudePreviewNoConsole', "This preview has not reported any console errors.");
}

export interface PreviewBounds {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** A picked element. Design mode (issue 485) adds the {@link PreviewDesignDetails}. */
export interface PreviewElement extends PreviewDesignDetails {
	readonly selector: string;
	readonly text: string;
	readonly bounds: PreviewBounds;
}

export type PreviewRelay =
	| { readonly kind: 'console'; readonly message: string }
	/** `append` is a Shift-click: add to the picked elements instead of replacing them. */
	| { readonly kind: 'element'; readonly element: PreviewElement; readonly append: boolean }
	| { readonly kind: 'ready' }
	| { readonly kind: 'frame-loaded' };

export interface PreviewFileWriter {
	createFolder(resource: URI): Promise<unknown>;
	writeFile(resource: URI, content: VSBuffer): Promise<unknown>;
}

/**
 * Accepts only http(s) loopback URLs. A bare port becomes `http://localhost:<port>`.
 * Userinfo, non-loopback hosts, and other schemes are rejected.
 */
export function parsePreviewUrl(input: string): string | undefined {
	const trimmed = input.trim();
	if (!trimmed || hasControlCharacter(trimmed) || trimmed.includes('\\')) {
		return undefined;
	}
	let candidate = trimmed;
	if (/^\d{1,5}$/.test(candidate)) {
		candidate = `http://localhost:${candidate}`;
	} else if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#].*)?$/i.test(candidate)) {
		candidate = `http://${candidate}`;
	}
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return undefined;
	}
	if (url.username || url.password) {
		return undefined;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return undefined;
	}
	if (!LOOPBACK.has(url.hostname.toLowerCase())) {
		return undefined;
	}
	if (url.port === '0') {
		return undefined;
	}
	return url.toString();
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 0x1F || code === 0x7F) {
			return true;
		}
	}
	return false;
}

export function previewViewportSize(device: PreviewDevice, available: { readonly width: number; readonly height: number }): { width: number; height: number } {
	return {
		width: Math.max(1, Math.min(device.width, Math.floor(available.width))),
		height: Math.max(1, Math.min(device.height, Math.floor(available.height))),
	};
}

/** Back, forward, and refresh for one preview editor. New addresses drop the forward stack. */
export class PreviewNavigation {
	private _entries: string[] = [];
	private _index = -1;

	get current(): string | undefined {
		return this._entries[this._index];
	}

	get canGoBack(): boolean {
		return this._index > 0;
	}

	get canGoForward(): boolean {
		return this._index >= 0 && this._index < this._entries.length - 1;
	}

	open(input: string): string | undefined {
		const href = parsePreviewUrl(input);
		if (!href) {
			return undefined;
		}
		if (this.current === href) {
			return href;
		}
		this._entries = this._entries.slice(0, this._index + 1);
		this._entries.push(href);
		this._index = this._entries.length - 1;
		return href;
	}

	back(): string | undefined {
		if (!this.canGoBack) {
			return undefined;
		}
		this._index--;
		return this.current;
	}

	forward(): string | undefined {
		if (!this.canGoForward) {
			return undefined;
		}
		this._index++;
		return this.current;
	}
}

const previewConsoleEmitter = new Emitter<string>();

/** Every console message any preview forwards, for Debug mode's log sources (issue 881). */
export const onDidPreviewConsole: Event<string> = previewConsoleEmitter.event;

/** Called by a preview for each console message its page forwards. */
export function firePreviewConsole(message: string): void {
	previewConsoleEmitter.fire(message);
}

export class PreviewConsoleBuffer {
	private readonly _lines: string[] = [];

	add(message: string): void {
		const text = message.trim().slice(0, 2000);
		if (!text) {
			return;
		}
		this._lines.push(text);
		if (this._lines.length > MAX_CONSOLE_ERRORS) {
			this._lines.shift();
		}
	}

	get errors(): readonly string[] {
		return this._lines;
	}

	clear(): void {
		this._lines.length = 0;
	}
}

/** Shape check for messages the preview host page forwards. Origin filtering happens in the host script. */
export function acceptPreviewRelay(data: unknown): PreviewRelay | undefined {
	if (!data || typeof data !== 'object') {
		return undefined;
	}
	const record = data as Record<string, unknown>;
	if (record.kind === 'ready') {
		return { kind: 'ready' };
	}
	if (record.kind === 'frame-loaded') {
		return { kind: 'frame-loaded' };
	}
	if (record.kind === 'console' && typeof record.message === 'string') {
		const message = record.message.trim().slice(0, 2000);
		return message ? { kind: 'console', message } : undefined;
	}
	if (record.kind === 'element') {
		const element = readElement(record.element ?? record);
		return element ? { kind: 'element', element, append: record.append === true } : undefined;
	}
	return undefined;
}

function readElement(value: unknown): PreviewElement | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (record.instrumented !== true || typeof record.selector !== 'string') {
		return undefined;
	}
	const selector = record.selector.trim().slice(0, 300);
	const bounds = readBounds(record.bounds);
	if (!selector || !bounds) {
		return undefined;
	}
	const text = typeof record.text === 'string' ? record.text.slice(0, 500) : '';
	return { selector, text, bounds, ...readPreviewDesignDetails(record) };
}

function readBounds(value: unknown): PreviewBounds | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const box = value as Record<string, unknown>;
	const x = box.x;
	const y = box.y;
	const width = box.width;
	const height = box.height;
	if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') {
		return undefined;
	}
	if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
		return undefined;
	}
	if (width < 0 || height < 0 || width > 10000 || height > 10000) {
		return undefined;
	}
	return { x, y, width, height };
}

export function consoleErrorsAttachment(id: string, errors: readonly string[]): ContextAttachment | undefined {
	if (!SAFE_ID.test(id) || errors.length === 0) {
		return undefined;
	}
	const text = errors.map((line, index) => `${index + 1}. ${line}`).join('\n');
	return { kind: 'pasted-text', id, text, lineCount: text.split('\n').length };
}

export function elementAttachment(id: string, pageUrl: string, element: PreviewElement): ContextAttachment | undefined {
	if (!SAFE_ID.test(id) || !parsePreviewUrl(pageUrl)) {
		return undefined;
	}
	const text = [
		`url: ${pageUrl}`,
		`selector: ${element.selector}`,
		`text: ${element.text}`,
		`bounds: ${element.bounds.x},${element.bounds.y} ${element.bounds.width}x${element.bounds.height}`,
		...previewDesignDetailLines(element),
	].join('\n');
	return { kind: 'pasted-text', id, text, lineCount: text.split('\n').length };
}

export function sessionAttachmentUri(userDataPath: string, sessionId: string, fileId: string, extension: 'png' | 'jpg'): URI {
	if (!SAFE_ID.test(sessionId) || !SAFE_ID.test(fileId)) {
		throw new Error('Preview attachment id is not safe to store.');
	}
	return URI.joinPath(URI.file(userDataPath), 'agent-sessions', sessionId, 'attachments', `${fileId}.${extension}`);
}

export function imageExtension(bytes: Uint8Array): 'png' | 'jpg' | undefined {
	if (bytes.byteLength >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		return 'png';
	}
	if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return 'jpg';
	}
	return undefined;
}

/** Writes a screenshot under `<userDataPath>/agent-sessions/<id>/attachments/<id>.png`. */
export class PreviewAttachmentStore {
	constructor(
		private readonly _files: PreviewFileWriter,
		private readonly _userDataPath: string,
		private readonly _newId: () => string,
	) { }

	async storeImage(sessionId: string, bytes: Uint8Array): Promise<ContextAttachment> {
		if (!SAFE_ID.test(sessionId)) {
			throw new Error('Preview attachment id is not safe to store.');
		}
		if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
			throw new Error('Preview screenshot is empty or too large.');
		}
		const extension = imageExtension(bytes);
		if (!extension) {
			throw new Error('Preview screenshot is not a PNG or JPEG.');
		}
		const fileId = this._newId();
		if (!SAFE_ID.test(fileId)) {
			throw new Error('Preview attachment id is not safe to store.');
		}
		const folder = URI.joinPath(URI.file(this._userDataPath), 'agent-sessions', sessionId, 'attachments');
		const uri = sessionAttachmentUri(this._userDataPath, sessionId, fileId, extension);
		await this._files.createFolder(folder);
		await this._files.writeFile(uri, VSBuffer.wrap(bytes));
		return { kind: 'image', localUri: uri.toString() };
	}
}

/**
 * Host document for the sandboxed preview. The iframe keeps the page's own loopback
 * origin so the app can run. This document is a different origin, and its script never
 * reads the iframe DOM. `frame-src` is only the preview origin.
 */
export function buildPreviewDocument(pageUrl: string, nonce: string, scriptCspSource: string): string {
	const href = parsePreviewUrl(pageUrl);
	if (!href) {
		throw new Error('Preview URL is not a local address.');
	}
	if (!/^[A-Za-z0-9]{8,128}$/.test(nonce) || /[;"<>]/.test(scriptCspSource)) {
		throw new Error('Preview document nonce is not safe.');
	}
	const origin = new URL(href).origin;
	const script = previewBridgeScript();
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${scriptCspSource}; frame-src ${escapeAttr(origin)};">
<title>Local preview</title>
<style>html,body{margin:0;height:100%;background:transparent}iframe{border:0;width:100%;height:100%}</style>
</head>
<body>
<iframe id="frame" title="Local preview" src="${escapeAttr(href)}" data-origin="${escapeAttr(origin)}" sandbox="allow-scripts allow-forms allow-same-origin allow-popups" referrerpolicy="no-referrer"></iframe>
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
}

/** Runs inside the webview host page. It forwards only explicit console and element messages. */
export function previewBridgeScript(): string {
	return `(function () {
	const api = acquireVsCodeApi();
	const frame = document.getElementById('frame');
	const expected = frame.getAttribute('data-origin');
	function clip(value, max) {
		return String(value == null ? '' : value).slice(0, max);
	}
	function box(value) {
		if (!value || typeof value !== 'object') {
			return undefined;
		}
		const x = value.x, y = value.y, width = value.width, height = value.height;
		if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') {
			return undefined;
		}
		if (!isFinite(x) || !isFinite(y) || !isFinite(width) || !isFinite(height)) {
			return undefined;
		}
		if (width < 0 || height < 0 || width > 10000 || height > 10000) {
			return undefined;
		}
		return { x: x, y: y, width: width, height: height };
	}
	frame.addEventListener('load', function () {
		api.postMessage({ kind: 'frame-loaded' });
	});
	window.addEventListener('message', function (event) {
		if (event.source === frame.contentWindow) {
			if (event.origin !== expected) {
				return;
			}
			const data = event.data;
			if (!data || data.source !== 'klawly-preview-page') {
				return;
			}
			if (data.kind === 'ready') {
				api.postMessage({ kind: 'ready' });
			}
			if (data.kind === 'console' && data.level === 'error') {
				const message = clip(data.message, 2000).trim();
				if (message) {
					api.postMessage({ kind: 'console', message: message });
				}
			}
			if (data.kind === 'element' && data.instrumented === true) {
				const bounds = box(data.bounds);
				const selector = clip(data.selector, 300).trim();
				if (!bounds || !selector) {
					return;
				}
				const element = { instrumented: true, selector: selector, text: clip(data.text, 500), bounds: bounds };
				if (typeof data.xpath === 'string') {
					element.xpath = clip(data.xpath, 500);
				}
				if (typeof data.html === 'string') {
					element.html = clip(data.html, 1500);
				}
				if (data.styles && typeof data.styles === 'object') {
					element.styles = data.styles;
				}
				if (data.component && typeof data.component === 'object') {
					element.component = data.component;
				}
				api.postMessage({ kind: 'element', element: element, append: data.append === true });
			}
			return;
		}
		const host = event.data;
		if (!host || host.channel !== 'klawly-preview-host') {
			return;
		}
		if (host.type === 'reload') {
			const next = frame.src;
			frame.src = next;
		}
		if (host.type === 'arm-picker' && frame.contentWindow) {
			frame.contentWindow.postMessage({ source: 'klawly-preview-host', type: 'arm-picker' }, expected);
		}
		if (host.type === 'design-mode' && frame.contentWindow) {
			frame.contentWindow.postMessage({ source: 'klawly-preview-host', type: 'design-mode', on: host.on === true }, expected);
		}
	});
}());`;
}

/**
 * Opt-in script a local page can include. The host accepts its messages only when the
 * iframe origin matches the preview URL. It is not injected into pages.
 */
export function previewPageBridgeSource(): string {
	return `(function () {
	function send(message) {
		parent.postMessage(message, '*');
	}
	function report(message) {
		send({ source: 'klawly-preview-page', kind: 'console', level: 'error', message: String(message || 'error') });
	}
	send({ source: 'klawly-preview-page', kind: 'ready' });
	window.addEventListener('error', function (event) {
		report(event && event.message);
	});
	window.addEventListener('unhandledrejection', function (event) {
		var reason = event && event.reason;
		var message = reason && typeof reason === 'object' && reason.message ? reason.message : reason;
		report(message == null ? 'unhandledrejection' : message);
	});
	var originalError = console.error.bind(console);
	console.error = function () {
		var parts = [];
		for (var i = 0; i < arguments.length; i++) {
			parts.push(String(arguments[i]));
		}
		report(parts.join(' ') || 'console.error');
		return originalError.apply(console, arguments);
	};
	${previewDesignPageSource()}
	var armed = false;
	var design = false;
	window.addEventListener('message', function (event) {
		var data = event.data;
		if (!data || data.source !== 'klawly-preview-host') {
			return;
		}
		if (data.type === 'arm-picker') {
			armed = true;
		}
		if (data.type === 'design-mode') {
			design = data.on === true;
		}
	});
	function pickElement(el, append) {
		var rect = el.getBoundingClientRect();
		var selector = el.id ? '#' + el.id : String(el.tagName || 'div').toLowerCase();
		var details = klawlyDesign(el);
		send({
			source: 'klawly-preview-page',
			kind: 'element',
			instrumented: true,
			selector: selector,
			text: String(el.innerText || '').slice(0, 500),
			bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
			xpath: details.xpath,
			styles: details.styles,
			html: details.html,
			component: details.component,
			append: append
		});
	}
	var dragStart;
	var dragBox;
	var dragged = false;
	document.addEventListener('mousedown', function (event) {
		if (design && event.shiftKey === true && event.button === 0) {
			dragStart = { x: event.clientX, y: event.clientY };
			dragged = false;
		}
	}, true);
	document.addEventListener('mousemove', function (event) {
		if (!dragStart) {
			return;
		}
		if (!dragged && Math.abs(event.clientX - dragStart.x) + Math.abs(event.clientY - dragStart.y) < 8) {
			return;
		}
		dragged = true;
		event.preventDefault();
		if (!dragBox) {
			dragBox = document.createElement('div');
			dragBox.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:1px dashed Highlight;background:color-mix(in srgb, Highlight 15%, transparent);';
			document.documentElement.appendChild(dragBox);
		}
		dragBox.style.left = Math.min(dragStart.x, event.clientX) + 'px';
		dragBox.style.top = Math.min(dragStart.y, event.clientY) + 'px';
		dragBox.style.width = Math.abs(event.clientX - dragStart.x) + 'px';
		dragBox.style.height = Math.abs(event.clientY - dragStart.y) + 'px';
	}, true);
	document.addEventListener('mouseup', function (event) {
		var start = dragStart;
		dragStart = undefined;
		if (dragBox) {
			dragBox.remove();
			dragBox = undefined;
		}
		if (!start || !dragged) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		var region = { x: Math.min(start.x, event.clientX), y: Math.min(start.y, event.clientY), width: Math.abs(event.clientX - start.x), height: Math.abs(event.clientY - start.y) };
		var picked = klawlyElementsInRegion(document.body, region, ${PREVIEW_MAX_PICKS});
		for (var i = 0; i < picked.length; i++) {
			pickElement(picked[i], true);
		}
	}, true);
	document.addEventListener('click', function (event) {
		if (dragged) {
			// The click that ends a Shift-drag is not a pick.
			dragged = false;
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		if (!armed && !design) {
			return;
		}
		var append = event.shiftKey === true;
		if (!append) {
			armed = false;
		}
		event.preventDefault();
		event.stopPropagation();
		pickElement(event.target || document.body, append);
	}, true);
}());`;
}

/** Status line. A loaded frame with no ready message has not included the page bridge. */
export function previewChromeStatus(frameLoaded: boolean, bridgeSeen: boolean, errors: readonly string[], selector: string | undefined): string {
	if (frameLoaded && !bridgeSeen) {
		return localize('claudePreviewNoBridge', "This page has not loaded the preview bridge. Console errors and element picking stay unavailable until the local page includes it.");
	}
	const parts: string[] = [];
	if (errors.length > 0) {
		parts.push(localize('claudePreviewErrorCount', "{0} console errors", errors.length));
	}
	if (selector) {
		parts.push(selector);
	}
	return parts.join(' · ');
}

/**
 * `capturePage` measures the window in zoomed pixels. CSS rects from
 * `getBoundingClientRect` stay in unzoomed CSS pixels, so multiply by the
 * window zoom factor before calling `getScreenshot`.
 */
export function scalePreviewCaptureRect(rect: PreviewBounds, zoomFactor: number): PreviewBounds {
	const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
	return {
		x: Math.round(rect.x * zoom),
		y: Math.round(rect.y * zoom),
		width: Math.round(rect.width * zoom),
		height: Math.round(rect.height * zoom),
	};
}

/** Toolbar and command both send the selected element through the action service. */
export function previewFixRequest(attachment: ContextAttachment | readonly ContextAttachment[] | undefined): AgentActionRequest | undefined {
	const attachments = attachment === undefined ? [] : isAttachmentList(attachment) ? attachment : [attachment];
	if (attachments.length === 0) {
		return undefined;
	}
	return { id: 'fixPreviewElement', source: 'button', attachments: [...attachments] };
}

function isAttachmentList(value: ContextAttachment | readonly ContextAttachment[]): value is readonly ContextAttachment[] {
	return Array.isArray(value);
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
