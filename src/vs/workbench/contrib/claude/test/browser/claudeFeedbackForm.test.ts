/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $ } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestClipboardService } from '../../../../../platform/clipboard/test/common/testClipboardService.js';
import { IOpenDialogOptions } from '../../../../../platform/dialogs/common/dialogs.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { TestFileDialogService, TestPathService } from '../../../../test/browser/workbenchTestServices.js';
import { ClaudeFeedbackForm, IClaudeFeedbackFormClose, IClaudeFeedbackFormOptions, shrinkClaudeFeedbackImage } from '../../browser/feedback/claudeFeedbackForm.js';
import { ClaudeFeedbackBan } from '../../../../../platform/claude/common/claudeFeedbackRelay.js';
import { ClaudeFeedbackDraft } from '../../common/claudeFeedback.js';

/** Answers the Attach Image... picker with whatever the test set. */
class PickedFileDialogService extends TestFileDialogService {
	picked: URI[] = [];
	readonly asked: IOpenDialogOptions[] = [];
	override async showOpenDialog(options: IOpenDialogOptions): Promise<URI[] | undefined> {
		this.asked.push(options);
		return this.picked;
	}
}

/** A real 2×2 image, so the form can decode it. */
async function encodeImage(type: 'image/png' | 'image/jpeg'): Promise<Uint8Array> {
	const canvas = mainWindow.document.createElement('canvas');
	canvas.width = 2;
	canvas.height = 2;
	const context = canvas.getContext('2d')!;
	context.fillStyle = '#c33';
	context.fillRect(0, 0, 2, 2);
	const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type));
	return new Uint8Array(await blob!.arrayBuffer());
}

async function until(condition: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !condition(); i++) {
		await timeout(10);
	}
}

suite('Klawly feedback form', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** Signed in as octo-cat unless the test says otherwise; resolves once the status has been applied. */
	async function createForm(submit: (draft: ClaudeFeedbackDraft) => void, options: Partial<IClaudeFeedbackFormOptions> = {}) {
		const container = $('div');
		const files = store.add(new FileService(new NullLogService()));
		store.add(files.registerProvider(Schemas.inMemory, store.add(new InMemoryFileSystemProvider())));
		const dialog = new PickedFileDialogService(new TestPathService());
		const opened: string[] = [];
		const opener = new class extends mock<IOpenerService>() {
			override async open(target: URI | string) {
				opened.push(target.toString());
				return true;
			}
		};
		const form = store.add(new ClaudeFeedbackForm(container, { submit, getStatus: async () => ({ login: 'octo-cat' }), ...options }, new TestClipboardService(), dialog, files, NullHoverService, opener));
		await timeout(0);
		const closes: IClaudeFeedbackFormClose[] = [];
		store.add(form.onDidClose(close => closes.push(close)));
		const title = container.querySelector<HTMLInputElement>('input[type="text"]')!;
		const send = container.querySelectorAll<HTMLElement>('.claude-feedback-footer .monaco-button')[1];
		const status = container.querySelector('.claude-feedback-status')!;
		const images = () => Array.from(container.querySelectorAll('.claude-feedback-image img'), image => image.getAttribute('alt'));
		const addButtons = () => Array.from(container.querySelectorAll('.claude-feedback-image-add'), button => button.textContent);
		return { form, closes, container, files, dialog, title, send, status, images, addButtons, opened };
	}

	const ban: ClaudeFeedbackBan = { login: 'octo-cat', bannedAt: '2026-10-14T10:00:00.000Z', reason: 'Abusive language aimed at the team.', reportExcerpt: 'you people are useless', issue: 951, appealEmail: 'appeals@example.com' };

	test('Send hands the report over and closes the form at once, without waiting for the upload (issue 735)', async () => {
		const submitted: ClaudeFeedbackDraft[] = [];
		const { container, title, send, closes } = await createForm(draft => submitted.push(draft));
		container.querySelector<HTMLTextAreaElement>('textarea')!.value = 'Sent a prompt and the pane froze.';
		title.value = '  Chat freezes ';

		send.click();

		assert.deepStrictEqual({ submitted, closes: closes.map(close => close.reason), open: !!container.querySelector('.claude-feedback') }, {
			submitted: [{ kind: 'bug', title: 'Chat freezes', description: 'Sent a prompt and the pane froze.', images: [], includeDiagnostics: true }],
			closes: ['sent'],
			open: false,
		});
	});

	test('a kept draft opens as it was left, and Discard Draft starts over (issue 739)', async () => {
		const draft: ClaudeFeedbackDraft = { kind: 'idea', title: 'Dark sidebar', description: 'Half written', images: [], includeDiagnostics: false };
		const kept = await createForm(() => { }, { draft });
		const restored = {
			kind: kept.container.querySelector('.claude-feedback-kind.is-checked')?.textContent,
			title: kept.title.value,
			sendEnabled: !kept.send.classList.contains('disabled'),
			discard: kept.container.querySelector('.claude-feedback-discard')?.textContent,
		};
		kept.title.value = 'Dark sidebar, please';
		kept.container.querySelectorAll<HTMLElement>('.claude-feedback-footer .monaco-button')[0].click();

		const discarded = await createForm(() => { }, { draft });
		discarded.container.querySelector<HTMLElement>('.claude-feedback-discard')!.click();
		const fresh = await createForm(() => { });

		assert.deepStrictEqual({ restored, cancelled: kept.closes, discarded: discarded.closes.map(close => close.reason), freshDiscard: !!fresh.container.querySelector('.claude-feedback-discard') }, {
			restored: { kind: 'Idea', title: 'Dark sidebar', sendEnabled: true, discard: 'Discard Draft' },
			cancelled: [{ reason: 'closed', draft: { ...draft, title: 'Dark sidebar, please' } }],
			discarded: ['discarded'],
			freshDiscard: false,
		});
	});

	test('a report that did not send opens with the reason, and a note points to the others (issue 735)', async () => {
		const draft: ClaudeFeedbackDraft = { kind: 'bug', title: 'Chat freezes', description: '', images: [], includeDiagnostics: true };
		const failed = await createForm(() => { }, { draft, error: { message: 'Could not send: Too many reports. Try again in 10 minutes.' } });
		const opened: string[] = [];
		const noted = await createForm(() => { }, { notice: { text: 'A report you sent earlier did not go through.', label: 'Open It', run: () => opened.push('open') } });
		const note = { status: noted.status.querySelector('span')?.textContent, isError: noted.status.classList.contains('is-error') };
		noted.status.querySelector<HTMLElement>('button')!.click();

		assert.deepStrictEqual({
			failed: { status: failed.status.textContent, isError: failed.status.classList.contains('is-error') },
			noted: note,
			opened,
			clearedAfterClick: noted.status.textContent,
		}, {
			failed: { status: 'Could not send: Too many reports. Try again in 10 minutes.', isError: true },
			noted: { status: 'A report you sent earlier did not go through.', isError: false },
			opened: ['open'],
			clearedAfterClick: '',
		});
	});

	test('signed in, the form says who it sends as and Send works (issue 949)', async () => {
		const { container, send } = await createForm(() => { });
		assert.deepStrictEqual({ identity: container.querySelector('.claude-feedback-identity span')?.textContent, sendEnabled: !send.classList.contains('disabled'), banned: !!container.querySelector('.is-banned') }, {
			identity: 'Sending as @octo-cat',
			sendEnabled: true,
			banned: false,
		});
	});

	test('signed out, Send is off, the draft is kept and Sign In to GitHub signs in, after a cancelled try (issue 949)', async () => {
		// The first sign-in is cancelled, the second one signs in.
		const answers = [{}, { login: 'octo-cat' }];
		const asked: string[] = [];
		const draft: ClaudeFeedbackDraft = { kind: 'bug', title: 'Chat freezes', description: 'Half written', images: [], includeDiagnostics: true };
		const { container, send, title } = await createForm(() => { }, { draft, getStatus: async () => ({}), signIn: async () => { asked.push('signIn'); return answers.shift()!; } });
		const link = () => container.querySelector<HTMLButtonElement>('.claude-feedback-sign-in');
		const sendOn = () => !send.classList.contains('disabled');
		const before = { link: link()?.textContent, sendEnabled: sendOn(), title: title.value };
		link()!.click();
		await timeout(0);
		const cancelled = { link: !!link(), disabled: link()?.disabled, sendEnabled: sendOn() };
		link()!.click();
		await timeout(0);
		const signedIn = { identity: container.querySelector('.claude-feedback-identity span')?.textContent, sendEnabled: sendOn(), title: title.value };

		assert.deepStrictEqual({ before, cancelled, signedIn, asked }, {
			before: { link: 'Sign In to GitHub', sendEnabled: false, title: 'Chat freezes' },
			cancelled: { link: true, disabled: false, sendEnabled: false },
			signedIn: { identity: 'Sending as @octo-cat', sendEnabled: true, title: 'Chat freezes' },
			asked: ['signIn', 'signIn'],
		});
	});

	test('a banned account sees the reason, what it sent and the appeal email, and cannot send (issue 949)', async () => {
		const submitted: ClaudeFeedbackDraft[] = [];
		const { container, send, opened } = await createForm(draft => submitted.push(draft), { getStatus: async () => ({ login: ban.login, ban }) });
		send.click();
		const panel = container.querySelector('.claude-feedback-ban')!;
		const text = () => Array.from(panel.querySelectorAll('p, blockquote'), element => element.textContent);
		container.querySelector<HTMLElement>('.claude-feedback-appeal')!.click();

		assert.deepStrictEqual({ panel: text(), banned: !!container.querySelector('.is-banned'), sendEnabled: !send.classList.contains('disabled'), submitted, opened }, {
			panel: [
				"Your GitHub account @octo-cat can't send feedback.",
				'Banned on ' + new Date(ban.bannedAt).toLocaleDateString(),
				'Reason',
				'Abusive language aimed at the team.',
				'What you sent',
				'you people are useless',
				'To appeal, email appeals@example.com',
			],
			banned: true,
			sendEnabled: false,
			submitted: [],
			opened: ['mailto:appeals%40example.com'],
		});
	});

	test('a ban the send was refused with opens at once, without asking the relay (issue 949)', async () => {
		const asked: string[] = [];
		const { container } = await createForm(() => { }, { ban, getStatus: async () => { asked.push('status'); return {}; } });
		assert.deepStrictEqual({ banned: !!container.querySelector('.is-banned'), asked }, { banned: true, asked: [] });
	});

	test('Attach Image... adds saved images and refuses a file that is not one (issue 699)', async () => {
		const { files, dialog, status, images, addButtons, container } = await createForm(() => { });
		const shot = URI.from({ scheme: Schemas.inMemory, path: '/shots/shot.png' });
		const notes = URI.from({ scheme: Schemas.inMemory, path: '/shots/notes.png' });
		await files.writeFile(shot, VSBuffer.wrap(await encodeImage('image/png')));
		await files.writeFile(notes, VSBuffer.fromString('not an image'));
		const attach = () => container.querySelectorAll<HTMLElement>('.claude-feedback-image-add')[1];
		const buttons = addButtons();

		dialog.picked = [shot];
		attach().click();
		await until(() => images().length === 1);
		const attached = images();
		dialog.picked = [notes];
		attach().click();
		await until(() => !!status.textContent);

		assert.deepStrictEqual({ buttons, canSelectMany: dialog.asked[0].canSelectMany, attached, after: images(), status: status.textContent }, {
			buttons: ['Paste Image', 'Attach Image...'],
			canSelectMany: true,
			attached: ['attached-1.png'],
			after: ['attached-1.png'],
			status: 'That image could not be read.',
		});
	});

	test('a screenshot dropped on the form is added and a dropped file that is not an image is refused (issue 1190)', async () => {
		const { container, status, images } = await createForm(() => { });
		const form = container.querySelector<HTMLElement>('.claude-feedback')!;
		const drag = (type: string, ...files: File[]) => {
			const dataTransfer = new DataTransfer();
			files.forEach(file => dataTransfer.items.add(file));
			const event = new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true });
			form.querySelector('.claude-feedback-images')!.dispatchEvent(event);
			return event;
		};
		const shot = new File([(await encodeImage('image/png')).buffer as ArrayBuffer], 'shot.png', { type: 'image/png' });

		const over = drag('dragover', shot);
		const highlighted = form.classList.contains('is-dragging');
		drag('drop', shot);
		await until(() => images().length === 1);
		const dropped = images();
		drag('drop', new File(['not an image'], 'notes.txt', { type: 'text/plain' }));
		await until(() => !!status.textContent);

		assert.deepStrictEqual({ accepted: over.defaultPrevented, highlighted, cleared: !form.classList.contains('is-dragging'), dropped, after: images(), status: status.textContent }, {
			accepted: true,
			highlighted: true,
			cleared: true,
			dropped: ['pasted-1.png'],
			after: ['pasted-1.png'],
			status: 'That image could not be read.',
		});
	});

	test('an image the feedback service refused can be removed from the status line (issue 698)', async () => {
		const sent: string[][] = [];
		const image = { name: 'attached-1.png', type: 'image/png' as const, bytes: VSBuffer.wrap(await encodeImage('image/png')) };
		const draft: ClaudeFeedbackDraft = { kind: 'bug', title: 'Chat freezes', description: '', images: [image], includeDiagnostics: true };
		const { send, status, images } = await createForm(result => sent.push(result.images.map(image => image.name)), {
			draft,
			error: { message: 'Could not send: Attachment attached-1.png does not match its type.', attachment: 'attached-1.png' },
		});
		const before = images();
		const refused = { status: status.querySelector('span')?.textContent, action: status.querySelector('button')?.textContent };
		status.querySelector<HTMLElement>('button')!.click();
		const afterRemove = images();
		send.click();

		assert.deepStrictEqual({ before, refused, afterRemove, sent }, {
			before: ['attached-1.png'],
			refused: { status: 'The feedback service could not take attached-1.png. Remove it and send again.', action: 'Remove attached-1.png' },
			afterRemove: [],
			sent: [[]],
		});
	});

	test('a small image keeps its bytes and gets the type they really are (issue 698)', async () => {
		const jpeg = await encodeImage('image/jpeg');
		const png = await encodeImage('image/png');
		const labeledPng = await shrinkClaudeFeedbackImage(mainWindow, jpeg, 'image/png');
		const realPng = await shrinkClaudeFeedbackImage(mainWindow, png, 'image/png');
		assert.deepStrictEqual([labeledPng.type, labeledPng.bytes.byteLength === jpeg.byteLength, realPng.type], ['image/jpeg', true, 'image/png']);
	});
});
