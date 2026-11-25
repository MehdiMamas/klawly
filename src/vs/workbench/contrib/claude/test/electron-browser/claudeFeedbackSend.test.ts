/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IProgressService } from '../../../../../platform/progress/common/progress.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../../platform/native/common/native.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { IClaudeFeedbackService } from '../../../../../platform/claude/common/claudeFeedbackRelay.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { IKlawlyAccountService } from '../../../../services/claude/common/klawlyAccount.js';
import { INativeWorkbenchEnvironmentService } from '../../../../services/environment/electron-browser/environmentService.js';
import { IOutputService } from '../../../../services/output/common/output.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { URI } from '../../../../../base/common/uri.js';
import { sendFeedback, sendFeedbackInBackground } from '../../electron-browser/claudeFeedback.js';
import { ClaudeFeedbackDraft } from '../../common/claudeFeedback.js';

suite('Klawly Send Feedback with logs and system info (issue 1211)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('looks up the account after the async diagnostics step without an accessor error', async () => {
		const stub = (value: object) => value as never;
		const posted: string[] = [];
		const services = new ServiceCollection(
			[ILogService, new NullLogService()],
			[IClaudeFeedbackService, stub({ send: async (_endpoint: string, body: string) => { posted.push(body); return { kind: 'sent', number: 7 }; } })],
			[IConfigurationService, stub({ getValue: () => undefined })],
			[IKlawlyAccountService, stub({ getSessionSilently: async () => ({ accessToken: 'token' }) })],
			[IProductService, stub({ nameLong: 'Klawly', version: '1' })],
			[INativeHostService, stub({ getOSProperties: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return { type: 'Test', release: '1', arch: 'x64' }; } })],
			[IClaudeRuntimeService, stub({ getRuntimeState: async () => { throw new Error('none'); } })],
			[IOutputService, stub({})],
			[ITextModelService, stub({})],
			[IPathService, stub({ userHome: async () => URI.file('/home/test') })],
			[IFileService, stub({ readFile: async () => { throw new Error('no file'); } })],
			[INativeWorkbenchEnvironmentService, stub({ logFile: URI.file('/logs/renderer.log'), logsHome: URI.file('/logs') })],
		);
		const instantiation = new InstantiationService(services);
		services.set(IInstantiationService, instantiation);
		const report = { kind: 'bug', title: 'T', description: 'D', includeDiagnostics: true, images: [] } as unknown as ClaudeFeedbackDraft;
		const number = await instantiation.invokeFunction(sendFeedback, report, () => { });
		assert.strictEqual(number, 7);
		assert.strictEqual(posted.length, 1);
	});

	test('sends in the background, awaiting every service, without an accessor error', async () => {
		const stub = (value: object) => value as never;
		const later = () => new Promise(resolve => setTimeout(resolve, 5));
		const posted: string[] = [];
		const infos: string[] = [];
		const services = new ServiceCollection(
			[ILogService, new NullLogService()],
			[IClaudeFeedbackService, stub({ send: async (_endpoint: string, body: string) => { await later(); posted.push(body); return { kind: 'sent', number: 9 }; } })],
			[IConfigurationService, stub({ getValue: () => undefined })],
			[IKlawlyAccountService, stub({ getSessionSilently: async () => { await later(); return { accessToken: 'token' }; } })],
			[IProductService, stub({ nameLong: 'Klawly', version: '1' })],
			[INativeHostService, stub({ getOSProperties: async () => { await later(); return { type: 'Test', release: '1', arch: 'x64' }; } })],
			[IClaudeRuntimeService, stub({ getRuntimeState: async () => { throw new Error('none'); } })],
			[IOutputService, stub({})],
			[ITextModelService, stub({})],
			[IPathService, stub({ userHome: async () => URI.file('/home/test') })],
			[IFileService, stub({ readFile: async () => { throw new Error('no file'); } })],
			[INativeWorkbenchEnvironmentService, stub({ logFile: URI.file('/logs/renderer.log'), logsHome: URI.file('/logs') })],
			[IProgressService, stub({ withProgress: async (_options: object, task: (progress: object) => Promise<number>) => { await later(); return task({ report: () => { } }); } })],
			[INotificationService, stub({ info: (message: string) => { infos.push(message); }, notify: (notification: { message: string }) => { infos.push(notification.message); } })],
			[ICommandService, stub({})],
			[IStorageService, stub({})],
		);
		const instantiation = new InstantiationService(services);
		services.set(IInstantiationService, instantiation);
		for (const includeDiagnostics of [true, false]) {
			const report = { kind: 'bug', title: 'T', description: 'D', includeDiagnostics, images: [] } as unknown as ClaudeFeedbackDraft;
			await instantiation.invokeFunction(sendFeedbackInBackground, report);
		}
		assert.deepStrictEqual({ posted: posted.length, infos }, {
			posted: 2,
			infos: [
				'Thanks! Your feedback was sent to the Klawly team (report #9).',
				'Thanks! Your feedback was sent to the Klawly team (report #9).',
			],
		});
	});
});
