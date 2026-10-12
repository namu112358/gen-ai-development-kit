# harness/scripts/accounts/

Orca につないだ Claude のアカウントのうち、使用量の低いものを選ぶ手元のコマンド（Epic #813）。

- `pick.ts`：`node harness/scripts/accounts/pick.ts`（引数なし）。標準出力に JSON を1つ返し、終了コードは常に 0。
  - 入力（読むだけ。書くのは `launches.json` だけ）：対応表 `~/.config/agent-harness/accounts.json`（`threshold5h`（既定 80）と `accounts[]` の `orcaId`・`name`・`configDir`）、使用量の控え `~/.config/agent-harness/usage/<組織の ID>.json`、起こした数の控え `usage/launches.json`、Orca の `account list --json`。
  - 結果：`picked`（`prefix` は `CLAUDE_CONFIG_DIR='<configDir>' `、`name`・`orcaId`・`usage`・`excluded`）、`wait`（全部の 5h がしきい値以上か `rejected`。`resetAt` は一番早い 5h のリセット）、`default`（対応表が無い・Orca が読めない・候補が無い。`prefix` は空、`reason` に理由）。
  - 候補から外す理由（`excluded` の `reason`）：`outside-config-root`・`unreadable-claude-json`・`onboarding`・`trust`・`auto-mode-prompt`・`org-mismatch`・`no-usage`。
  - 値の取り元は 10 分以内の問い合わせ（`source: probe`）の控え → 5 分以内のほかの控え → 30 分以内の Orca の順。別のアカウントと取り違えていそうな値は使わない。

メールアドレス・トークン・組織名は出力に入れない。`.claude.json` と使用量の控えは書き換えない。
