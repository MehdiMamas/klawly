/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { resolveContextEnvelope } from '../../../../../platform/claude/common/claudeContextResolve.js';
import { actionAvailable, actionNeedsEditorSelection, compileSubmission, resolveAgentAction, userTextForResolution } from '../../../../../platform/claude/common/claudePrompt.js';
import { acceptPreviewRelay, buildPreviewDocument, consoleErrorsAttachment, elementAttachment, FIX_ELEMENT_TEXT, parsePreviewUrl, PREVIEW_DEVICES, previewChromeStatus, previewFixRequest, PreviewAttachmentStore, PreviewConsoleBuffer, PreviewNavigation, previewBridgeScript, previewPageBridgeSource, previewViewportSize, scalePreviewCaptureRect } from '../../common/claudePreview.js';

function runScript(source: string, sandbox: Record<string, unknown>): void {
	const names = Object.keys(sandbox);
	const runner = new Function(...names, source);
	runner(...names.map(name => sandbox[name]));
}

suite('Claude browser preview', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('opens only loopback http(s) addresses', () => {
		assert.strictEqual(parsePreviewUrl('3000'), 'http://localhost:3000/');
		assert.strictEqual(parsePreviewUrl('http://127.0.0.1:5173/app'), 'http://127.0.0.1:5173/app');
		assert.strictEqual(parsePreviewUrl('https://[::1]/'), 'https://[::1]/');
		assert.strictEqual(parsePreviewUrl('https://example.com'), undefined);
		assert.strictEqual(parsePreviewUrl('http://localhost.evil.com'), undefined);
		assert.strictEqual(parsePreviewUrl('http://user:pass@127.0.0.1'), undefined);
		assert.strictEqual(parsePreviewUrl('javascript:alert(1)'), undefined);
		assert.strictEqual(parsePreviewUrl('file:///etc/passwd'), undefined);
		assert.strictEqual(parsePreviewUrl('http://127.0.0.1:0/'), undefined);
		assert.strictEqual(parsePreviewUrl('http://localhost:3000/\u0000'), undefined);
		assert.strictEqual(parsePreviewUrl('http://localhost:3000/\u0001'), undefined);
		assert.strictEqual(parsePreviewUrl('http://localhost:3000/\u007f'), undefined);
	});

	test('back, forward, and a new address drop the forward stack', () => {
		const navigation = new PreviewNavigation();
		assert.strictEqual(navigation.open('http://localhost:3000'), 'http://localhost:3000/');
		assert.strictEqual(navigation.open('http://localhost:3000/a'), 'http://localhost:3000/a');
		assert.strictEqual(navigation.back(), 'http://localhost:3000/');
		assert.strictEqual(navigation.canGoForward, true);
		assert.strictEqual(navigation.open('http://localhost:3000/b'), 'http://localhost:3000/b');
		assert.strictEqual(navigation.canGoForward, false);
		assert.strictEqual(navigation.forward(), undefined);
		assert.strictEqual(navigation.back(), 'http://localhost:3000/');
		assert.strictEqual(navigation.forward(), 'http://localhost:3000/b');
		assert.strictEqual(navigation.current, 'http://localhost:3000/b');
	});

	test('device presets fit inside the editor', () => {
		const desktop = PREVIEW_DEVICES.find(device => device.id === 'desktop')!;
		const mobile = PREVIEW_DEVICES.find(device => device.id === 'mobile')!;
		assert.deepStrictEqual(previewViewportSize(desktop, { width: 1000, height: 600 }), { width: 1000, height: 600 });
		assert.deepStrictEqual(previewViewportSize(mobile, { width: 2000, height: 2000 }), { width: 390, height: 844 });
	});

	test('the preview document sandboxes the page and does not read its DOM', () => {
		const selfSource = '\'self\'';
		const html = buildPreviewDocument('http://localhost:3000/app', 'noncevalue', selfSource);
		assert.ok(html.includes('frame-src http://localhost:3000;'));
		assert.ok(html.includes('sandbox="allow-scripts allow-forms allow-same-origin allow-popups"'));
		assert.ok(!html.includes('allow-top-navigation'));
		assert.ok(!html.includes('allow-popups-to-escape-sandbox'));
		assert.ok(!html.includes('contentDocument'));
		assert.ok(!previewBridgeScript().includes('contentDocument'));
		assert.ok(!previewBridgeScript().includes('eval('));
		assert.ok(!previewBridgeScript().includes('location.reload'));
		assert.ok(!previewBridgeScript().includes('function allowed'));
		const scriptSrc = html.match(/script-src[^;]*/)?.[0] ?? '';
		assert.ok(scriptSrc.includes('nonce-noncevalue'));
		assert.ok(!scriptSrc.includes('unsafe-inline'));
		assert.ok(!scriptSrc.includes('unsafe-eval'));
		assert.throws(() => buildPreviewDocument('https://example.com', 'noncevalue', selfSource));
	});

	test('the host bridge keeps other origins and uninstrumented elements out', () => {
		const posted: unknown[] = [];
		const child: { data: unknown; origin: string }[] = [];
		let srcValue = 'http://localhost:3000/app';
		const srcSets: string[] = [];
		let onLoad: (() => void) | undefined;
		const frame = {
			get src() { return srcValue; },
			set src(value: string) {
				srcSets.push(value);
				srcValue = value;
			},
			addEventListener(type: string, fn: () => void) {
				if (type === 'load') {
					onLoad = fn;
				}
			},
			contentWindow: {
				postMessage(data: unknown, origin: string) {
					child.push({ data, origin });
				},
			},
			getAttribute(name: string) {
				return name === 'data-origin' ? 'http://localhost:3000' : null;
			},
		};
		let listener: ((event: { source: unknown; origin: string; data: unknown }) => void) | undefined;
		const window = { addEventListener(_type: string, fn: typeof listener) { listener = fn; } };
		runScript(previewBridgeScript(), {
			acquireVsCodeApi: () => ({ postMessage(message: unknown) { posted.push(message); } }),
			document: { getElementById: () => frame },
			window,
			isFinite: Number.isFinite,
			String,
		});
		assert.ok(listener);
		const page = (origin: string, data: unknown) => listener!({ source: frame.contentWindow, origin, data });
		page('http://evil.example', { source: 'klawly-preview-page', kind: 'console', level: 'error', message: 'nope' });
		page('http://localhost:3000', { source: 'klawly-preview-page', kind: 'console', level: 'warn', message: 'warn' });
		page('http://localhost:3000', { source: 'klawly-preview-page', kind: 'element', instrumented: false, selector: 'body', bounds: { x: 0, y: 0, width: 1, height: 1 } });
		assert.deepStrictEqual(posted, []);
		page('http://localhost:3000', { source: 'klawly-preview-page', kind: 'ready' });
		page('http://localhost:3000', { source: 'klawly-preview-page', kind: 'console', level: 'error', message: 'Cannot read height' });
		page('http://localhost:3000', { source: 'klawly-preview-page', kind: 'element', instrumented: true, selector: '#save', text: 'Save', bounds: { x: 1, y: 2, width: 3, height: 4 } });
		assert.deepStrictEqual(posted, [
			{ kind: 'ready' },
			{ kind: 'console', message: 'Cannot read height' },
			{ kind: 'element', element: { instrumented: true, selector: '#save', text: 'Save', bounds: { x: 1, y: 2, width: 3, height: 4 } }, append: false },
		]);
		onLoad!();
		assert.deepStrictEqual(posted[posted.length - 1], { kind: 'frame-loaded' });
		listener!({ source: {}, origin: '', data: { channel: 'klawly-preview-host', type: 'arm-picker' } });
		listener!({ source: {}, origin: '', data: { channel: 'klawly-preview-host', type: 'design-mode', on: true } });
		assert.deepStrictEqual(child, [
			{ data: { source: 'klawly-preview-host', type: 'arm-picker' }, origin: 'http://localhost:3000' },
			{ data: { source: 'klawly-preview-host', type: 'design-mode', on: true }, origin: 'http://localhost:3000' },
		]);
		listener!({ source: {}, origin: '', data: { channel: 'klawly-preview-host', type: 'reload' } });
		assert.deepStrictEqual(srcSets, ['http://localhost:3000/app']);
		assert.ok(!previewBridgeScript().includes('location.reload'));
	});

	function installPageBridge(): {
		sent: unknown[];
		onError?: (event: { message?: string }) => void;
		onRejection?: (event: { reason?: unknown }) => void;
		onMessage?: (event: { data: unknown }) => void;
		onClick?: (event: { target: unknown; preventDefault(): void; stopPropagation(): void }) => void;
		element: { id: string; tagName: string; innerText: string; getBoundingClientRect(): { x: number; y: number; width: number; height: number } };
	} {
		const sent: unknown[] = [];
		const element = {
			id: 'save',
			tagName: 'BUTTON',
			innerText: 'Save',
			getBoundingClientRect: () => ({ x: 1, y: 2, width: 3, height: 4 }),
		};
		const installed: ReturnType<typeof installPageBridge> = { sent, element };
		const originalError = console.error;
		console.error = (() => undefined) as typeof console.error;
		try {
			runScript(previewPageBridgeSource(), {
				parent: { postMessage(data: unknown) { sent.push(data); } },
				window: {
					addEventListener(type: string, fn: unknown) {
						if (type === 'error') {
							installed.onError = fn as typeof installed.onError;
						}
						if (type === 'unhandledrejection') {
							installed.onRejection = fn as typeof installed.onRejection;
						}
						if (type === 'message') {
							installed.onMessage = fn as typeof installed.onMessage;
						}
					},
				},
				document: {
					body: element,
					addEventListener(_type: string, fn: unknown) { installed.onClick = fn as typeof installed.onClick; },
				},
				console,
				String,
			});
		} finally {
			console.error = originalError;
		}
		return installed;
	}

	test('the page bridge reports an uncaught error', () => {
		const page = installPageBridge();
		page.onError!({ message: 'Cannot read height' });
		const reported = page.sent.find(item => (item as { kind?: string }).kind === 'console') as { level: string; message: string };
		assert.strictEqual(reported.level, 'error');
		assert.strictEqual(reported.message, 'Cannot read height');
		assert.deepStrictEqual(acceptPreviewRelay({ kind: 'console', message: reported.message }), { kind: 'console', message: 'Cannot read height' });
	});

	test('the page bridge reports unhandledrejection', () => {
		const page = installPageBridge();
		page.onRejection!({ reason: new Error('rejected promise') });
		const reported = page.sent.find(item => (item as { message?: string }).message === 'rejected promise') as { kind: string; level: string; message: string };
		assert.strictEqual(reported.kind, 'console');
		assert.strictEqual(reported.level, 'error');
		assert.deepStrictEqual(acceptPreviewRelay({ kind: 'console', message: reported.message }), { kind: 'console', message: 'rejected promise' });
	});

	test('the page bridge reports console.error', () => {
		const sent: unknown[] = [];
		const originalError = console.error;
		console.error = (() => undefined) as typeof console.error;
		try {
			runScript(previewPageBridgeSource(), {
				parent: { postMessage(data: unknown) { sent.push(data); } },
				window: { addEventListener() { } },
				document: { body: {}, addEventListener() { } },
				console,
				String,
			});
			console.error('render failed', 404);
		} finally {
			console.error = originalError;
		}
		const reported = sent.find(item => (item as { message?: string }).message === 'render failed 404') as { kind: string; level: string; source: string };
		assert.ok(reported);
		assert.strictEqual(reported.kind, 'console');
		assert.strictEqual(reported.level, 'error');
		assert.strictEqual(reported.source, 'klawly-preview-page');
		assert.deepStrictEqual(acceptPreviewRelay({ kind: 'console', message: 'render failed 404' }), { kind: 'console', message: 'render failed 404' });
	});

	test('the page bridge reports a picked element only after it is armed', () => {
		const page = installPageBridge();
		assert.deepStrictEqual(page.sent[0], { source: 'klawly-preview-page', kind: 'ready' });
		const click = { target: page.element, preventDefault() { }, stopPropagation() { } };
		page.onClick!(click);
		assert.strictEqual(page.sent.length, 1);
		page.onMessage!({ data: { source: 'klawly-preview-host', type: 'arm-picker' } });
		page.onClick!(click);
		const picked = page.sent[1] as { instrumented: boolean; selector: string };
		assert.strictEqual(picked.instrumented, true);
		assert.strictEqual(picked.selector, '#save');
	});

	test('a loaded page with no bridge is named in the status', () => {
		assert.strictEqual(previewChromeStatus(false, false, [], undefined), '');
		assert.ok(previewChromeStatus(true, false, ['Cannot read height'], undefined).includes('preview bridge'));
		assert.ok(previewChromeStatus(true, true, ['Cannot read height'], '#save').includes('1 console errors'));
		assert.ok(previewChromeStatus(true, true, ['Cannot read height'], '#save').includes('#save'));
	});

	test('the screenshot rect includes the window zoom factor', () => {
		assert.deepStrictEqual(scalePreviewCaptureRect({ x: 10, y: 20, width: 100, height: 50 }, 1), { x: 10, y: 20, width: 100, height: 50 });
		assert.deepStrictEqual(scalePreviewCaptureRect({ x: 10, y: 20, width: 100, height: 50 }, 1.5), { x: 15, y: 30, width: 150, height: 75 });
		assert.deepStrictEqual(scalePreviewCaptureRect({ x: 10.2, y: 20.6, width: 3, height: 4 }, Number.NaN), { x: 10, y: 21, width: 3, height: 4 });
	});

	test('ask agent to fix this element goes through the action service', () => {
		assert.strictEqual(previewFixRequest(undefined), undefined);
		const attachment = elementAttachment('element-1', 'http://localhost:3000/', {
			selector: '#save',
			text: 'Save',
			bounds: { x: 1, y: 2, width: 3, height: 4 },
		});
		const request = previewFixRequest(attachment);
		assert.deepStrictEqual(request, { id: 'fixPreviewElement', source: 'button', attachments: [attachment] });
		assert.strictEqual(actionAvailable('fixPreviewElement'), true);
		assert.strictEqual(actionNeedsEditorSelection('fixPreviewElement'), false);
		assert.strictEqual(actionNeedsEditorSelection('explainSelection'), true);
		const resolution = resolveAgentAction('fixPreviewElement', { slashCommands: [], skills: ['fix'], preferClaudeCommands: true });
		assert.deepStrictEqual(resolution, { kind: 'prompt', templateId: 'fix-preview-element' });
		assert.strictEqual(userTextForResolution('fixPreviewElement', resolution), FIX_ELEMENT_TEXT);
	});

	test('screenshot, console errors, and the selected element compile into the agent prompt', async () => {
		const userDataPath = isWindows ? 'C:\\Klawly' : '/Klawly';
		const expectedUri = URI.joinPath(URI.file(userDataPath), 'agent-sessions', 'sess-1', 'attachments', 'img-1.png').toString();
		const writes: { uri: string; bytes: number }[] = [];
		const store = new PreviewAttachmentStore({
			async createFolder() { return undefined; },
			async writeFile(uri, content) {
				writes.push({ uri: uri.toString(), bytes: content.byteLength });
			},
		}, userDataPath, () => 'img-1');
		const png = new Uint8Array(24);
		png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const image = await store.storeImage('sess-1', png);
		assert.strictEqual(image.kind, 'image');
		if (image.kind === 'image') {
			assert.strictEqual(image.localUri, expectedUri);
			assert.ok(image.localUri.includes('agent-sessions/sess-1/attachments/img-1.png'));
		}
		assert.strictEqual(writes[0]?.uri, expectedUri);
		assert.strictEqual(writes.length, 1);
		assert.ok(writes[0].bytes > 0);
		await assert.rejects(() => store.storeImage('../sess', png));
		await assert.rejects(() => store.storeImage('sess-1', new Uint8Array([1, 2, 3, 4])));
		assert.strictEqual(writes.length, 1);

		const buffer = new PreviewConsoleBuffer();
		buffer.add('Cannot read height');
		const errors = consoleErrorsAttachment('console-1', buffer.errors);
		const selected = elementAttachment('element-1', 'http://localhost:3000/', {
			selector: '#save',
			text: 'Save',
			bounds: { x: 1, y: 2, width: 3, height: 4 },
		});
		assert.strictEqual(acceptPreviewRelay({ kind: 'element', selector: 'body', bounds: { x: 0, y: 0, width: 1, height: 1 } }), undefined);
		assert.strictEqual(elementAttachment('element-1', 'https://example.com', {
			selector: 'body',
			text: '',
			bounds: { x: 0, y: 0, width: 1, height: 1 },
		}), undefined);

		const envelope = await resolveContextEnvelope(FIX_ELEMENT_TEXT, 'agent', [image, errors!, selected!], {
			relativePath: () => '',
			readText: async () => undefined,
			readMarkers: async () => [],
			readGit: async () => ({ stat: '', patch: '', truncated: false }),
			readTerminal: async () => undefined,
			activeEditor: () => undefined,
			workspaceRoot: () => '/repo',
		});
		const prompt = compileSubmission(envelope);
		assert.ok(prompt.includes(FIX_ELEMENT_TEXT));
		assert.ok(prompt.includes('kind="image"'));
		// Claude gets the screenshot as a file path it can read, not a file URI (issue 744).
		assert.ok(prompt.includes(URI.parse(expectedUri).fsPath));
		assert.ok(prompt.includes('Cannot read height'));
		assert.ok(prompt.includes('selector: #save'));
		assert.ok(VSBuffer.wrap(png).byteLength === png.byteLength);
	});
});
