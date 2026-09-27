import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { allLabelDefs, CHECKS, loadConfig } from '../lib/config.ts';
import { GhTransport, GitHub } from '../lib/github.ts';

/**
 * リポジトリ設定を冪等に適用する（人が手元で、リポジトリ管理者の gh 認証で実行する）。
 *
 *   node harness/scripts/setup.ts labels <owner/repo>
 *   node harness/scripts/setup.ts repo <owner/repo>                 マージ方式・auto-merge・Actions の既定権限
 *   node harness/scripts/setup.ts environment <owner/repo> [clientId] Environment `gate`（既定ブランチからの実行に限定）と App の変数
 *   node harness/scripts/setup.ts ruleset <owner/repo> <appId>      main の Ruleset（必須チェックの出どころを App に固定、bypass なし）
 *   node harness/scripts/setup.ts app-manifest <owner/repo> <name>  App 作成用の HTML（マニフェストフロー）を出力
 *   node harness/scripts/setup.ts app-convert <owner/repo> <code>   マニフェストの code から App を確定し、鍵を Environment Secret に保存
 *   node harness/scripts/setup.ts all <owner/repo> <appId>          labels・repo・environment・ruleset をまとめて
 */

const GITHUB_ACTIONS_APP_ID = 15368;
const ENVIRONMENT = 'gate';
const RULESET_NAME = 'agent-harness-main';

/** ハーネスが管理するラベルの接頭辞。定義に無いものは消す（廃止したラベルを残さない） */
const MANAGED_PREFIXES = ['agent:', 'risk:', 'priority:', 'size:', 'area:', 'plan:', 'review:'];

async function labels(gh: GitHub): Promise<void> {
  const defs = allLabelDefs(loadConfig());
  const existing = new Set((await gh.paginate<{ name: string }>('/labels')).map((l) => l.name));
  for (const name of existing) {
    if (MANAGED_PREFIXES.some((p) => name.startsWith(p)) && !defs.some((d) => d.name === name)) {
      await gh.request('DELETE', `/labels/${encodeURIComponent(name)}`);
      console.log(`deleted ${name}`);
    }
  }
  for (const def of defs) {
    if (existing.has(def.name)) {
      await gh.request('PATCH', `/labels/${encodeURIComponent(def.name)}`, { body: { color: def.color, description: def.description } });
    } else {
      await gh.request('POST', '/labels', { body: def });
    }
    console.log(`label ${def.name}`);
  }
}

async function repo(gh: GitHub): Promise<void> {
  await gh.request('PATCH', gh.repoPath, {
    body: {
      allow_auto_merge: true,
      allow_squash_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      delete_branch_on_merge: true,
      allow_update_branch: true,
      squash_merge_commit_title: 'PR_TITLE',
      squash_merge_commit_message: 'PR_BODY',
    },
  });
  await gh.request('PUT', `${gh.repoPath}/actions/permissions/workflow`, {
    body: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false },
  });
  console.log('repo settings applied');
}

async function environment(gh: GitHub, clientId?: string): Promise<void> {
  await gh.request('PUT', `${gh.repoPath}/environments/${ENVIRONMENT}`, {
    body: { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } },
  });
  const config = loadConfig();
  const policies = await gh.get<{ branch_policies: { id: number; name: string; type?: string }[] }>(`${gh.repoPath}/environments/${ENVIRONMENT}/deployment-branch-policies`);
  for (const p of policies.branch_policies) {
    if (p.name !== config.defaultBranch) {
      await gh.request('DELETE', `${gh.repoPath}/environments/${ENVIRONMENT}/deployment-branch-policies/${p.id}`);
    }
  }
  if (!policies.branch_policies.some((p) => p.name === config.defaultBranch)) {
    await gh.request('POST', `${gh.repoPath}/environments/${ENVIRONMENT}/deployment-branch-policies`, { body: { name: config.defaultBranch, type: 'branch' } });
  }
  console.log(`environment ${ENVIRONMENT}: ${config.defaultBranch} のみ`);
  await setVariable(gh, `${gh.repoPath}/actions/variables`, 'AGENT_APP_SLUG', config.appSlug);
  if (clientId) await setVariable(gh, `${gh.repoPath}/environments/${ENVIRONMENT}/variables`, 'AGENT_APP_CLIENT_ID', clientId);
}

/** 変数を作成または更新する（リポジトリ変数・Environment 変数の両方に使う） */
async function setVariable(gh: GitHub, base: string, name: string, value: string): Promise<void> {
  const existing = await gh.get(`${base}/${name}`, { allow404: true });
  if (existing) await gh.request('PATCH', `${base}/${name}`, { body: { name, value } });
  else await gh.request('POST', base, { body: { name, value } });
  console.log(`variable ${name}=${value}`);
}

export function rulesetBody(appId: number) {
  return {
    name: RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
          allowed_merge_methods: ['squash'],
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
          required_status_checks: [
            { context: 'ci', integration_id: GITHUB_ACTIONS_APP_ID },
            { context: CHECKS.review, integration_id: appId },
            { context: CHECKS.mergeRoute, integration_id: appId },
            { context: CHECKS.planLink, integration_id: appId },
            { context: CHECKS.title, integration_id: appId },
          ],
        },
      },
    ],
  };
}

async function ruleset(gh: GitHub, appId: number): Promise<void> {
  if (!Number.isInteger(appId) || appId <= 0) throw new Error('appId が必要です');
  const existing = (await gh.get<{ id: number; name: string }[]>(`${gh.repoPath}/rulesets`)).find((r) => r.name === RULESET_NAME);
  const body = rulesetBody(appId);
  if (existing) await gh.request('PUT', `${gh.repoPath}/rulesets/${existing.id}`, { body });
  else await gh.request('POST', `${gh.repoPath}/rulesets`, { body });
  console.log(`ruleset ${RULESET_NAME}: required = ci(GitHub Actions), ${CHECKS.review}・${CHECKS.mergeRoute}・${CHECKS.planLink}・${CHECKS.title}(App ${appId}); bypass なし`);
}

function appManifest(repository: string, name: string): void {
  const manifest = {
    name,
    url: `https://github.com/${repository}`,
    description: 'Agent harness の決定論的ゲート（Claude は動かさない）',
    hook_attributes: { url: `https://github.com/${repository}`, active: false },
    redirect_url: `https://github.com/${repository}/blob/main/docs/setup.md`,
    public: false,
    default_permissions: {
      checks: 'write',
      contents: 'write',
      issues: 'write',
      pull_requests: 'write',
      metadata: 'read',
    },
    default_events: [],
  };
  const html = `<!doctype html><meta charset="utf-8"><title>Create GitHub App</title>
<p>下のボタンで GitHub App「${name}」を作成します（権限: checks / contents / issues / pull_requests = write、metadata = read。workflows 権限なし、Webhook なし）。</p>
<form action="https://github.com/settings/apps/new" method="post">
<input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, '&#39;')}'>
<button type="submit">GitHub App を作成</button>
</form>
<p>作成後にリダイレクトされた URL の <code>?code=...</code> を控え、<code>node harness/scripts/setup.ts app-convert ${repository} &lt;code&gt;</code> を実行してください（1時間以内）。</p>`;
  const out = 'app-manifest.html';
  writeFileSync(out, html);
  console.log(`wrote ${out}`);
}

/** マニフェストの code を App に確定し、鍵を Environment Secret に保存する。鍵は画面に出さない */
async function appConvert(gh: GitHub, code: string): Promise<void> {
  const app = await gh.request<{ id: number; slug: string; client_id: string; pem: string; html_url: string }>('POST', `/app-manifests/${code}/conversions`);
  const set = (args: string[], input?: string) => {
    const r = spawnSync('gh', args, { input, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${r.stderr}`);
  };
  const repo = `${gh.owner}/${gh.repo}`;
  set(['secret', 'set', 'AGENT_APP_PRIVATE_KEY', '--env', ENVIRONMENT, '--repo', repo], app.pem);
  set(['variable', 'set', 'AGENT_APP_CLIENT_ID', '--env', ENVIRONMENT, '--repo', repo, '--body', app.client_id]);
  set(['variable', 'set', 'AGENT_APP_SLUG', '--repo', repo, '--body', app.slug]);
  const path = 'harness.config.json';
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.appSlug = app.slug;
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  console.log(JSON.stringify({ id: app.id, slug: app.slug, client_id: app.client_id, html_url: app.html_url, next: `${app.html_url}/installations/new でこのリポジトリにだけインストールし、ruleset ${app.id} を実行` }, null, 2));
}

const [cmd, repository, arg] = process.argv.slice(2);
if (!cmd || !repository) {
  console.error('usage: see header of harness/scripts/setup.ts');
  process.exit(1);
}
const gh = new GitHub(new GhTransport(), repository);
switch (cmd) {
  case 'labels': await labels(gh); break;
  case 'repo': await repo(gh); break;
  case 'environment': await environment(gh, arg); break;
  case 'ruleset': await ruleset(gh, Number(arg)); break;
  case 'app-manifest': appManifest(repository, arg ?? `${gh.owner}-agent-gate`); break;
  case 'app-convert': await appConvert(gh, arg!); break;
  case 'all':
    await labels(gh);
    await repo(gh);
    await environment(gh);
    await ruleset(gh, Number(arg));
    break;
  default:
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
}
