/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Fixture name the developer command passes to `begin()`. The live runner ignores it. */
export const CLAUDE_TEST_SESSION_FIXTURE = 'test-session';

const CLAUDE_TEST_SESSION_SCRIPT = [
	'{"type":"session.started","sessionId":"$session","model":"fixture-sonnet"}',
	'{"type":"tool.started","sessionId":"$session","call":{"id":"call-1","name":"Read","category":"read","input":{"path":"README.md"},"display":{"label":"Read README.md","file":"README.md"}}}',
	'{"type":"assistant.delta","sessionId":"$session","text":"ok"}',
	'{"type":"assistant.completed","sessionId":"$session","text":"ok"}',
	'{"type":"session.completed","sessionId":"$session"}',
].join('\n');

/**
 * Default composer script. `FakeClaudeRuntimeService.begin()` and `send()` use
 * this name when the caller does not pass a fixture. Same lines as
 * `test/claude/fixtures/plain-answer.jsonl`.
 */
const CLAUDE_PLAIN_ANSWER_SCRIPT = [
	'{"type":"session.started","sessionId":"$session","model":"fixture-sonnet"}',
	'{"type":"thinking.delta","sessionId":"$session","text":"","at":1000}',
	'{"type":"thinking.delta","sessionId":"$session","text":"The early return sits above the guard, so the guard never runs for empty input.","at":1400}',
	'{"type":"thinking.delta","sessionId":"$session","text":"","at":4200,"done":true}',
	'{"type":"assistant.delta","sessionId":"$session","text":"The handler returns early. "}',
	'{"type":"assistant.delta","sessionId":"$session","text":"That skips the check."}',
	'{"type":"assistant.completed","sessionId":"$session","text":"The handler returns early. That skips the check."}',
	'{"type":"session.completed","sessionId":"$session"}',
].join('\n');

/** Scripts the shared-process fake runtime ships. The live runner ignores them. */
export function claudeTestSessionFixtures(): ReadonlyMap<string, string> {
	return new Map([
		[CLAUDE_TEST_SESSION_FIXTURE, CLAUDE_TEST_SESSION_SCRIPT],
		['plain-answer', CLAUDE_PLAIN_ANSWER_SCRIPT],
	]);
}
