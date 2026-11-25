/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { homedir } from 'os';
import { isAbsolute, join } from '../../../base/common/path.js';
import { OS } from '../../../base/common/platform.js';
import { streamToBuffer } from '../../../base/common/buffer.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IEnvironmentService } from '../../environment/common/environment.js';
import { asText, IRequestService } from '../../request/common/request.js';
import { IClaudeRuntimeService } from '../common/claude.js';
import { claudeManagedDirectory } from '../common/claudeManagedFiles.js';
import { claudeConfigDirectory } from '../common/claudePlanFiles.js';
import { ClaudeInstalledPlugin, ClaudePluginCatalog, ClaudePluginCatalogRequest, ClaudePluginCommand, ClaudePluginCommandResult, ClaudePluginDetails, ClaudePluginKind, IClaudePluginService, readClaudePluginCommand } from '../common/claudePlugins.js';
import { writeClaudeTerminalPlugin } from './claudeTerminalPlugin.js';
import product from '../../product/common/product.js';
import { ClaudeCatalogFetch, ClaudeCatalogFetchBytes, ClaudePluginCatalogReader } from './claudePluginCatalog.js';

const FETCH_TIMEOUT_MS = 20_000;

/** A {@link ClaudeCatalogFetch} on the platform request service, so proxy settings apply. */
export function claudeCatalogFetch(requests: IRequestService): ClaudeCatalogFetch {
	return async (url, etag) => {
		const context = await requests.request({
			type: 'GET',
			url,
			timeout: FETCH_TIMEOUT_MS,
			headers: etag ? { 'If-None-Match': etag } : {},
			callSite: 'claudePluginCatalog',
		}, CancellationToken.None);
		const status = context.res.statusCode ?? 0;
		const header = context.res.headers.etag;
		return {
			status,
			etag: typeof header === 'string' ? header : undefined,
			body: status === 200 ? await asText(context) ?? undefined : undefined,
		};
	};
}

/** A {@link ClaudeCatalogFetchBytes} on the platform request service: the body stays bytes, so any file round-trips unchanged. */
export function claudeCatalogFetchBytes(requests: IRequestService): ClaudeCatalogFetchBytes {
	return async url => {
		const context = await requests.request({ type: 'GET', url, timeout: FETCH_TIMEOUT_MS, callSite: 'claudePluginCatalog' }, CancellationToken.None);
		const status = context.res.statusCode ?? 0;
		return { status, body: status === 200 ? await streamToBuffer(context.stream) : undefined };
	};
}

/** The project folder a request names, only when it is an absolute path. */
function readCwd(cwd: unknown): string | undefined {
	return typeof cwd === 'string' && isAbsolute(cwd) ? cwd : undefined;
}

/** A catalog request from IPC, with only the fields the reader knows. */
function readRequest(request: ClaudePluginCatalogRequest | undefined): ClaudePluginCatalogRequest {
	return { builtIn: request?.builtIn === true, refresh: request?.refresh === true, cwd: readCwd(request?.cwd) };
}

/**
 * Shared-process `IClaudePluginService`. Reads the catalog itself; installs,
 * updates and removals run `claude plugin` through the Claude runtime, the
 * same way Customize runs `claude mcp`.
 */
export class ClaudePluginService extends Disposable implements IClaudePluginService {
	declare readonly _serviceBrand: undefined;

	private readonly _reader: ClaudePluginCatalogReader;

	constructor(
		@IRequestService requests: IRequestService,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IEnvironmentService private readonly _environment: IEnvironmentService,
	) {
		super();
		this._reader = new ClaudePluginCatalogReader({
			configDirectory: claudeConfigDirectory(homedir(), process.env.CLAUDE_CONFIG_DIR),
			fetch: claudeCatalogFetch(requests),
			fetchBytes: claudeCatalogFetchBytes(requests),
			trialDirectory: join(this._environment.cacheHome.fsPath, 'claude-plugin-trials'),
			managedDirectory: claudeManagedDirectory(OS),
		});
	}

	getCatalog(request: ClaudePluginCatalogRequest): Promise<ClaudePluginCatalog> {
		return this._reader.getCatalog(readRequest(request));
	}

	getDetails(id: string, request: ClaudePluginCatalogRequest): Promise<ClaudePluginDetails | undefined> {
		return typeof id === 'string' ? this._reader.getDetails(id, readRequest(request)) : Promise.resolve(undefined);
	}

	resolveKinds(ids: readonly string[], request: ClaudePluginCatalogRequest): Promise<Record<string, readonly ClaudePluginKind[]>> {
		const valid = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
		return this._reader.resolveKinds(valid, readRequest(request));
	}

	getInstalled(cwd: string | undefined): Promise<ClaudeInstalledPlugin[]> {
		return this._reader.getInstalled(readCwd(cwd));
	}

	preparePluginTrial(id: string, request: ClaudePluginCatalogRequest): Promise<string | undefined> {
		return typeof id === 'string' ? this._reader.preparePluginTrial(id, readRequest(request)) : Promise.resolve(undefined);
	}

	getPluginIcons(ids: readonly string[], request: ClaudePluginCatalogRequest): Promise<Record<string, string>> {
		const valid = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
		return this._reader.getPluginIcons(valid, readRequest(request));
	}

	prepareTerminalPlugin(): Promise<string> {
		return writeClaudeTerminalPlugin(join(this._environment.userRoamingDataHome.fsPath, 'bundled-plugins'), product.version);
	}

	async run(command: ClaudePluginCommand): Promise<ClaudePluginCommandResult> {
		const valid = readClaudePluginCommand(command);
		if (!valid) {
			throw new Error('The plugin command is not valid.');
		}
		if (!this._runtime.runPluginCommand) {
			throw new Error('This Claude runtime cannot install plugins.');
		}
		const result = await this._runtime.runPluginCommand(valid);
		if (result.outcome === 'done') {
			this._reader.invalidate();
		}
		return result;
	}
}
