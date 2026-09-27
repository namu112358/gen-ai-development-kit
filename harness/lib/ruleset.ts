/**
 * 既定ブランチの Ruleset の本文（harness/scripts/setup.ts の ruleset が適用する）。
 * 必須チェックは、導入先の CI が出すもの（harness.config.json の projectChecks）と、App が出すハーネスの5つ（コードに固定）。
 */

import { CHECKS, projectChecks, type HarnessConfig } from './config.ts';

export const RULESET_NAME = 'agent-harness-main';

const harnessChecks = [CHECKS.review, CHECKS.mergeRoute, CHECKS.planLink, CHECKS.title, CHECKS.tests];

export function rulesetBody(appId: number, config: HarnessConfig) {
  const project = projectChecks(config).map((c) => ({ context: c.context, integration_id: c.integrationId }));
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
          required_status_checks: [...project, ...harnessChecks.map((context) => ({ context, integration_id: appId }))],
        },
      },
    ],
  };
}

/** ruleset の出力の文言と、プロジェクトの CI を必須にしないときの警告 */
export function rulesetSummary(appId: number, config: HarnessConfig): { text: string; warning: string | null } {
  const project = projectChecks(config);
  const projectText = project.length > 0 ? `${project.map((c) => `${c.context}(${c.integrationId})`).join('・')}, ` : '';
  return {
    text: `ruleset ${RULESET_NAME}: required = ${projectText}${harnessChecks.join('・')}(App ${appId}); bypass なし`,
    warning: project.length === 0 ? 'projectChecks が空です。プロジェクトの CI を必須にしません（harness.config.json の projectChecks）' : null,
  };
}
