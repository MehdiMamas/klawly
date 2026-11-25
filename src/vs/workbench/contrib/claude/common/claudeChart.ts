/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Small charts in Claude's replies (issue 492). A ```chart block holds Klawly's own JSON
 * spec; a ```vega-lite block may use the common Vega-Lite subset (inline `data.values`,
 * a `bar` or `line` mark, `x`/`y` fields and an optional `color` field). Both become one
 * {@link ClaudeChart}, which {@link layoutClaudeChart} turns into plain geometry for SVG.
 * No Vega runtime ships in Klawly, so anything outside the subset stays a code block.
 */

export type ClaudeChartKind = 'bar' | 'line';

export interface ClaudeChartSeries {
	readonly name: string;
	/** One value per label; `NaN` where the series has no value. */
	readonly values: readonly number[];
}

export interface ClaudeChart {
	readonly kind: ClaudeChartKind;
	readonly title?: string;
	readonly xTitle?: string;
	readonly yTitle?: string;
	readonly labels: readonly string[];
	readonly series: readonly ClaudeChartSeries[];
}

/** The fence languages drawn as charts. */
export const CLAUDE_CHART_LANGUAGES: readonly string[] = ['chart', 'vega-lite', 'vegalite'];

/** More than this many labels or series is not a "small chart"; it stays a code block. */
const MAX_LABELS = 200;
const MAX_SERIES = 8;

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };
type JsonObject = { readonly [key: string]: Json };

function isObject(value: Json | undefined): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: Json | undefined): string | undefined {
	if (typeof value === 'string') {
		return value.trim() || undefined;
	}
	if (isObject(value) && typeof value.text === 'string') {
		return value.text.trim() || undefined;
	}
	return undefined;
}

function toNumber(value: Json | undefined): number {
	if (typeof value === 'number') {
		return value;
	}
	if (typeof value === 'string' && value.trim() !== '') {
		return Number(value);
	}
	return NaN;
}

function chartKind(value: Json | undefined): ClaudeChartKind | undefined {
	const kind = isObject(value) ? value.type : value;
	return kind === 'bar' || kind === 'line' ? kind : undefined;
}

/** Parses a fenced chart, or returns undefined when it is not one Klawly can draw. */
export function parseClaudeChart(languageId: string, source: string): ClaudeChart | undefined {
	let parsed: Json;
	try {
		parsed = JSON.parse(source);
	} catch {
		return undefined;
	}
	if (!isObject(parsed)) {
		return undefined;
	}
	const chart = languageId.toLowerCase() === 'chart' ? fromKlawlySpec(parsed) : fromVegaLite(parsed);
	if (!chart || chart.labels.length === 0 || chart.labels.length > MAX_LABELS || chart.series.length === 0 || chart.series.length > MAX_SERIES) {
		return undefined;
	}
	if (!chart.series.some(series => series.values.some(value => Number.isFinite(value)))) {
		return undefined;
	}
	return chart;
}

/** `{ "type": "bar", "title", "x", "y", "labels": [...], "series": [{ "name", "values": [...] }] }`. */
function fromKlawlySpec(spec: JsonObject): ClaudeChart | undefined {
	const kind = chartKind(spec.type);
	if (!kind || !Array.isArray(spec.labels) || !Array.isArray(spec.series)) {
		return undefined;
	}
	const labels = (spec.labels as readonly Json[]).map(label => String(label ?? ''));
	const series: ClaudeChartSeries[] = [];
	for (const [index, entry] of (spec.series as readonly Json[]).entries()) {
		if (!isObject(entry) || !Array.isArray(entry.values)) {
			return undefined;
		}
		const values = entry.values as readonly Json[];
		series.push({
			name: text(entry.name) ?? String(index + 1),
			values: labels.map((_, i) => toNumber(values[i])),
		});
	}
	return { kind, title: text(spec.title), xTitle: text(spec.x), yTitle: text(spec.y), labels, series };
}

/** The Vega-Lite subset: inline values, one bar or line mark, x/y fields and an optional color field. */
function fromVegaLite(spec: JsonObject): ClaudeChart | undefined {
	const kind = chartKind(spec.mark);
	const data = spec.data;
	const values = isObject(data) ? data.values : undefined;
	const rows = Array.isArray(values) ? (values as readonly Json[]).filter(isObject) : undefined;
	const encoding = isObject(spec.encoding) ? spec.encoding : undefined;
	const x = encoding?.x;
	const y = encoding?.y;
	if (!kind || !rows || !encoding || !isObject(x) || !isObject(y)) {
		return undefined;
	}
	// Horizontal bars put the numbers on x; Klawly draws every bar chart upright.
	const horizontal = x.type === 'quantitative' && y.type !== 'quantitative';
	const category = horizontal ? y : x;
	const measure = horizontal ? x : y;
	const categoryField = typeof category.field === 'string' ? category.field : undefined;
	const measureField = typeof measure.field === 'string' ? measure.field : undefined;
	if (!categoryField || !measureField) {
		return undefined;
	}
	const color = encoding.color;
	const colorField = isObject(color) && typeof color.field === 'string' ? color.field : undefined;
	const mean = measure.aggregate === 'mean' || measure.aggregate === 'average';

	const labels: string[] = [];
	const names: string[] = [];
	const sums = new Map<string, { sum: number; count: number }>();
	for (const row of rows) {
		const label = String(row[categoryField] ?? '');
		const name = colorField ? String(row[colorField] ?? '') : measureField;
		const value = toNumber(row[measureField]);
		if (!labels.includes(label)) {
			labels.push(label);
		}
		if (!names.includes(name)) {
			names.push(name);
		}
		if (!Number.isFinite(value)) {
			continue;
		}
		const key = JSON.stringify([name, label]);
		const cell = sums.get(key) ?? { sum: 0, count: 0 };
		sums.set(key, { sum: cell.sum + value, count: cell.count + 1 });
	}
	const series = names.map(name => ({
		name,
		values: labels.map(label => {
			const cell = sums.get(JSON.stringify([name, label]));
			return !cell ? NaN : mean ? cell.sum / cell.count : cell.sum;
		}),
	}));
	return {
		kind,
		title: text(spec.title),
		xTitle: text(category.title) ?? categoryField,
		yTitle: text(measure.title) ?? measureField,
		labels,
		series,
	};
}

export interface ClaudeChartRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface ClaudeChartBar extends ClaudeChartRect {
	readonly series: number;
	readonly label: string;
	readonly value: number;
}

export interface ClaudeChartPoint {
	readonly x: number;
	readonly y: number;
	readonly label: string;
	readonly value: number;
}

export interface ClaudeChartLayout {
	readonly width: number;
	readonly height: number;
	readonly plot: ClaudeChartRect;
	/** Value axis ticks, bottom to top. */
	readonly ticks: readonly { readonly y: number; readonly label: string }[];
	/** Category labels under the plot; crowded ones are skipped. */
	readonly categories: readonly { readonly x: number; readonly label: string }[];
	readonly bars: readonly ClaudeChartBar[];
	/** One polyline per series; a missing value breaks the line. */
	readonly lines: readonly { readonly series: number; readonly segments: readonly (readonly ClaudeChartPoint[])[] }[];
}

/** Room for the value labels left of the plot and the category labels under it. */
const PAD_LEFT = 44;
const PAD_RIGHT = 8;
const PAD_TOP = 8;
const PAD_BOTTOM = 24;
/** The narrowest gap a category label gets before labels are skipped. */
const MIN_LABEL_GAP = 44;
const MAX_LABEL_CHARS = 12;

/** A round step near `span / count`: 1, 2 or 5 times a power of ten. */
function niceStep(span: number, count: number): number {
	const raw = span / count;
	const power = Math.pow(10, Math.floor(Math.log10(raw)));
	const fraction = raw / power;
	return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
}

/** A tick value without float noise: `0.30000000000000004` reads `0.3`, `12000` reads `12k`. */
export function formatClaudeChartValue(value: number): string {
	const abs = Math.abs(value);
	if (abs >= 1e6) {
		return `${round(value / 1e6)}M`;
	}
	if (abs >= 1e4) {
		return `${round(value / 1e3)}k`;
	}
	return String(round(value));
}

function round(value: number): number {
	return Number(value.toPrecision(4));
}

function shorten(label: string): string {
	return label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label;
}

/** Places the chart in a `width` by `height` box. Bars start at zero; lines too, unless a value is negative. */
export function layoutClaudeChart(chart: ClaudeChart, width: number, height: number): ClaudeChartLayout {
	const plot: ClaudeChartRect = { x: PAD_LEFT, y: PAD_TOP, width: width - PAD_LEFT - PAD_RIGHT, height: height - PAD_TOP - PAD_BOTTOM };
	const finite = chart.series.flatMap(series => series.values.filter(value => Number.isFinite(value)));
	const dataMin = Math.min(0, ...finite);
	const dataMax = Math.max(0, ...finite);
	const step = niceStep(dataMax - dataMin || 1, 4);
	const min = Math.floor(dataMin / step) * step;
	const max = Math.max(Math.ceil(dataMax / step) * step, min + step);
	const yOf = (value: number) => plot.y + plot.height - (value - min) / (max - min) * plot.height;

	const ticks: { y: number; label: string }[] = [];
	for (let value = min; value <= max + step / 2; value += step) {
		ticks.push({ y: yOf(value), label: formatClaudeChartValue(value) });
	}

	const count = chart.labels.length;
	const band = plot.width / count;
	const centerOf = (index: number) => plot.x + band * (index + 0.5);
	const every = Math.max(1, Math.ceil(MIN_LABEL_GAP / band));
	const categories = chart.labels
		.map((label, index) => ({ x: centerOf(index), label: shorten(label) }))
		.filter((_, index) => index % every === 0);

	const bars: ClaudeChartBar[] = [];
	const lines: { series: number; segments: ClaudeChartPoint[][] }[] = [];
	if (chart.kind === 'bar') {
		const groupWidth = band * 0.7;
		const barWidth = groupWidth / chart.series.length;
		chart.series.forEach((series, seriesIndex) => {
			series.values.forEach((value, index) => {
				if (!Number.isFinite(value)) {
					return;
				}
				const top = yOf(Math.max(value, 0));
				const bottom = yOf(Math.min(value, 0));
				bars.push({
					series: seriesIndex,
					label: chart.labels[index],
					value,
					x: centerOf(index) - groupWidth / 2 + barWidth * seriesIndex,
					y: top,
					width: barWidth,
					height: bottom - top,
				});
			});
		});
	} else {
		chart.series.forEach((series, seriesIndex) => {
			const segments: ClaudeChartPoint[][] = [];
			let current: ClaudeChartPoint[] = [];
			series.values.forEach((value, index) => {
				if (!Number.isFinite(value)) {
					if (current.length) {
						segments.push(current);
						current = [];
					}
					return;
				}
				current.push({ x: centerOf(index), y: yOf(value), label: chart.labels[index], value });
			});
			if (current.length) {
				segments.push(current);
			}
			lines.push({ series: seriesIndex, segments });
		});
	}
	return { width, height, plot, ticks, categories, bars, lines };
}
