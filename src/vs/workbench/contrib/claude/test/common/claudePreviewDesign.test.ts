/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { acceptPreviewRelay, elementAttachment, previewBridgeScript, previewFixRequest, previewPageBridgeSource } from '../../common/claudePreview.js';
import { previewDesignPageSource, previewElementCropRect, previewSelectionLabel, PreviewSelection, readPreviewDesignDetails } from '../../common/claudePreviewDesign.js';

function runScript(source: string, sandbox: Record<string, unknown>): void {
	const names = Object.keys(sandbox);
	const runner = new Function(...names, source);
	runner(...names.map(name => sandbox[name]));
}

interface FakeNode {
	nodeType: number;
	tagName: string;
	id: string;
	innerText: string;
	outerHTML: string;
	parentNode: FakeNode | null;
	previousElementSibling: FakeNode | null;
	getBoundingClientRect(): { x: number; y: number; width: number; height: number };
	[key: string]: unknown;
}

function node(tagName: string, parentNode: FakeNode | null, previousElementSibling: FakeNode | null = null): FakeNode {
	return {
		nodeType: 1,
		tagName,
		id: '',
		innerText: '',
		outerHTML: `<${tagName.toLowerCase()}></${tagName.toLowerCase()}>`,
		parentNode,
		previousElementSibling,
		getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
	};
}

suite('Claude browser preview design mode', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function installPageBridge() {
		const sent: Record<string, unknown>[] = [];
		const handlers: { message?: (event: { data: unknown }) => void; click?: (event: { target: unknown; shiftKey?: boolean; preventDefault(): void; stopPropagation(): void }) => void } = {};
		runScript(previewPageBridgeSource(), {
			parent: { postMessage(data: Record<string, unknown>) { sent.push(data); } },
			window: {
				addEventListener(type: string, fn: never) {
					if (type === 'message') {
						handlers.message = fn;
					}
				},
			},
			document: { body: {}, addEventListener(_type: string, fn: never) { handlers.click = fn; } },
			console: { error() { } },
			getComputedStyle: () => ({ getPropertyValue: (name: string) => ({ color: 'rgb(0, 0, 0)', 'font-size': '14px', 'border-radius': '6px' } as Record<string, string>)[name] ?? '' }),
			String,
		});
		const click = (target: FakeNode, shiftKey = false) => handlers.click!({ target, shiftKey, preventDefault() { }, stopPropagation() { } });
		const host = (data: Record<string, unknown>) => handlers.message!({ data: { source: 'klawly-preview-host', ...data } });
		return { sent, click, host };
	}

	test('design mode picks every click, Shift-click adds, and each pick carries styles, xpath, html and the React component', () => {
		const html = node('HTML', null);
		const body = node('BODY', html);
		const first = node('BUTTON', body);
		const second = node('BUTTON', body, first);
		second.id = 'save';
		second.outerHTML = '<button id="save">Save</button>';
		second.__reactFiber$abc = {
			type: 'button',
			return: {
				type: { name: 'SaveButton' },
				_debugSource: { fileName: 'src/SaveButton.tsx', lineNumber: 12 },
				memoizedProps: { label: 'Save', onClick: () => undefined, token: 'sk-ant-test0000', children: 'Save' },
				return: null,
			},
		};
		const page = installPageBridge();
		page.click(second);
		assert.strictEqual(page.sent.length, 1, 'a click before design mode picks nothing');
		page.host({ type: 'design-mode', on: true });
		page.click(second);
		page.click(first, true);
		page.host({ type: 'design-mode', on: false });
		page.click(first);
		const picks = page.sent.slice(1).map(message => acceptPreviewRelay({ kind: 'element', element: message, append: message.append }));
		assert.deepStrictEqual(picks, [
			{
				kind: 'element', append: false, element: {
					selector: '#save', text: '', bounds: { x: 0, y: 0, width: 10, height: 10 },
					xpath: '/html[1]/body[1]/button[2]',
					styles: [['color', 'rgb(0, 0, 0)'], ['border-radius', '6px'], ['font-size', '14px']],
					html: '<button id="save">Save</button>',
					component: { name: 'SaveButton', file: 'src/SaveButton.tsx:12', props: '{"label":"Save","onClick":"[function]","token":"[redacted]"}' },
				},
			},
			{
				kind: 'element', append: true, element: {
					selector: 'button', text: '', bounds: { x: 0, y: 0, width: 10, height: 10 },
					xpath: '/html[1]/body[1]/button[1]',
					styles: [['color', 'rgb(0, 0, 0)'], ['border-radius', '6px'], ['font-size', '14px']],
					html: '<button></button>',
				},
			},
		]);
	});

	test('a Vue component is read from the nearest instance', () => {
		const html = node('HTML', null);
		html.__vueParentComponent = { type: { __name: 'NavBar', __file: 'src/NavBar.vue' }, props: { open: true } };
		const link = node('A', html);
		const page = installPageBridge();
		page.host({ type: 'arm-picker' });
		page.click(link);
		assert.deepStrictEqual(page.sent[1].component, { name: 'NavBar', file: 'src/NavBar.vue', props: '{"open":true}' });
	});

	test('Shift-click keeps a one-shot picker armed until a plain click', () => {
		const target = node('DIV', null);
		const page = installPageBridge();
		page.host({ type: 'arm-picker' });
		page.click(target, true);
		page.click(target, true);
		page.click(target);
		page.click(target);
		assert.deepStrictEqual(page.sent.slice(1).map(message => message.append), [true, true, false]);
	});

	test('the host bridge forwards design fields and the append flag', () => {
		const posted: unknown[] = [];
		const frame = {
			contentWindow: { postMessage() { } },
			addEventListener() { },
			getAttribute: () => 'http://localhost:3000',
		};
		let listener: ((event: { source: unknown; origin: string; data: unknown }) => void) | undefined;
		runScript(previewBridgeScript(), {
			acquireVsCodeApi: () => ({ postMessage(message: unknown) { posted.push(message); } }),
			document: { getElementById: () => frame },
			window: { addEventListener(_type: string, fn: typeof listener) { listener = fn; } },
			isFinite: Number.isFinite,
			String,
		});
		listener!({
			source: frame.contentWindow, origin: 'http://localhost:3000', data: {
				source: 'klawly-preview-page', kind: 'element', instrumented: true, selector: 'a', text: 'Home', bounds: { x: 1, y: 2, width: 3, height: 4 },
				xpath: '/html[1]/a[1]', html: '<a>Home</a>', styles: { color: 'red' }, component: { name: 'Nav' }, append: true,
			},
		});
		assert.deepStrictEqual(acceptPreviewRelay(posted[0]), {
			kind: 'element', append: true, element: {
				selector: 'a', text: 'Home', bounds: { x: 1, y: 2, width: 3, height: 4 },
				xpath: '/html[1]/a[1]', styles: [['color', 'red']], html: '<a>Home</a>', component: { name: 'Nav' },
			},
		});
	});

	test('design fields are shape-checked and props go through the secret guard', () => {
		assert.deepStrictEqual(readPreviewDesignDetails({
			xpath: 'not-a-path',
			styles: { color: 'blue', 'pointer-events': 'none', width: 42 },
			html: '   ',
			component: { name: '', file: 'x' },
		}), { styles: [['color', 'blue']] });
		assert.deepStrictEqual(readPreviewDesignDetails({
			component: { name: 'Card', props: '{"apiKey":"sk-ant-test0000"}' },
		}), { component: { name: 'Card', props: '{"apiKey":"[redacted]"}' } });
	});

	test('the element chip lists the design details after the bounds', () => {
		const chip = elementAttachment('element-1', 'http://localhost:3000/', {
			selector: '#save', text: 'Save', bounds: { x: 1, y: 2, width: 3, height: 4 },
			xpath: '/html[1]/body[1]/button[1]',
			component: { name: 'SaveButton', file: 'src/SaveButton.tsx:12', props: '{"label":"Save"}' },
			styles: [['color', 'red'], ['font-size', '14px']],
			html: '<button id="save">Save</button>',
		});
		assert.deepStrictEqual(chip, {
			kind: 'pasted-text', id: 'element-1', lineCount: 12, text: [
				'url: http://localhost:3000/',
				'selector: #save',
				'text: Save',
				'bounds: 1,2 3x4',
				'xpath: /html[1]/body[1]/button[1]',
				'component: SaveButton (src/SaveButton.tsx:12)',
				'props: {"label":"Save"}',
				'styles:',
				'  color: red',
				'  font-size: 14px',
				'html:',
				'<button id="save">Save</button>',
			].join('\n'),
		});
		assert.deepStrictEqual(previewFixRequest([chip!, chip!])?.attachments.length, 2);
		assert.strictEqual(previewFixRequest([]), undefined);
	});

	test('a selection replaces on click, toggles on Shift-click, and names its size', () => {
		const element = (selector: string, xpath: string) => ({ selector, text: '', bounds: { x: 0, y: 0, width: 1, height: 1 }, xpath });
		const selection = new PreviewSelection();
		const labels: (string | undefined)[] = [previewSelectionLabel(selection.elements)];
		selection.pick(element('#a', '/a[1]'), false);
		labels.push(previewSelectionLabel(selection.elements));
		selection.pick(element('#b', '/b[1]'), true);
		labels.push(previewSelectionLabel(selection.elements));
		selection.pick(element('#a', '/a[1]'), true);
		labels.push(previewSelectionLabel(selection.elements));
		selection.pick(element('#c', '/c[1]'), false);
		labels.push(previewSelectionLabel(selection.elements));
		assert.deepStrictEqual(labels, [undefined, '#a', '2 elements picked', '#b', '#c']);
	});

	test('an element crop is clipped to the preview viewport', () => {
		const viewport = { x: 100, y: 50, width: 400, height: 300 };
		assert.deepStrictEqual([
			previewElementCropRect(viewport, { x: 10, y: 20, width: 30, height: 40 }),
			previewElementCropRect(viewport, { x: -10, y: 280, width: 30, height: 40 }),
			previewElementCropRect(viewport, { x: 500, y: 20, width: 30, height: 40 }),
		], [
			{ x: 110, y: 70, width: 30, height: 40 },
			{ x: 100, y: 330, width: 20, height: 20 },
			undefined,
		]);
	});

	test('a Shift-drag region picks the outermost elements inside the box, up to the limit', () => {
		interface Box { name: string; left: number; top: number; right: number; bottom: number; kids: Box[] }
		const box = (name: string, left: number, top: number, right: number, bottom: number, kids: Box[] = []): Box => ({ name, left, top, right, bottom, kids });
		const wrap = (b: Box | undefined): unknown => b && ({
			name: b.name,
			firstElementChild: wrap(b.kids[0]),
			nextElementSibling: undefined as unknown,
			getBoundingClientRect: () => ({ left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.right - b.left, height: b.bottom - b.top }),
		});
		const build = (b: Box): { name: string; firstElementChild: unknown; nextElementSibling: unknown; getBoundingClientRect(): object } => {
			const node = wrap(b) as { firstElementChild: unknown; nextElementSibling: unknown; name: string; getBoundingClientRect(): object };
			let previous: { nextElementSibling: unknown } | undefined;
			node.firstElementChild = undefined;
			for (const kid of b.kids) {
				const child = build(kid);
				if (previous) {
					previous.nextElementSibling = child;
				} else {
					node.firstElementChild = child;
				}
				previous = child;
			}
			return node;
		};
		const inRegion = new Function(`${previewDesignPageSource()}; return klawlyElementsInRegion;`)() as (root: unknown, region: object, max: number) => { name: string }[];
		const root = build(box('root', 0, 0, 500, 500, [
			box('left', 10, 10, 90, 90, [box('leftChild', 20, 20, 40, 40)]),
			box('wide', 0, 100, 500, 150),
			box('inside', 120, 10, 180, 60),
			box('tiny', 130, 70, 131, 71),
		]));
		const region = { x: 5, y: 5, width: 200, height: 90 };
		assert.deepStrictEqual([
			inRegion(root, region, 10).map(e => e.name),
			inRegion(root, region, 1).map(e => e.name),
		], [['left', 'inside'], ['left']]);
	});
});
