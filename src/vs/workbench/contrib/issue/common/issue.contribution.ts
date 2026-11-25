/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry, ICommandMetadata, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IssueReporterData, IWorkbenchIssueService } from './issue.js';

const OpenIssueReporterActionId = 'workbench.action.openIssueReporter';
const OpenIssueReporterApiId = 'vscode.openIssueReporter';
// Klawly: a report about the app itself goes to Send Feedback, since `reportIssueUrl` is a private repo (issue 765)
const KlawlySendFeedbackCommandId = 'klawly.sendFeedback';

const OpenIssueReporterCommandMetadata: ICommandMetadata = {
	description: 'Open the issue reporter and optionally prefill part of the form.',
	args: [
		{
			name: 'options',
			description: 'Data to use to prefill the issue reporter with.',
			isOptional: true,
			schema: {
				oneOf: [
					{
						type: 'string',
						description: 'The extension id to preselect.'
					},
					{
						type: 'object',
						properties: {
							extensionId: {
								type: 'string'
							},
							issueTitle: {
								type: 'string'
							},
							issueBody: {
								type: 'string'
							}
						}

					}
				]
			}
		},
	]
};

interface OpenIssueReporterArgs {
	readonly extensionId?: string;
	readonly issueTitle?: string;
	readonly issueBody?: string;
	readonly extensionData?: string;
}

export class BaseIssueContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@IProductService productService: IProductService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();

		if (!configurationService.getValue<boolean>('telemetry.feedback.enabled')) {
			this._register(CommandsRegistry.registerCommand({
				id: 'workbench.action.openIssueReporter',
				handler: function (accessor) {
					const data = accessor.get(INotificationService);
					data.info('Feedback is disabled.');

				},
			}));
			return;
		}

		if (!productService.reportIssueUrl) {
			return;
		}

		this._register(CommandsRegistry.registerCommand({
			id: OpenIssueReporterActionId,
			handler: function (accessor, args?: string | [string] | OpenIssueReporterArgs) {
				const data: Partial<IssueReporterData> =
					typeof args === 'string'
						? { extensionId: args }
						: Array.isArray(args)
							? { extensionId: args[0] }
							: args ?? {};

				if (!data.extensionId) {
					return accessor.get(ICommandService).executeCommand(KlawlySendFeedbackCommandId);
				}
				return accessor.get(IWorkbenchIssueService).openReporter(data);
			},
			metadata: OpenIssueReporterCommandMetadata
		}));

		this._register(CommandsRegistry.registerCommand({
			id: OpenIssueReporterApiId,
			handler: function (accessor, args?: string | [string] | OpenIssueReporterArgs) {
				const data: Partial<IssueReporterData> =
					typeof args === 'string'
						? { extensionId: args }
						: Array.isArray(args)
							? { extensionId: args[0] }
							: args ?? {};

				return accessor.get(IWorkbenchIssueService).openReporter(data);
			},
			metadata: OpenIssueReporterCommandMetadata
		}));

		// Klawly: Help > Send Feedback and its palette entry replace Report Issue (issue 765)
	}
}
