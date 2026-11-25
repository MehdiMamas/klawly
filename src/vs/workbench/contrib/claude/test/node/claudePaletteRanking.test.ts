/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable local/code-import-patterns, local/code-layering, local/code-translation-remind -- the guard builds the real palette provider (platform/quickinput/browser) to run its ranking */

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { AbstractCommandsQuickAccessProvider, ICommandQuickPick } from '../../../../../platform/quickinput/browser/commandsQuickAccess.js';
import { IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { readClaudePaletteCommands } from './claudePaletteCommands.js';

/**
 * Issue 1504: typing a Klawly command's own name in the palette must put that command first.
 * The real commands quick access provider ranks the full Klawly command set, so the filter, the
 * tf-idf fallback and the sort are the ones the palette runs, not a copy of them.
 */
class TestProvider extends AbstractCommandsQuickAccessProvider {

	constructor(private readonly picks: ICommandQuickPick[], private readonly disposables: DisposableStore, instantiationService: TestInstantiationService) {
		super({ showAlias: true, noResultsPick: { label: 'no results', commandId: '' } }, instantiationService, instantiationService.get(IKeybindingService), instantiationService.get(ICommandService), instantiationService.get(ITelemetryService), instantiationService.get(IDialogService));
	}

	protected async getCommandPicks(): Promise<ICommandQuickPick[]> {
		return this.picks.map(pick => ({ ...pick }));
	}

	protected hasAdditionalCommandPicks(): boolean {
		return false;
	}

	protected async getAdditionalCommandPicks(): Promise<Array<ICommandQuickPick | IQuickPickSeparator>> {
		return [];
	}

	async rank(filter: string): Promise<ICommandQuickPick[]> {
		const picks = await this._getPicks(filter, this.disposables, CancellationToken.None);
		return (Array.isArray(picks) ? picks : []).filter((pick): pick is ICommandQuickPick => pick.type !== 'separator' && !!(pick as ICommandQuickPick).commandId);
	}
}

suite('Klawly palette commands, ranking by own name (issue 1504)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('every Klawly command ranks first, or ties first with an identical label, for its own lowercased title', async () => {
		const { commands } = readClaudePaletteCommands();
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IStorageService, store.add(new InMemoryStorageService()));
		instantiationService.stub(IConfigurationService, new TestConfigurationService());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ITelemetryService, NullTelemetryService);
		instantiationService.stub(IKeybindingService, { lookupKeybinding: () => undefined });
		instantiationService.stub(ICommandService, {});
		instantiationService.stub(IDialogService, {});

		const picks: ICommandQuickPick[] = commands.map(command => ({
			commandId: command.id,
			label: command.label,
			commandAlias: command.commandAlias,
		}));
		const provider = store.add(new TestProvider(picks, store.add(new DisposableStore()), instantiationService));

		const failures: string[] = [];
		for (const command of commands) {
			const title = command.label.replace(/^[^:]+:\s*/, '');
			const ranked = await provider.rank(title.toLowerCase());
			const first = ranked[0];
			const ok = !!first && (first.commandId === command.id || first.label === command.label);
			if (!ok) {
				failures.push(`"${title.toLowerCase()}" (${command.id}) ranks ${ranked.findIndex(r => r.commandId === command.id) + 1}, first is ${first?.label ?? 'nothing'}`);
			}
		}
		assert.deepStrictEqual(failures, []);
	});
});
