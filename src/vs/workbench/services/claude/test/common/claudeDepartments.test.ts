/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { claudeDepartmentProjects } from '../../common/claudeDepartments.js';

/** Issue 1177: the projects a hand-off can reach. */
suite('Claude departments', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('lists open and recent local folders once, named by their folder', () => {
		const projects = claudeDepartmentProjects(
			[{ uri: URI.file('/work/klawly') }],
			[{ folderUri: URI.file('/work/klawly') }, { folderUri: URI.file('/work/relay') }, { folderUri: URI.parse('vscode-remote://host/work/far') }],
		);
		assert.deepStrictEqual(projects.map(project => project.name), ['klawly', 'relay']);
	});
});
