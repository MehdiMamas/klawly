/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { disallowedToolsForMode, evaluateModePolicy, isReadOnlyMode, isReadOnlyShellCommand, policyForMode } from '../../common/claudeModePolicy.js';
import { resolveContextEnvelope } from '../../common/claudeContextResolve.js';
import { AGENT_POLICY, ASK_POLICY, PLAN_POLICY } from '../../common/claudePermissions.js';
import { buildPlanPrompt, parsePlanArtifact } from '../../common/claudePlan.js';
import { parsePlanDocument } from '../../common/claudePlanDocument.js';
import { planToMarkdown } from '../../common/claudePlanEdit.js';
import { compilePrompt, retargetCompiledPrompt } from '../../common/claudePrompt.js';
import { classifyTool } from '../../common/claudeProtocol.js';
import { CLAUDE_FEEDBACK_TOOL_ID, claudeFeedbackToolText } from '../../common/claudeFeedbackTool.js';
import { CLAUDE_STATUS_TOOL_ID, claudeStatusText } from '../../common/claudeStatusTool.js';

suite('Claude mode policy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('issue 1171: the status tool runs in every mode and its text is one short line', () => {
		for (const mode of ['ask', 'plan', 'agent'] as const) {
			assert.strictEqual(evaluateModePolicy(mode, CLAUDE_STATUS_TOOL_ID, { text: 'x' }).behavior, 'defer', mode);
		}
		assert.deepStrictEqual([claudeStatusText('  a\n b  '), claudeStatusText('   '), claudeStatusText('x'.repeat(300))?.length], ['a b', undefined, 120]);
	});

	test('issue 1174: the feedback tool runs in every mode', () => {
		for (const mode of ['ask', 'plan', 'agent'] as const) {
			assert.strictEqual(evaluateModePolicy(mode, CLAUDE_FEEDBACK_TOOL_ID, { title: 'x', description: 'y' }).behavior, 'defer', mode);
		}
		assert.deepStrictEqual([claudeFeedbackToolText(' a\n b ', ' d '), claudeFeedbackToolText(' ', 'd'), claudeFeedbackToolText('t', ' ')], [{ title: 'a b', description: 'd' }, undefined, undefined]);
	});

	test('each mode maps to its SessionPolicy', () => {
		assert.strictEqual(policyForMode('agent'), AGENT_POLICY);
		assert.strictEqual(policyForMode('ask'), ASK_POLICY);
		assert.strictEqual(policyForMode('plan'), PLAN_POLICY);
	});

	test('Ask denies every file write with a structured denial; Plan and Agent pass writes on to the host', () => {
		for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
			const result = evaluateModePolicy('ask', tool, { file_path: '/repo/a.plan.md' });
			assert.strictEqual(result.behavior, 'deny', tool);
			if (result.behavior === 'deny') {
				assert.deepStrictEqual(result.denial, { code: 'mode-read-only', mode: 'ask', tool, category: classifyTool(tool) });
				assert.ok(result.message.includes('never changes files'));
				assert.ok(result.message.includes('not switched'));
			}
			// Plan writes are judged by path in the host policy (plan files only).
			assert.strictEqual(evaluateModePolicy('plan', tool, { file_path: '/repo/a.ts' }).behavior, 'defer', `plan ${tool}`);
			assert.strictEqual(evaluateModePolicy('agent', tool, { file_path: '/repo/a.ts' }).behavior, 'defer', `agent ${tool}`);
		}
	});

	test('every mode passes commands, web, MCP, unknown and bookkeeping tools on to the host', () => {
		const requests: [string, unknown][] = [
			['Bash', { command: 'rm -rf node_modules' }], ['Bash', { command: 'npm install' }], ['Bash', { command: 'git status' }], ['Bash', {}],
			['Read', {}], ['Grep', {}], ['Glob', {}], ['WebFetch', { url: 'https://x.dev' }], ['WebSearch', {}],
			['mcp__db__drop_table', {}], ['SomethingNew', {}], ['TodoWrite', {}], ['Task', {}],
		];
		const seen = (['agent', 'plan', 'ask'] as const).flatMap(mode => requests.map(([tool, input]) => `${mode} ${tool} ${evaluateModePolicy(mode, tool, input).behavior}`));
		assert.deepStrictEqual(seen.filter(line => !line.endsWith(' defer')), []);
	});

	test('Plan and Ask open the SDK with fewer built-in write tools; Agent with none removed', () => {
		assert.deepStrictEqual([disallowedToolsForMode('agent'), disallowedToolsForMode('plan'), disallowedToolsForMode('ask')], [undefined, ['NotebookEdit'], ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']]);
		assert.deepStrictEqual([isReadOnlyMode('agent'), isReadOnlyMode('plan'), isReadOnlyMode('ask')], [false, true, true]);
	});

	test('read-only shell check rejects redirects, substitution and tool-specific writers', () => {
		assert.strictEqual(isReadOnlyShellCommand('ls'), true);
		assert.strictEqual(isReadOnlyShellCommand(''), false);
		assert.strictEqual(isReadOnlyShellCommand('cat a < b'), false);
		assert.strictEqual(isReadOnlyShellCommand('echo `id`'), false);
		assert.strictEqual(isReadOnlyShellCommand('rg --pre ./run foo'), false);
		assert.strictEqual(isReadOnlyShellCommand('git -c core.pager=x log'), false);
		assert.strictEqual(isReadOnlyShellCommand('git diff --output=a.patch'), false);
		assert.strictEqual(isReadOnlyShellCommand('ls;\nrm a'), false);
		for (const command of ['ls & rm a', 'echo x &rm a', 'ls |& rm a', 'uniq a b', 'tree -o f', 'tree --output=f', 'tree -ao f', 'sort -o f a', 'sort --output f a', 'date -s 2020-01-01', 'date', 'rg --hostname-bin x foo', 'rm -rf node_modules', 'npm install', 'git commit -m x', 'echo hi > a.txt', 'sed -i s/a/b/ f', 'find . -delete', 'git branch -D x', '$(rm a)']) {
			assert.strictEqual(isReadOnlyShellCommand(command), false, command);
		}
		for (const command of ['tree -L 2', 'ls && pwd', 'ls -la', 'git status', 'git log --oneline | head -5', 'rg foo src', 'cat package.json', 'git diff HEAD', 'git branch -a']) {
			assert.strictEqual(isReadOnlyShellCommand(command), true, command);
		}
	});

	test('Ask and Plan prompts tell the model what the mode may change; Agent adds nothing', () => {
		const base = { userText: 'hi', workspaceRoot: '/repo', attachments: [], diagnostics: [], instructionFiles: [] };
		assert.ok(compilePrompt({ ...base, mode: 'ask' }).includes('Ask mode never changes files'));
		const plan = compilePrompt({ ...base, mode: 'plan' });
		assert.ok(plan.includes('Plan mode does not change project files') && plan.includes('If you write one, put it in the Klawly plans folder in your home directory (~/.klawly/plans), not in the project, unless the user asks for it there'), plan);
		assert.ok(plan.includes('then the details of the plan') && plan.includes('last a "## To-dos" heading over a numbered list of short tasks'), plan);
		assert.strictEqual(compilePrompt({ ...base, mode: 'agent' }).includes('mode_instructions'), false);
	});

	test('Plan mode names the user plan folder the context readers resolve, not the project (issue 322)', async () => {
		const readers = {
			relativePath: () => '',
			readText: async () => undefined,
			readMarkers: async () => [],
			readGit: async () => ({ stat: '', patch: '', truncated: false }),
			readTerminal: async () => undefined,
			activeEditor: () => undefined,
			workspaceRoot: () => '/repo',
			planFolder: async () => '/home/me/.klawly-dev/plans',
		};
		const plan = await resolveContextEnvelope('plan it', 'plan', [], readers);
		const agent = await resolveContextEnvelope('do it', 'agent', [], readers);
		const instructions = (prompt: string) => /<mode_instructions>\n(?<text>[\s\S]*?)\n<\/mode_instructions>/.exec(prompt)?.groups?.text.split('. ').slice(-2);
		assert.deepStrictEqual({
			plan: instructions(compilePrompt(plan)),
			retargeted: instructions(retargetCompiledPrompt(compilePrompt(agent), 'plan', plan.planFolder)),
			agent: agent.planFolder,
		}, {
			plan: ['The only files you may write are plan files, and your reply is the plan, so you need none', 'If you write one, put it in Klawly\'s plans folder for this user, /home/me/.klawly-dev/plans, not in the project, unless the user asks for it there; then use a *.plan.md file or the project\'s .claude/plans/ folder.'],
			retargeted: ['The only files you may write are plan files, and your reply is the plan, so you need none', 'If you write one, put it in Klawly\'s plans folder for this user, /home/me/.klawly-dev/plans, not in the project, unless the user asks for it there; then use a *.plan.md file or the project\'s .claude/plans/ folder.'],
			agent: undefined,
		});
	});

	test('Switch to Agent and Retry re-targets the sent prompt and keeps its context', () => {
		const base = { userText: 'Add <b> & fix', workspaceRoot: '/repo', attachments: [], diagnostics: [{ path: 'a.ts', line: 1, column: 1, severity: 'error' as const, message: 'x' }], instructionFiles: [] };
		const ask = compilePrompt({ ...base, mode: 'ask' });
		assert.strictEqual(retargetCompiledPrompt(ask, 'agent'), compilePrompt({ ...base, mode: 'agent' }));
		assert.strictEqual(retargetCompiledPrompt(compilePrompt({ ...base, mode: 'agent' }), 'plan'), compilePrompt({ ...base, mode: 'plan' }));
		assert.strictEqual(retargetCompiledPrompt('/compact', 'agent'), '/compact');
	});
});

suite('Claude plan artifact', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const answer = [
		'# Add coupon expiry handling',
		'',
		'Reject expired coupons on the server and show a clear message.',
		'',
		'1. Add `expiresAt` check to `src/coupon.ts`',
		'2. Return a typed `CouponExpired` error',
		'   - Map to HTTP 410 in `api/handler.ts`',
		'3. [x] Unit tests',
		'```',
		'1. not a step',
		'```',
	].join('\n');

	test('reads a titled checklist with detail and file chips', () => {
		const plan = parsePlanArtifact(answer);
		assert.ok(plan);
		assert.strictEqual(plan.title, 'Add coupon expiry handling');
		assert.strictEqual(plan.summary, 'Reject expired coupons on the server and show a clear message.');
		assert.deepStrictEqual(plan.steps.map(step => step.title), [
			'Add expiresAt check to src/coupon.ts',
			'Return a typed CouponExpired error',
			'Unit tests',
		]);
		assert.deepStrictEqual(plan.steps[0].files, ['src/coupon.ts']);
		assert.strictEqual(plan.steps[1].detail, 'Map to HTTP 410 in api/handler.ts');
		assert.deepStrictEqual(plan.steps[1].files, ['api/handler.ts']);
		assert.deepStrictEqual(plan.steps.map(step => step.status), ['pending', 'pending', 'done']);
	});

	test('text above the heading is the lead, not the summary', () => {
		const plan = parsePlanArtifact(['I read the `cart.ts` tests.', '', '# Fix totals', '', 'Round to cents.', '', '1. Round'].join('\n'));
		const noHeading = parsePlanArtifact(['Fix totals', 'Round to cents.', '1. Round'].join('\n'));
		assert.deepStrictEqual([plan?.lead, plan?.title, plan?.summary, noHeading?.lead, noHeading?.title, noHeading?.summary], ['I read the `cart.ts` tests.', 'Fix totals', 'Round to cents.', undefined, 'Fix totals', 'Round to cents.']);
	});

	test('a "Plan:" or "Plan -" prefix is dropped from the title, so the file name and the Build text do not repeat it', () => {
		const titles = ['# Plan: add clearCart(cart) to cart.ts', '## plan - Fix totals', 'PLAN:Fix totals', '# Plan', '# Plan:', '# Planner fixes', '# Plan-based routing'].map(heading => parsePlanArtifact(`${heading}\n\n1. Do it`)?.title);
		assert.deepStrictEqual(titles, ['add clearCart(cart) to cart.ts', 'Fix totals', 'Fix totals', 'Plan', 'Plan:', 'Planner fixes', 'Plan-based routing']);
	});

	test('details come first and stay out of the steps; the steps are the to-do list (issue 317)', () => {
		const plan = parsePlanArtifact([
			'# Restructure textstats',
			'',
			'A restructure is worth doing only where it fixes something real:',
			'',
			'- `report.js` reaches into both counters itself.',
			'- Every test imports from `src/index.js`.',
			'',
			'## Approach',
			'',
			'Add one place that computes the stats.',
			'',
			'## To-dos',
			'',
			'1. Start on a branch',
			'2. Add `src/stats.js`',
			'',
			'Want me to go ahead?',
		].join('\n'));
		const unheaded = parsePlanArtifact(['# T', '', '- a finding', '- another', '', '1. Do it', '2. Test it'].join('\n'));
		assert.deepStrictEqual({
			title: plan?.title,
			summary: plan?.summary,
			details: plan?.details?.split('\n'),
			steps: plan?.steps.map(step => step.title),
			unheaded: [unheaded?.details, unheaded?.steps.map(step => step.title)],
			build: plan && buildPlanPrompt(plan, '').split('\n').slice(2, 14),
		}, {
			title: 'Restructure textstats',
			summary: 'A restructure is worth doing only where it fixes something real: report.js reaches into both counters itself. Every test imports from src/index.js. Add one place that computes the stats.',
			details: [
				'A restructure is worth doing only where it fixes something real:',
				'',
				'- `report.js` reaches into both counters itself.',
				'- Every test imports from `src/index.js`.',
				'',
				'## Approach',
				'',
				'Add one place that computes the stats.',
			],
			steps: ['Start on a branch', 'Add src/stats.js'],
			unheaded: ['- a finding\n- another', ['Do it', 'Test it']],
			build: [
				'Plan: Restructure textstats',
				'A restructure is worth doing only where it fixes something real:',
				'',
				'- `report.js` reaches into both counters itself.',
				'- Every test imports from `src/index.js`.',
				'',
				'## Approach',
				'',
				'Add one place that computes the stats.',
				'',
				'1. Start on a branch',
				'2. Add src/stats.js',
			],
		});
	});

	test('sections after the to-do list stay in the details, the plan file and the Build text', () => {
		const plan = parsePlanArtifact([
			'# Clear the cart',
			'',
			'Add a clear method.',
			'',
			'## To-dos',
			'',
			'1. Add `clear()` to `src/cart.ts`',
			'2. Call it on logout',
			'',
			'Want me to go ahead?',
			'',
			'## Verification',
			'',
			'- run `npm test`',
			'```',
			'# not a heading',
			'```',
		].join('\n'));
		const document = plan && parsePlanDocument(planToMarkdown(plan, ''));
		assert.deepStrictEqual({
			details: plan?.details?.split('\n'),
			steps: plan?.steps.map(step => step.title),
			build: plan && buildPlanPrompt(plan, '').split('\n').slice(3, 9),
			file: [document?.before.split('\n'), document?.todos.map(todo => todo.text)],
		}, {
			details: ['Add a clear method.', '', '## Verification', '', '- run `npm test`', '```', '# not a heading', '```'],
			steps: ['Add clear() to src/cart.ts', 'Call it on logout'],
			build: ['Add a clear method.', '', '## Verification', '', '- run `npm test`', '```'],
			file: [['Add a clear method.', '', '## Verification', '', '- run `npm test`', '```', '# not a heading', '```'], ['Add clear() to src/cart.ts', 'Call it on logout']],
		});
	});

	test('an indented sub-bullet stays in its step, an exact To-dos heading beats "Test steps", and a Notes list is never the steps', () => {
		const nested = (indent: string) => parsePlanArtifact(`## To-dos\n1. Do A\n${indent}- detail a\n2. Do B\n3. Do C`)?.steps.map(step => [step.title, step.detail]);
		const headed = parsePlanArtifact('# Add caching\n\nWe cache.\n\n### Test steps\n- Open the cart\n- Apply a code\n\n## To-dos\n1. Add the cache\n2. Wire it up');
		const mainEra = parsePlanArtifact('# Plan\n\nSummary here.\n\n1. Step one\n2. Step two\n\n## Notes\n\n1. use redis\n2. keep it small');
		const steps = [['Do A', 'detail a'], ['Do B', undefined], ['Do C', undefined]];
		assert.deepStrictEqual({
			tab: nested('\t'),
			space: nested(' '),
			headed: [headed?.details, headed?.steps.map(step => step.title)],
			mainEra: mainEra?.steps.map(step => step.title),
		}, {
			tab: steps,
			space: steps,
			headed: ['We cache.\n\n### Test steps\n- Open the cart\n- Apply a code', ['Add the cache', 'Wire it up']],
			mainEra: ['Step one', 'Step two'],
		});
	});

	test('a plain answer with no list is not a plan', () => {
		assert.strictEqual(parsePlanArtifact('The handler returns early.'), undefined);
	});

	test('Build text carries the steps and the user notes', () => {
		const plan = parsePlanArtifact(answer);
		assert.ok(plan);
		const text = buildPlanPrompt(plan, '  keep the public API  ');
		assert.ok(text.includes('Plan: Add coupon expiry handling'));
		assert.ok(text.includes('1. Add expiresAt check to src/coupon.ts'));
		assert.ok(text.includes('Files: src/coupon.ts'));
		assert.ok(text.endsWith('Notes from the user:\nkeep the public API'));
		assert.strictEqual(buildPlanPrompt(plan, '   ').includes('Notes from the user'), false);
	});
});
