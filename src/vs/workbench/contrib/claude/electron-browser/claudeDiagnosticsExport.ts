/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../base/common/network.js';
import { joinPath } from '../../../../base/common/resources.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ClaudeRuntimeState, IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { CLAUDE_PROTOCOL_VERSION } from '../../../../platform/claude/common/claudeProtocol.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IOutputService } from '../../../services/output/common/output.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { CLAUDE_AGENT_OUTPUT_CHANNEL_ID } from '../../../services/claude/common/claudeAgentLog.js';
import { buildClaudeDiagnosticsFiles, CLAUDE_EXPORT_DIAGNOSTICS_COMMAND_ID } from '../common/claudeDiagnosticsExport.js';

/**
 * Developer: Export Claude Agent Diagnostics. Writes a redacted ZIP of versions,
 * OS, `claude.*` settings, recent event types, Claude Agent output lines and
 * error stacks. The content is built by `buildClaudeDiagnosticsFiles`.
 */
export function registerClaudeDiagnosticsExport(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_EXPORT_DIAGNOSTICS_COMMAND_ID,
				title: localize2('claudeExportDiagnostics', "Export Claude Agent Diagnostics"),
				category: Categories.Developer,
				f1: true,
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const fileDialogs = accessor.get(IFileDialogService);
			const nativeHost = accessor.get(INativeHostService);
			const notifications = accessor.get(INotificationService);
			const product = accessor.get(IProductService);
			const configuration = accessor.get(IConfigurationService);
			const runtime = accessor.get(IClaudeRuntimeService);
			const output = accessor.get(IOutputService);
			const textModels = accessor.get(ITextModelService);
			const paths = accessor.get(IPathService);

			const stamp = new Date().toISOString().replace(/[:.]/g, '-');
			const target = await fileDialogs.showSaveDialog({
				title: localize('claudeExportDiagnosticsTitle', "Export Claude Agent Diagnostics"),
				defaultUri: joinPath(await fileDialogs.defaultFilePath(Schemas.file), `claude-diagnostics-${stamp}.zip`),
				filters: [{ name: localize('claudeExportDiagnosticsZip', "ZIP Archive"), extensions: ['zip'] }],
				availableFileSystems: [Schemas.file],
			});
			if (!target) {
				return;
			}
			try {
				let state: ClaudeRuntimeState | undefined;
				let runtimeError: string | undefined;
				try {
					state = await runtime.getRuntimeState();
				} catch (error) {
					runtimeError = error instanceof Error ? error.message : String(error);
				}
				const home = (await paths.userHome()).fsPath;
				const os = await nativeHost.getOSProperties();
				const files = buildClaudeDiagnosticsFiles({
					generatedAt: new Date().toISOString(),
					product: { nameLong: product.nameLong, version: product.version, commit: product.commit, date: product.date, quality: product.quality },
					protocolVersion: CLAUDE_PROTOCOL_VERSION,
					runtime: state,
					runtimeError,
					os: { type: os.type, release: os.release, arch: os.arch },
					configuration: configuration.getValue('claude'),
					log: await readAgentLog(output, textModels),
					homeDirectories: [home, home.replace(/\\/g, '/')],
				});
				await nativeHost.createZipFile(target, [...files]);
				notifications.info(localize('claudeExportDiagnosticsDone', "Saved Claude Agent diagnostics to {0}. Secrets are redacted on a best-effort basis; check the files before sharing them.", target.fsPath));
			} catch (error) {
				notifications.error(localize('claudeExportDiagnosticsFailed', "Could not export Claude Agent diagnostics: {0}", error instanceof Error ? error.message : String(error)));
			}
		}
	});
}

/** The Claude Agent output channel text, or empty when the channel was never opened. */
export async function readAgentLog(output: IOutputService, textModels: ITextModelService): Promise<string> {
	const channel = output.getChannel(CLAUDE_AGENT_OUTPUT_CHANNEL_ID);
	if (!channel) {
		return '';
	}
	const reference = await textModels.createModelReference(channel.uri);
	try {
		return reference.object.textEditorModel.getValue();
	} finally {
		reference.dispose();
	}
}
