// Issue #833：セッションの前提の確かめ（session-doctor）が、git の名義・Orca の CLI・main の古さ・gh の認証の欠けごとに1行を出し、そろえば何も出さないことを確かめる（依存は差し替え、本物の gh・git・ls-remote を呼ばない）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionDoctor, sessionDoctorDisabled, type SessionDoctorDeps } from '../scripts/session-doctor.ts';

const LOCAL = 'a'.repeat(40);
const ORIGIN = 'b'.repeat(40);
const CLI = 'my-orca-cli-xyz';
const BIN = '/fake/bin';

type GitReply = { status: number | null; stdout: string };
type Over = {
  git?: Record<string, GitReply>;
  env?: Record<string, string | undefined>;
  lsRemote?: () => Promise<string | null>;
  gh?: () => Promise<number | null>;
  orcaFound?: boolean;
  totalTimeoutMs?: number;
};

/** 全部そろった状態の依存。over で1つずつ崩す。呼ばれた回数を calls に数える */
function deps(over: Over = {}) {
  const calls = { git: 0, lsRemote: 0, gh: 0, isExecutable: 0 };
  const git: Record<string, GitReply> = {
    'config --get user.name': { status: 0, stdout: 'Someone\n' },
    'config --get user.email': { status: 0, stdout: 'someone@example.com\n' },
    'rev-parse --verify --quiet refs/heads/main': { status: 0, stdout: `${LOCAL}\n` },
    [`cat-file -e ${ORIGIN}^{commit}`]: { status: 0, stdout: '' },
    [`merge-base --is-ancestor ${ORIGIN} ${LOCAL}`]: { status: 0, stdout: '' },
    ...over.git,
  };
  const d: SessionDoctorDeps = {
    platform: 'linux',
    env: over.env ?? { AGENT_HARNESS_SESSION_DOCTOR: '1', ORCA_CLI_COMMAND: CLI, PATH: BIN },
    gitSync: (args) => {
      calls.git++;
      return git[args.join(' ')] ?? { status: 1, stdout: '' };
    },
    lsRemoteMain: () => {
      calls.lsRemote++;
      return over.lsRemote ? over.lsRemote() : Promise.resolve(LOCAL);
    },
    ghAuthStatus: () => {
      calls.gh++;
      return over.gh ? over.gh() : Promise.resolve(0);
    },
    isExecutable: (path) => {
      calls.isExecutable++;
      return (over.orcaFound ?? true) && path === `${BIN}/${CLI}`;
    },
    totalTimeoutMs: over.totalTimeoutMs ?? 5_000,
  };
  return { d, calls };
}

test('sessionDoctor：前提が全部そろえば何も出さない', async () => {
  assert.deepEqual(await sessionDoctor({}, deps().d), []);
});

test('sessionDoctor：git の名義（user.name・user.email）が空・失敗のときだけ git の1行（値は出さない）', async () => {
  const cases: [string, Record<string, GitReply>][] = [
    ['user.name が失敗', { 'config --get user.name': { status: 1, stdout: '' } }],
    ['user.email が失敗', { 'config --get user.email': { status: 1, stdout: '' } }],
    ['user.name が空', { 'config --get user.name': { status: 0, stdout: '\n' } }],
    ['user.email が空', { 'config --get user.email': { status: 0, stdout: '' } }],
  ];
  for (const [name, git] of cases) {
    const lines = await sessionDoctor({}, deps({ git }).d);
    assert.equal(lines.length, 1, name);
    assert.match(lines[0]!, /git/, name);
    assert.ok(!lines[0]!.includes('Someone') && !lines[0]!.includes('someone@example.com'), name);
  }
});

test('sessionDoctor：Orca の CLI が見つからないときだけ Orca の1行（CLI の名前は入れない）。orcaNoticeShown が真なら出さない', async () => {
  const lines = await sessionDoctor({}, deps({ orcaFound: false }).d);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /Orca/);
  assert.ok(!lines[0]!.includes(CLI), 'ORCA_CLI_COMMAND の値を行に入れない');

  assert.deepEqual(await sessionDoctor({ orcaNoticeShown: true }, deps({ orcaFound: false }).d), []);
});

test('sessionDoctor：環境変数の読み取りが例外を投げると Orca の CLI を決められない1行を出す', async () => {
  const env = new Proxy({} as Record<string, string | undefined>, {
    get(_t, key) {
      if (key === 'AGENT_HARNESS_SESSION_DOCTOR') return '1';
      if (key === 'NODE_TEST_CONTEXT') return undefined;
      throw new Error(`env を読めません: ${String(key)}`);
    },
  });
  const lines = await sessionDoctor({}, deps({ env }).d);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /Orca/);
});

test('sessionDoctor：手元の main が origin より古いときだけ main の1行（SHA は入れない）。古くない・決められないときは出さない', async () => {
  const stale: [string, Record<string, GitReply>][] = [
    ['origin の SHA が手元に無い', { [`cat-file -e ${ORIGIN}^{commit}`]: { status: 1, stdout: '' } }],
    ['origin の SHA が手元の祖先でない', { [`merge-base --is-ancestor ${ORIGIN} ${LOCAL}`]: { status: 1, stdout: '' } }],
  ];
  for (const [name, git] of stale) {
    const lines = await sessionDoctor({}, deps({ git, lsRemote: async () => ORIGIN }).d);
    assert.equal(lines.length, 1, name);
    assert.match(lines[0]!, /main/, name);
    assert.ok(!lines[0]!.includes(LOCAL) && !lines[0]!.includes(ORIGIN), `${name}：SHA を行に入れない`);
    assert.ok(!lines[0]!.includes(LOCAL.slice(0, 7)) && !lines[0]!.includes(ORIGIN.slice(0, 7)), `${name}：短い SHA も入れない`);
  }

  const silent: [string, Over][] = [
    ['ls-remote が失敗（null）', { lsRemote: async () => null }],
    ['同じ SHA', { lsRemote: async () => LOCAL }],
    ['手元が先に進んでいる（origin が祖先）', { lsRemote: async () => ORIGIN }],
    ['手元に main が無い', { lsRemote: async () => ORIGIN, git: { 'rev-parse --verify --quiet refs/heads/main': { status: 1, stdout: '' } } }],
    ['merge-base が 0・1 以外', { lsRemote: async () => ORIGIN, git: { [`merge-base --is-ancestor ${ORIGIN} ${LOCAL}`]: { status: 128, stdout: '' } } }],
  ];
  for (const [name, over] of silent) {
    assert.deepEqual(await sessionDoctor({}, deps(over).d), [], name);
  }
});

test('sessionDoctor：gh の認証が無い（終了コード 1）ときだけ gh の1行。起動できない（null）なら出さない', async () => {
  const lines = await sessionDoctor({}, deps({ gh: async () => 1 }).d);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /gh/);

  assert.deepEqual(await sessionDoctor({}, deps({ gh: async () => null }).d), []);
});

test('sessionDoctorDisabled：=0、または NODE_TEST_CONTEXT があって =1 が無いときは真。env の読み取りが投げたら偽', () => {
  const cases: [Record<string, string | undefined>, boolean][] = [
    [{ AGENT_HARNESS_SESSION_DOCTOR: '0' }, true],
    [{ AGENT_HARNESS_SESSION_DOCTOR: '0', NODE_TEST_CONTEXT: 'child-v8' }, true],
    [{ NODE_TEST_CONTEXT: 'child-v8' }, true],
    [{ NODE_TEST_CONTEXT: 'child-v8', AGENT_HARNESS_SESSION_DOCTOR: '' }, true],
    [{ NODE_TEST_CONTEXT: 'child-v8', AGENT_HARNESS_SESSION_DOCTOR: '1' }, false],
    [{}, false],
    [{ AGENT_HARNESS_SESSION_DOCTOR: '1' }, false],
  ];
  for (const [env, want] of cases) assert.equal(sessionDoctorDisabled(env), want, JSON.stringify(env));

  const throwing = new Proxy({} as Record<string, string | undefined>, {
    get() {
      throw new Error('env を読めません');
    },
  });
  assert.equal(sessionDoctorDisabled(throwing), false);
});

test('sessionDoctor：止められているときは依存を1回も呼ばずに空を返す', async () => {
  const envs: Record<string, string | undefined>[] = [
    { AGENT_HARNESS_SESSION_DOCTOR: '0', ORCA_CLI_COMMAND: CLI, PATH: BIN },
    { NODE_TEST_CONTEXT: 'child-v8', ORCA_CLI_COMMAND: CLI, PATH: BIN },
  ];
  for (const env of envs) {
    // 崩した依存でも何も出さず、何も呼ばない
    const { d, calls } = deps({ env, orcaFound: false, gh: async () => 1, git: { 'config --get user.name': { status: 1, stdout: '' } } });
    assert.deepEqual(await sessionDoctor({}, d), [], JSON.stringify(env));
    assert.deepEqual(calls, { git: 0, lsRemote: 0, gh: 0, isExecutable: 0 }, JSON.stringify(env));
  }
});

test('sessionDoctor：ls-remote が返らなくても全体の上限で終わり、終わった gh の行だけを出す', { timeout: 5_000 }, async () => {
  const started = Date.now();
  const lines = await sessionDoctor({}, deps({ lsRemote: () => new Promise<string | null>(() => {}), gh: async () => 1, totalTimeoutMs: 50 }).d);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /gh/);
  assert.ok(Date.now() - started < 2_000, '上限（50ms）の近くで終わる');
});
