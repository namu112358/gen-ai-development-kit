// Issue #399：claim の --fleet は、fleet が領域の上限で宣言し直すときに上限だけを飛ばす（--force を使わずに済む）。
// claimOptions が引数から manual・skipAreaLimit・takeover を読むこと（--fleet と --force は上限を飛ばすだけで引き継ぎにならない。引き継ぎは --takeover だけ）を確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';

/** commands/claim.ts は cli.ts を通して harness.config.json を読むので、ほかのテストを巻き込まないよう使うときだけ読み込む */
const loadClaim = () => import('../scripts/agent/commands/claim.ts');

const CASES: { args: string[]; want: { manual: boolean; skipAreaLimit: boolean; takeover: boolean } }[] = [
  { args: ['399', '--manual', '--fleet'], want: { manual: true, skipAreaLimit: true, takeover: false } },
  { args: ['399', '--manual', '--force'], want: { manual: true, skipAreaLimit: true, takeover: false } },
  { args: ['399', '--manual'], want: { manual: true, skipAreaLimit: false, takeover: false } },
  { args: ['399', '--manual', '--fleet', '--takeover'], want: { manual: true, skipAreaLimit: true, takeover: true } },
];

test('claimOptions：--fleet・--force は領域の上限だけを飛ばし、引き継ぎは --takeover だけ', async () => {
  const { claimOptions } = await loadClaim();
  for (const { args, want } of CASES) {
    assert.deepEqual(claimOptions(args), want, args.join(' '));
  }
});
