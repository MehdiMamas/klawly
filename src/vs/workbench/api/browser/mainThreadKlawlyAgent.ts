/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { IClaudeExtensionAgentService } from '../../services/claude/common/claudeExtensionAgentService.js';
import { extHostNamedCustomer, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { MainContext, MainThreadKlawlyAgentShape } from '../common/extHost.protocol.js';

@extHostNamedCustomer(MainContext.MainThreadKlawlyAgent)
export class MainThreadKlawlyAgent extends Disposable implements MainThreadKlawlyAgentShape {

	constructor(
		_extHostContext: IExtHostContext,
		@IClaudeExtensionAgentService private readonly _service: IClaudeExtensionAgentService,
	) {
		super();
	}

	async $startAgent(extensionId: string, extensionName: string, prompt: string): Promise<string> {
		const result = await this._service.startAgent(extensionId, extensionName, prompt);
		switch (result.kind) {
			case 'started':
				return result.sessionId;
			case 'denied':
				throw new Error(`The user did not allow ${extensionId} to start Klawly agents.`);
			case 'failed':
				throw new Error(result.message);
		}
	}
}
