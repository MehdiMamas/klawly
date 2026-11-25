/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeQrCode, claudeQrCodeSvg } from '../../common/claudeQrCode.js';

/** The QR Code behind Share to Phone (issue 863). */
suite('Claude QR Code', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const render = (text: string) => claudeQrCode(text)?.map(row => row.map(on => on ? '#' : '.').join(''));

	test('draws the link as a scannable code and refuses text that does not fit', () => {
		const sizes = [17, 18, 32, 33, 53, 54, 78, 79, 106, 107, 134].map(length => claudeQrCode('x'.repeat(length))?.length);
		const svg = claudeQrCodeSvg('https://claude.ai/c', 4);
		assert.deepStrictEqual({
			// Decoded back to the same text with OpenCV's QR detector when this snapshot was made.
			link: render('https://claude.ai/c'),
			sizes,
			tooLong: [claudeQrCode('x'.repeat(135)), claudeQrCodeSvg('x'.repeat(135))],
			svg: [svg?.startsWith('<svg '), svg?.includes('width="132"'), svg?.includes('viewBox="0 0 33 33"')],
		}, {
			link: [
				'#######.#.#.##....#######',
				'#.....#..#####..#.#.....#',
				'#.###.#.###..##.#.#.###.#',
				'#.###.#.###.###...#.###.#',
				'#.###.#.#..##.###.#.###.#',
				'#.....#...##......#.....#',
				'#######.#.#.#.#.#.#######',
				'..........#.#............',
				'####..#.#.####..##..###.#',
				'....#.....#.##..#..#...#.',
				'.######..#####....##.....',
				'##.###.####....#...#.##..',
				'...####..##.#.#..##.#.###',
				'.###.#.#...##.##.####...#',
				'.#..#.###..#.#......#.##.',
				'#....#.##.##..#######...#',
				'..#.#####.#.#.#.#########',
				'........###...#.#...#.#.#',
				'#######..#...##.#.#.#.###',
				'#.....#..###.####...#...#',
				'#.###.#..##..##.######...',
				'#.###.#.#......#.##.#####',
				'#.###.#.#.....##..#.#.##.',
				'#.....#.#..####..#..#.#..',
				'#######.##.#.....########',
			],
			sizes: [21, 25, 25, 29, 29, 33, 33, 37, 37, 41, 41],
			tooLong: [undefined, undefined],
			svg: [true, true, true],
		});
	});
});
