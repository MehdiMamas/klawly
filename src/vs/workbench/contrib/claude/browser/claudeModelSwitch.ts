/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ClaudeModelInfo, IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { CLAUDE_DEFAULT_MODEL_ALIAS, claudeModelDisplayName } from '../../../../platform/claude/common/claudeModels.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { canonicalClaudeModel, CLAUDE_MODELS_WARN_ON_SWITCH_SETTING, claudeFinishedTurns, claudeModelSwitchTokens, claudeModelSwitchWarns } from '../common/claudeModelSwitch.js';

/** The notice one chat shows after the user picked another model mid-chat (issue 703). */
export interface ClaudeModelSwitchNotice {
	readonly sessionId: string;
	/** The model the chat ran on before; undefined is Claude Code's default. */
	readonly from: string | undefined;
	readonly fromName: string;
	/** Auto's strategy when Auto picked the model before, so Switch Back turns Auto on again. */
	readonly fromAuto?: boolean;
	readonly to: string;
	readonly toName: string;
	/** What the context meter shows, rounded; undefined when Claude Code has not reported it. */
	readonly tokens?: number;
}

/**
 * Issue 703: the one way the composer's model menu, the Pick Model action and
 * the cycle-model command change a chat's model. Picking another model in a
 * chat with a finished turn leaves a notice on that chat, because the new model
 * reads the whole conversation again without the cache. Auto's own picks and
 * background runs call `IClaudeAgentService.setNextModel` directly and never warn.
 */
export interface IClaudeModelSwitchService {
	readonly _serviceBrand: undefined;
	/** Fires with the session id whose notice appeared, changed or went away. */
	readonly onDidChange: Event<string>;
	/** Picks the model for the session's next turn, and leaves a notice when that costs more usage. */
	switchModel(sessionId: string, modelId: string): Promise<void>;
	getNotice(sessionId: string): ClaudeModelSwitchNotice | undefined;
	/** Keep: the notice goes, the new model stays. */
	dismiss(sessionId: string): void;
	/** Back to the model (or Auto) the chat ran on before. */
	switchBack(sessionId: string): Promise<void>;
	/** A new chat on the new model, with the draft; this chat goes back to its old model and keeps its cache. */
	newChat(sessionId: string): Promise<void>;
	/** Don't Show Again: turns `claude.models.warnOnSwitch` off. */
	turnOff(sessionId: string): Promise<void>;
}

export const IClaudeModelSwitchService = createDecorator<IClaudeModelSwitchService>('claudeModelSwitchService');

interface StoredNotice extends ClaudeModelSwitchNotice {
	/** Turns in the chat when the notice appeared: the next message pays the cost, so a new turn ends the notice. */
	readonly turns: number;
}

export class ClaudeModelSwitchService extends Disposable implements IClaudeModelSwitchService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _notices = new Map<string, StoredNotice>();

	constructor(
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
	) {
		super();
		this._register(this._agent.onDidChangeViewState(({ sessionId }) => {
			const notice = this._notices.get(sessionId);
			if (notice && this._agent.getViewState(sessionId).turns.length > notice.turns) {
				this.clear(sessionId);
			}
		}));
		this._register(this._agent.onDidChangeSession(change => {
			if (change.reason !== 'closed') {
				return;
			}
			const open = new Set(this._agent.getSessions().map(session => session.id));
			for (const id of [...this._notices.keys()]) {
				if (!open.has(id)) {
					this._notices.delete(id);
				}
			}
		}));
		this._register(this._configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CLAUDE_MODELS_WARN_ON_SWITCH_SETTING) && !this.enabled()) {
				for (const id of [...this._notices.keys()]) {
					this.clear(id);
				}
			}
		}));
	}

	async switchModel(sessionId: string, modelId: string): Promise<void> {
		const session = this._agent.getSessions().find(candidate => candidate.id === sessionId);
		const auto = this._agent.getAutoModel(sessionId);
		const state = this._agent.getViewState(sessionId);
		const models = await this._runtime.listModels();
		// Under Auto the chat ran on Auto's last pick; with no pick yet there is nothing cached to lose.
		const from = auto ? auto.last?.modelId : session?.modelId;
		const warns = !!session && (!auto || !!auto.last) && claudeModelSwitchWarns({
			finishedTurns: claudeFinishedTurns(state.turns),
			from,
			to: modelId,
			models,
			auto: false,
			enabled: this.enabled(),
		});
		await this._agent.setNextModel(sessionId, modelId);
		if (!warns || !session) {
			this.clear(sessionId);
			return;
		}
		const previous = this._notices.get(sessionId);
		// Picking the model the chat ran on before ends the notice: its cache may still be warm.
		const origin = previous ? { from: previous.from, fromName: previous.fromName, fromAuto: previous.fromAuto } : { from, fromName: auto?.last?.modelName ?? session.modelName ?? this.name(from, models), fromAuto: !!auto };
		if (previous && canonicalClaudeModel(previous.from, models) === canonicalClaudeModel(modelId, models)) {
			this.clear(sessionId);
			return;
		}
		this._notices.set(sessionId, {
			sessionId,
			...origin,
			to: modelId,
			toName: this.name(modelId, models),
			tokens: claudeModelSwitchTokens(state.usage),
			turns: state.turns.length,
		});
		this._onDidChange.fire(sessionId);
	}

	getNotice(sessionId: string): ClaudeModelSwitchNotice | undefined {
		return this._notices.get(sessionId);
	}

	dismiss(sessionId: string): void {
		this.clear(sessionId);
	}

	async switchBack(sessionId: string): Promise<void> {
		const notice = this._notices.get(sessionId);
		if (!notice) {
			return;
		}
		this.clear(sessionId);
		await this.restore(notice);
	}

	async newChat(sessionId: string): Promise<void> {
		const notice = this._notices.get(sessionId);
		if (!notice) {
			return;
		}
		this.clear(sessionId);
		const draft = this._agent.getSessions().find(candidate => candidate.id === sessionId)?.draft ?? '';
		await this.restore(notice);
		if (draft) {
			this._agent.setDraft(sessionId, '');
		}
		const created = this._agent.createSession({ draft });
		await this._agent.setNextModel(created.id, notice.to);
	}

	async turnOff(sessionId: string): Promise<void> {
		this.clear(sessionId);
		await this._configuration.updateValue(CLAUDE_MODELS_WARN_ON_SWITCH_SETTING, false, ConfigurationTarget.USER);
	}

	private async restore(notice: ClaudeModelSwitchNotice): Promise<void> {
		if (notice.fromAuto) {
			this._agent.setAutoModel(notice.sessionId, true);
			return;
		}
		await this._agent.setNextModel(notice.sessionId, notice.from ?? (await this.defaultModel()));
	}

	/** The id to pick for "the model Claude Code chose itself": the `default` row when reported, else the first model. */
	private async defaultModel(): Promise<string> {
		const models = await this._runtime.listModels();
		return models.find(model => model.id === CLAUDE_DEFAULT_MODEL_ALIAS)?.id ?? models[0]?.id ?? CLAUDE_DEFAULT_MODEL_ALIAS;
	}

	private name(id: string | undefined, models: readonly ClaudeModelInfo[]): string {
		const canonical = canonicalClaudeModel(id, models);
		const row = models.find(model => model.id === (id ?? CLAUDE_DEFAULT_MODEL_ALIAS)) ?? models.find(model => model.id === canonical || model.resolvedModel === canonical);
		return row ? claudeModelDisplayName(row) : canonical;
	}

	private enabled(): boolean {
		return this._configuration.getValue(CLAUDE_MODELS_WARN_ON_SWITCH_SETTING) !== false;
	}

	private clear(sessionId: string): void {
		if (this._notices.delete(sessionId)) {
			this._onDidChange.fire(sessionId);
		}
	}
}

registerSingleton(IClaudeModelSwitchService, ClaudeModelSwitchService, InstantiationType.Delayed);
