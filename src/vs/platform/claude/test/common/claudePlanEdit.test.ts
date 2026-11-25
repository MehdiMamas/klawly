/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { buildPlanPrompt, parsePlanArtifact, PlanArtifact } from '../../common/claudePlan.js';
import { acceptEditedPlan, isPlanEdited, movePlanStep, planDetailSource, planToMarkdown, renamePlanStep } from '../../common/claudePlanEdit.js';

function samplePlan(): PlanArtifact {
	return {
		title: 'Add coupon expiry',
		summary: 'Reject expired coupons.',
		steps: [
			{ id: 'step-1', title: 'Check expiresAt', files: ['src/coupon.ts'], status: 'pending' },
			{ id: 'step-2', title: 'Return CouponExpired', detail: 'Map to HTTP 410', status: 'pending' },
			{ id: 'step-3', title: 'Add tests', status: 'done' },
		],
	};
}

suite('Claude plan edits', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('renaming a step trims it, ignores a blank title and leaves the original alone', () => {
		const plan = samplePlan();
		const renamed = renamePlanStep(plan, 'step-2', '  Return a typed\nCouponExpired error ');
		assert.deepStrictEqual(renamed.steps.map(step => step.title), ['Check expiresAt', 'Return a typed CouponExpired error', 'Add tests']);
		assert.strictEqual(renamed.steps[1].detail, 'Map to HTTP 410');
		assert.strictEqual(plan.steps[1].title, 'Return CouponExpired');
		assert.strictEqual(renamePlanStep(plan, 'step-2', '   '), plan);
		assert.strictEqual(renamePlanStep(plan, 'step-9', 'x'), plan);
		assert.strictEqual(renamePlanStep(plan, 'step-1', 'Check expiresAt'), plan);
	});

	test('moving a step swaps it with its neighbour and stops at either edge', () => {
		const plan = samplePlan();
		const down = movePlanStep(plan, 'step-1', 1);
		assert.deepStrictEqual(down.steps.map(step => step.id), ['step-2', 'step-1', 'step-3']);
		const up = movePlanStep(down, 'step-3', -1);
		assert.deepStrictEqual(up.steps.map(step => step.id), ['step-2', 'step-3', 'step-1']);
		assert.strictEqual(movePlanStep(plan, 'step-1', -1), plan);
		assert.strictEqual(movePlanStep(plan, 'step-3', 1), plan);
		assert.strictEqual(movePlanStep(plan, 'step-9', 1), plan);
		assert.deepStrictEqual(plan.steps.map(step => step.id), ['step-1', 'step-2', 'step-3']);
	});

	test('an accepted edit keeps only order and titles, and anything else is refused', () => {
		const plan = samplePlan();
		assert.strictEqual(isPlanEdited(plan, plan), false);
		const edited = renamePlanStep(movePlanStep(plan, 'step-3', -1), 'step-1', 'Check expiry date');
		assert.strictEqual(isPlanEdited(plan, edited), true);
		const tampered: PlanArtifact = { ...edited, title: 'Other', steps: edited.steps.map(step => ({ ...step, status: 'done', files: ['secret.txt'] })) };
		const accepted = acceptEditedPlan(plan, tampered);
		assert.deepStrictEqual(accepted, {
			title: 'Add coupon expiry',
			summary: 'Reject expired coupons.',
			steps: [
				{ id: 'step-1', title: 'Check expiry date', files: ['src/coupon.ts'], status: 'pending' },
				{ id: 'step-3', title: 'Add tests', status: 'done' },
				{ id: 'step-2', title: 'Return CouponExpired', detail: 'Map to HTTP 410', status: 'pending' },
			],
		});

		const dropped = { ...plan, steps: plan.steps.slice(1) };
		const added = { ...plan, steps: [...plan.steps, { id: 'step-4', title: 'Deploy', status: 'pending' as const }] };
		const duplicated = { ...plan, steps: [plan.steps[0], plan.steps[0], plan.steps[2]] };
		const blank = { ...plan, steps: plan.steps.map(step => step.id === 'step-2' ? { ...step, title: '  ' } : step) };
		assert.deepStrictEqual([dropped, added, duplicated, blank].map(candidate => acceptEditedPlan(plan, candidate)), [undefined, undefined, undefined, undefined]);
	});

	test('the Markdown file lists the steps in order with detail, files and notes', () => {
		const plan = movePlanStep(samplePlan(), 'step-3', -1);
		assert.strictEqual(planToMarkdown(plan, '  keep the API  '), [
			'# Add coupon expiry',
			'',
			'Reject expired coupons.',
			'',
			'## To-dos',
			'',
			'1. Check expiresAt',
			'   Files: `src/coupon.ts`',
			'2. [x] Add tests',
			'3. Return CouponExpired',
			'   Map to HTTP 410',
			'',
			'## Notes',
			'',
			'keep the API',
			'',
		].join('\n'));
		assert.strictEqual(planToMarkdown({ title: 'T', summary: '', steps: [{ id: 'a', title: 'One', status: 'pending' }] }, ' '), '# T\n\n## To-dos\n\n1. One\n');
	});

	test('with the source Markdown, step titles keep their bold and code', () => {
		const plan = { title: 'T', summary: '', steps: [{ id: 'a', title: 'Add remove(id)', status: 'pending' as const }, { id: 'b', title: 'Renamed', status: 'done' as const }] };
		assert.strictEqual(planToMarkdown(plan, '', '1. **Add** `remove(id)`\n2. Original'), '# T\n\n## To-dos\n\n1. **Add** `remove(id)`\n2. [x] Renamed\n');
	});

	test('the Build prompt says when the user edited the plan', () => {
		const plan = samplePlan();
		assert.strictEqual(buildPlanPrompt(plan, '').includes('The user edited'), false);
		const edited = buildPlanPrompt(movePlanStep(plan, 'step-3', -1), '', true);
		assert.ok(edited.includes('The user edited or reordered the steps of your plan. Follow this version.'));
		assert.ok(edited.includes('2. Add tests\n3. Return CouponExpired'));
	});

	test('the detail of a step keeps its code and leaves out the files the chips show', () => {
		const markdown = ['1. Add a `Discount` type', '   A `Discount` has a **code**.', '', '   Files: `cartTypes.ts`, `discounts.ts`', '2. Look codes up', '   `cartService.ts`', '3. Test', '4. Round', '   Round to cents. `cartService.ts` `cart.test.ts`', '5. Update', '   Update `cartService.ts`'].join('\n');
		assert.deepStrictEqual(['Add a Discount type', 'Look codes up', 'Test', 'Round', 'Update', 'Renamed'].map(title => planDetailSource(markdown, title)), ['A `Discount` has a **code**.', '', '', 'Round to cents.', 'Update `cartService.ts`', undefined]);
	});

	test('Depends lines leave the detail, follow a moved step, and come back in the plan file (issue 495)', () => {
		const plan = parsePlanArtifact(['# Dark mode', '', '1. Add the theme tokens', '2. Style the settings page', '   Use the tokens.', '   Depends: 1', '3. Screenshot it', '   Depends on 1 and 2'].join('\n'))!;
		const moved = movePlanStep(plan, 'step-2', 1);
		assert.deepStrictEqual({
			steps: plan.steps.map(step => [step.title, step.detail, step.depends]),
			moved: moved.steps.map(step => [step.title, step.depends]),
			markdown: planToMarkdown(moved, '').split('\n').slice(4, -1),
		}, {
			steps: [['Add the theme tokens', undefined, undefined], ['Style the settings page', 'Use the tokens.', [1]], ['Screenshot it', undefined, [1, 2]]],
			moved: [['Add the theme tokens', undefined], ['Screenshot it', [1]], ['Style the settings page', [1]]],
			markdown: ['1. Add the theme tokens', '2. Screenshot it', '   Depends: 1', '3. Style the settings page', '   Use the tokens.', '   Depends: 1'],
		});
	});
});
