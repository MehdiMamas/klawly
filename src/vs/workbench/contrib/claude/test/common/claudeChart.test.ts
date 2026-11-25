/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { formatClaudeChartValue, layoutClaudeChart, parseClaudeChart } from '../../common/claudeChart.js';

suite('Claude chart blocks', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the Klawly spec parses, with a missing value as NaN and an unnamed series by number', () => {
		const chart = parseClaudeChart('chart', JSON.stringify({
			type: 'line', title: 'Build time', x: 'Day', y: 'Seconds',
			labels: ['Mon', 'Tue', 'Wed'],
			series: [{ name: 'main', values: [3, '4', null] }, { values: [1, 2, 3] }],
		}));
		assert.deepStrictEqual(chart, {
			kind: 'line', title: 'Build time', xTitle: 'Day', yTitle: 'Seconds',
			labels: ['Mon', 'Tue', 'Wed'],
			series: [{ name: 'main', values: [3, 4, NaN] }, { name: '2', values: [1, 2, 3] }],
		});
	});

	test('the Vega-Lite subset parses: color splits series, duplicates sum or average, horizontal bars stand up', () => {
		const rows = [
			{ month: 'Jan', team: 'A', bugs: 2 }, { month: 'Jan', team: 'A', bugs: 4 },
			{ month: 'Jan', team: 'B', bugs: 1 }, { month: 'Feb', team: 'A', bugs: 5 },
		];
		const grouped = parseClaudeChart('vega-lite', JSON.stringify({
			mark: { type: 'bar' }, data: { values: rows },
			encoding: { x: { field: 'month', type: 'nominal' }, y: { field: 'bugs', type: 'quantitative', title: 'Bugs' }, color: { field: 'team' } },
		}));
		const horizontal = parseClaudeChart('vegalite', JSON.stringify({
			mark: 'bar', data: { values: rows },
			encoding: { x: { field: 'bugs', type: 'quantitative', aggregate: 'mean' }, y: { field: 'team', type: 'nominal' } },
		}));
		assert.deepStrictEqual([grouped, horizontal], [{
			kind: 'bar', title: undefined, xTitle: 'month', yTitle: 'Bugs',
			labels: ['Jan', 'Feb'],
			series: [{ name: 'A', values: [6, 5] }, { name: 'B', values: [1, NaN] }],
		}, {
			kind: 'bar', title: undefined, xTitle: 'team', yTitle: 'bugs',
			labels: ['A', 'B'],
			series: [{ name: 'bugs', values: [11 / 3, 1] }],
		}]);
	});

	test('anything Klawly cannot draw stays a code block', () => {
		assert.deepStrictEqual([
			parseClaudeChart('chart', 'not json'),
			parseClaudeChart('chart', '[1, 2]'),
			parseClaudeChart('chart', JSON.stringify({ type: 'pie', labels: ['a'], series: [{ values: [1] }] })),
			parseClaudeChart('chart', JSON.stringify({ type: 'bar', labels: [], series: [{ values: [] }] })),
			parseClaudeChart('chart', JSON.stringify({ type: 'bar', labels: ['a'], series: [{ values: ['x'] }] })),
			parseClaudeChart('vega-lite', JSON.stringify({ mark: 'point', data: { values: [{ a: 1, b: 2 }] }, encoding: { x: { field: 'a' }, y: { field: 'b' } } })),
			parseClaudeChart('vega-lite', JSON.stringify({ mark: 'bar', data: { url: 'data.csv' }, encoding: { x: { field: 'a' }, y: { field: 'b' } } })),
		], [undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
	});

	test('layout: round ticks from zero, grouped bars, a missing value breaks the line', () => {
		const bars = layoutClaudeChart({ kind: 'bar', labels: ['a', 'b'], series: [{ name: 's', values: [10, -5] }] }, 152, 132);
		const line = layoutClaudeChart({ kind: 'line', labels: ['a', 'b', 'c'], series: [{ name: 's', values: [1, NaN, 3] }] }, 152, 132);
		assert.deepStrictEqual({
			plot: bars.plot,
			ticks: bars.ticks.map(tick => tick.label),
			bars: bars.bars.map(bar => [bar.x, bar.y, bar.width, bar.height].map(value => Math.round(value * 100) / 100)),
			segments: line.lines[0].segments.map(segment => segment.map(point => point.label)),
			values: [0.30000000000000004, 12000, 2500000].map(formatClaudeChartValue),
		}, {
			plot: { x: 44, y: 8, width: 100, height: 100 },
			ticks: ['-5', '0', '5', '10'],
			bars: [[51.5, 8, 35, 66.67], [101.5, 74.67, 35, 33.33]],
			segments: [['a'], ['c']],
			values: ['0.3', '12k', '2.5M'],
		});
	});
});
