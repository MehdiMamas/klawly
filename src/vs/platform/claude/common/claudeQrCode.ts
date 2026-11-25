/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A small QR Code encoder for Share to Phone (issue 863): byte mode, error
 * correction level L, versions 1 to 6 (up to 134 bytes), which holds the
 * claude.ai links Remote Control returns. It returns the dark modules; the
 * caller draws them. Longer text returns undefined.
 */

/** Per version 1 to 6: [data codewords per block, blocks, error correction codewords per block]. */
const VERSIONS: readonly (readonly [number, number, number])[] = [
	[19, 1, 7],
	[34, 1, 10],
	[55, 1, 15],
	[80, 1, 20],
	[108, 1, 26],
	[68, 2, 18],
];

/** Alignment pattern centres per version 1 to 6. */
const ALIGNMENT: readonly (readonly number[])[] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];

const EXP: number[] = [];
const LOG: number[] = new Array<number>(256).fill(0);
for (let i = 0, x = 1; i < 255; i++) {
	EXP[i] = x;
	LOG[x] = i;
	x <<= 1;
	if (x & 0x100) {
		x ^= 0x11d;
	}
}

function multiply(a: number, b: number): number {
	return a === 0 || b === 0 ? 0 : EXP[(LOG[a] + LOG[b]) % 255];
}

/** The Reed-Solomon remainder of `data` for `count` error correction codewords. */
function reedSolomon(data: readonly number[], count: number): number[] {
	let generator = [1];
	for (let i = 0; i < count; i++) {
		const next = new Array<number>(generator.length + 1).fill(0);
		for (let j = 0; j < generator.length; j++) {
			next[j] ^= generator[j];
			next[j + 1] ^= multiply(generator[j], EXP[i]);
		}
		generator = next;
	}
	const result = new Array<number>(count).fill(0);
	for (const byte of data) {
		const factor = byte ^ result[0];
		result.shift();
		result.push(0);
		for (let i = 0; i < count; i++) {
			result[i] ^= multiply(generator[i + 1], factor);
		}
	}
	return result;
}

/** The data bits for `bytes` in byte mode, padded to `capacity` codewords. */
function dataCodewords(bytes: Uint8Array, capacity: number): number[] {
	const bits: number[] = [];
	const push = (value: number, length: number) => {
		for (let i = length - 1; i >= 0; i--) {
			bits.push((value >>> i) & 1);
		}
	};
	push(0b0100, 4);
	push(bytes.length, 8);
	for (const byte of bytes) {
		push(byte, 8);
	}
	push(0, Math.min(4, capacity * 8 - bits.length));
	while (bits.length % 8 !== 0) {
		bits.push(0);
	}
	const words: number[] = [];
	for (let i = 0; i < bits.length; i += 8) {
		words.push(parseInt(bits.slice(i, i + 8).join(''), 2));
	}
	for (let pad = 0; words.length < capacity; pad++) {
		words.push(pad % 2 === 0 ? 0xec : 0x11);
	}
	return words;
}

/** Data and error correction codewords of all blocks, interleaved. */
function interleave(words: readonly number[], blocks: number, perBlock: number, ecCount: number): number[] {
	const data: number[][] = [];
	const ec: number[][] = [];
	for (let b = 0; b < blocks; b++) {
		const block = words.slice(b * perBlock, (b + 1) * perBlock);
		data.push(block);
		ec.push(reedSolomon(block, ecCount));
	}
	const out: number[] = [];
	for (let i = 0; i < perBlock; i++) {
		data.forEach(block => out.push(block[i]));
	}
	for (let i = 0; i < ecCount; i++) {
		ec.forEach(block => out.push(block[i]));
	}
	return out;
}

const MASKS: readonly ((row: number, column: number) => boolean)[] = [
	(r, c) => (r + c) % 2 === 0,
	r => r % 2 === 0,
	(_, c) => c % 3 === 0,
	(r, c) => (r + c) % 3 === 0,
	(r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
	(r, c) => (r * c) % 2 + (r * c) % 3 === 0,
	(r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
	(r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
];

/** The 15 format bits for error correction level L and `mask`. */
function formatBits(mask: number): number {
	const data = (0b01 << 3) | mask;
	let remainder = data << 10;
	for (let i = 14; i >= 10; i--) {
		if ((remainder >>> i) & 1) {
			remainder ^= 0x537 << (i - 10);
		}
	}
	return ((data << 10) | remainder) ^ 0x5412;
}

/** The penalty of a finished symbol: lower scans better. */
function penalty(grid: readonly (readonly boolean[])[]): number {
	const size = grid.length;
	let score = 0;
	const lines: boolean[][] = [];
	for (let i = 0; i < size; i++) {
		lines.push([...grid[i]]);
		lines.push(grid.map(row => row[i]));
	}
	for (const line of lines) {
		let run = 1;
		for (let i = 1; i < size; i++) {
			if (line[i] === line[i - 1]) {
				run++;
				if (run === 5) {
					score += 3;
				} else if (run > 5) {
					score++;
				}
			} else {
				run = 1;
			}
		}
		for (let i = 0; i + 10 < size; i++) {
			const window = line.slice(i, i + 11).map(dark => dark ? 1 : 0).join('');
			if (window === '10111010000' || window === '00001011101') {
				score += 40;
			}
		}
	}
	for (let r = 0; r + 1 < size; r++) {
		for (let c = 0; c + 1 < size; c++) {
			if (grid[r][c] === grid[r][c + 1] && grid[r][c] === grid[r + 1][c] && grid[r][c] === grid[r + 1][c + 1]) {
				score += 3;
			}
		}
	}
	const dark = grid.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
	score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
	return score;
}

/**
 * The QR Code for `text` as rows of modules (true is dark), or undefined when
 * it does not fit version 6 at level L.
 */
export function claudeQrCode(text: string): boolean[][] | undefined {
	const bytes = new TextEncoder().encode(text);
	const versionIndex = VERSIONS.findIndex(([perBlock, blocks]) => bytes.length + 2 <= perBlock * blocks);
	if (versionIndex < 0) {
		return undefined;
	}
	const [perBlock, blocks, ecCount] = VERSIONS[versionIndex];
	const codewords = interleave(dataCodewords(bytes, perBlock * blocks), blocks, perBlock, ecCount);
	const size = 17 + 4 * (versionIndex + 1);
	const dark: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
	const reserved: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
	const set = (r: number, c: number, value: boolean) => {
		if (r >= 0 && c >= 0 && r < size && c < size) {
			dark[r][c] = value;
			reserved[r][c] = true;
		}
	};

	const finder = (top: number, left: number) => {
		for (let r = -1; r <= 7; r++) {
			for (let c = -1; c <= 7; c++) {
				const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
				set(top + r, left + c, ring !== 4 && ring !== 2 ? r >= 0 && r <= 6 && c >= 0 && c <= 6 : false);
			}
		}
	};
	finder(0, 0);
	finder(0, size - 7);
	finder(size - 7, 0);
	const centres = ALIGNMENT[versionIndex];
	for (const r of centres) {
		for (const c of centres) {
			if (reserved[r][c]) {
				continue;
			}
			for (let dr = -2; dr <= 2; dr++) {
				for (let dc = -2; dc <= 2; dc++) {
					set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
				}
			}
		}
	}
	for (let i = 8; i < size - 8; i++) {
		set(6, i, i % 2 === 0);
		set(i, 6, i % 2 === 0);
	}
	set(size - 8, 8, true);
	for (let i = 0; i < 9; i++) {
		reserved[8][i] = reserved[i][8] = true;
	}
	for (let i = 0; i < 8; i++) {
		reserved[8][size - 1 - i] = reserved[size - 1 - i][8] = true;
	}

	const bits: boolean[] = [];
	for (const word of codewords) {
		for (let i = 7; i >= 0; i--) {
			bits.push(((word >>> i) & 1) === 1);
		}
	}
	const place = (mask: number): boolean[][] => {
		const grid = dark.map(row => [...row]);
		let index = 0;
		for (let right = size - 1; right >= 1; right -= 2) {
			if (right === 6) {
				right = 5;
			}
			for (let step = 0; step < size; step++) {
				const r = ((right + 1) & 2) === 0 ? size - 1 - step : step;
				for (const c of [right, right - 1]) {
					if (!reserved[r][c]) {
						const bit = index < bits.length ? bits[index++] : false;
						grid[r][c] = bit !== MASKS[mask](r, c);
					}
				}
			}
		}
		const format = formatBits(mask);
		const f = (i: number) => ((format >>> i) & 1) === 1;
		for (let i = 0; i <= 5; i++) {
			grid[i][8] = f(i);
			grid[8][size - 1 - i] = f(i);
		}
		grid[7][8] = f(6);
		grid[8][size - 7] = f(6);
		grid[8][8] = f(7);
		grid[size - 8][8] = true;
		grid[8][7] = f(8);
		grid[size - 7][8] = f(8);
		for (let i = 9; i < 15; i++) {
			grid[8][14 - i] = f(i);
			grid[size - 15 + i][8] = f(i);
		}
		grid[8][size - 8] = f(7);
		return grid;
	};
	let best: boolean[][] | undefined;
	let bestScore = Infinity;
	for (let mask = 0; mask < MASKS.length; mask++) {
		const grid = place(mask);
		const score = penalty(grid);
		if (score < bestScore) {
			best = grid;
			bestScore = score;
		}
	}
	return best;
}

/** The QR Code as an SVG image with a four-module quiet zone, black on white. */
export function claudeQrCodeSvg(text: string, pixelsPerModule = 6): string | undefined {
	const grid = claudeQrCode(text);
	if (!grid) {
		return undefined;
	}
	const quiet = 4;
	const side = grid.length + quiet * 2;
	const cells: string[] = [];
	grid.forEach((row, r) => row.forEach((on, c) => {
		if (on) {
			cells.push(`M${c + quiet},${r + quiet}h1v1h-1z`);
		}
	}));
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" width="${side * pixelsPerModule}" height="${side * pixelsPerModule}" shape-rendering="crispEdges"><rect width="${side}" height="${side}" fill="#fff"/><path d="${cells.join('')}" fill="#000"/></svg>`;
}
