/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { splitLines } from '../../../../base/common/strings.js';
import { ILanguageIdCodec } from '../../../../editor/common/languages.js';
import { IReducedTokenizationSupport } from '../../../../editor/common/languages/textToHtmlTokenizer.js';
import { LineTokens } from '../../../../editor/common/tokens/lineTokens.js';

/** One colored run of a code line: the editor's token classes (`mtk<N>` plus font style) and its text. */
export interface CodeTokenRun {
	readonly className: string;
	readonly text: string;
}

/**
 * Splits code into lines of token runs with the editor's tokenizer, so a code block in chat
 * takes the editor's theme colors (the `mtk<N>` rules the theme writes for the editor).
 */
export function tokenizeCodeLines(code: string, languageIdCodec: ILanguageIdCodec, support: IReducedTokenizationSupport): CodeTokenRun[][] {
	const lines: CodeTokenRun[][] = [];
	let state = support.getInitialState();
	for (const line of splitLines(code)) {
		const result = support.tokenizeEncoded(line, true, state);
		LineTokens.convertToEndOffset(result.tokens, line.length);
		const tokens = new LineTokens(result.tokens, line, languageIdCodec).inflate();
		const runs: CodeTokenRun[] = [];
		let start = 0;
		for (let i = 0; i < tokens.getCount(); i++) {
			const end = tokens.getEndOffset(i);
			runs.push({ className: tokens.getClassName(i), text: line.substring(start, end) });
			start = end;
		}
		lines.push(runs);
		state = result.endState;
	}
	return lines;
}
