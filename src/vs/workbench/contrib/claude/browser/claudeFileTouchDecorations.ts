/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Color } from '../../../../base/common/color.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { registerColor } from '../../../../platform/theme/common/colorRegistry.js';
import { ClaudeFilePets, claudeAgentPetColor } from '../../../../platform/claude/common/claudeAgentFileTouch.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IDecorationData, IDecorationsProvider, IDecorationsService } from '../../../services/decorations/common/decorations.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IClaudeFileTouchService } from '../../../services/claude/common/claudeFileTouchService.js';

// DL-09: accents are for real status only. A pet is real status (an agent is editing this file now), so it
// takes one of eight low-chroma hues; a changed-by mark uses the same hue, and a collision takes the warning hue.
const PET_COLORS: readonly [string, string][] = [
	['#dd8f52', '#9e5522'], ['#6ea8d8', '#2f6a9e'], ['#8fc27a', '#4c7f38'], ['#c58fd0', '#7f4a8c'],
	['#d9c168', '#8a7420'], ['#6cc3b8', '#2a7d73'], ['#d98a8a', '#9c4646'], ['#9aa0d8', '#545aa3'],
];

const petColorIds = PET_COLORS.map(([dark, light], index) => registerColor(
	`claude.pet.color${index + 1}`,
	{ dark: Color.fromHex(dark), light: Color.fromHex(light), hcDark: Color.fromHex(dark), hcLight: Color.fromHex(light) },
	localize('claude.pet.color', "Colour {0} of 8 for the mark of an agent that is editing a file or changed it last.", index + 1)
));

const petConflictColor = registerColor(
	'claude.pet.conflict',
	{ dark: Color.fromHex('#e5b95c'), light: Color.fromHex('#8a6410'), hcDark: Color.fromHex('#ffd479'), hcLight: Color.fromHex('#6b4a00') },
	localize('claude.pet.conflict', "Mark of a file that two or more agents are editing at once.")
);

/** The mark on Explorer rows and editor tabs for a file agents are editing or changed last. */
export function claudeFilePetDecoration(pets: ClaudeFilePets, colorOf: (agentId: string) => number): IDecorationData | undefined {
	if (pets.conflict) {
		const names = pets.active.map(touch => touch.agent.name).join(', ');
		return { weight: 30, letter: '!', color: petConflictColor, bubble: false, tooltip: localize('claudeFilePetConflict', "Being edited by several agents at once: {0}", names) };
	}
	const touch = pets.active[0];
	if (touch) {
		return { weight: 20, letter: '●', color: petColorIds[touch.color % petColorIds.length], bubble: false, tooltip: localize('claudeFilePetActive', "{0} is editing this file", touch.agent.name) };
	}
	if (pets.changedBy) {
		return { weight: 10, letter: '○', color: petColorIds[colorOf(pets.changedBy.agentId) % petColorIds.length], bubble: false, tooltip: localize('claudeFilePetChanged', "Changed by {0}, not reviewed yet", pets.changedBy.name) };
	}
	return undefined;
}

class ClaudeFilePetsProvider extends Disposable implements IDecorationsProvider {

	readonly label = localize('claudeFilePetsLabel', "Claude");

	private readonly _onDidChange = this._register(new Emitter<readonly URI[]>());
	readonly onDidChange: Event<readonly URI[]> = this._onDidChange.event;

	constructor(@IClaudeFileTouchService private readonly _touch: IClaudeFileTouchService) {
		super();
		this._register(this._touch.onDidChange(paths => this._onDidChange.fire(paths.map(path => URI.file(path)))));
	}

	provideDecorations(uri: URI, _token: CancellationToken): IDecorationData | undefined {
		if (uri.scheme !== 'file') {
			return undefined;
		}
		return claudeFilePetDecoration(this._touch.petsOf(uri.fsPath), claudeAgentPetColor);
	}
}

/** Registers the pets provider and clears a file's changed-by mark once the user looks at it. */
class ClaudeFileTouchDecorationsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.claudeFileTouchDecorations';

	constructor(
		@IDecorationsService decorationsService: IDecorationsService,
		@IClaudeFileTouchService touch: IClaudeFileTouchService,
		@IEditorService editorService: IEditorService,
	) {
		super();
		const provider = this._register(new ClaudeFilePetsProvider(touch));
		this._register(decorationsService.registerDecorationsProvider(provider));
		this._register(editorService.onDidActiveEditorChange(() => {
			const resource = editorService.activeEditor?.resource;
			if (resource?.scheme === 'file') {
				const pets = touch.petsOf(resource.fsPath);
				if (pets.changedBy && pets.active.length === 0) {
					touch.markReviewed(resource.fsPath);
				}
			}
		}));
	}
}

registerWorkbenchContribution2(ClaudeFileTouchDecorationsContribution.ID, ClaudeFileTouchDecorationsContribution, WorkbenchPhase.AfterRestored);
