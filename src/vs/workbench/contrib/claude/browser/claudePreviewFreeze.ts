/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { FREEZE_LINE_WIDTH, FreezeDrawing, FreezePoint, FreezeStroke, FreezeTool, freezeBoxRect, freezeClampPoint, freezeFlattenScale, freezeFlattenSize } from '../common/claudePreviewFreeze.js';

/** What the editor lends the drawing layer: the platform's label for Undo and a way to tell the user. */
export interface IFreezeFrameOptions {
	readonly undoHint: string;
	readonly notify: (message: string, severity: 'info' | 'error') => void;
}

const FREEZE_COLORS = [
	{ value: '#e5484d', label: localize('claudeFreezeRed', "Red") },
	{ value: '#3e63dd', label: localize('claudeFreezeBlue', "Blue") },
	{ value: '#30a46c', label: localize('claudeFreezeGreen', "Green") },
	{ value: '#f5d90a', label: localize('claudeFreezeYellow', "Yellow") },
] as const;

/**
 * Freeze Frame (issue 886, DL-106): the preview is frozen as an image in the
 * viewport and drawn on. The drawing lives only here; Add to Chat flattens it
 * to one PNG and hands the bytes to the caller, and closing discards it.
 */
export class ClaudePreviewFreezeFrame extends Disposable {

	private readonly _drawing = new FreezeDrawing();
	private readonly _root: HTMLElement;
	private readonly _canvas: HTMLCanvasElement;
	private readonly _image: HTMLImageElement;
	private readonly _objectUrl: string;
	private readonly _tools: { tool: FreezeTool; button: HTMLButtonElement }[] = [];
	private readonly _swatches: { color: string; button: HTMLButtonElement }[] = [];
	/** The colour of each stroke in the drawing, in the same order. */
	private readonly _colors: string[] = [];
	private _color: string = FREEZE_COLORS[0].value;
	private _tool: FreezeTool = 'pen';
	private _live: FreezeStroke | undefined;
	private readonly _status: HTMLElement;
	private _closed = false;
	private _discardArmed = false;

	constructor(
		viewport: HTMLElement,
		bytes: Uint8Array,
		private readonly _onAdd: (png: Uint8Array) => Promise<void>,
		private readonly _onClose: () => void,
		private readonly _options: IFreezeFrameOptions = { undoHint: 'Ctrl+Z', notify: () => { } },
	) {
		super();
		this._root = append(viewport, $('.claude-preview-freeze'));
		this._root.setAttribute('role', 'dialog');
		this._root.setAttribute('aria-label', localize('claudeFreezeLabel', "Freeze Frame"));
		this._root.tabIndex = -1;
		this._objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
		this._image = append(this._root, $('img.claude-preview-freeze-image')) as HTMLImageElement;
		this._image.alt = localize('claudeFreezeImageAlt', "Frozen preview");
		this._image.src = this._objectUrl;
		this._canvas = append(this._root, $('canvas.claude-preview-freeze-canvas')) as HTMLCanvasElement;

		const bar = append(this._root, $('.claude-preview-freeze-bar'));
		bar.setAttribute('role', 'toolbar');
		bar.setAttribute('aria-label', localize('claudeFreezeTools', "Freeze Frame tools"));
		this._status = append(this._root, $('.claude-preview-freeze-status'));
		this._status.setAttribute('role', 'status');
		this._status.setAttribute('aria-live', 'polite');
		for (const [tool, label] of [['pen', localize('claudeFreezePen', "Pen")], ['box', localize('claudeFreezeBox', "Box")]] as const) {
			const button = this.button(bar, label, () => this.setTool(tool), tool === 'pen' ? localize('claudeFreezePenTip', "Pen: draw freehand") : localize('claudeFreezeBoxTip', "Box: drag a rectangle"));
			this._tools.push({ tool, button });
		}
		const colors = append(bar, $('.claude-preview-freeze-colors'));
		colors.setAttribute('role', 'group');
		colors.setAttribute('aria-label', localize('claudeFreezeColour', "Colour"));
		colors.style.display = 'inline-flex';
		colors.style.gap = '4px';
		for (const { value, label } of FREEZE_COLORS) {
			const swatch = this.button(colors, label, () => this.setColor(value));
			swatch.classList.add('claude-preview-freeze-swatch');
			swatch.textContent = '';
			swatch.style.backgroundColor = value;
			swatch.style.width = '22px';
			swatch.style.height = '22px';
			swatch.style.padding = '0';
			this._swatches.push({ color: value, button: swatch });
		}
		this.setColor(this._color);
		this.button(bar, localize('claudeFreezeUndo', "Undo"), () => this.undo(), localize('claudeFreezeUndoTip', "Undo the last mark ({0})", this._options.undoHint));
		this.button(bar, localize('claudeFreezeClear', "Clear"), () => this.clear(), localize('claudeFreezeClearTip', "Remove every mark"));
		const add = this.button(bar, localize('claudeFreezeAdd', "Add to Chat"), () => this.add(), localize('claudeFreezeAddTip', "Attach the drawing to the current chat"));
		add.classList.add('primary');
		this.button(bar, localize('claudeFreezeCancel', "Cancel"), () => this.cancel(), localize('claudeFreezeCancelTip', "Close without adding (Esc). With marks, press it twice to discard."));
		this.setTool('pen');

		this._register(addDisposableListener(this._root, EventType.KEY_DOWN, event => {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				this.cancel();
			} else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
				event.preventDefault();
				this.undo();
			}
		}));
		this._register(addDisposableListener(this._canvas, EventType.POINTER_DOWN, event => this.pointerDown(event)));
		this._register(addDisposableListener(this._canvas, EventType.POINTER_MOVE, event => this.pointerMove(event)));
		this._register(addDisposableListener(this._canvas, EventType.POINTER_UP, event => this.pointerUp(event)));
		this.layout();
		this._root.focus();
	}

	/** Sizes the drawing layer to the viewport. The editor calls it when the viewport changes size. */
	layout(): void {
		const rect = this._root.getBoundingClientRect();
		const width = Math.max(1, Math.round(rect.width));
		const height = Math.max(1, Math.round(rect.height));
		if (this._canvas.width !== width || this._canvas.height !== height) {
			this._canvas.width = width;
			this._canvas.height = height;
		}
		this.redraw();
	}

	private setTool(tool: FreezeTool): void {
		this._tool = tool;
		for (const entry of this._tools) {
			entry.button.setAttribute('aria-pressed', String(entry.tool === tool));
		}
	}

	private setColor(color: string): void {
		this._color = color;
		for (const entry of this._swatches) {
			const selected = entry.color === color;
			entry.button.setAttribute('aria-pressed', String(selected));
			entry.button.style.outline = selected ? '2px solid var(--vscode-focusBorder)' : '1px solid var(--vscode-contrastBorder, var(--vscode-widget-border))';
			entry.button.style.outlineOffset = selected ? '2px' : '0';
		}
		const label = FREEZE_COLORS.find(c => c.value === color)?.label;
		if (label && this._status) {
			this._status.textContent = localize('claudeFreezeColourSet', "Colour: {0}", label);
		}
	}

	private undo(): void {
		if (this._drawing.undo()) {
			this._colors.pop();
			this.redraw();
		}
	}

	private clear(): void {
		this._drawing.clear();
		this._colors.length = 0;
		this.redraw();
	}

	private point(event: PointerEvent): FreezePoint {
		const rect = this._canvas.getBoundingClientRect();
		return freezeClampPoint({ x: event.clientX - rect.left, y: event.clientY - rect.top }, { width: this._canvas.width, height: this._canvas.height });
	}

	private pointerDown(event: PointerEvent): void {
		if (event.button !== 0) {
			return;
		}
		this._canvas.setPointerCapture(event.pointerId);
		this._live = { tool: this._tool, points: [this.point(event)] };
	}

	private pointerMove(event: PointerEvent): void {
		if (!this._live) {
			return;
		}
		this._live = { tool: this._live.tool, points: [...this._live.points, this.point(event)] };
		this.redraw();
	}

	private pointerUp(event: PointerEvent): void {
		if (!this._live) {
			return;
		}
		const stroke: FreezeStroke = { tool: this._live.tool, points: [...this._live.points, this.point(event)] };
		this._live = undefined;
		this._discardArmed = false;
		if (this._drawing.add(stroke)) {
			this._colors.push(this._color);
		}
		this.redraw();
	}

	private redraw(): void {
		const context = this._canvas.getContext('2d');
		if (!context) {
			return;
		}
		context.clearRect(0, 0, this._canvas.width, this._canvas.height);
		this.paint(context, 1, 1);
	}

	private paint(context: CanvasRenderingContext2D, scaleX: number, scaleY: number): void {
		const strokes = this._live ? [...this._drawing.strokes, this._live] : this._drawing.strokes;
		const colors = this._live ? [...this._colors, this._color] : this._colors;
		context.save();
		context.scale(scaleX, scaleY);
		context.lineWidth = FREEZE_LINE_WIDTH;
		context.lineCap = 'round';
		context.lineJoin = 'round';
		for (const [index, stroke] of strokes.entries()) {
			context.strokeStyle = colors[index] ?? FREEZE_COLORS[0].value;
			if (stroke.tool === 'box') {
				if (stroke.points.length >= 2) {
					const rect = freezeBoxRect(stroke.points[0], stroke.points[stroke.points.length - 1]);
					context.strokeRect(rect.x, rect.y, rect.width, rect.height);
				}
				continue;
			}
			context.beginPath();
			stroke.points.forEach((p, i) => i === 0 ? context.moveTo(p.x, p.y) : context.lineTo(p.x, p.y));
			if (stroke.points.length === 1) {
				context.lineTo(stroke.points[0].x + 0.01, stroke.points[0].y);
			}
			context.stroke();
		}
		context.restore();
	}

	private async add(): Promise<void> {
		const size = freezeFlattenSize({ width: this._image.naturalWidth, height: this._image.naturalHeight });
		const scale = freezeFlattenScale({ width: this._canvas.width, height: this._canvas.height }, size);
		const flat = this._canvas.ownerDocument.createElement('canvas');
		flat.width = size.width;
		flat.height = size.height;
		const context = flat.getContext('2d');
		if (!context) {
			this.fail();
			return;
		}
		context.drawImage(this._image, 0, 0, size.width, size.height);
		this.paint(context, scale.x, scale.y);
		const blob = await new Promise<Blob | null>(resolve => flat.toBlob(resolve, 'image/png'));
		if (!blob) {
			this.fail();
			return;
		}
		try {
			await this._onAdd(new Uint8Array(await blob.arrayBuffer()));
		} catch {
			// The caller logged the cause; the drawing stays so the user can try again.
			this._options.notify(localize('claudeFreezeFailed', "Could not add the drawing to the chat. Try again."), 'error');
			return;
		}
		this.close();
	}

	private fail(): void {
		const message = localize('claudeFreezeNoImage', "Could not make the image. Your drawing is kept; try again.");
		this._status.textContent = message;
		this._options.notify(message, 'error');
	}

	/** Esc and Cancel: with marks, the first press asks and the second discards. */
	private cancel(): void {
		if (this._drawing.strokes.length > 0 && !this._discardArmed) {
			this._discardArmed = true;
			this._status.textContent = localize('claudeFreezeDiscard', "Press Esc or Cancel again to discard the drawing, or Undo to keep editing.");
			return;
		}
		this.close();
	}

	close(): void {
		if (this._closed) {
			return;
		}
		this._closed = true;
		this._drawing.clear();
		this._onClose();
		this.dispose();
	}

	override dispose(): void {
		URL.revokeObjectURL(this._objectUrl);
		this._root.remove();
		super.dispose();
	}

	private button(parent: HTMLElement, label: string, onClick: () => void, tooltip?: string): HTMLButtonElement {
		const button = append(parent, $('button.claude-preview-button')) as HTMLButtonElement;
		button.type = 'button';
		button.textContent = label;
		button.setAttribute('aria-label', label);
		if (tooltip) {
			button.title = tooltip;
			button.setAttribute('aria-description', tooltip);
		}
		this._register(addDisposableListener(button, EventType.CLICK, event => {
			event.preventDefault();
			onClick();
		}));
		return button;
	}
}
