/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FontStyle, MetadataConsts } from '../../../../../editor/common/encodedTokenAttributes.js';
import { EncodedTokenizationResult, IState } from '../../../../../editor/common/languages.js';
import { NullState } from '../../../../../editor/common/languages/nullTokenize.js';
import { IReducedTokenizationSupport } from '../../../../../editor/common/languages/textToHtmlTokenizer.js';
import { LanguageIdCodec } from '../../../../../editor/common/services/languagesRegistry.js';
import { tokenizeCodeLines } from '../../common/claudeCodeTokens.js';

suite('Claude code tokens', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** Words get color 5, `//` comments color 7 in italics, everything else color 3. */
	const support: IReducedTokenizationSupport = {
		getInitialState: () => NullState,
		tokenizeEncoded: (line: string, _hasEOL: boolean, state: IState) => {
			const tokens: number[] = [];
			const pattern = /(?<comment>\/\/.*)|(?<word>\w+)|(?<other>(?:(?!\/\/)\W)+)/g;
			for (const match of line.matchAll(pattern)) {
				const color = match.groups?.comment ? 7 : match.groups?.word ? 5 : 3;
				const style = match.groups?.comment ? FontStyle.Italic : FontStyle.None;
				tokens.push(match.index ?? 0, (color << MetadataConsts.FOREGROUND_OFFSET) | (style << MetadataConsts.FONT_STYLE_OFFSET));
			}
			return new EncodedTokenizationResult(new Uint32Array(tokens), [], state);
		},
	};

	test('splits code into lines of colored runs', () => {
		assert.deepStrictEqual(tokenizeCodeLines('const a = 1;\n// done\n', new LanguageIdCodec(), support), [
			[
				{ className: 'mtk5', text: 'const' },
				{ className: 'mtk3', text: ' ' },
				{ className: 'mtk5', text: 'a' },
				{ className: 'mtk3', text: ' = ' },
				{ className: 'mtk5', text: '1' },
				{ className: 'mtk3', text: ';' },
			],
			[{ className: 'mtk7 mtki', text: '// done' }],
			[],
		]);
	});
});
