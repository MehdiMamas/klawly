/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { redactClaudeSecrets } from '../../../../platform/claude/common/claudeSecretPatterns.js';
import type { PreviewBounds, PreviewElement } from './claudePreview.js';

/**
 * Design mode in the browser preview (issue 485): a pick carries the element's
 * XPath, the computed styles that matter for a visual change, its trimmed outer
 * HTML and, in a React or Vue dev build, the owning component.
 */

/** Computed styles a design pick sends: layout, spacing, color and font. */
export const PREVIEW_DESIGN_STYLES: readonly string[] = [
	'display', 'position', 'width', 'height', 'margin', 'padding', 'gap',
	'flex-direction', 'justify-content', 'align-items',
	'color', 'background-color', 'border', 'border-radius', 'box-shadow', 'opacity',
	'font-family', 'font-size', 'font-weight', 'line-height',
];

/** How many elements one design selection holds. */
export const PREVIEW_MAX_PICKS = 10;

const MAX_XPATH = 500;
const MAX_HTML = 1500;
const MAX_STYLE_VALUE = 200;
const MAX_COMPONENT_NAME = 120;
const MAX_COMPONENT_FILE = 300;
const MAX_PROPS = 800;

/** The component that owns a picked element, read from the React or Vue dev build. */
export interface PreviewComponent {
	readonly name: string;
	readonly file?: string;
	/** Props as trimmed JSON, with secrets redacted. */
	readonly props?: string;
}

/** What a design pick adds to a picked element. Every field is optional: a plain pick has none. */
export interface PreviewDesignDetails {
	readonly xpath?: string;
	/** The computed styles in {@link PREVIEW_DESIGN_STYLES}, in that order. */
	readonly styles?: readonly (readonly [string, string])[];
	/** The outer HTML, trimmed. */
	readonly html?: string;
	readonly component?: PreviewComponent;
}

/** Shape check for the design fields the page bridge sends. Unknown style names are dropped; props go through the secret guard. */
export function readPreviewDesignDetails(record: Record<string, unknown>): PreviewDesignDetails {
	const details: { xpath?: string; styles?: (readonly [string, string])[]; html?: string; component?: PreviewComponent } = {};
	const xpath = typeof record.xpath === 'string' ? record.xpath.trim().slice(0, MAX_XPATH) : '';
	if (xpath.startsWith('/')) {
		details.xpath = xpath;
	}
	const styles = readStyles(record.styles);
	if (styles.length > 0) {
		details.styles = styles;
	}
	const html = typeof record.html === 'string' ? record.html.trim().slice(0, MAX_HTML) : '';
	if (html) {
		details.html = redactClaudeSecrets(html);
	}
	const component = readComponent(record.component);
	if (component) {
		details.component = component;
	}
	return details;
}

function readStyles(value: unknown): (readonly [string, string])[] {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return [];
	}
	const record = value as Record<string, unknown>;
	const styles: (readonly [string, string])[] = [];
	for (const name of PREVIEW_DESIGN_STYLES) {
		const raw = record[name];
		const style = typeof raw === 'string' ? raw.trim().slice(0, MAX_STYLE_VALUE) : '';
		if (style) {
			styles.push([name, style]);
		}
	}
	return styles;
}

function readComponent(value: unknown): PreviewComponent | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const name = typeof record.name === 'string' ? record.name.trim().slice(0, MAX_COMPONENT_NAME) : '';
	if (!name) {
		return undefined;
	}
	const file = typeof record.file === 'string' ? record.file.trim().slice(0, MAX_COMPONENT_FILE) : '';
	const props = typeof record.props === 'string' ? record.props.trim().slice(0, MAX_PROPS) : '';
	return {
		name,
		...(file ? { file } : {}),
		...(props ? { props: redactClaudeSecrets(props) } : {}),
	};
}

/** The design lines of an element chip, after its selector, text and bounds. */
export function previewDesignDetailLines(details: PreviewDesignDetails): string[] {
	const lines: string[] = [];
	if (details.xpath) {
		lines.push(`xpath: ${details.xpath}`);
	}
	if (details.component) {
		const file = details.component.file ? ` (${details.component.file})` : '';
		lines.push(`component: ${details.component.name}${file}`);
		if (details.component.props) {
			lines.push(`props: ${details.component.props}`);
		}
	}
	if (details.styles?.length) {
		lines.push('styles:');
		for (const [name, value] of details.styles) {
			lines.push(`  ${name}: ${value}`);
		}
	}
	if (details.html) {
		lines.push('html:', details.html);
	}
	return lines;
}

/**
 * The page rect to crop for one picked element: its bounds inside the preview
 * viewport, clipped to the viewport. Undefined when less than 2px stays visible.
 */
export function previewElementCropRect(viewport: PreviewBounds, element: PreviewBounds): PreviewBounds | undefined {
	const left = Math.max(viewport.x, viewport.x + element.x);
	const top = Math.max(viewport.y, viewport.y + element.y);
	const right = Math.min(viewport.x + viewport.width, viewport.x + element.x + element.width);
	const bottom = Math.min(viewport.y + viewport.height, viewport.y + element.y + element.height);
	if (right - left < 2 || bottom - top < 2) {
		return undefined;
	}
	return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The picked elements of one preview. A click replaces them; a Shift-click adds
 * the element, or removes it when it is already picked.
 */
export class PreviewSelection {
	private _elements: PreviewElement[] = [];

	get elements(): readonly PreviewElement[] {
		return this._elements;
	}

	pick(element: PreviewElement, append: boolean): void {
		if (!append) {
			this._elements = [element];
			return;
		}
		const key = selectionKey(element);
		const index = this._elements.findIndex(candidate => selectionKey(candidate) === key);
		if (index >= 0) {
			this._elements = this._elements.filter((_, i) => i !== index);
		} else if (this._elements.length < PREVIEW_MAX_PICKS) {
			this._elements = [...this._elements, element];
		}
	}

	clear(): void {
		this._elements = [];
	}
}

/** What the preview status names: the one picked selector, or how many elements are picked. */
export function previewSelectionLabel(elements: readonly PreviewElement[]): string | undefined {
	if (elements.length === 0) {
		return undefined;
	}
	return elements.length === 1 ? elements[0].selector : localize('claudePreviewPickedCount', "{0} elements picked", elements.length);
}

function selectionKey(element: PreviewElement): string {
	return element.xpath ?? `${element.selector}@${element.bounds.x},${element.bounds.y}`;
}

/**
 * Page-side helpers the opt-in page bridge includes: `klawlyDesign(el)` returns
 * the design fields for a picked element. Component info reads the React fiber
 * or Vue instance the dev build attaches to DOM nodes; it never throws.
 */
export function previewDesignPageSource(): string {
	return `var klawlyDesignStyles = ${JSON.stringify(PREVIEW_DESIGN_STYLES)};
	function klawlyXpath(el) {
		var parts = [];
		for (var node = el; node && node.nodeType === 1; node = node.parentNode) {
			var index = 1;
			for (var sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
				if (sibling.tagName === node.tagName) {
					index++;
				}
			}
			parts.unshift(String(node.tagName).toLowerCase() + '[' + index + ']');
		}
		return parts.length ? '/' + parts.join('/') : undefined;
	}
	function klawlyStyles(el) {
		var out = {};
		try {
			var computed = getComputedStyle(el);
			for (var i = 0; i < klawlyDesignStyles.length; i++) {
				var value = computed.getPropertyValue(klawlyDesignStyles[i]);
				if (value) {
					out[klawlyDesignStyles[i]] = String(value).slice(0, ${MAX_STYLE_VALUE});
				}
			}
		} catch (e) {
		}
		return out;
	}
	function klawlyProps(props) {
		var count = 0;
		try {
			var json = JSON.stringify(props, function (key, value) {
				if (key === 'children' || ++count > 200) {
					return undefined;
				}
				if (typeof value === 'function') {
					return '[function]';
				}
				if (value && typeof value === 'object' && (value.$$typeof || value.nodeType)) {
					return '[element]';
				}
				return value;
			});
			return json ? json.slice(0, ${MAX_PROPS}) : undefined;
		} catch (e) {
			return undefined;
		}
	}
	function klawlyComponent(el) {
		try {
			var keys = Object.keys(el);
			for (var k = 0; k < keys.length; k++) {
				if (keys[k].indexOf('__reactFiber$') !== 0 && keys[k].indexOf('__reactInternalInstance$') !== 0) {
					continue;
				}
				for (var fiber = el[keys[k]]; fiber; fiber = fiber.return) {
					var type = fiber.type;
					if (!type || typeof type === 'string') {
						continue;
					}
					var name = type.displayName || type.name || (type.render && (type.render.displayName || type.render.name));
					if (name) {
						var source = fiber._debugSource;
						return { name: String(name), file: source && source.fileName ? source.fileName + ':' + source.lineNumber : undefined, props: klawlyProps(fiber.memoizedProps) };
					}
				}
			}
			for (var node = el; node; node = node.parentNode) {
				var vue = node.__vueParentComponent;
				if (vue && vue.type) {
					return { name: String(vue.type.name || vue.type.__name || 'Anonymous'), file: vue.type.__file, props: klawlyProps(vue.props) };
				}
				var legacy = node.__vue__;
				if (legacy && legacy.$options) {
					return { name: String(legacy.$options.name || 'Anonymous'), file: legacy.$options.__file, props: klawlyProps(legacy.$props) };
				}
			}
		} catch (e) {
		}
		return undefined;
	}
	function klawlyElementsInRegion(root, region, max) {
		var found = [];
		function visit(node) {
			for (var child = node.firstElementChild; child && found.length < max; child = child.nextElementSibling) {
				var r = child.getBoundingClientRect();
				if (r.width < 2 || r.height < 2) {
					continue;
				}
				if (r.left >= region.x && r.top >= region.y && r.right <= region.x + region.width && r.bottom <= region.y + region.height) {
					found.push(child);
				} else if (r.right > region.x && r.bottom > region.y && r.left < region.x + region.width && r.top < region.y + region.height) {
					visit(child);
				}
			}
		}
		visit(root);
		return found;
	}
	function klawlyDesign(el) {
		return {
			xpath: klawlyXpath(el),
			styles: klawlyStyles(el),
			html: String(el.outerHTML || '').slice(0, ${MAX_HTML}),
			component: klawlyComponent(el)
		};
	}`;
}
