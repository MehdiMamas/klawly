/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IOnboardingService } from '../common/onboardingService.js';

/**
 * Klawly has no sign-in step to onboard (the upstream wizard was a Copilot sign-in), so the
 * onboarding service does nothing. The Klawly first-run flow replaces it in a later phase.
 */
class NoOnboardingService implements IOnboardingService {

	declare readonly _serviceBrand: undefined;

	readonly onDidDismiss = Event.None;

	show(): void { }
}

registerSingleton(IOnboardingService, NoOnboardingService, InstantiationType.Delayed);
