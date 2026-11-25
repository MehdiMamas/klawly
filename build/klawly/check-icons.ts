/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Fails when a product image still carries the upstream blue Code - OSS mark (issue 1389).
// Decodes PNG, ICO, ICNS (every size inside them) and BMP, and measures how much of the
// colored, visible area is blue. SVGs are checked for the upstream blue fills.
// Usage: node build/klawly/check-icons.ts [--report]   (--report lists every file's blue share)

import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { inflateSync } from 'zlib';

const root = join(import.meta.dirname, '..', '..');

/**
 * The product surfaces that must carry the Klawly mark: app icons, installer images, the
 * logos and letterpress art, and the marketplace icon of every built-in extension. Other
 * images (file-type glyphs, language logos, UI and welcome art, test fixtures) may be blue.
 */
const scope = /^(resources\/(linux|server)\/|resources\/win32\/(code|sessions|default|inno)|resources\/darwin\/(code|default|sessions)|build\/.*\.(png|ico|icns|bmp|svg)$|\.vscode\/extensions\/[^/]+\/icon\.png$|extensions\/(?!copilot\/)[^/]+\/(media|images)\/icon\.png$|src\/vs\/.*\/(letterpress|sessions-logo|code-icon)[^/]*\.svg$|src\/vs\/workbench\/contrib\/welcomeGettingStarted\/common\/media\/[^/]+\.svg$|extensions\/typescript-language-features\/resources\/walkthroughs\/[^/]+\.svg$|extensions\/[^/]+\/(media|images)\/(code-icon|favicon)[^/]*$)/;
/**
 * Upstream blue brand fills (hex), blue rgb() values and the named blues. Brand art takes the
 * Klawly orange ramp instead (DL-13 muted accents, DL-94 orange is the product accent); theme
 * variables such as --vscode-charts-blue and git status colours are semantic and stay.
 */
const upstreamBlues = /#(?:0065a9|007acc|0078d4|0078d7|1177bb|2489ca|1f9cf0|0098ff|3794ff|3c99d6|75beff)\b|rgba?\(\s*(?:0|31|36|55)\s*,\s*(?:101|120|122|156|152|137|148)\s*,\s*(?:169|204|212|215|240|255|202)\b|(?<![\w-])(?:blue|dodgerblue|royalblue|steelblue|deepskyblue)(?![\w-])/i;
/** SVGs that keep a blue on purpose: git status colours are semantic. */
const svgKeep = /^extensions\/git\/resources\/icons\//;
/** Share of colored pixels that may be blue before a raster counts as the upstream mark. */
const blueLimit = 0.25;

interface Pixels { readonly width: number; readonly height: number; readonly rgba: Uint8Array }

const channelsOf: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(buf: Buffer): Pixels | undefined {
	if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) {
		return undefined;
	}
	let width = 0, height = 0, depth = 8, colorType = 6, interlace = 0;
	let palette = Buffer.alloc(0), trns = Buffer.alloc(0);
	const data: Buffer[] = [];
	for (let o = 8; o + 8 <= buf.length;) {
		const len = buf.readUInt32BE(o);
		const type = buf.toString('ascii', o + 4, o + 8);
		const body = buf.subarray(o + 8, o + 8 + len);
		if (type === 'IHDR') {
			width = body.readUInt32BE(0); height = body.readUInt32BE(4);
			depth = body[8]; colorType = body[9]; interlace = body[12];
		} else if (type === 'PLTE') {
			palette = body;
		} else if (type === 'tRNS') {
			trns = body;
		} else if (type === 'IDAT') {
			data.push(body);
		}
		o += 12 + len;
	}
	if (interlace !== 0 || depth > 8 || !width) {
		return undefined;
	}
	const channels = channelsOf[colorType];
	const bpp = depth === 8 ? channels : 1;
	const rowBytes = Math.ceil(width * channels * depth / 8);
	const raw = inflateSync(Buffer.concat(data));
	const out = Buffer.alloc(rowBytes * height);
	for (let y = 0; y < height; y++) {
		const f = raw[y * (rowBytes + 1)];
		for (let x = 0; x < rowBytes; x++) {
			const v = raw[y * (rowBytes + 1) + 1 + x];
			const a = x >= bpp ? out[y * rowBytes + x - bpp] : 0;
			const b = y > 0 ? out[(y - 1) * rowBytes + x] : 0;
			const c = x >= bpp && y > 0 ? out[(y - 1) * rowBytes + x - bpp] : 0;
			out[y * rowBytes + x] = (v + (f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? ((a + b) >> 1) : paeth(a, b, c))) & 255;
		}
	}
	const rgba = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const d = (y * width + x) * 4;
			const row = y * rowBytes;
			if (colorType === 6) {
				for (let k = 0; k < 4; k++) { rgba[d + k] = out[row + x * 4 + k]; }
			} else if (colorType === 2) {
				for (let k = 0; k < 3; k++) { rgba[d + k] = out[row + x * 3 + k]; }
				rgba[d + 3] = 255;
			} else if (colorType === 3) {
				let idx: number;
				if (depth === 8) {
					idx = out[row + x];
				} else {
					const bit = x * depth;
					idx = (out[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
				}
				rgba[d] = palette[idx * 3]; rgba[d + 1] = palette[idx * 3 + 1]; rgba[d + 2] = palette[idx * 3 + 2];
				rgba[d + 3] = idx < trns.length ? trns[idx] : 255;
			} else if (colorType === 0) {
				rgba[d] = rgba[d + 1] = rgba[d + 2] = out[row + x]; rgba[d + 3] = 255;
			} else {
				rgba[d] = rgba[d + 1] = rgba[d + 2] = out[row + x * 2]; rgba[d + 3] = out[row + x * 2 + 1];
			}
		}
	}
	return { width, height, rgba };
}

/** Decodes a BMP file, or the DIB inside an ICO entry (whose height counts the AND mask too). */
function decodeDib(buf: Buffer, off: number, inIco: boolean): Pixels | undefined {
	const headerSize = buf.readUInt32LE(off);
	const width = buf.readInt32LE(off + 4);
	let height = buf.readInt32LE(off + 8);
	const bits = buf.readUInt16LE(off + 14);
	const colors = buf.readUInt32LE(off + 32) || (bits <= 8 ? 1 << bits : 0);
	if (inIco) { height = height / 2; }
	const flip = height > 0;
	height = Math.abs(height);
	if (![8, 24, 32].includes(bits) || buf.readUInt32LE(off + 16) > 3 || width <= 0) {
		return undefined;
	}
	const palOff = off + headerSize;
	const dataOff = palOff + (bits <= 8 ? colors * 4 : 0);
	const stride = Math.ceil(width * bits / 32) * 4;
	const rgba = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		const sy = flip ? height - 1 - y : y;
		for (let x = 0; x < width; x++) {
			const d = (y * width + x) * 4;
			const p = dataOff + sy * stride + x * bits / 8;
			if (bits === 8) {
				const pi = palOff + buf[p] * 4;
				rgba[d] = buf[pi + 2]; rgba[d + 1] = buf[pi + 1]; rgba[d + 2] = buf[pi]; rgba[d + 3] = 255;
			} else {
				rgba[d] = buf[p + 2]; rgba[d + 1] = buf[p + 1]; rgba[d + 2] = buf[p];
				rgba[d + 3] = bits === 32 ? buf[p + 3] : 255;
			}
		}
	}
	return { width, height, rgba };
}

/** Every raster inside a file, labelled with where it sits. */
function decodeAll(file: string, buf: Buffer): { label: string; px: Pixels }[] {
	const found: { label: string; px: Pixels }[] = [];
	const add = (label: string, px: Pixels | undefined) => { if (px) { found.push({ label, px }); } };
	const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
	if (ext === '.png') {
		add('png', decodePng(buf));
	} else if (ext === '.bmp') {
		add('bmp', decodeDib(buf, 14, false));
	} else if (ext === '.ico' || ext === '.cur') {
		const n = buf.readUInt16LE(4);
		for (let i = 0; i < n; i++) {
			const size = buf.readUInt32LE(6 + i * 16 + 8);
			const at = buf.readUInt32LE(6 + i * 16 + 12);
			const slice = buf.subarray(at, at + size);
			add(`ico[${i}]`, slice.readUInt32BE(0) === 0x89504e47 ? decodePng(slice) : decodeDib(buf, at, true));
		}
	} else if (ext === '.icns') {
		for (let o = 8; o + 8 <= buf.length;) {
			const type = buf.toString('ascii', o, o + 4);
			const len = buf.readUInt32BE(o + 4);
			const body = buf.subarray(o + 8, o + len);
			if (body.length > 8 && body.readUInt32BE(0) === 0x89504e47) { add(`icns:${type}`, decodePng(body)); }
			o += len;
		}
	}
	return found;
}

/** Share of visible, colored pixels whose hue is blue. */
export function blueShare(px: Pixels): number {
	let colored = 0, blue = 0;
	for (let i = 0; i < px.rgba.length; i += 4) {
		const r = px.rgba[i], g = px.rgba[i + 1], b = px.rgba[i + 2], a = px.rgba[i + 3];
		const max = Math.max(r, g, b), min = Math.min(r, g, b);
		if (a < 128 || max - min < 40) { continue; }
		colored++;
		if (b === max && b - r > 40 && b >= g) { blue++; }
	}
	return colored ? blue / colored : 0;
}

function main(): void {
	const report = process.argv.includes('--report');
	const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true }).split('\n')
		.filter(f => /\.(png|ico|icns|bmp|cur|svg)$/i.test(f) && scope.test(f));
	const bad: string[] = [];
	for (const file of files) {
		let buf: Buffer;
		try { buf = readFileSync(join(root, file)); } catch { continue; }
		if (file.endsWith('.svg')) {
				if (svgKeep.test(file)) { continue; }
			const m = upstreamBlues.exec(buf.toString('utf8'));
			if (m) { bad.push(`${file}: upstream blue ${m[0]}`); }
			continue;
		}
		let rasters: { label: string; px: Pixels }[];
		try { rasters = decodeAll(file, buf); } catch { continue; }
		for (const { label, px } of rasters) {
			const share = blueShare(px);
			if (report && share > 0.05) { console.log(`${share.toFixed(2)} ${file} ${label} ${px.width}x${px.height}`); }
			if (share > blueLimit) { bad.push(`${file} ${label} ${px.width}x${px.height}: ${(share * 100).toFixed(0)}% blue`); }
		}
	}
	console.log(`checked ${files.length} image files`);
	if (bad.length) {
		console.error(`${bad.length} blue icon image(s) found:\n${bad.join('\n')}`);
		process.exit(1);
	}
}

main();
