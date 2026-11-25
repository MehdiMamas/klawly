/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType, getWindow } from '../../../../../base/browser/dom.js';
import { IMouseWheelEvent } from '../../../../../base/browser/mouseEvent.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IChatOutputRendererService } from '../../../chat/browser/chatOutputItemRenderer.js';
import { CLAUDE_CHART_LANGUAGES, ClaudeChart, formatClaudeChartValue, layoutClaudeChart, parseClaudeChart } from '../../common/claudeChart.js';

/** Draws Mermaid and chart fences in Claude's replies (issue 492). */
export const CLAUDE_CHAT_DIAGRAMS_SETTING = 'claude.chat.renderDiagrams';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'claude',
	order: 102,
	title: localize('claudeConfigurationTitle', "AI / Claude"),
	type: 'object',
	properties: {
		[CLAUDE_CHAT_DIAGRAMS_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeChatDiagrams', "Draws Mermaid diagrams and small charts (chart or vega-lite blocks) in Claude's replies once the reply finishes. When off, they show as code. Diagrams render offline in a sandboxed view."),
		},
	},
});

const MERMAID = 'mermaid';
/** The built-in Mermaid extension's command; it opens the diagram in its own editor. */
const MERMAID_OPEN_IN_EDITOR = '_mermaid-markdown.openInEditor';
/**
 * The renderer service scrolls upstream chat widgets by session; Klawly has none, so the
 * diagram passes a resource no widget owns and forwards the wheel itself.
 */
const DIAGRAM_SESSION = URI.from({ scheme: 'klawly-chat', path: '/diagram' });

function mermaidTitle(): string {
	return localize('claudeDiagramTitle', "Mermaid diagram");
}

const CHART_WIDTH = 480;
const CHART_HEIGHT = 220;
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Turns finished ```mermaid, ```chart and ```vega-lite fences into drawings with a
 * Show Source toggle and Open in Editor. Mermaid reuses the built-in Mermaid extension's
 * chat renderer (a sandboxed webview with no network, colored from the theme); charts are
 * plain SVG colored by the theme's chart tokens (DL-01). The frame is the code block's (DL-54).
 */
export class ClaudeDiagramBlocks {

	constructor(
		@IChatOutputRendererService private readonly _outputs: IChatOutputRendererService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@ICommandService private readonly _commands: ICommandService,
		@IEditorService private readonly _editors: IEditorService,
		@IClipboardService private readonly _clipboard: IClipboardService,
		@INotificationService private readonly _notifications: INotificationService,
	) { }

	/**
	 * The drawing for a fence, or undefined when the fence is not a diagram or chart Klawly
	 * draws. While `live` (the reply still streams) every fence stays code: it may be cut short.
	 */
	render(languageId: string, value: string, live: boolean, store: DisposableStore): HTMLElement | undefined {
		const language = languageId.toLowerCase();
		if (live || !this._configuration.getValue<boolean>(CLAUDE_CHAT_DIAGRAMS_SETTING)) {
			return undefined;
		}
		const code = value.replace(/\n$/, '');
		if (language === MERMAID && this._outputs.hasCodeBlockRenderer(MERMAID)) {
			return this.frame(localize('claudeDiagramMermaid', "Mermaid"), code, store, view => this.drawMermaid(view, code, store), () => this.openMermaid(code));
		}
		if (CLAUDE_CHART_LANGUAGES.includes(language)) {
			const chart = parseClaudeChart(language, code);
			if (chart) {
				return this.frame(localize('claudeDiagramChart', "Chart"), code, store, view => drawChart(view, chart), () => this.openSource(code, 'json'));
			}
		}
		return undefined;
	}

	/** The code block frame: a header with the toggle and actions, the drawing, and the source behind the toggle. */
	private frame(label: string, code: string, store: DisposableStore, draw: (view: HTMLElement) => void, open: () => Promise<unknown>): HTMLElement {
		const block = $('.claude-codeblock.claude-diagram');
		const header = append(block, $('.claude-codeblock-header'));
		append(header, $('span.path')).textContent = label;
		const view = append(block, $('.claude-diagram-view'));
		const source = append(block, $('pre.claude-diagram-source'));
		source.hidden = true;
		append(source, $('code')).textContent = code;

		const toggle = this.action(header, store, Codicon.code, localize('claudeDiagramShowSource', "Show Source"), () => {
			const showSource = source.hidden !== false;
			source.hidden = !showSource;
			view.hidden = showSource;
			toggle.classList.toggle('is-active', showSource);
			toggle.setAttribute('aria-pressed', String(showSource));
		});
		toggle.setAttribute('aria-pressed', 'false');
		this.action(header, store, Codicon.goToFile, localize('claudeDiagramOpen', "Open in Editor"), open);
		this.action(header, store, Codicon.copy, localize('claudeCopyCode', "Copy"), () => this._clipboard.writeText(code));
		draw(view);
		return block;
	}

	private action(parent: HTMLElement, store: DisposableStore, icon: ThemeIcon, label: string, run: () => unknown): HTMLButtonElement {
		const button = append(parent, $<HTMLButtonElement>('button.claude-icon-btn'));
		button.type = 'button';
		button.title = label;
		button.setAttribute('aria-label', label);
		append(button, $(ThemeIcon.asCSSSelector(icon)));
		store.add(addDisposableListener(button, EventType.CLICK, event => {
			event.preventDefault();
			void Promise.resolve(run()).catch(error => this._notifications.error(error instanceof Error ? error.message : String(error)));
		}));
		return button;
	}

	private drawMermaid(view: HTMLElement, code: string, store: DisposableStore): void {
		view.classList.add('is-mermaid');
		const waiting = append(view, $('span.claude-diagram-wait'));
		waiting.textContent = localize('claudeDiagramDrawing', "Drawing diagram...");
		const cts = new CancellationTokenSource();
		store.add(toDisposable(() => cts.dispose(true)));
		void this._outputs.renderCodeBlock(MERMAID, new TextEncoder().encode(code), view, {
			title: mermaidTitle(),
			chatSessionResource: DIAGRAM_SESSION,
		}, cts.token).then(part => {
			if (cts.token.isCancellationRequested) {
				part.dispose();
				return;
			}
			store.add(part);
			waiting.remove();
			store.add(part.webview.onDidWheel(event => forwardWheel(view, event)));
		}, error => {
			if (isCancellationError(error)) {
				return;
			}
			waiting.textContent = localize('claudeDiagramFailed', "Klawly could not draw this diagram. Show Source has the Mermaid text.");
			view.classList.add('is-failed');
		});
	}

	private async openMermaid(code: string): Promise<void> {
		try {
			await this._commands.executeCommand(MERMAID_OPEN_IN_EDITOR, { mermaidSource: code, title: mermaidTitle() });
		} catch {
			await this.openSource(code, MERMAID);
		}
	}

	private openSource(code: string, languageId: string): Promise<unknown> {
		return this._editors.openEditor({ resource: undefined, contents: code, languageId, options: { pinned: true } });
	}
}

/**
 * The diagram's webview eats wheel events; replaying them on its host lets the timeline's
 * scrollable element scroll past the diagram.
 */
function forwardWheel(host: HTMLElement, event: IMouseWheelEvent): void {
	const targetWindow = getWindow(host);
	host.dispatchEvent(new targetWindow.WheelEvent('wheel', {
		deltaX: event.deltaX,
		deltaY: event.deltaY,
		deltaZ: event.deltaZ,
		deltaMode: event.deltaMode,
		bubbles: true,
		cancelable: true,
	}));
}

function svg<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] {
	const element = parent.ownerDocument.createElementNS(SVG_NS, tag);
	for (const [name, value] of Object.entries(attributes)) {
		element.setAttribute(name, String(value));
	}
	parent.appendChild(element);
	return element;
}

/** A small bar or line chart as SVG. Series colors come from the theme's chart tokens (DL-01). */
function drawChart(view: HTMLElement, chart: ClaudeChart): void {
	view.classList.add('is-chart');
	if (chart.title) {
		append(view, $('.claude-chart-title')).textContent = chart.title;
	}
	if (chart.yTitle) {
		append(view, $('.claude-chart-axis.is-y')).textContent = chart.yTitle;
	}
	const layout = layoutClaudeChart(chart, CHART_WIDTH, CHART_HEIGHT);
	const root = svg(view, 'svg', { width: CHART_WIDTH, height: CHART_HEIGHT, viewBox: `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`, role: 'img', class: 'claude-chart' });
	root.setAttribute('aria-label', chart.title ?? (chart.kind === 'bar'
		? localize('claudeChartBarLabel', "Bar chart of {0} values", chart.labels.length)
		: localize('claudeChartLineLabel', "Line chart of {0} values", chart.labels.length)));

	const { plot } = layout;
	for (const tick of layout.ticks) {
		svg(root, 'line', { x1: plot.x, x2: plot.x + plot.width, y1: tick.y, y2: tick.y, class: 'grid' });
		svg(root, 'text', { x: plot.x - 6, y: tick.y, class: 'tick is-value' }).textContent = tick.label;
	}
	for (const category of layout.categories) {
		svg(root, 'text', { x: category.x, y: plot.y + plot.height + 16, class: 'tick is-category' }).textContent = category.label;
	}
	const named = chart.series.length > 1;
	for (const bar of layout.bars) {
		const rect = svg(root, 'rect', { x: bar.x, y: bar.y, width: Math.max(bar.width - 1, 1), height: Math.max(bar.height, 0.5), rx: 2, class: `mark series-${bar.series}` });
		svg(rect, 'title', {}).textContent = pointLabel(chart, bar.series, bar.label, bar.value, named);
	}
	for (const line of layout.lines) {
		for (const segment of line.segments) {
			svg(root, 'polyline', { points: segment.map(point => `${point.x},${point.y}`).join(' '), class: `line series-${line.series}` });
			for (const point of segment) {
				const dot = svg(root, 'circle', { cx: point.x, cy: point.y, r: 2.5, class: `mark series-${line.series}` });
				svg(dot, 'title', {}).textContent = pointLabel(chart, line.series, point.label, point.value, named);
			}
		}
	}

	if (chart.xTitle) {
		append(view, $('.claude-chart-axis.is-x')).textContent = chart.xTitle;
	}
	if (named) {
		const legend = append(view, $('.claude-chart-legend'));
		chart.series.forEach((series, index) => {
			const item = append(legend, $('span.item'));
			append(item, $(`span.swatch.series-${index}`));
			append(item, $('span.name')).textContent = series.name;
		});
	}
}

function pointLabel(chart: ClaudeChart, series: number, label: string, value: number, named: boolean): string {
	return named
		? localize('claudeChartPointSeries', "{0}, {1}: {2}", label, chart.series[series].name, formatClaudeChartValue(value))
		: localize('claudeChartPoint', "{0}: {1}", label, formatClaudeChartValue(value));
}
