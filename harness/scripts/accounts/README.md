# harness/scripts/accounts/

Orca につないだ Claude のアカウントのうち、使用量の低いものを選ぶ手元のコマンド（Epic #813）。

- `pick.ts`：`node harness/scripts/accounts/pick.ts`（引数なし）。標準出力に JSON を1つ返し、終了コードは常に 0。
  - 入力（読むだけ。書くのは `launches.json` だけ）：対応表 `~/.config/agent-harness/accounts.json`（`threshold5h`（既定 80）・`threshold7d`（既定 90。7d が null のアカウントは 7d では外さない）と `accounts[]` の `orcaId`・`name`・`configDir`。`configDir` の先頭の `~/` はホームに展開する）、使用量の控え `~/.config/agent-harness/usage/<組織の ID>.json`、起こした数の控え `usage/launches.json`、Orca の `account list --json`（アカウントの一覧と組織の ID だけを読む）。
  - 結果：`picked`（`prefix` は `CLAUDE_CONFIG_DIR='<configDir>' `、`name`・`orcaId`・`usage`・`excluded`）、`wait`（全部が 5h か 7d のしきい値以上か `rejected`。リセット時刻を過ぎた値は 0% とみなす。`resetAt` はアカウントが選べるようになる時刻の一番早いもの。5h と 7d の両方で外れたアカウントは遅い方）、`default`（対応表が無い・Orca が読めない・候補が無い。`prefix` は空、`reason` に理由）。
  - 順番（Issue #979）：5h（リセット済みは 0%）＋ 10 × 直近 15 分に起こした数（`launches.json`。値の時刻にかかわらず数える）で低い方から。同点なら 7d が低い方（null は後ろ）、それも同じなら対応表の順。7d は `threshold7d` で外す条件と同点の順番にだけ使う。
  - 候補から外す理由（`excluded` の `reason`）：`outside-config-root`・`unreadable-claude-json`・`onboarding`・`trust`・`auto-mode-prompt`・`org-mismatch`・`no-usage`。
  - 値の取り元は 10 分以内の問い合わせ（`source: probe`）の控え → 5 分以内のほかの控えの順。別のアカウントと取り違えていそうな値は使わない。
  - 控えが使われる条件（Issue #976）：`source` が `probe` の控えか、控えの `configDir` の実パスが対応表のそのアカウントの `configDir` の実パスと同じ控えだけ。`configDir` が無い・違う控え（どの設定ディレクトリで書いたか分からない）は無いものとして扱う。
  - Orca の使用量（`rateLimits`）は選ぶのに使わない。`~/.claude` で動くセッションは Orca のアカウントの切り替えの後も前のアカウントで動き続け、Orca と控えに別のアカウントの値を書くことがあるため。
- `probe.ts`：`node harness/scripts/accounts/probe.ts`（引数なし。fleet が `probe` → `pick` の順に流す想定。標準出力に JSON を1つ返し、終了コードは常に 0）。
  - 各アカウントの設定ディレクトリ（`CLAUDE_CONFIG_DIR`）で `claude -p` を haiku で1回呼び（一時ディレクトリを cwd に、時間の上限 90 秒）、応答の `rate_limit_event` から 5h・7d を読んで使用量の控え `usage/<組織の ID>.json` に `source: "probe"` を付けて書く。
  - 子プロセスには `ANTHROPIC_API_KEY`・`ANTHROPIC_AUTH_TOKEN`・`CLAUDE_CODE_OAUTH_TOKEN` を渡さない（設定ディレクトリのアカウントで認証させるため）。
  - `pick.ts` がそのまま使える控え（使われる条件を満たし、問い合わせの控えは 10 分・ほかの控えは 5 分以内。新しさは `pick.ts` と同じ規則）があるアカウントと、候補から外れるアカウント（`pick.ts` と同じ確かめ）は呼ばない。
  - 結果：`done`（`probed`・`skipped`・`failed`（`timeout`・`no-rate-limit-event`・`spawn-failed`・`write-failed`）・`mismatches`（問い合わせた 5h と Orca の 5h が 20 ポイント以上ずれたもの））、または `skipped`（対応表が無い・Orca が読めない）。

メールアドレス・トークン・組織名は出力に入れない。`.claude.json` はどちらも書き換えない。使用量の控えは `pick.ts` は書き換えず（書くのは `launches.json` だけ）、`probe.ts` は問い合わせたアカウントの控えだけを書く。
