/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Freeze Frame (issue 886): the preview is frozen as an image and the person
 * draws pen strokes and boxes over it. The model here is pure: points are in
 * frame pixels, and flattening scales them to the captured image's pixels.
 */

export interface FreezePoint {
	readonly x: number;
	readonly y: number;
}

export type FreezeTool = 'pen' | 'box';

export interface FreezeStroke {
	readonly tool: FreezeTool;
	/** A pen stroke holds every sampled point; a box holds its two corners. */
	readonly points: readonly FreezePoint[];
}

/** Most strokes one frame keeps; the oldest are not dropped, new ones are refused. */
export const FREEZE_MAX_STROKES = 200;
/** Most points one pen stroke keeps. */
export const FREEZE_MAX_POINTS = 2000;
/** Stroke width in frame pixels. */
export const FREEZE_LINE_WIDTH = 3;

export class FreezeDrawing {
	private readonly _strokes: FreezeStroke[] = [];

	get strokes(): readonly FreezeStroke[] {
		return this._strokes;
	}

	get isEmpty(): boolean {
		return this._strokes.length === 0;
	}

	/** Adds a finished stroke. Returns false when it is empty or the frame is full. */
	add(stroke: FreezeStroke): boolean {
		if (this._strokes.length >= FREEZE_MAX_STROKES) {
			return false;
		}
		const points = stroke.tool === 'box'
			? (stroke.points.length >= 2 ? [stroke.points[0], stroke.points[stroke.points.length - 1]] : [])
			: stroke.points.slice(0, FREEZE_MAX_POINTS);
		if (points.length === 0 || (stroke.tool === 'box' && points[0].x === points[1].x && points[0].y === points[1].y)) {
			return false;
		}
		this._strokes.push({ tool: stroke.tool, points });
		return true;
	}

	/** Removes the last stroke. Returns false when there is none. */
	undo(): boolean {
		return this._strokes.pop() !== undefined;
	}

	clear(): void {
		this._strokes.length = 0;
	}
}

/** The box a two-corner stroke covers, whichever way it was dragged. */
export function freezeBoxRect(a: FreezePoint, b: FreezePoint): { x: number; y: number; width: number; height: number } {
	return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/** Pixel size of the flattened image: the captured image's own size, never zero. */
export function freezeFlattenSize(image: { readonly width: number; readonly height: number }): { width: number; height: number } {
	return { width: Math.max(1, Math.round(image.width)), height: Math.max(1, Math.round(image.height)) };
}

/**
 * Scale from frame pixels (where the person drew) to image pixels (where the
 * flatten draws). A capture taken at 2x zoom is twice the frame's size.
 */
export function freezeFlattenScale(frame: { readonly width: number; readonly height: number }, image: { readonly width: number; readonly height: number }): { x: number; y: number } {
	return {
		x: frame.width > 0 ? image.width / frame.width : 1,
		y: frame.height > 0 ? image.height / frame.height : 1,
	};
}

/** Clamps a point into the frame so a drag that leaves it draws to the edge. */
export function freezeClampPoint(point: FreezePoint, frame: { readonly width: number; readonly height: number }): FreezePoint {
	return { x: Math.min(Math.max(point.x, 0), frame.width), y: Math.min(Math.max(point.y, 0), frame.height) };
}
