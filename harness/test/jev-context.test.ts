/**
 * harness/scripts/jev-context.ts（Issue #596）のテスト。auto mode の危険の問いを4通りの材料で問い直す実験のスクリプト。
 * 材料の作り分け（contextVariants）、表（renderContextTable）、PR 2件を1回動かす流れと、GitHub に書かないこと（GET と query の GraphQL だけ）を確かめる。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoModePrJevRequest } from '../lib/auto-mode.ts';
import { appLogin, loadConfig } from '../lib/config.ts';
import { GitHub, type RequestOptions, type Transport } from '../lib/github.ts';
import type { askJev } from '../lib/jev.ts';
import {
  CONTEXT_MAX_FACTOR,
  collectMaterial,
  contextVariants,
  issueContext,
  renderContextTable,
  runVariants,
  type PrMaterial,
  type VariantKey,
} from '../scripts/jev-context.ts';

const config = loadConfig();
const small = { ...config, jev: { ...config.jev, maxDiffChars: 1000 } };
const KEYS: VariantKey[] = ['base', 'issue', 'files', 'both'];

type AskResult = Awaited<ReturnType<typeof askJev>>;

const issueBody = (goal: string, ac: string) =>
  ['### Goal', '', goal, '', '### Requirements', '', '要件', '', '### Acceptance Criteria', '', ac].join('\n');

function material(over: Partial<PrMaterial> = {}): PrMaterial {
  return {
    number: 577,
    head: 'abcdef1234567890',
    recordedYes: 0.14,
    diff: 'diff --git a/x.ts b/x.ts\n+1\n',
    changedFiles: ['x.ts'],
    issue: { number: 500, goal: 'ゴール', acceptanceCriteria: '- AC1' },
    fileContents: [{ path: 'x.ts', content: 'export const x = 1;\n' }],
    ...over,
  };
}

// ---- issueContext ----

test('issueContext: Issue Form の本文から goal と AC を取り、読めない本文・無い本文は null', () => {
  assert.deepEqual(issueContext(500, issueBody('ゴール', '- AC1')), { number: 500, goal: 'ゴール', acceptanceCriteria: '- AC1' });
  for (const body of [null, '', '見出しの無い本文']) assert.equal(issueContext(500, body), null, String(body));
});

// ---- contextVariants ----

test('contextVariants: 4通りとも model・questions は本番と同じで、state は表のとおりに欄が増える', () => {
  const m = material();
  const prod = autoModePrJevRequest(small, m.diff, m.changedFiles);
  assert.ok(prod.ask);
  const v = contextVariants(small, m);
  const issue = { number: 500, goal: 'ゴール', acceptance_criteria: '- AC1' };
  const files = [{ path: 'x.ts', content: 'export const x = 1;\n' }];
  const expected: Record<VariantKey, Record<string, unknown>> = {
    base: { ...prod.request.state },
    issue: { ...prod.request.state, issue },
    files: { ...prod.request.state, file_contents: files },
    both: { ...prod.request.state, issue, file_contents: files },
  };
  for (const key of KEYS) {
    const cell = v[key];
    assert.ok(cell.ask, key);
    assert.equal(cell.request.model, prod.request.model, key);
    assert.deepEqual(cell.request.questions, prod.request.questions, key);
    assert.deepEqual(cell.request.state, expected[key], key);
  }
  assert.deepEqual(v.base.ask && v.base.request, prod.request);
});

test('contextVariants: 問わない場合（diff の上限・Issue なし・足した材料の上限）', () => {
  const big = 'x'.repeat(small.jev.maxDiffChars * CONTEXT_MAX_FACTOR + 1);
  const cases: { name: string; m: PrMaterial; asked: VariantKey[] }[] = [
    { name: 'diff が maxDiffChars を超える', m: material({ diff: 'd'.repeat(small.jev.maxDiffChars + 1) }), asked: [] },
    { name: 'Issue なし', m: material({ issue: null }), asked: ['base', 'files'] },
    { name: 'ファイル全体が上限を超える', m: material({ fileContents: [{ path: 'x.ts', content: big }] }), asked: ['base', 'issue'] },
    { name: 'すべて上限の内', m: material(), asked: KEYS },
  ];
  for (const c of cases) {
    const v = contextVariants(small, c.m);
    for (const key of KEYS) {
      const cell = v[key];
      assert.equal(cell.ask, c.asked.includes(key), `${c.name}: ${key}`);
      if (!cell.ask) assert.ok(cell.reason.trim() !== '', `${c.name}: ${key} の理由が空`);
    }
  }
});

// ---- runVariants ----

test('runVariants: 問うものだけ ask を呼び、ok は危険の確率、error は detail を理由に残す', async () => {
  const v = contextVariants(small, material({ issue: null }));
  const calls: { apiKey: string; state: Record<string, unknown> }[] = [];
  const ask = (async (apiKey: string, request: { state: unknown }) => {
    const state = request.state as Record<string, unknown>;
    calls.push({ apiKey, state });
    if ('file_contents' in state) return { status: 'error', detail: 'boom-detail' } satisfies AskResult;
    return { status: 'ok', model: 'jev-x', answers: { danger: { noul: 0.25 } } } as unknown as AskResult;
  }) as typeof askJev;
  const r = await runVariants('key-1', v, ask);
  assert.equal(calls.length, 2, 'ask:false の材料（issue・both）は問わない');
  assert.ok(calls.every((c) => c.apiKey === 'key-1'));
  assert.deepEqual(r.base, { yes: 0.25 });
  assert.ok('reason' in r.files && r.files.reason.includes('boom-detail'));
  assert.ok('reason' in r.issue && r.issue.reason.trim() !== '');
  assert.ok('reason' in r.both && r.both.reason.trim() !== '');
});

// ---- renderContextTable ----

const rowCells = (table: string, pr: number): string[] => {
  const line = table.split('\n').find((l) => l.trimStart().startsWith('|') && l.includes(`#${pr}`));
  assert.ok(line, `#${pr} の行が無い`);
  return line.split('|').slice(1, -1).map((s) => s.trim());
};

test('renderContextTable: 保留・通るは dangerSafe で決まり、問えなかったセルは理由を出す', () => {
  const table = renderContextTable(
    [
      {
        material: material(),
        results: { base: { yes: 0.05 }, issue: { yes: 0.2 }, files: { reason: 'skipped-reason' }, both: { reason: 'error: boom' } },
      },
    ],
    0.9,
  );
  const [pr, recorded, base, issue, files, both] = rowCells(table, 577);
  assert.ok(pr!.includes('#577'));
  assert.ok(recorded!.includes('abcdef1'), '本番の記録の列に head の短い SHA');
  assert.ok(base!.includes('通る') && !base!.includes('保留'), `線の上: ${base}`);
  assert.ok(issue!.includes('保留') && !issue!.includes('通る'), `線の下: ${issue}`);
  assert.ok(files!.includes('skipped-reason'));
  assert.ok(both!.includes('boom'));
});

test('renderContextTable: 本番の記録が無い PR は「記録なし」', () => {
  const r = { yes: 0.1 };
  const table = renderContextTable([{ material: material({ number: 569, recordedYes: null }), results: { base: r, issue: r, files: r, both: r } }], 0.9);
  assert.ok(rowCells(table, 569)[1]!.includes('記録なし'));
});

// ---- 1回動かす流れ（AC1・AC2） ----

interface Call {
  method: string;
  path: string;
  opts?: RequestOptions;
}

const REPO = 'o/r';
const R = `/repos/${REPO}`;

interface FakePr {
  number: number;
  headSha: string;
  baseSha: string;
  /** App の受け付けの記録の head（無ければ記録なし） */
  recordHead?: string;
  recordedYes?: number;
  closes: number[];
  files: { filename: string; previous_filename?: string }[];
}

function fakeTransport(prs: FakePr[], issues: Record<number, string>, contents: Record<string, string>) {
  const calls: Call[] = [];
  const transport: Transport = {
    async request(method, path, opts) {
      calls.push({ method, path, ...(opts ? { opts } : {}) });
      const p = decodeURIComponent(path);
      if (method === 'POST' && path === '/graphql') {
        const pr = prs.find((x) => x.number === (opts?.body as { variables: { pr: number } }).variables.pr)!;
        return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: pr.closes.map((n) => ({ number: n, repository: { nameWithOwner: REPO } })) } } } } };
      }
      if (method !== 'GET') throw new Error(`unexpected ${method} ${path}`);
      for (const pr of prs) {
        if (p === `${R}/pulls/${pr.number}`) {
          return { number: pr.number, state: 'closed', draft: false, title: 't', body: '', labels: [], user: null, head: { ref: `claude/issue-${pr.number}`, sha: pr.headSha, repo: { full_name: REPO } }, base: { ref: 'main', sha: pr.baseSha } };
        }
        if (p.startsWith(`${R}/issues/${pr.number}/comments`)) {
          if (!p.includes('page=1') && p.includes('page=')) return [];
          if (pr.recordHead === undefined) return [];
          const value = { verdictHeadSha: pr.recordHead, autoMode: { jev: { status: 'ok', yes: pr.recordedYes, questionSet: 1 } } };
          return [
            {
              id: pr.number * 10,
              body: `<!-- agent-harness:app kind=acceptance -->\n\`\`\`agent-app\n${JSON.stringify(value)}\n\`\`\``,
              html_url: '',
              created_at: '2026-10-01T00:00:00Z',
              updated_at: '2026-10-01T00:00:00Z',
              author_association: 'NONE',
              user: { login: appLogin(config), type: 'Bot' },
            },
          ];
        }
        if (p.startsWith(`${R}/pulls/${pr.number}/files`)) return p.includes('page=1') || !p.includes('page=') ? pr.files : [];
        if (p.startsWith(`${R}/compare/`)) {
          const [base, head] = p.slice(`${R}/compare/`.length).split('...');
          const target = prs.find((x) => x.baseSha === base && (x.recordHead ?? x.headSha) === head);
          if (target) return `diff --git a/f b/f\n+pr ${target.number}\n`;
        }
      }
      for (const [n, body] of Object.entries(issues)) if (p === `${R}/issues/${n}`) return { number: Number(n), body };
      const m = p.match(/^\/repos\/o\/r\/contents\/(.+)\?ref=(.+)$/);
      if (m) {
        const key = `${m[1]}@${m[2]}`;
        if (key in contents) return contents[key];
        if (opts?.allow404) return null;
        throw new Error(`404 ${path}`);
      }
      throw new Error(`unexpected GET ${path}`);
    },
  };
  return { transport, calls };
}

const PRS: FakePr[] = [
  {
    number: 577,
    headSha: 'head577new',
    baseSha: 'base577',
    recordHead: 'rec5771abcdef',
    recordedYes: 0.14,
    closes: [500],
    files: [{ filename: 'src/a.ts' }, { filename: 'src/new.ts', previous_filename: 'src/old.ts' }, { filename: 'src/gone.ts' }],
  },
  { number: 569, headSha: 'head569', baseSha: 'base569', closes: [], files: [{ filename: 'src/b.ts' }] },
];
const ISSUES = { 500: issueBody('ゴール500', '- AC500') };
const CONTENTS = {
  'src/a.ts@rec5771abcdef': 'a content',
  'src/new.ts@rec5771abcdef': 'new content',
  'src/b.ts@head569': 'b content',
};

test('collectMaterial: 受け付けの記録の head と PR の base の SHA で読み、head に無いファイルは入れない', async () => {
  const { transport, calls } = fakeTransport(PRS, ISSUES, CONTENTS);
  const gh = new GitHub(transport, REPO);

  const m = await collectMaterial(gh, config, 577);
  assert.equal(m.number, 577);
  assert.equal(m.head, 'rec5771abcdef');
  assert.equal(m.recordedYes, 0.14);
  assert.ok(m.diff.includes('+pr 577'), 'diff は pr.base.sha と記録の head の比較');
  assert.ok(calls.some((c) => decodeURIComponent(c.path) === `${R}/compare/base577...rec5771abcdef`));
  assert.deepEqual([...m.changedFiles].sort(), ['src/a.ts', 'src/gone.ts', 'src/new.ts', 'src/old.ts']);
  assert.deepEqual(m.issue, { number: 500, goal: 'ゴール500', acceptanceCriteria: '- AC500' });
  assert.deepEqual(
    [...m.fileContents].sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: 'src/a.ts', content: 'a content' },
      { path: 'src/new.ts', content: 'new content' },
    ],
  );

  const n = await collectMaterial(gh, config, 569);
  assert.equal(n.head, 'head569', '記録が無ければ pr.head.sha');
  assert.equal(n.recordedYes, null);
  assert.equal(n.issue, null, 'Closes が無ければ Issue なし');
});

test('1回動かす: PR 2件で表に2行×4通りの確率が出て、GitHub には GET と query の GraphQL しか出さない', async () => {
  const { transport, calls } = fakeTransport(PRS, ISSUES, CONTENTS);
  const gh = new GitHub(transport, REPO);
  const yesOf: Record<VariantKey, number> = { base: 0.111, issue: 0.222, files: 0.333, both: 0.444 };
  const ask = (async (_k: string, request: { state: unknown }) => {
    const s = request.state as Record<string, unknown>;
    const key: VariantKey = 'issue' in s && 'file_contents' in s ? 'both' : 'issue' in s ? 'issue' : 'file_contents' in s ? 'files' : 'base';
    return { status: 'ok', model: 'jev-x', answers: { danger: { noul: yesOf[key] } } } as unknown as AskResult;
  }) as typeof askJev;

  const rows = [];
  for (const pr of [577, 569]) {
    const m = await collectMaterial(gh, config, pr);
    rows.push({ material: m, results: await runVariants('key', contextVariants(config, m), ask) });
  }
  const table = renderContextTable(rows, 0.9);

  const r577 = rowCells(table, 577);
  assert.equal(r577.length, 6, '列は PR・本番の記録・4通り');
  const pcts = [/11\.1%/, /22\.2%/, /33\.3%/, /44\.4%/];
  pcts.forEach((re, i) => assert.match(r577[2 + i]!, re, KEYS[i]));
  const r569 = rowCells(table, 569);
  assert.equal(r569.length, 6);
  assert.match(r569[2]!, /11\.1%/);
  assert.match(r569[4]!, /33\.3%/);

  assert.ok(calls.length > 0);
  for (const c of calls) {
    const okGet = c.method === 'GET';
    const okQuery = c.method === 'POST' && c.path === '/graphql' && !/\bmutation\b/.test(String((c.opts?.body as { query?: string })?.query ?? ''));
    assert.ok(okGet || okQuery, `書く要求を出した: ${c.method} ${c.path}`);
  }
});
