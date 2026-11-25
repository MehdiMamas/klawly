/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/// <reference lib="dom" />
// The page.evaluate callback below runs in Chromium and uses Image, document and canvas.

// Rebuilds the product icon sets from the source marks in resources/klawly/.
// Usage: node build/klawly/generate-icons.ts
// Rasterizes with the Playwright Chromium already installed for the smoke tests
// (`npx playwright install chromium` if it is missing) and writes ICO, ICNS, BMP,
// XPM, PNG and SVG files in place. File-type icons keep their own page and glyph; only
// the badge in their corner is redrawn with the app icon (issue 751).

import { execFileSync } from 'child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { chromium, type Page } from 'playwright-core';

const root = join(import.meta.dirname, '..', '..');
const appIcon = readFileSync(join(root, 'resources/klawly/app-icon.svg'), 'utf8');
const mark = readFileSync(join(root, 'resources/klawly/klawly-mark.svg'), 'utf8');
const monoMark = readFileSync(join(root, 'resources/klawly/klawly-mark-mono.svg'), 'utf8');

/** Background of the app icon, reused behind the mark on the installer's wizard image. */
const iconBackground = '#1E1E1E';

/**
 * The disk image window, in points. The icon slots match `icon_locations` in
 * build/darwin/dmg-settings.py.template: Klawly.app at (160, 180), Applications at (440, 180).
 */
const dmgWidth = 600;
const dmgHeight = 380;
const dmgBackground = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dmgWidth} ${dmgHeight}">
	<defs>
		<linearGradient id="bg" x1="0" y1="0" x2="0" y2="${dmgHeight}" gradientUnits="userSpaceOnUse">
			<stop offset="0" stop-color="#2A2A2A"/>
			<stop offset="1" stop-color="#131313"/>
		</linearGradient>
		<radialGradient id="glow" cx="300" cy="180" r="260" gradientUnits="userSpaceOnUse">
			<stop offset="0" stop-color="#DD8F52" stop-opacity="0.14"/>
			<stop offset="1" stop-color="#DD8F52" stop-opacity="0"/>
		</radialGradient>
		<linearGradient id="claw" x1="236" y1="0" x2="364" y2="0" gradientUnits="userSpaceOnUse">
			<stop offset="0" stop-color="#DD8F52"/>
			<stop offset="1" stop-color="#DD8F52"/>
		</linearGradient>
	</defs>
	<rect width="${dmgWidth}" height="${dmgHeight}" fill="url(#bg)"/>
	<rect width="${dmgWidth}" height="${dmgHeight}" fill="url(#glow)"/>
	<path d="M236 180 H356" stroke="url(#claw)" stroke-width="4" stroke-linecap="round" stroke-dasharray="0.1 12"/>
	<path d="M352 168 L366 180 L352 192" fill="none" stroke="#DD8F52" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
	<text x="300" y="322" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif" font-size="13" fill="#FFFFFF" fill-opacity="0.6">Drag Klawly to Applications to install</text>
</svg>`;

interface Raster {
	readonly width: number;
	readonly height: number;
	/** Straight (not premultiplied) RGBA rows, top to bottom. */
	readonly rgba: Buffer;
	readonly png: Buffer;
}

interface Placement {
	readonly svg: string;
	readonly width: number;
	readonly height: number;
	readonly size: number;
	readonly x: number;
	readonly y: number;
	readonly background?: string;
}

async function render(page: Page, placement: Placement): Promise<Raster> {
	const sized = placement.svg.replace('<svg ', `<svg width="${placement.size}" height="${placement.size}" `);
	const result = await page.evaluate(async ({ svg, width, height, size, x, y, background }) => {
		const image = new Image();
		image.src = 'data:image/svg+xml;base64,' + btoa(svg);
		await image.decode();
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext('2d')!;
		if (background) {
			context.fillStyle = background;
			context.fillRect(0, 0, width, height);
		}
		context.drawImage(image, x, y, size, size);
		const data = context.getImageData(0, 0, width, height).data;
		let binary = '';
		for (let i = 0; i < data.length; i += 0x8000) {
			binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
		}
		return { rgba: btoa(binary), png: canvas.toDataURL('image/png').split(',')[1] };
	}, { ...placement, svg: sized, background: placement.background ?? '' });
	return { width: placement.width, height: placement.height, rgba: Buffer.from(result.rgba, 'base64'), png: Buffer.from(result.png, 'base64') };
}

function square(page: Page, svg: string, size: number, inset = 0): Promise<Raster> {
	const drawn = Math.round(size * (1 - 2 * inset));
	const offset = Math.round((size - drawn) / 2);
	return render(page, { svg, width: size, height: size, size: drawn, x: offset, y: offset });
}

/** One image of an ICO file: a PNG, or a 32-bit DIB as older icons store it. */
interface IcoImage {
	readonly size: number;
	readonly data: Buffer;
}

/** ICO from square 32-bit images, in the given order. */
function icoOf(images: readonly IcoImage[]): Buffer {
	const header = Buffer.alloc(6 + 16 * images.length);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(images.length, 4);
	let offset = header.length;
	images.forEach((image, i) => {
		const entry = 6 + 16 * i;
		header.writeUInt8(image.size >= 256 ? 0 : image.size, entry);
		header.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1);
		header.writeUInt16LE(1, entry + 4);
		header.writeUInt16LE(32, entry + 6);
		header.writeUInt32LE(image.data.length, entry + 8);
		header.writeUInt32LE(offset, entry + 12);
		offset += image.data.length;
	});
	return Buffer.concat([header, ...images.map(image => image.data)]);
}

/** ICO with one PNG image per size (Windows Vista and later, every browser). */
function ico(images: readonly Raster[]): Buffer {
	return icoOf(images.map(image => ({ size: image.width, data: image.png })));
}

function readIco(data: Buffer): IcoImage[] {
	return Array.from({ length: data.readUInt16LE(4) }, (_, i) => {
		const entry = 6 + 16 * i;
		if (data.readUInt8(entry) !== data.readUInt8(entry + 1) || data.readUInt16LE(entry + 6) !== 32) {
			throw new Error('expected square 32-bit ICO images');
		}
		const offset = data.readUInt32LE(entry + 12);
		return { size: data.readUInt8(entry) || 256, data: data.subarray(offset, offset + data.readUInt32LE(entry + 8)) };
	});
}

const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47]);

/** Straight RGBA rows, top to bottom, from a 32-bit bottom-up BGRA DIB (its AND mask is ignored). */
function dibRgba(dib: Buffer, size: number): Buffer {
	const pixels = dib.readUInt32LE(0);
	const rgba = Buffer.alloc(size * size * 4);
	for (let y = 0; y < size; y++) {
		const row = pixels + (size - 1 - y) * size * 4;
		for (let x = 0; x < size; x++) {
			const source = row + x * 4;
			const target = (y * size + x) * 4;
			rgba[target] = dib[source + 2];
			rgba[target + 1] = dib[source + 1];
			rgba[target + 2] = dib[source];
			rgba[target + 3] = dib[source + 3];
		}
	}
	return rgba;
}

/** ICNS from raw chunks, keyed by OSType. */
function icnsOf(chunks: readonly (readonly [string, Buffer])[]): Buffer {
	const parts = chunks.map(([type, data]) => {
		const head = Buffer.alloc(8);
		head.write(type, 0, 'latin1');
		head.writeUInt32BE(8 + data.length, 4);
		return Buffer.concat([head, data]);
	});
	const head = Buffer.alloc(8);
	head.write('icns', 0, 'latin1');
	head.writeUInt32BE(8 + parts.reduce((sum, part) => sum + part.length, 0), 4);
	return Buffer.concat([head, ...parts]);
}

/** ICNS with PNG entries, keyed by OSType. */
function icns(entries: readonly (readonly [string, Raster])[]): Buffer {
	return icnsOf(entries.map(([type, image]) => [type, image.png]));
}

function readIcns(data: Buffer): [string, Buffer][] {
	const chunks: [string, Buffer][] = [];
	for (let offset = 8; offset < data.length;) {
		const length = data.readUInt32BE(offset + 4);
		chunks.push([data.toString('latin1', offset, offset + 4), data.subarray(offset + 8, offset + length)]);
		offset += length;
	}
	return chunks;
}

/** A rectangle in pixels: left, top, right, bottom; right and bottom exclusive. */
type Box = readonly [number, number, number, number];

/**
 * Where Code - OSS drew its blue badge on the file-type icons, anti-aliased edge included, by ICO
 * size or ICNS OSType. Measured once from the upstream icons; the sizes not listed have no badge.
 * Kept fixed so that running this script again draws the Klawly badge exactly over itself.
 */
const fileBadges: Readonly<Record<string, Box>> = {
	'64': [39, 49, 52, 60], '96': [59, 73, 78, 89], '128': [79, 98, 104, 119], '256': [159, 196, 207, 237],
	ic07: [83, 95, 118, 124], ic08: [167, 190, 235, 248], ic09: [335, 380, 470, 495],
};

/** go.icns has its badge a few pixels up and to the left. */
const fileBadgeOverrides: Readonly<Record<string, Readonly<Record<string, Box>>>> = {
	'go.icns': { ic07: [83, 93, 117, 123], ic08: [166, 187, 234, 245], ic09: [333, 374, 467, 489] },
};

/**
 * Redraws the badge of one file-type icon image: the app icon in a square as wide as the old
 * badge's longer side, on a white plate `frame` pixels wider, both anchored to the old badge's
 * bottom-right corner. The plate is opaque, so nothing of the old badge shows through.
 */
async function rebadge(page: Page, source: { readonly kind: 'png' | 'rgba'; readonly data: Buffer }, size: number, box: Box, frame: number): Promise<Buffer> {
	const [left, top, right, bottom] = box;
	const side = Math.max(right - left, bottom - top);
	const svg = appIcon.replace('<svg ', `<svg width="${side}" height="${side}" `);
	const result = await page.evaluate(async ({ png, rgba, size, svg, right, bottom, side, frame }) => {
		const canvas = document.createElement('canvas');
		canvas.width = size;
		canvas.height = size;
		const context = canvas.getContext('2d')!;
		if (png) {
			const image = new Image();
			image.src = 'data:image/png;base64,' + png;
			await image.decode();
			context.drawImage(image, 0, 0);
		} else {
			context.putImageData(new ImageData(Uint8ClampedArray.from(atob(rgba), c => c.charCodeAt(0)), size, size), 0, 0);
		}
		context.fillStyle = '#FFFFFF';
		context.fillRect(right - side - frame, bottom - side - frame, side + 2 * frame, side + 2 * frame);
		const icon = new Image();
		icon.src = 'data:image/svg+xml;base64,' + btoa(svg);
		await icon.decode();
		context.drawImage(icon, right - side, bottom - side, side, side);
		return canvas.toDataURL('image/png').split(',')[1];
	}, { png: source.kind === 'png' ? source.data.toString('base64') : '', rgba: source.kind === 'rgba' ? source.data.toString('base64') : '', size, svg, right, bottom, side, frame });
	return Buffer.from(result, 'base64');
}

/** 24-bit bottom-up BMP. The installer images are drawn on an opaque background, so alpha is dropped. */
function bmp(image: Raster): Buffer {
	const stride = Math.ceil(image.width * 3 / 4) * 4;
	const pixels = Buffer.alloc(stride * image.height);
	for (let y = 0; y < image.height; y++) {
		const row = (image.height - 1 - y) * stride;
		for (let x = 0; x < image.width; x++) {
			const source = (y * image.width + x) * 4;
			pixels[row + x * 3] = image.rgba[source + 2];
			pixels[row + x * 3 + 1] = image.rgba[source + 1];
			pixels[row + x * 3 + 2] = image.rgba[source];
		}
	}
	const header = Buffer.alloc(54);
	header.write('BM', 0, 'latin1');
	header.writeUInt32LE(54 + pixels.length, 2);
	header.writeUInt32LE(54, 10);
	header.writeUInt32LE(40, 14);
	header.writeInt32LE(image.width, 18);
	header.writeInt32LE(image.height, 22);
	header.writeUInt16LE(1, 26);
	header.writeUInt16LE(24, 28);
	header.writeUInt32LE(pixels.length, 34);
	header.writeInt32LE(2835, 38);
	header.writeInt32LE(2835, 42);
	return Buffer.concat([header, pixels]);
}

/** XPM with each channel reduced to four levels, the same palette depth Phase 2 used. */
function xpm(image: Raster): string {
	const symbols = '.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#@$%&*+-=';
	const level = (value: number) => Math.round(value / 85) * 85;
	const hex = (value: number) => level(value).toString(16).padStart(2, '0').toUpperCase();
	const colors = new Map<string, string>();
	const rows: string[] = [];
	for (let y = 0; y < image.height; y++) {
		let row = '';
		for (let x = 0; x < image.width; x++) {
			const i = (y * image.width + x) * 4;
			if (image.rgba[i + 3] < 128) {
				row += ' ';
				continue;
			}
			const color = `#${hex(image.rgba[i])}${hex(image.rgba[i + 1])}${hex(image.rgba[i + 2])}`;
			let symbol = colors.get(color);
			if (!symbol) {
				symbol = symbols[colors.size];
				colors.set(color, symbol);
			}
			row += symbol;
		}
		rows.push(row);
	}
	const palette = [...colors].sort(([a], [b]) => a.localeCompare(b));
	const lines = [
		`"${image.width} ${image.height} ${palette.length + 1} 1",`,
		'" \tc None",',
		...palette.map(([color, symbol]) => `"${symbol}\tc ${color}",`),
		...rows.map((row, i) => `"${row}"${i === rows.length - 1 ? '' : ','}`),
	];
	return `/* XPM */\nstatic char * code_xpm[] = {\n${lines.join('\n')}};\n`;
}

/** The SVG's children, without comments, for re-use inside another SVG. */
function body(svg: string): string {
	return svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<!--[\s\S]*?-->\s*/g, '').trim();
}

/** A copy of `svg` with its own root attributes, scaled from the 64-unit source grid. */
function rescale(svg: string, rootAttributes: string, size: number, color?: string): string {
	let content = body(svg);
	if (color) {
		content = content.replaceAll('currentColor', color);
	}
	const scale = size / 64;
	return `<svg ${rootAttributes} xmlns="http://www.w3.org/2000/svg">\n<g transform="scale(${scale})">\n${content}\n</g>\n</svg>\n`;
}

type Point = readonly [number, number];
type Segment = { readonly kind: 'L'; readonly to: Point } | { readonly kind: 'C'; readonly c1: Point; readonly c2: Point; readonly to: Point } | { readonly kind: 'A'; readonly radius: number; readonly sweep: 0 | 1; readonly to: Point };
interface Outline {
	readonly start: Point;
	readonly segments: readonly Segment[];
}

/** A rounded rectangle, wound clockwise on screen. */
function rectOutline(x: number, y: number, width: number, height: number, radius: number): Outline {
	const r = Math.min(radius, width / 2, height / 2);
	const segments: Segment[] = [
		{ kind: 'L', to: [x + width - r, y] }, { kind: 'A', radius: r, sweep: 1, to: [x + width, y + r] },
		{ kind: 'L', to: [x + width, y + height - r] }, { kind: 'A', radius: r, sweep: 1, to: [x + width - r, y + height] },
		{ kind: 'L', to: [x + r, y + height] }, { kind: 'A', radius: r, sweep: 1, to: [x, y + height - r] },
		{ kind: 'L', to: [x, y + r] }, { kind: 'A', radius: r, sweep: 1, to: [x + r, y] },
	];
	// A pill's straight sides along its short axis have no length.
	return { start: [x + r, y], segments: segments.filter((segment, i) => segment.kind !== 'L' || segment.to.join() !== (i ? segments[i - 1].to : [x + r, y]).join()) };
}

/** The outlines of a path made of absolute M, L, C and Z commands, which is all the marks use. */
function pathOutlines(d: string): Outline[] {
	const tokens = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
	const outlines: Outline[] = [];
	let segments: Segment[] = [];
	let i = 0;
	const point = (): Point => [Number(tokens[i++]), Number(tokens[i++])];
	while (i < tokens.length) {
		const command = tokens[i++];
		if (command === 'M') {
			segments = [];
			outlines.push({ start: point(), segments });
		} else if (command === 'L') {
			segments.push({ kind: 'L', to: point() });
		} else if (command === 'C') {
			segments.push({ kind: 'C', c1: point(), c2: point(), to: point() });
		} else if (command !== 'Z') {
			throw new Error(`unsupported path command ${command}`);
		}
	}
	return outlines;
}

function reverseOutline(outline: Outline): Outline {
	const points = [outline.start, ...outline.segments.map(segment => segment.to)];
	const segments = outline.segments.map((segment, i): Segment => {
		const to = points[i];
		switch (segment.kind) {
			case 'L': return { kind: 'L', to };
			case 'C': return { kind: 'C', c1: segment.c2, c2: segment.c1, to };
			case 'A': return { kind: 'A', radius: segment.radius, sweep: segment.sweep ? 0 : 1, to };
		}
	}).reverse();
	return { start: points[points.length - 1], segments };
}

/** Positive when the outline runs clockwise on screen, judged from its end and control points. */
function winding(outline: Outline): number {
	const points = [outline.start, ...outline.segments.flatMap(segment => segment.kind === 'C' ? [segment.c1, segment.c2, segment.to] : [segment.to])];
	return points.reduce((sum, [x, y], i) => {
		const [nextX, nextY] = points[(i + 1) % points.length];
		return sum + x * nextY - nextX * y;
	}, 0);
}

/**
 * The mark as one SVG path in a `size`-unit box, with the group's transform applied and every
 * outline wound clockwise, so the arms that overlap the stem fill under the nonzero rule.
 */
function markPath(svg: string, size: number): string {
	// Fold the group's transform list (applied right to left) into p -> scale * p + offset.
	let scale = 1;
	let offset: Point = [0, 0];
	const transform = /<g [^>]*transform="([^"]*)"/.exec(svg)?.[1] ?? '';
	for (const [, kind, args] of [...transform.matchAll(/(translate|scale)\(([^)]*)\)/g)].reverse()) {
		const [a, b = a] = args.trim().split(/[\s,]+/).map(Number);
		if (kind === 'translate') {
			offset = [offset[0] + a, offset[1] + b];
		} else {
			scale *= a;
			offset = [offset[0] * a, offset[1] * a];
		}
	}
	const unit = size / 64;
	const number = (value: number) => String(Number(value.toFixed(3)));
	const map = ([x, y]: Point) => `${number((scale * x + offset[0]) * unit)} ${number((scale * y + offset[1]) * unit)}`;
	const outlines = [
		...[...svg.matchAll(/<rect ([^>]*)\/>/g)].map(([, attributes]) => {
			const value = (name: string) => Number(new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1] ?? 0);
			return rectOutline(value('x'), value('y'), value('width'), value('height'), value('rx'));
		}),
		...[...svg.matchAll(/<path [^>]*\bd="([^"]*)"/g)].flatMap(([, d]) => pathOutlines(d)),
	].map(outline => winding(outline) < 0 ? reverseOutline(outline) : outline);
	return outlines.map(outline => `M${map(outline.start)}` + outline.segments.map(segment => {
		switch (segment.kind) {
			case 'L': return `L${map(segment.to)}`;
			case 'C': return `C${map(segment.c1)} ${map(segment.c2)} ${map(segment.to)}`;
			case 'A': return `A${number(segment.radius * scale * unit)} ${number(segment.radius * scale * unit)} 0 0 ${segment.sweep} ${map(segment.to)}`;
		}
	}).join('') + 'Z').join('');
}

function write(file: string, data: Buffer | string): void {
	writeFileSync(join(root, file), data);
	console.log(`wrote ${file}`);
}

const browser = await chromium.launch(process.env.KLAWLY_CHROMIUM ? { executablePath: process.env.KLAWLY_CHROMIUM } : undefined);
try {
	const page = await browser.newPage();
	const squares = async (svg: string, sizes: readonly number[], inset = 0) => Promise.all(sizes.map(size => square(page, svg, size, inset)));

	// Windows: app and Agents window icons, Start tiles.
	write('resources/win32/code.ico', ico(await squares(appIcon, [16, 24, 32, 48, 64, 128, 256])));
	write('resources/win32/sessions.ico', ico(await squares(appIcon, [16, 20, 24, 32, 40, 48, 64, 96, 256])));
	write('resources/win32/code_70x70.png', (await square(page, appIcon, 70)).png);
	write('resources/win32/code_150x150.png', (await square(page, appIcon, 150)).png);

	// Windows installer: the wizard side panel shows the mark on the icon's background; the header shows the icon.
	const wizard: readonly (readonly [number, number, number])[] = [[100, 164, 314], [125, 192, 386], [150, 246, 459], [175, 273, 556], [200, 328, 604], [225, 355, 700], [250, 410, 797]];
	for (const [scale, width, height] of wizard) {
		const size = Math.round(width * 0.6);
		write(`resources/win32/inno-big-${scale}.bmp`, bmp(await render(page, { svg: mark, width, height, size, x: Math.round((width - size) / 2), y: Math.round((height - size) / 2), background: iconBackground })));
	}
	const header: readonly (readonly [number, number, number])[] = [[100, 55, 55], [125, 64, 68], [150, 83, 80], [175, 92, 97], [200, 110, 106], [225, 119, 123], [250, 138, 140]];
	for (const [scale, width, height] of header) {
		const size = Math.round(Math.min(width, height) * 0.9);
		write(`resources/win32/inno-small-${scale}.bmp`, bmp(await render(page, { svg: appIcon, width, height, size, x: Math.round((width - size) / 2), y: Math.round((height - size) / 2), background: '#FFFFFF' })));
	}

	// macOS: the icon sits inside Apple's 824/1024 grid.
	const inset = 100 / 1024;
	const mac = async (size: number) => square(page, appIcon, size, inset);
	write('resources/darwin/code.icns', icns([
		['icp4', await mac(16)], ['icp5', await mac(32)], ['icp6', await mac(64)],
		['ic07', await mac(128)], ['ic08', await mac(256)], ['ic09', await mac(512)], ['ic10', await mac(1024)],
		['ic11', await mac(32)], ['ic12', await mac(64)], ['ic13', await mac(256)], ['ic14', await mac(512)],
	]));

	// macOS disk image window: 1x and 2x backgrounds joined into one HiDPI TIFF (tiffutil is macOS only).
	if (process.platform === 'darwin') {
		const temp = mkdtempSync(join(tmpdir(), 'klawly-dmg-'));
		try {
			const [standard, retina] = [join(temp, 'background.png'), join(temp, 'background@2x.png')];
			// render() draws a square, and the wide SVG sits centered in it, so lift it to the top edge.
			const background = (scale: number) => render(page, { svg: dmgBackground, width: dmgWidth * scale, height: dmgHeight * scale, size: dmgWidth * scale, x: 0, y: -(dmgWidth - dmgHeight) / 2 * scale });
			writeFileSync(standard, (await background(1)).png);
			writeFileSync(retina, (await background(2)).png);
			execFileSync('tiffutil', ['-cathidpicheck', standard, retina, '-out', join(root, 'build/darwin/dmg-background-stable.tiff')]);
			console.log('wrote build/darwin/dmg-background-stable.tiff');
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	}

	// Linux.
	const linux = await square(page, appIcon, 1024);
	write('resources/linux/code.png', linux.png);
	write('resources/linux/rpm/code.xpm', xpm(linux));

	// Server and web, and the sign-in pages of the authentication extensions.
	const favicon = ico(await squares(appIcon, [16, 24, 32, 48, 64]));
	write('resources/server/favicon.ico', favicon);
	write('resources/server/code-192.png', (await square(page, appIcon, 192)).png);
	write('resources/server/code-512.png', (await square(page, appIcon, 512)).png);
	write('extensions/github-authentication/media/favicon.ico', favicon);
	write('extensions/microsoft-authentication/media/favicon.ico', favicon);

	// File-type icons (Explorer and Finder): the app icon replaces the Code - OSS badge.
	for (const name of readdirSync(join(root, 'resources/win32')).filter(name => name.endsWith('.ico') && name !== 'code.ico' && name !== 'sessions.ico')) {
		const file = `resources/win32/${name}`;
		write(file, icoOf(await Promise.all(readIco(readFileSync(join(root, file))).map(async (image): Promise<IcoImage> => {
			const box = fileBadges[image.size];
			if (!box) {
				return image;
			}
			const source = image.data.subarray(0, 4).equals(pngSignature) ? { kind: 'png' as const, data: image.data } : { kind: 'rgba' as const, data: dibRgba(image.data, image.size) };
			return { size: image.size, data: await rebadge(page, source, image.size, box, Math.max(1, Math.round(image.size / 128))) };
		}))));
	}
	for (const name of readdirSync(join(root, 'resources/darwin')).filter(name => name.endsWith('.icns') && name !== 'code.icns')) {
		const file = `resources/darwin/${name}`;
		write(file, icnsOf(await Promise.all(readIcns(readFileSync(join(root, file))).map(async ([type, data]): Promise<[string, Buffer]> => {
			const box = fileBadgeOverrides[name]?.[type] ?? fileBadges[type];
			if (!box) {
				return [type, data];
			}
			const size = data.readUInt32BE(16); // PNG IHDR width
			return [type, await rebadge(page, { kind: 'png', data }, size, box, size / 64)];
		}))));
	}
} finally {
	await browser.close();
}

// Workbench and Agents window SVGs.
write('src/vs/workbench/browser/media/code-icon.svg', appIcon);
write('src/vs/workbench/contrib/claude/browser/media/klawly-mark.svg', mark);
write('src/vs/sessions/browser/media/sessions-icon.svg', rescale(appIcon, 'width="1024" height="1024" viewBox="0 0 1024 1024" fill="none"', 1024));
write('src/vs/sessions/browser/media/vscode-icon.svg', rescale(appIcon, 'width="96" height="96" viewBox="0 0 96 96" fill="none"', 96));
write('src/vs/sessions/browser/media/sessions-logo-dark.svg', rescale(monoMark, 'width="128" height="128" viewBox="0 0 128 128" fill="none"', 128));
write('src/vs/sessions/browser/media/sessions-logo-light.svg', rescale(monoMark, 'width="128" height="128" viewBox="0 0 128 128" fill="none"', 128, '#D9D9D9'));
write('extensions/github-authentication/media/code-icon.svg', appIcon);

// The Agents window aquarium draws each fish from the mark's silhouette.
const fishFile = 'src/vs/sessions/contrib/aquarium/browser/vscodeLogoPath.ts';
write(fishFile, readFileSync(join(root, fishFile), 'utf8').replace(/(export const VSCODE_LOGO_PATH = ')[^']*(';)/, `$1${markPath(monoMark, 96)}$2`));

// Empty-editor letterpress: the mono mark in each theme's existing colour and opacity.
const letterpress: readonly (readonly [string, string, string])[] = [
	['dark', 'width="260" height="260" viewBox="0 0 260 260" opacity="0.3"', '#000000'],
	['light', 'width="260" height="260" viewBox="0 0 260 260" opacity="0.1"', '#000000'],
	['hcDark', 'width="260" height="260" viewBox="0 0 260 260" fill="none"', '#3C3C3C'],
	['hcLight', 'width="260" height="260" viewBox="0 0 260 260" fill="none"', '#D9D9D9'],
];
for (const [theme, attributes, color] of letterpress) {
	write(`src/vs/workbench/browser/parts/editor/media/letterpress-${theme}.svg`, rescale(monoMark, attributes, 260, color));
}
