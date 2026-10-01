// Issue #186：作業の中で起きた出来事（deny・人に返した・App に拒まれた・人の訂正・回避策）の控え（harness/lib/incident.ts）と
// `agent.ts incident`（add・list・sessions・render-issue・render-comment）を確かめる。記録は種類ごとにまとまり、
// Issue の下書きは Issue Form の形で読め、見出しを増やさず、秘密に見える文字列を記録のファイルにも出力にも残さない。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { claudeMark, extractBlock } from '../lib/blocks.ts';
import {
  INCIDENT_KINDS,
  appendIncident,
  groupByKind,
  incidentDir,
  incidentFile,
  listSessions,
  maskSecrets,
  readIncidents,
  renderIncidentComment,
  renderIssueDraft,
} from '../lib/incident.ts';
import { parseIssueBody } from '../lib/issue-form.ts';

const root = realpathSync(join(import.meta.dirname, '..', '..'));
const agentPath = join(root, 'harness', 'scripts', 'agent.ts');

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
/** 記録の置き場所にする一時ディレクトリ（まだ作らない下のディレクトリを返し、作るのは実装に任せる） */
function tempIncidentDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'incident-'));
  tmpDirs.push(d);
  return join(d, 'incidents');
}

/** 子プロセスの env：実行環境の AGENT_HARNESS_SESSION・AGENT_HARNESS_INCIDENT_DIR に頼らない */
function runAgent(args: string[], envPatch: Record<string, string | undefined> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_REPOSITORY: 'owner/repo' };
  delete env.AGENT_HARNESS_SESSION;
  delete env.AGENT_HARNESS_INCIDENT_DIR;
  for (const [k, v] of Object.entries(envPatch)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return spawnSync(process.execPath, [agentPath, ...args], { cwd: root, encoding: 'utf8', env });
}

/** `incident add` を動かし、終了コード 0 と標準出力が id の数字だけであることを確かめて id を返す */
function add(dir: string, session: string, fields: string[]): number {
  const r = runAgent(['incident', 'add', ...fields, '--session', session], { AGENT_HARNESS_INCIDENT_DIR: dir });
  assert.equal(r.status, 0, `incident add ${fields.join(' ')}: ${r.stderr}`);
  assert.match(r.stdout.trim(), /^\d+$/, `id の数字だけを出す：${r.stdout}`);
  return Number(r.stdout.trim());
}

// 秘密に見える値。リポジトリに秘密そのものの形で書かないよう、つないで作る
const GHP = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const PAT = 'github_pat_' + '11ABCDEFG0' + '123456789_abcdefghijklmnopqrstuvwxyzABCDEFGH';
const ANT = 'sk-ant-' + 'api03-' + 'zYxWvUtSrQpOnMlKjIhGfEdCbA0987654321';
const BEARER_VALUE = 'eyJhbGciOi' + 'JIUzI1NiJ9abc';
const TOKEN_VALUE = 's3cr3t' + 'TokenValue99';
const SECRETS = [GHP, PAT, ANT, BEARER_VALUE, TOKEN_VALUE];

function assertNoSecrets(where: string, text: string): void {
  for (const s of SECRETS) assert.ok(!text.includes(s), `${where} に秘密の値（${s.slice(0, 8)}…）が残っています`);
}

const TITLE = 'feat(harness): 出来事から改善の Issue を作る';

// ---- 記録と一覧 ----

test('incident add を種類を混ぜて動かすと、id が 1 から振られ、list --json は種類の順で種類ごとにまとまる', () => {
  const dir = tempIncidentDir();
  const ids = [
    add(dir, 's1', ['--kind', 'workaround', '--what', 'gh が無いので REST を使った', '--workaround', 'curl で読んだ']),
    add(dir, 's1', ['--kind', 'deny', '--what', 'git push が拒まれた', '--target', '#12']),
    add(dir, 's1', ['--kind', 'deny', '--what', 'rm が拒まれた']),
    add(dir, 's1', ['--kind', 'app-reject', '--what', '計画ゲートで止まった', '--target', 'PR #34']),
  ];
  assert.deepEqual(ids, [1, 2, 3, 4]);

  const r = runAgent(['incident', 'list', '--session', 's1', '--json'], { AGENT_HARNESS_INCIDENT_DIR: dir });
  assert.equal(r.status, 0, r.stderr);
  const grouped = JSON.parse(r.stdout) as Record<string, { id: number; kind: string; what: string; target?: string; session: string }[]>;
  assert.deepEqual(Object.keys(grouped), ['deny', 'app-reject', 'workaround'], '種類は INCIDENT_KINDS の順で、項目のある種類だけ');
  assert.deepEqual(grouped.deny!.map((i) => i.id), [2, 3]);
  assert.equal(grouped.deny![0]!.target, '#12');
  assert.equal(grouped['app-reject']![0]!.target, 'PR #34');
  assert.equal(grouped.workaround![0]!.what, 'gh が無いので REST を使った');
  for (const [kind, items] of Object.entries(grouped)) {
    for (const i of items) {
      assert.equal(i.session, 's1', '各項目に session のフィールドがある');
      assert.equal(i.kind, kind, '項目はその種類のキーの下にある');
    }
  }
});

test('incident list（--json 無し）は種類ごとの「## 」の見出し（種類の名前を含む）の下に「- [<session>:<id>]」の行を出す', () => {
  const dir = tempIncidentDir();
  add(dir, 's1', ['--kind', 'human-correction', '--what', '人がブランチ名を直した']);
  add(dir, 's1', ['--kind', 'deny', '--what', 'push が拒まれた']);
  const r = runAgent(['incident', 'list', '--session', 's1'], { AGENT_HARNESS_INCIDENT_DIR: dir });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split(/\r?\n/);
  // 見出しは「## 」で始まり種類の名前を含む（日本語の名前を添えてもよい）
  const headingOf = (kind: string): number => lines.findIndex((l) => l.startsWith('## ') && l.includes(kind));
  const denyAt = headingOf('deny');
  const corrAt = headingOf('human-correction');
  assert.ok(denyAt >= 0 && corrAt >= 0, `種類の見出しがありません：${r.stdout}`);
  assert.ok(denyAt < corrAt, '見出しは INCIDENT_KINDS の順');
  assert.equal(headingOf('workaround'), -1, '項目の無い種類の見出しは出さない');
  const denyLine = lines.slice(denyAt + 1, corrAt).find((l) => l.startsWith('- [s1:2]'));
  assert.ok(denyLine?.includes('push が拒まれた'), `deny の見出しの下に [s1:2] の行がありません：${r.stdout}`);
  assert.ok(lines.slice(corrAt + 1).some((l) => l.startsWith('- [s1:1]') && l.includes('人がブランチ名を直した')));
});

test('--session を2つ渡すと、両方のセッションの記録を合わせて出す', () => {
  const dir = tempIncidentDir();
  add(dir, 's1', ['--kind', 'deny', '--what', 's1 の deny']);
  add(dir, 's2', ['--kind', 'deny', '--what', 's2 の deny']);
  add(dir, 's2', ['--kind', 'return-to-human', '--what', 's2 で人に返した']);
  const r = runAgent(['incident', 'list', '--session', 's1', '--session', 's2', '--json'], { AGENT_HARNESS_INCIDENT_DIR: dir });
  assert.equal(r.status, 0, r.stderr);
  const grouped = JSON.parse(r.stdout) as Record<string, { id: number; what: string; session: string }[]>;
  assert.deepEqual(grouped.deny!.map((i) => `${i.session}:${i.id}`).sort(), ['s1:1', 's2:1']);
  assert.deepEqual(grouped['return-to-human']!.map((i) => `${i.session}:${i.id}`), ['s2:2']);

  const text = runAgent(['incident', 'list', '--session', 's1', '--session', 's2'], { AGENT_HARNESS_INCIDENT_DIR: dir });
  assert.equal(text.status, 0, text.stderr);
  for (const ref of ['[s1:1]', '[s2:1]', '[s2:2]']) assert.ok(text.stdout.includes(ref), `${ref} がありません：${text.stdout}`);
});

test('--session が無ければ AGENT_HARNESS_SESSION のセッションに記録する', () => {
  const dir = tempIncidentDir();
  const r = runAgent(['incident', 'add', '--kind', 'deny', '--what', 'env のセッション'], { AGENT_HARNESS_INCIDENT_DIR: dir, AGENT_HARNESS_SESSION: 'envsess' });
  assert.equal(r.status, 0, r.stderr);
  const l = runAgent(['incident', 'list', '--json'], { AGENT_HARNESS_INCIDENT_DIR: dir, AGENT_HARNESS_SESSION: 'envsess' });
  assert.equal(l.status, 0, l.stderr);
  const grouped = JSON.parse(l.stdout) as Record<string, { session: string; what: string }[]>;
  assert.equal(grouped.deny![0]!.session, 'envsess');
  assert.equal(grouped.deny![0]!.what, 'env のセッション');
});

test('不正な種類・--what 無し・セッション無しは、終了コード 2 で記録しない', () => {
  const dir = tempIncidentDir();
  const bad = runAgent(['incident', 'add', '--kind', 'no-such-kind', '--what', 'x', '--session', 's1'], { AGENT_HARNESS_INCIDENT_DIR: dir });
  assert.equal(bad.status, 2, bad.stderr);
  const noWhat = runAgent(['incident', 'add', '--kind', 'deny', '--session', 's1'], { AGENT_HARNESS_INCIDENT_DIR: dir });
  assert.equal(noWhat.status, 2, noWhat.stderr);
  const noSession = runAgent(['incident', 'add', '--kind', 'deny', '--what', 'x'], { AGENT_HARNESS_INCIDENT_DIR: dir });
  assert.equal(noSession.status, 2, noSession.stderr);
  assert.ok(noSession.stderr.includes('書式エラー'), noSession.stderr);
  assert.deepEqual(readIncidents('s1', { AGENT_HARNESS_INCIDENT_DIR: dir }), []);
});

test('ファイル名に使えない文字のセッション ID は、CLI が終了コード 2（書式エラー）で、incidentFile が Error で拒む', () => {
  const dir = tempIncidentDir();
  const env = { AGENT_HARNESS_INCIDENT_DIR: dir };
  for (const session of ['../evil', 'a/b', 'a\\b', 'a b', 'x.y']) {
    const r = runAgent(['incident', 'add', '--kind', 'deny', '--what', 'x', '--session', session], env);
    assert.equal(r.status, 2, `${session}: ${r.stderr}`);
    assert.ok(r.stderr.includes('書式エラー'), `${session}: ${r.stderr}`);
    assert.throws(() => incidentFile(session, env), Error, session);
  }
  const bad = runAgent(['incident', 'list', '--session', '../evil'], env);
  assert.equal(bad.status, 2, bad.stderr);
  assert.equal(incidentFile('ok_Session-1', env), join(dir, 'ok_Session-1.jsonl'));
});

test('incident sessions は記録のあるセッション ID を更新の新しい順に1行ずつ出す', () => {
  const dir = tempIncidentDir();
  add(dir, 'older', ['--kind', 'deny', '--what', 'a']);
  add(dir, 'newer', ['--kind', 'deny', '--what', 'b']);
  const t = Date.now() / 1000;
  utimesSync(join(dir, 'older.jsonl'), t - 3600, t - 3600);
  utimesSync(join(dir, 'newer.jsonl'), t, t);
  const r = runAgent(['incident', 'sessions'], { AGENT_HARNESS_INCIDENT_DIR: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split(/\r?\n/).filter((l) => l !== ''), ['newer', 'older']);
  assert.deepEqual(listSessions({ AGENT_HARNESS_INCIDENT_DIR: dir }), ['newer', 'older']);
  assert.deepEqual(listSessions({ AGENT_HARNESS_INCIDENT_DIR: tempIncidentDir() }), [], 'ディレクトリが無ければ []');
});

test('記録のディレクトリは 0700、ファイルは 0600 で作る', { skip: process.platform === 'win32' ? 'Windows では mode を検査しない' : false }, () => {
  const dir = tempIncidentDir();
  add(dir, 's1', ['--kind', 'deny', '--what', 'x']);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 's1.jsonl')).mode & 0o777, 0o600);
});

// ---- Issue の下書き ----

test('render-issue は Issue Form の形の下書きを出し、parseIssueBody で Goal・Background・Requirements・AC などが読める', () => {
  const dir = tempIncidentDir();
  add(dir, 's1', ['--kind', 'deny', '--what', 'git push が拒まれた', '--target', '#12']);
  add(dir, 's1', ['--kind', 'workaround', '--what', 'gh が無い', '--workaround', 'REST で読んだ', '--target', 'PR #34']);
  add(dir, 's2', ['--kind', 'return-to-human', '--what', '人に返した']);
  const r = runAgent(['incident', 'render-issue', '1', '2', 's2:1', '--title', TITLE, '--session', 's1', '--session', 's2'], { AGENT_HARNESS_INCIDENT_DIR: dir });
  assert.equal(r.status, 0, r.stderr);
  const parsed = parseIssueBody(r.stdout);
  assert.ok(parsed.ok, `Issue Form として読めません：${parsed.ok ? '' : parsed.errors.join('、')}`);
  const c = parsed.contract;
  // 必須の項目は人が書く印を置く。任意の項目は印か空（_No response_）
  for (const key of ['goal', 'requirements', 'acceptanceCriteria'] as const) {
    assert.ok(c[key].includes('（人が書く）'), `${key} は「（人が書く）」：${c[key]}`);
  }
  for (const key of ['nonGoals', 'dependencies', 'validation'] as const) {
    assert.ok(c[key] === '' || c[key].includes('（人が書く）'), `${key} は「（人が書く）」か空：${c[key]}`);
  }
  for (const w of ['deny', '#12', 'git push が拒まれた', 'workaround', 'PR #34', 'gh が無い', 'REST で読んだ', 'return-to-human', '人に返した']) {
    assert.ok(c.background.includes(w), `Background に「${w}」がありません：${c.background}`);
  }
});

test('render-issue は、題が Conventional Commits でない・id が見つからない・セッションが無いと終了コード 2', () => {
  const dir = tempIncidentDir();
  add(dir, 's1', ['--kind', 'deny', '--what', 'x']);
  const env = { AGENT_HARNESS_INCIDENT_DIR: dir };
  const badTitle = runAgent(['incident', 'render-issue', '1', '--title', '出来事を直す', '--session', 's1'], env);
  assert.equal(badTitle.status, 2, badTitle.stderr);
  const noTitle = runAgent(['incident', 'render-issue', '1', '--session', 's1'], env);
  assert.equal(noTitle.status, 2, noTitle.stderr);
  const missing = runAgent(['incident', 'render-issue', '9', '--title', TITLE, '--session', 's1'], env);
  assert.equal(missing.status, 2, missing.stderr);
  const missingSession = runAgent(['incident', 'render-issue', 'nosuch:1', '--title', TITLE, '--session', 's1'], env);
  assert.equal(missingSession.status, 2, missingSession.stderr);
  const noSession = runAgent(['incident', 'render-issue', '1', '--title', TITLE], env);
  assert.equal(noSession.status, 2, noSession.stderr);
});

test('what・workaround の行頭の見出し（# 見出し・### Goal、前の空白を含む）は、下書きの見出しを増やさず Background に文として残る', () => {
  const dir = tempIncidentDir();
  const what = ['# 見出しのつもり', '### Goal', '  ## 字下げした見出し', '本文の行'].join('\n');
  const workaround = ['### Acceptance Criteria', '回避した'].join('\n');
  add(dir, 's1', ['--kind', 'workaround', '--what', what, '--workaround', workaround]);
  const r = runAgent(['incident', 'render-issue', '1', '--title', TITLE, '--session', 's1'], { AGENT_HARNESS_INCIDENT_DIR: dir });
  assert.equal(r.status, 0, r.stderr);

  const headingLines = r.stdout.split(/\r?\n/).filter((l) => /^[ \t]*#{1,6}([ \t]|$)/.test(l));
  assert.deepEqual(
    headingLines,
    ['### Goal', '### Background', '### Requirements', '### Non-goals', '### Acceptance Criteria', '### Dependencies', '### Validation Requirements'],
    '見出しは Issue Form の7つだけ',
  );
  const parsed = parseIssueBody(r.stdout);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.errors.join('、'));
  assert.ok(!parsed.contract.goal.includes('見出しのつもり'), 'Goal に記録の文が入り込まない');
  assert.ok(parsed.contract.acceptanceCriteria.includes('（人が書く）'));
  assert.ok(!parsed.contract.acceptanceCriteria.includes('回避した'));
  for (const w of ['見出しのつもり', 'Goal', '字下げした見出し', '本文の行', 'Acceptance Criteria', '回避した']) {
    assert.ok(parsed.contract.background.includes(w), `Background に「${w}」が残っていません：${parsed.contract.background}`);
  }

  // lib を直接呼んでも同じ
  const draft = renderIssueDraft(readIncidents('s1', { AGENT_HARNESS_INCIDENT_DIR: dir }));
  assert.equal(draft.split('\n').filter((l) => /^[ \t]*#{1,6}([ \t]|$)/.test(l)).length, 7);
});

// ---- 秘密を残さない ----

test('秘密に見える値（ghp_・github_pat_・sk-ant-・Bearer・token=）は、記録のファイル・list・下書き・コメントのどれにも残らない', () => {
  const dir = tempIncidentDir();
  const env = { AGENT_HARNESS_INCIDENT_DIR: dir };
  add(dir, 's1', ['--kind', 'deny', '--what', `push で ${GHP} を使った`, '--target', '#5']);
  add(dir, 's1', ['--kind', 'workaround', '--what', `PAT ${PAT} を渡した`, '--workaround', `Authorization: Bearer ${BEARER_VALUE} を付けた`]);
  add(dir, 's1', ['--kind', 'app-reject', '--what', `鍵 ${ANT} と token=${TOKEN_VALUE} が出た`]);

  assertNoSecrets('記録のファイル', readFileSync(join(dir, 's1.jsonl'), 'utf8'));
  const list = runAgent(['incident', 'list', '--session', 's1', '--json'], env);
  assert.equal(list.status, 0, list.stderr);
  assertNoSecrets('list --json', list.stdout);
  assert.ok(list.stdout.includes('***'), '伏せた箇所は *** になる');

  const draft = runAgent(['incident', 'render-issue', '1', '2', '3', '--title', TITLE, '--session', 's1'], env);
  assert.equal(draft.status, 0, draft.stderr);
  assertNoSecrets('render-issue', draft.stdout);
  const parsed = parseIssueBody(draft.stdout);
  assert.ok(parsed.ok);
  assert.ok(parsed.contract.background.includes('push で'), '秘密でない文は残る');

  const comment = runAgent(['incident', 'render-comment', '--session', 's1'], env);
  assert.equal(comment.status, 0, comment.stderr);
  assertNoSecrets('render-comment', comment.stdout);

  // 記録を通さず lib に直接渡しても、出力で伏せる
  const raw = [{ id: 1, at: '2026-10-01T00:00:00.000Z', kind: 'deny' as const, what: `raw ${GHP} token=${TOKEN_VALUE}`, workaround: `Bearer ${BEARER_VALUE}`, source: 'session' as const }];
  assertNoSecrets('renderIssueDraft', renderIssueDraft(raw));
  assertNoSecrets('renderIncidentComment', renderIncidentComment('s1', raw));
});

test('maskSecrets は秘密に見える値を *** に置き換え、ふつうの文は変えない', () => {
  const cases = [
    GHP,
    'gho_' + 'abcdefghijklmnopqrstuvwxyz0123456789',
    PAT,
    ANT,
    'AKIA' + 'IOSFODNN7EXAMPLE',
    '0123456789abcdef' + '0123456789abcdef01234567', // 40 文字の hex
    'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo' + 'wMTIzNDU2Nzg5YWJjZGVm', // 長い base64
  ];
  for (const s of cases) {
    const out = maskSecrets(`前 ${s} 後`);
    assert.ok(!out.includes(s), `${s.slice(0, 8)}… が伏せられていません：${out}`);
    assert.ok(out.includes('***') && out.startsWith('前 ') && out.endsWith(' 後'), out);
  }
  for (const [key, value] of [['token', TOKEN_VALUE], ['password', 'hunter2pass'], ['secret', 'mySecretVal']] as const) {
    const out = maskSecrets(`${key}=${value} のあと`);
    assert.ok(!out.includes(value), `${key}= の値が伏せられていません：${out}`);
  }
  const bearer = maskSecrets(`Authorization: Bearer ${BEARER_VALUE}`);
  assert.ok(!bearer.includes(BEARER_VALUE), bearer);
  const plain = 'git push が拒まれた（#12、PR #34）。sha は abc1234';
  assert.equal(maskSecrets(plain), plain);
});

// ---- コメント ----

test('render-comment は Claude の目印と agent-incident のフェンスを出し、extractBlock で version・session・incidents が読める', () => {
  const dir = tempIncidentDir();
  add(dir, 's1', ['--kind', 'deny', '--what', 'push が拒まれた']);
  add(dir, 's1', ['--kind', 'human-correction', '--what', '人が直した']);
  const r = runAgent(['incident', 'render-comment', '--session', 's1'], { AGENT_HARNESS_INCIDENT_DIR: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('<!-- agent-harness:claude'), `Claude の目印がありません：${r.stdout}`);
  const block = extractBlock(r.stdout, 'agent-incident');
  assert.ok(block.found && block.ok, `agent-incident が読めません：${JSON.stringify(block)}`);
  const value = block.value as { version: number; incidents: { what: string; kind: string }[] };
  assert.equal(value.version, 1);
  assert.deepEqual(value.incidents.map((i) => i.what).sort(), ['push が拒まれた', '人が直した'].sort());

  const items = readIncidents('s1', { AGENT_HARNESS_INCIDENT_DIR: dir });
  const body = renderIncidentComment('s1', items);
  assert.ok(body.startsWith(claudeMark('s1')), '先頭はセッション入りの Claude の目印');
  const libBlock = extractBlock(body, 'agent-incident');
  assert.ok(libBlock.found && libBlock.ok);
  const v = libBlock.value as { version: number; session: string | null; incidents: unknown[] };
  assert.equal(v.version, 1);
  assert.equal(v.session, 's1');
  assert.equal(v.incidents.length, 2);
  const nullBody = renderIncidentComment(null, items);
  assert.ok(nullBody.startsWith(claudeMark(null)));
  const nb = extractBlock(nullBody, 'agent-incident');
  assert.ok(nb.found && nb.ok && (nb.value as { session: unknown }).session === null);
});

// ---- lib ----

test('appendIncident は id を最大 +1 で振り、source の既定は session。readIncidents は壊れた行を飛ばし、ファイルが無ければ []', () => {
  const dir = tempIncidentDir();
  const env = { AGENT_HARNESS_INCIDENT_DIR: dir };
  assert.deepEqual(readIncidents('s1', env), []);
  const now = new Date('2026-10-01T01:02:03.000Z');
  const a = appendIncident('s1', { kind: 'deny', what: 'a', target: '#1' }, env, now);
  assert.deepEqual(a, { id: 1, at: now.toISOString(), kind: 'deny', target: '#1', what: 'a', source: 'session' });
  appendFileSync(join(dir, 's1.jsonl'), '{壊れた行\n');
  const b = appendIncident('s1', { kind: 'workaround', what: 'b', workaround: 'c', source: 'hook' }, env, now);
  assert.equal(b.id, 2);
  assert.equal(b.source, 'hook');
  const items = readIncidents('s1', env);
  assert.deepEqual(items.map((i) => i.id), [1, 2]);
  assert.throws(() => appendIncident('s1', { kind: 'nope' as never, what: 'x' }, env), Error);
});

test('groupByKind は INCIDENT_KINDS の順で項目のある種類だけをキーに持ち、incidentDir は既定で ~/.agent-harness/incidents', () => {
  assert.deepEqual([...INCIDENT_KINDS], ['deny', 'return-to-human', 'app-reject', 'human-correction', 'workaround']);
  const mk = (id: number, kind: (typeof INCIDENT_KINDS)[number]) => ({ id, at: '2026-10-01T00:00:00.000Z', kind, what: String(id), source: 'session' as const });
  const g = groupByKind([mk(1, 'workaround'), mk(2, 'deny'), mk(3, 'human-correction'), mk(4, 'deny')]);
  assert.deepEqual(Object.keys(g), ['deny', 'human-correction', 'workaround']);
  assert.deepEqual(g.deny!.map((i) => i.id), [2, 4]);
  assert.deepEqual(groupByKind([]), {});
  assert.equal(incidentDir({}), join(homedir(), '.agent-harness', 'incidents'));
  assert.equal(incidentDir({ AGENT_HARNESS_INCIDENT_DIR: '/x/y' }), '/x/y');
});
