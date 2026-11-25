/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { joinPath, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { Position } from '../../../../editor/common/core/position.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { buildClaudeReviewContextPack, ClaudeContextPack, ClaudeContextReference, claudeChangedSymbols, claudeDiffPaths, ClaudeReviewImpactContext } from '../../../../platform/claude/common/claudeReviewContext.js';

const GRAPH_REPORT = ['graphify-out', 'GRAPH_REPORT.md'];

/**
 * Issue 931: where the symbols a change touches are used, found with the editor's reference providers (the language
 * servers), so the reviewer sees callers outside the diff. Without a provider for a file the symbol is skipped and the
 * reviewer falls back to searching the repo itself. Never throws: a review runs without the pack.
 */
export async function gatherClaudeReviewContext(services: { files: IFileService; languageFeatures: ILanguageFeaturesService; textModels: ITextModelService }, root: URI, diff: string, mode: ClaudeReviewImpactContext): Promise<ClaudeContextPack | undefined> {
	if (mode === 'off') {
		return undefined;
	}
	try {
		const symbols = claudeChangedSymbols(diff);
		const references: ClaudeContextReference[] = [];
		const lines = new Map<string, string[]>();
		for (const symbol of symbols) {
			for (const reference of await findReferences(services, root, symbol.name, symbol.path)) {
				const path = relativePath(root, reference.uri);
				if (!path) {
					continue;
				}
				let content = lines.get(path);
				if (!content) {
					content = (await services.files.readFile(reference.uri)).value.toString().split(/\r?\n/);
					lines.set(path, content);
				}
				references.push({ symbol: symbol.name, path, line: reference.line, text: content[reference.line - 1] ?? '' });
			}
		}
		const graph = mode === 'symbolsAndPatterns' ? await readGraphSummary(services.files, root) : undefined;
		return buildClaudeReviewContextPack(symbols, references, claudeDiffPaths(diff), graph);
	} catch {
		return undefined;
	}
}

async function findReferences(services: { files: IFileService; languageFeatures: ILanguageFeaturesService; textModels: ITextModelService }, root: URI, name: string, path: string): Promise<{ uri: URI; line: number }[]> {
	let reference;
	try {
		reference = await services.textModels.createModelReference(joinPath(root, ...path.split('/')));
	} catch {
		return [];
	}
	try {
		const model = reference.object.textEditorModel;
		const providers = services.languageFeatures.referenceProvider.ordered(model);
		const match = new RegExp(`\\b${name.replace(/[$]/g, '\\$&')}\\b`).exec(model.getValue());
		if (!providers.length || !match) {
			return [];
		}
		const position = model.getPositionAt(match.index);
		const found = await providers[0].provideReferences(model, new Position(position.lineNumber, position.column), { includeDeclaration: false }, CancellationToken.None);
		return (found ?? []).slice(0, 40).map(location => ({ uri: location.uri, line: location.range.startLineNumber }));
	} catch {
		return [];
	} finally {
		reference.dispose();
	}
}

async function readGraphSummary(files: IFileService, root: URI): Promise<string | undefined> {
	try {
		return (await files.readFile(joinPath(root, ...GRAPH_REPORT))).value.toString().slice(0, 2_000);
	} catch {
		return undefined;
	}
}
