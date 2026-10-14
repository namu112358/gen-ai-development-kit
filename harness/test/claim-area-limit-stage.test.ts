// Issue #658：計画と批評の段階の着手宣言では、領域の上限（同時の Draft PR の数）を見ない。
// checksAreaLimit が、--stage plan・plan-critique では上限を見ず、implement（と段階なし）では今までどおり見ること、
// --force・--fleet（skipAreaLimit）と --manual でない宣言では見ないことを確かめる。
// 末尾に、claimOptions が --fleet・--force では領域の上限だけを飛ばし、引き継ぎは --takeover だけであること（元 claim-fleet-flag.test.ts、Issue #399）も確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClaimStage } from '../lib/queue.ts';

/** commands/claim.ts は cli.ts を通して harness.config.json を読むので、ほかのテストを巻き込まないよう使うときだけ読み込む */
const loadClaim = () => import('../scripts/agent/commands/claim.ts');

const CASES: { manual: boolean; skipAreaLimit: boolean; stage: ClaimStage | undefined; want: boolean }[] = [
  { manual: true, skipAreaLimit: false, stage: 'plan', want: false },
  { manual: true, skipAreaLimit: false, stage: 'plan-critique', want: false },
  { manual: true, skipAreaLimit: false, stage: 'implement', want: true },
  { manual: true, skipAreaLimit: false, stage: undefined, want: true },
  { manual: true, skipAreaLimit: true, stage: 'implement', want: false },
  { manual: false, skipAreaLimit: false, stage: 'implement', want: false },
];

test('checksAreaLimit：plan・plan-critique は領域の上限を見ず、implement と段階なしは見る', async () => {
  const { checksAreaLimit } = await loadClaim();
  for (const { manual, skipAreaLimit, stage, want } of CASES) {
    assert.equal(checksAreaLimit(manual, skipAreaLimit, stage), want, `manual=${manual} skipAreaLimit=${skipAreaLimit} stage=${stage}`);
  }
});

const FLAG_CASES: { args: string[]; want: { manual: boolean; skipAreaLimit: boolean; takeover: boolean } }[] = [
  { args: ['399', '--manual', '--fleet'], want: { manual: true, skipAreaLimit: true, takeover: false } },
  { args: ['399', '--manual', '--force'], want: { manual: true, skipAreaLimit: true, takeover: false } },
  { args: ['399', '--manual'], want: { manual: true, skipAreaLimit: false, takeover: false } },
  { args: ['399', '--manual', '--fleet', '--takeover'], want: { manual: true, skipAreaLimit: true, takeover: true } },
];

test('claimOptions：--fleet・--force は領域の上限だけを飛ばし、引き継ぎは --takeover だけ', async () => {
  const { claimOptions } = await loadClaim();
  for (const { args, want } of FLAG_CASES) {
    assert.deepEqual(claimOptions(args), want, args.join(' '));
  }
});
