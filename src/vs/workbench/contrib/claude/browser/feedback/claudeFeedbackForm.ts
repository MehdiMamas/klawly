/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Checkbox } from '../../../../../base/browser/ui/toggle/toggle.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { getMediaMime } from '../../../../../base/common/mime.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { ClaudeFeedbackBan } from '../../../../../platform/claude/common/claudeFeedbackRelay.js';
import { defaultButtonStyles, defaultCheckboxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { CLAUDE_FEEDBACK_IMAGE_EXTENSIONS, ClaudeFeedbackDraft, ClaudeFeedbackImage, claudeFeedbackImageName, claudeFeedbackImageType, ClaudeFeedbackKind, KLAWLY_FEEDBACK_IMAGE_BUDGET, KLAWLY_FEEDBACK_MAX_IMAGES } from '../../common/claudeFeedback.js';
import '../media/claude.css';
import '../media/claudeFeedback.css';

export interface IClaudeFeedbackFormOptions {
	/** The window as the tester saw it, attached to a fresh report. */
	readonly screenshot?: ClaudeFeedbackImage;
	/** A kept draft or an unsent report to open instead of a fresh one (issue 739). */
	readonly draft?: ClaudeFeedbackDraft;
	/** Why the opened report did not send, for the status line (issue 735). */
	readonly error?: { readonly message: string; readonly attachment?: string };
	/** A note for the status line with one action, such as opening an unsent report. */
	readonly notice?: { readonly text: string; readonly label: string; readonly run: () => void };
	/** Takes the report on Send. The form closes at once; the report uploads in the background (issue 735). */
	readonly submit: (draft: ClaudeFeedbackDraft) => void;
	/** Who is signed in and whether that account is banned; asked once when the form opens (issue 949). */
	readonly getStatus?: () => Promise<IClaudeFeedbackStatus>;
	/** A ban to show at once, such as the one a send was refused with. */
	readonly ban?: ClaudeFeedbackBan;
	/** Signs in with GitHub; resolves the new status. Offered while signed out. */
	readonly signIn?: () => Promise<IClaudeFeedbackStatus>;
	/** Signs out and in again as another account; resolves the new status. */
	readonly switchAccount?: () => Promise<IClaudeFeedbackStatus>;
}

/** The signed-in GitHub login, if any, and the ban on it, if any. */
export interface IClaudeFeedbackStatus {
	readonly login?: string;
	readonly ban?: ClaudeFeedbackBan;
}

/** How the form closed, with what it held then, so the caller can keep or drop the draft. */
export interface IClaudeFeedbackFormClose {
	readonly reason: 'sent' | 'discarded' | 'closed';
	readonly draft: ClaudeFeedbackDraft;
}

/** Longest side of an image after it is shrunk to fit the upload. */
const MAX_IMAGE_SIDE = 1920;
/** Images at or under this size are kept as they are; larger ones become JPEG. */
const KEEP_IMAGE_BYTES = 400_000;

/**
 * The Send Feedback form (issue 444): a modal over the workbench. Images come from
 * the window screenshot taken before it opened, from a paste (the clipboard is read
 * directly, nothing is saved to disk), from saved files (issue 699) and from drag and
 * drop. Send hands the report to `submit` and closes the form, so the tester can go on
 * working or start another report while it uploads (issue 735). Closing without sending
 * hands back the draft to keep (issue 739); a report that failed to send opens again with
 * its error on the status line.
 */
export class ClaudeFeedbackForm extends Disposable {

	private readonly _onDidClose = this._register(new Emitter<IClaudeFeedbackFormClose>());
	readonly onDidClose: Event<IClaudeFeedbackFormClose> = this._onDidClose.event;

	private readonly _root: HTMLElement;
	private readonly _images: { image: ClaudeFeedbackImage; url: string }[] = [];
	private readonly _imageList: HTMLElement;
	private readonly _imageListStore = this._register(new DisposableStore());
	private readonly _status: HTMLElement;
	private readonly _statusStore = this._register(new DisposableStore());
	private readonly _identityStore = this._register(new DisposableStore());
	private readonly _banStore = this._register(new DisposableStore());
	private readonly _title: HTMLInputElement;
	private readonly _description: HTMLTextAreaElement;
	private readonly _identity: HTMLElement;
	private readonly _ban: HTMLElement;
	private readonly _dialog: HTMLElement;
	private _login: string | undefined;
	private _banned = false;
	private readonly _diagnostics: Checkbox;
	private readonly _send: Button;
	private _kind: ClaudeFeedbackKind;
	private _pasteCount = 0;
	private _attachCount = 0;

	constructor(
		container: HTMLElement,
		private readonly _options: IClaudeFeedbackFormOptions,
		@IClipboardService private readonly _clipboard: IClipboardService,
		@IFileDialogService private readonly _fileDialog: IFileDialogService,
		@IFileService private readonly _files: IFileService,
		@IHoverService private readonly _hover: IHoverService,
		@IOpenerService private readonly _opener: IOpenerService,
	) {
		super();
		const { draft } = _options;
		this._kind = draft?.kind ?? 'bug';
		this._register(toDisposable(() => {
			for (const { url } of this._images) {
				URL.revokeObjectURL(url);
			}
		}));

		const backdrop = this._root = append(container, $('.claude-root.claude-feedback-backdrop'));
		this._register(toDisposable(() => backdrop.remove()));
		const dialog = append(backdrop, $('.claude-feedback', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'claude-feedback-heading' }));

		this._dialog = dialog;
		const header = append(dialog, $('.claude-feedback-header'));
		append(header, $('h2#claude-feedback-heading', undefined, localize('claudeFeedbackHeading', "Send Feedback to the Klawly Team")));
		const close = append(header, $<HTMLButtonElement>('button.claude-feedback-close', { 'aria-label': localize('claudeFeedbackClose', "Close"), type: 'button' }));
		append(close, $(ThemeIcon.asCSSSelector(Codicon.close)));
		this._register(addDisposableListener(close, EventType.CLICK, () => this.close('closed')));

		// Kind
		const kinds = append(dialog, $('.claude-feedback-kinds', { role: 'radiogroup', 'aria-label': localize('claudeFeedbackKind', "Kind") }));
		const kindButtons: [ClaudeFeedbackKind, HTMLButtonElement][] = ([
			['bug', localize('claudeFeedbackBug', "Bug")],
			['idea', localize('claudeFeedbackIdea', "Idea")],
			['other', localize('claudeFeedbackOther', "Other")],
		] as const).map(([kind, label]) => {
			const button = append(kinds, $<HTMLButtonElement>('button.claude-feedback-kind', { type: 'button', role: 'radio' }, label));
			this._register(addDisposableListener(button, EventType.CLICK, () => {
				this._kind = kind;
				syncKinds();
			}));
			return [kind, button];
		});
		const syncKinds = () => {
			for (const [kind, button] of kindButtons) {
				button.classList.toggle('is-checked', kind === this._kind);
				button.setAttribute('aria-checked', String(kind === this._kind));
			}
		};
		syncKinds();

		// Fields
		this._title = this.field(dialog, $<HTMLInputElement>('input', { type: 'text', maxLength: 200 }), localize('claudeFeedbackTitle', "Title"), localize('claudeFeedbackTitlePlaceholder', "A short summary"));
		this._description = this.field(dialog, $<HTMLTextAreaElement>('textarea', { rows: 6 }), localize('claudeFeedbackDescription', "What happened?"), localize('claudeFeedbackDescriptionPlaceholder', "What you did, what you expected, and what happened instead. Paste screenshots here."));
		// Feedback is sent as the signed-in GitHub account, never anonymously (issue 949, DL-97).
		this._identity = append(dialog, $('.claude-feedback-identity'));
		this._ban = append(dialog, $('.claude-feedback-ban', { role: 'alert' }));

		// Images
		const imagesRow = append(dialog, $('.claude-feedback-images'));
		const imagesHeader = append(imagesRow, $('.claude-feedback-images-header'));
		append(imagesHeader, $('span.claude-feedback-label', undefined, localize('claudeFeedbackImages', "Images")));
		append(imagesHeader, $('span.claude-feedback-hint', undefined, isMacintosh
			? localize('claudeFeedbackImagesHintMac', "Paste with Cmd+V, drop images here, or attach a saved image")
			: localize('claudeFeedbackImagesHint', "Paste with Ctrl+V, drop images here, or attach a saved image")));
		this._imageList = append(imagesRow, $('.claude-feedback-image-list'));

		// Diagnostics
		const diagnosticsRow = append(dialog, $('.claude-feedback-check'));
		this._diagnostics = this._register(new Checkbox(localize('claudeFeedbackDiagnostics', "Include logs and system info"), true, defaultCheckboxStyles));
		diagnosticsRow.appendChild(this._diagnostics.domNode);
		const diagnosticsLabel = append(diagnosticsRow, $('span', undefined, localize('claudeFeedbackDiagnosticsLabel', "Include logs and system info")));
		this._register(addDisposableListener(diagnosticsLabel, EventType.CLICK, () => this._diagnostics.checked = !this._diagnostics.checked));

		append(dialog, $('p.claude-feedback-note', undefined, localize('claudeFeedbackPrivacy', "Your report goes to the Klawly team's private issue tracker. Logs are recent Klawly and Claude Agent output, with API keys, tokens and your home folder path removed on a best-effort basis. Prompts and file contents are not included. Attachments are deleted 3 days after the report is closed.")));

		this._status = append(dialog, $('.claude-feedback-status', { role: 'status', 'aria-live': 'polite' }));

		const footer = append(dialog, $('.claude-feedback-footer'));
		if (draft) {
			// A kept draft opens in place of a fresh report; this starts over (DL-78).
			const discard = append(footer, $<HTMLButtonElement>('button.claude-file-link.claude-feedback-discard', { type: 'button' }, localize('claudeFeedbackDiscard', "Discard Draft")));
			this._register(addDisposableListener(discard, EventType.CLICK, () => this.close('discarded')));
		}
		const cancel = this._register(new Button(footer, { ...defaultButtonStyles, secondary: true }));
		cancel.label = localize('claudeFeedbackCancel', "Cancel");
		this._register(cancel.onDidClick(() => this.close('closed')));
		this._send = this._register(new Button(footer, defaultButtonStyles));
		this._send.label = localize('claudeFeedbackSend', "Send");
		this._register(this._send.onDidClick(() => this.send()));
		this.renderIdentity();
		if (_options.ban) {
			this.showBan(_options.ban);
		} else {
			_options.getStatus?.().then(status => this.applyStatus(status), () => undefined);
		}

		// Paste and drop anywhere in the form. Text pastes keep their default behavior.
		this._register(addDisposableListener(dialog, EventType.PASTE, event => {
			const files = Array.from(event.clipboardData?.items ?? []).filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => !!file);
			if (files.length > 0) {
				event.preventDefault();
				this.addFiles(files);
			} else if (event.target !== this._title && event.target !== this._description) {
				this.pasteFromClipboard();
			}
		}));
		this.registerDrop(dialog);

		this._register(addDisposableListener(backdrop, EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Escape)) {
				event.preventDefault();
				event.stopPropagation();
				this.close('closed');
			} else if ((isMacintosh ? event.metaKey : event.ctrlKey) && event.keyCode === KeyCode.Enter) {
				event.preventDefault();
				this.send();
			}
		}));
		this._register(trapFocus(backdrop, close, this._send.element));
		this._register(addDisposableListener(backdrop, EventType.MOUSE_DOWN, event => {
			if (event.target === backdrop) {
				event.preventDefault();
			}
		}));

		if (draft) {
			this._title.value = draft.title;
			this._description.value = draft.description;
			this._diagnostics.checked = draft.includeDiagnostics;
			this._pasteCount = countNamed(draft.images, 'pasted');
			this._attachCount = countNamed(draft.images, 'attached');
			for (const image of draft.images) {
				this.addImage(image);
			}
		} else if (_options.screenshot) {
			this.addImage(_options.screenshot);
		}
		this.renderImages();
		if (_options.error) {
			this.showSendError(_options.error.message, _options.error.attachment);
		} else if (_options.notice) {
			this.setStatus(_options.notice.text, false, { label: _options.notice.label, run: _options.notice.run });
		}
		this._title.focus();
	}

	/** What the form holds now. */
	getDraft(): ClaudeFeedbackDraft {
		return {
			kind: this._kind,
			title: this._title.value,
			description: this._description.value,
			images: this._images.map(({ image }) => image),
			includeDiagnostics: this._diagnostics.checked,
		};
	}

	private field<T extends HTMLInputElement | HTMLTextAreaElement>(parent: HTMLElement, control: T, label: string, placeholder: string): T {
		const id = `claude-feedback-${parent.childElementCount}`;
		const row = append(parent, $('.claude-feedback-field'));
		append(row, $('label.claude-feedback-label', { for: id }, label));
		control.id = id;
		control.placeholder = placeholder;
		control.classList.add('claude-feedback-control');
		row.appendChild(control);
		return control;
	}

	private addImage(image: ClaudeFeedbackImage): boolean {
		const used = this._images.reduce((sum, { image }) => sum + image.bytes.byteLength, 0);
		if (this._images.length >= KLAWLY_FEEDBACK_MAX_IMAGES) {
			this.setStatus(localize('claudeFeedbackTooManyImages', "You can attach up to {0} images.", KLAWLY_FEEDBACK_MAX_IMAGES), true);
			return false;
		}
		if (used + image.bytes.byteLength > KLAWLY_FEEDBACK_IMAGE_BUDGET) {
			this.setStatus(localize('claudeFeedbackImagesTooLarge', "The images are too large to send together. Remove one and try again."), true);
			return false;
		}
		const url = URL.createObjectURL(new Blob([image.bytes.buffer.slice()], { type: image.type }));
		this._images.push({ image, url });
		return true;
	}

	/**
	 * Screenshots dropped from the file manager, a screenshot tool or a browser
	 * (issue 1190). The handlers stop the event so the workbench's own drop
	 * handling never sees it, and the highlight only clears when the pointer
	 * really leaves the dialog, not when it crosses a child.
	 */
	private registerDrop(dialog: HTMLElement): void {
		const store = this._register(new DisposableStore());
		const carriesFiles = (event: DragEvent) => !!event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files');
		const accept = (event: DragEvent) => {
			if (!carriesFiles(event)) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			event.dataTransfer!.dropEffect = 'copy';
			dialog.classList.add('is-dragging');
		};
		store.add(addDisposableListener(dialog, EventType.DRAG_ENTER, accept));
		store.add(addDisposableListener(dialog, EventType.DRAG_OVER, accept));
		store.add(addDisposableListener(dialog, EventType.DRAG_LEAVE, event => {
			const next = event.relatedTarget;
			if (!(next instanceof Node) || !dialog.contains(next)) {
				dialog.classList.remove('is-dragging');
			}
		}));
		store.add(addDisposableListener(dialog, EventType.DROP, event => {
			dialog.classList.remove('is-dragging');
			if (!carriesFiles(event)) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			const dropped = event.dataTransfer!;
			const files = dropped.files.length > 0
				? Array.from(dropped.files)
				: Array.from(dropped.items).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => !!file);
			// Every dropped file is tried, so a file that is not an image says so (issue 699).
			this.addFiles(files);
		}));
	}

	private async addFiles(files: readonly File[]): Promise<void> {
		await this.addImages(files.map(file => ({ base: `pasted-${++this._pasteCount}`, read: async () => ({ bytes: new Uint8Array(await file.arrayBuffer()), type: file.type }) })));
	}

	/** Attach Image…: saved images from disk, through the same path as a drop (issue 699). */
	private async attachImages(): Promise<void> {
		const picked = await this._fileDialog.showOpenDialog({
			title: localize('claudeFeedbackAttachTitle', "Attach Images"),
			openLabel: localize('claudeFeedbackAttachOpen', "Attach"),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: true,
			filters: [{ name: localize('claudeFeedbackAttachFilter', "Images"), extensions: [...CLAUDE_FEEDBACK_IMAGE_EXTENSIONS] }],
		});
		if (!picked || this._store.isDisposed) {
			return;
		}
		await this.addImages(picked.map(resource => ({ base: `attached-${++this._attachCount}`, read: async () => ({ bytes: (await this._files.readFile(resource)).value.buffer, type: getMediaMime(resource.path) ?? '' }) })));
	}

	/** Adds images in order and stops at the first one that cannot be read or does not fit. */
	private async addImages(sources: readonly { base: string; read: () => Promise<{ bytes: Uint8Array; type: string }> }[]): Promise<void> {
		for (const source of sources) {
			const image = await this.prepareImage(source.base, source.read);
			if (!image || !this.addImage(image)) {
				break;
			}
		}
		this.renderImages();
	}

	/** Reads an image straight from the system clipboard, for pastes the DOM event does not carry. */
	private async pasteFromClipboard(): Promise<void> {
		const bytes = await this._clipboard.readImage().catch(() => new Uint8Array());
		if (bytes.byteLength === 0) {
			return;
		}
		const image = await this.prepareImage(`pasted-${++this._pasteCount}`, async () => ({ bytes, type: 'image/png' }));
		if (image && this.addImage(image)) {
			this.renderImages();
		}
	}

	/** Shrinks an image so a few fit in one report: longest side 1920px, JPEG when large. */
	private async prepareImage(base: string, read: () => Promise<{ bytes: Uint8Array; type: string }>): Promise<ClaudeFeedbackImage | undefined> {
		try {
			const { bytes, type } = await read();
			const prepared = await shrinkClaudeFeedbackImage(getWindow(this._root), bytes, type);
			return { ...prepared, name: claudeFeedbackImageName(base, prepared.type) };
		} catch {
			this.setStatus(localize('claudeFeedbackImageUnreadable', "That image could not be read."), true);
			return undefined;
		}
	}

	private removeImage(entry: { image: ClaudeFeedbackImage; url: string }): void {
		URL.revokeObjectURL(entry.url);
		this._images.splice(this._images.indexOf(entry), 1);
		this.renderImages();
	}

	private renderImages(): void {
		this._imageListStore.clear();
		clearNode(this._imageList);
		for (const entry of this._images) {
			const item = append(this._imageList, $('.claude-feedback-image'));
			append(item, $<HTMLImageElement>('img', { src: entry.url, alt: entry.image.name }));
			const remove = append(item, $<HTMLButtonElement>('button.claude-feedback-image-remove', { type: 'button', 'aria-label': localize('claudeFeedbackRemoveImage', "Remove {0}", entry.image.name) }));
			append(remove, $(ThemeIcon.asCSSSelector(Codicon.close)));
			this._imageListStore.add(addDisposableListener(remove, EventType.CLICK, () => this.removeImage(entry)));
		}
		// Both ways to add an image go away together at the limit (issue 699).
		if (this._images.length < KLAWLY_FEEDBACK_MAX_IMAGES) {
			this.addImageButton(Codicon.clippy, localize('claudeFeedbackPasteImage', "Paste Image"), localize('claudeFeedbackPasteImageHover', "Add the image on the clipboard"), () => this.pasteFromClipboard());
			this.addImageButton(Codicon.fileMedia, localize('claudeFeedbackAttachImage', "Attach Image..."), localize('claudeFeedbackAttachImageHover', "Choose saved images, such as screenshots"), () => this.attachImages());
		}
	}

	private addImageButton(icon: ThemeIcon, label: string, hover: string, run: () => void): void {
		const button = append(this._imageList, $<HTMLButtonElement>('button.claude-feedback-image-add', { type: 'button' }));
		append(button, $(ThemeIcon.asCSSSelector(icon)));
		append(button, $('span', undefined, label));
		this._imageListStore.add(addDisposableListener(button, EventType.CLICK, run));
		this._imageListStore.add(this._hover.setupDelayedHover(button, { content: hover, additionalClasses: ['claude-root'] }));
	}

	/** Takes a new sign-in status: a ban replaces the form, a login lets Send work. */
	private applyStatus(status: IClaudeFeedbackStatus): void {
		if (this._store.isDisposed) {
			return;
		}
		this._login = status.login;
		if (status.ban) {
			this.showBan(status.ban);
			return;
		}
		this.renderIdentity();
	}

	/** The "Sending as @login" row, or the sign-in button while signed out. The draft stays as it is. */
	private renderIdentity(): void {
		clearNode(this._identity);
		this._identityStore.clear();
		this._send.enabled = !!this._login && !this._banned;
		if (this._login) {
			append(this._identity, $('span', undefined, localize('claudeFeedbackSendingAs', "Sending as @{0}", this._login)));
			const { switchAccount } = this._options;
			if (switchAccount) {
				const link = append(this._identity, $<HTMLButtonElement>('button.claude-file-link.claude-feedback-sign-in', { type: 'button' }, localize('claudeFeedbackSwitchAccount', "Switch Account")));
				this._identityStore.add(addDisposableListener(link, EventType.CLICK, async () => {
					link.disabled = true;
					const status = await switchAccount();
					if (!this._store.isDisposed) {
						this.applyStatus(status);
					}
				}));
			}
			return;
		}
		append(this._identity, $('span', undefined, localize('claudeFeedbackSignInNote', "Sign in to GitHub to send feedback. Your report is filed under your account.")));
		const { signIn } = this._options;
		if (signIn) {
			const button = append(this._identity, $<HTMLButtonElement>('button.claude-file-link.claude-feedback-sign-in', { type: 'button' }, localize('claudeFeedbackSignIn', "Sign In to GitHub")));
			this._identityStore.add(addDisposableListener(button, EventType.CLICK, async () => {
				button.disabled = true;
				const status = await signIn();
				if (this._store.isDisposed) {
					return;
				}
				if (status.login || status.ban) {
					this.applyStatus(status);
				} else {
					button.disabled = false;
				}
			}));
		}
	}

	/** Shows why the account cannot send, in place of the form: the reason, what was sent and how to appeal (issue 949, DL-97). */
	private showBan(ban: ClaudeFeedbackBan): void {
		this._banned = true;
		this._login = ban.login;
		this._send.enabled = false;
		this._dialog.classList.add('is-banned');
		clearNode(this._ban);
		this._banStore.clear();
		append(this._ban, $('p.claude-feedback-ban-title', undefined, localize('claudeFeedbackBanTitle', "Your GitHub account @{0} can't send feedback.", ban.login)));
		const date = new Date(ban.bannedAt);
		if (!isNaN(date.getTime())) {
			append(this._ban, $('p.claude-feedback-hint', undefined, localize('claudeFeedbackBanDate', "Banned on {0}", date.toLocaleDateString())));
		}
		if (ban.reason) {
			append(this._ban, $('p.claude-feedback-label', undefined, localize('claudeFeedbackBanReason', "Reason")));
			append(this._ban, $('p.claude-feedback-ban-text', undefined, ban.reason));
		}
		if (ban.reportExcerpt) {
			append(this._ban, $('p.claude-feedback-label', undefined, localize('claudeFeedbackBanSent', "What you sent")));
			append(this._ban, $('blockquote.claude-feedback-ban-text', undefined, ban.reportExcerpt));
		}
		const appeal = append(this._ban, $('p'));
		const isLink = /^https?:\/\//.test(ban.appealEmail);
		append(appeal, $('span', undefined, isLink ? localize('claudeFeedbackBanAppealIssue', "To appeal, open an issue at ") : localize('claudeFeedbackBanAppeal', "To appeal, email ")));
		const link = append(appeal, $<HTMLButtonElement>('button.claude-file-link.claude-feedback-appeal', { type: 'button' }, ban.appealEmail));
		this._banStore.add(addDisposableListener(link, EventType.CLICK, () => this._opener.open(URI.parse(isLink ? ban.appealEmail : `mailto:${ban.appealEmail}`))));
	}

	/** The status line above the buttons, with an optional action such as removing a refused image. */
	private setStatus(text: string, isError: boolean, action?: { readonly label: string; readonly run: () => void }): void {
		this._statusStore.clear();
		clearNode(this._status);
		if (text) {
			append(this._status, $('span', undefined, text));
		}
		if (action) {
			const button = append(this._status, $<HTMLButtonElement>('button.claude-feedback-status-action', { type: 'button' }, action.label));
			this._statusStore.add(addDisposableListener(button, EventType.CLICK, () => {
				this.setStatus('', false);
				action.run();
			}));
		}
		this._status.classList.toggle('is-error', isError);
	}

	private send(): void {
		if (!this._login || this._banned) {
			return;
		}
		if (!this._title.value.trim()) {
			this.setStatus(localize('claudeFeedbackNeedsTitle', "Add a title."), true);
			this._title.focus();
			return;
		}
		// The upload runs in the background with its own progress, so the form never waits on it (issue 735).
		const draft = this.getDraft();
		this._options.submit({ ...draft, title: draft.title.trim() });
		this.close('sent');
	}

	/** Why the report did not send. An image the relay refused is named, with a way to drop it (issue 698). */
	private showSendError(message: string, attachment: string | undefined): void {
		const refused = attachment ? this._images.find(({ image }) => image.name === attachment) : undefined;
		if (refused) {
			this.setStatus(localize('claudeFeedbackImageRefused', "The feedback service could not take {0}. Remove it and send again.", refused.image.name), true, {
				label: localize('claudeFeedbackRemoveRefused', "Remove {0}", refused.image.name),
				run: () => this.removeImage(refused),
			});
		} else {
			this.setStatus(message, true);
		}
	}

	close(reason: IClaudeFeedbackFormClose['reason'] = 'closed'): void {
		if (this._store.isDisposed) {
			return;
		}
		this._onDidClose.fire({ reason, draft: this.getDraft() });
		this.dispose();
	}
}

/** The highest `<prefix>-<n>` among the image names, so a new image never reuses a name. */
function countNamed(images: readonly ClaudeFeedbackImage[], prefix: string): number {
	return images.reduce((count, image) => {
		const match = image.name.match(/^(?<prefix>[a-z]+)-(?<n>\d+)\./);
		return match?.groups?.prefix === prefix ? Math.max(count, Number(match.groups.n)) : count;
	}, 0);
}

/**
 * Scales an image so its longest side is at most 1920px. Small PNG and JPEG images keep
 * their bytes, labeled with the type the bytes are; larger ones and other formats are
 * re-encoded as JPEG so several fit in one report.
 */
export async function shrinkClaudeFeedbackImage(targetWindow: Window, bytes: Uint8Array, type: string): Promise<Omit<ClaudeFeedbackImage, 'name'>> {
	const blob = new Blob([bytes.slice()], { type });
	const bitmap = await targetWindow.createImageBitmap(blob);
	try {
		const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
		// The type comes from the bytes, not the caller's label (issue 698).
		const sniffed = claudeFeedbackImageType(bytes);
		if (scale === 1 && bytes.byteLength <= KEEP_IMAGE_BYTES && sniffed) {
			return { type: sniffed, bytes: VSBuffer.wrap(bytes) };
		}
		const canvas = targetWindow.document.createElement('canvas');
		canvas.width = Math.round(bitmap.width * scale);
		canvas.height = Math.round(bitmap.height * scale);
		canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		const jpeg = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
		if (!jpeg) {
			throw new Error('encode failed');
		}
		return { type: 'image/jpeg', bytes: VSBuffer.wrap(new Uint8Array(await jpeg.arrayBuffer())) };
	} finally {
		bitmap.close();
	}
}

/** Keeps focus inside the form, so Tab does not walk into the workbench behind it. */
function trapFocus(root: HTMLElement, first: HTMLElement, last: HTMLElement): IDisposable {
	return addDisposableListener(root, EventType.KEY_DOWN, e => {
		if (e.key !== 'Tab') {
			return;
		}
		const active = root.ownerDocument.activeElement;
		if (e.shiftKey && active === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && (active === last || !root.contains(active))) {
			e.preventDefault();
			first.focus();
		}
	});
}
