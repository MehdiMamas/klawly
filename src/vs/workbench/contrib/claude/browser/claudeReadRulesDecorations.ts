/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Color } from '../../../../base/common/color.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerColor } from '../../../../platform/theme/common/colorRegistry.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ClaudeReadRule, CLAUDE_PRIVACY_EXPLORER_DECORATIONS_SETTING, CLAUDE_READ_RULES_FILE, evaluateReadRules, mergeReadRules, parseReadRules, readRulesFromSettings } from '../../../../platform/claude/common/claudeReadRules.js';
import { CLAUDE_USER_LAYER_FOLDER } from '../../../../platform/claude/common/claudeUserLayer.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IDecorationData, IDecorationsProvider, IDecorationsService } from '../../../services/decorations/common/decorations.js';
import { IPathService } from '../../../services/path/common/pathService.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'claude',
	order: 102,
	title: localize('claudePrivacyConfigurationTitle', "AI / Claude"),
	type: 'object',
	properties: {
		[CLAUDE_PRIVACY_EXPLORER_DECORATIONS_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudePrivacyExplorerDecorationsSetting', "Marks the files and folders Claude cannot read in the Explorer. The block list is the read-rules file in your Klawly Claude folder plus the Read entries of a project's Claude permissions. A block holds in every approval mode. The sandbox layer under it is best effort and only applies while the sandbox is on."),
		},
	},
});

// DL-09: accents are for real status only. A blocked file is real, enforced status, so it takes a muted
// foreground and a slashed circle instead of a loud hue (DL-121).
export const claudeHiddenResourceForeground = registerColor(
	'claude.hiddenResourceForeground',
	{ dark: Color.fromHex('#8a8a8a'), light: Color.fromHex('#7a7a7a'), hcDark: Color.fromHex('#c0c0c0'), hcLight: Color.fromHex('#4a4a4a') },
	localize('claude.hiddenResourceForeground', "Colour of a file or folder Claude cannot read in the Explorer.")
);

/** The Explorer mark for a path Claude cannot read, or undefined when it can read it. */
export function claudeReadBlockDecoration(rules: readonly ClaudeReadRule[], fsPath: string): IDecorationData | undefined {
	const verdict = evaluateReadRules(rules, fsPath);
	if (!verdict.blocked || !verdict.rule) {
		return undefined;
	}
	const rule = verdict.rule;
	const where = rule.source === 'user'
		? localize('claudeReadBlockedUser', "your block list")
		: localize('claudeReadBlockedProject', "this project's Claude settings");
	return {
		weight: 5,
		letter: ThemeIcon.fromId('circle-slash'),
		color: claudeHiddenResourceForeground,
		bubble: false,
		tooltip: localize('claudeReadBlockedTooltip', "Claude cannot read this: {0} ({1})", rule.pattern, where),
	};
}

class ClaudeReadRulesProvider extends Disposable implements IDecorationsProvider {

	readonly label = localize('claudeReadRulesLabel', "Claude Privacy");

	private readonly _onDidChange = this._register(new Emitter<readonly URI[]>());
	readonly onDidChange: Event<readonly URI[]> = this._onDidChange.event;

	private _rules: readonly ClaudeReadRule[] = [];
	private _enabled: boolean;
	private _home: URI | undefined;
	private readonly _reload = this._register(new RunOnceScheduler(() => this.reload(), 300));

	constructor(
		private readonly _files: IFileService,
		private readonly _paths: IPathService,
		private readonly _product: IProductService,
		private readonly _workspace: IWorkspaceContextService,
		private readonly _configuration: IConfigurationService,
	) {
		super();
		this._enabled = this._configuration.getValue<boolean>(CLAUDE_PRIVACY_EXPLORER_DECORATIONS_SETTING) !== false;
		this._register(this._configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CLAUDE_PRIVACY_EXPLORER_DECORATIONS_SETTING)) {
				this._enabled = this._configuration.getValue<boolean>(CLAUDE_PRIVACY_EXPLORER_DECORATIONS_SETTING) !== false;
				this._onDidChange.fire([]);
			}
		}));
		this._register(this._files.onDidFilesChange(event => {
			const userList = this._userList();
			if ((userList && event.affects(userList)) || this._workspace.getWorkspace().folders.some(folder => event.affects(joinPath(folder.uri, '.claude')))) {
				this._reload.schedule();
			}
		}));
		this._register(this._workspace.onDidChangeWorkspaceFolders(() => this._reload.schedule()));
		this._reload.schedule(0);
	}

	private _userList(): URI | undefined {
		return this._home && joinPath(this._home, this._product.dataFolderName ?? '.klawly', CLAUDE_USER_LAYER_FOLDER, CLAUDE_READ_RULES_FILE);
	}

	private async _read(uri: URI): Promise<string | undefined> {
		try {
			return (await this._files.readFile(uri)).value.toString();
		} catch {
			return undefined;
		}
	}

	async reload(): Promise<void> {
		this._home = await this._paths.userHome({ preferLocal: true });
		const home = this._home.fsPath;
		const layers: ClaudeReadRule[][] = [];
		const userList = this._userList()!;
		const userText = await this._read(userList);
		layers.push(userText === undefined ? [] : parseReadRules(userText, { source: 'user', origin: userList.fsPath, home }));
		for (const folder of this._workspace.getWorkspace().folders) {
			for (const name of ['settings.json', 'settings.local.json']) {
				const uri = joinPath(folder.uri, '.claude', name);
				const text = await this._read(uri);
				if (text === undefined) {
					continue;
				}
				try {
					layers.push(readRulesFromSettings(JSON.parse(text), { source: 'project', origin: uri.fsPath, base: folder.uri.fsPath, home }));
				} catch {
					// A settings file that is not valid JSON has no rules to read.
				}
			}
		}
		this._rules = mergeReadRules(...layers);
		this._onDidChange.fire([]);
	}

	provideDecorations(uri: URI, _token: CancellationToken): IDecorationData | undefined {
		if (!this._enabled || uri.scheme !== 'file' || this._rules.length === 0) {
			return undefined;
		}
		return claudeReadBlockDecoration(this._rules, uri.fsPath);
	}
}

/** Marks the files Claude cannot read in the Explorer (issue 458). */
class ClaudeReadRulesDecorationsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.claudeReadRulesDecorations';

	constructor(
		@IDecorationsService decorationsService: IDecorationsService,
		@IFileService fileService: IFileService,
		@IPathService pathService: IPathService,
		@IProductService productService: IProductService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@IConfigurationService configuration: IConfigurationService,
	) {
		super();
		const provider = this._register(new ClaudeReadRulesProvider(fileService, pathService, productService, workspace, configuration));
		this._register(decorationsService.registerDecorationsProvider(provider));
	}
}

registerWorkbenchContribution2(ClaudeReadRulesDecorationsContribution.ID, ClaudeReadRulesDecorationsContribution, WorkbenchPhase.AfterRestored);
