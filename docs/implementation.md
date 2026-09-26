# 実装との対応と進捗

計画（[plan.md](plan.md)）の要素と実装ファイルの対応、Phase ごとの進捗。

## 対応表

| 計画の要素 | 実装 |
| --- | --- |
| ラベルと状態モデル | `harness/lib/config.ts`（`LABELS`・`LABEL_DEFS`）、`harness/scripts/setup.ts labels` |
| Issue Forms とパーサ | `.github/ISSUE_TEMPLATE/agent-task.yml`、`harness/lib/issue-form.ts`、`harness/test/issue-form.test.ts`（フォームとパーサの一致を検査） |
| 読めない Issue は blocked | `harness/gates/on-issue.ts`（`agent:ready` 付与時に検査） |
| 着手宣言・冪等 | `harness/scripts/agent.ts claim/release`、`harness/lib/queue.ts`（状態を毎回 GitHub から再構成） |
| 計画の構造化出力（触るファイル一覧必須） | `harness/lib/plan.ts`、`docs/formats.md` |
| 計画ゲート（App） | `harness/gates/on-comment.ts` `onPlan`。通過時の計画を App の記録に写す |
| `agent:plan-ok` は App のみ | `harness/gates/on-issue.ts`（App 以外が付けたら外す）、`queue.ts`（Timeline で App が付けたことを確認） |
| 実装（Routine）・Test Designer | `.claude/routine.md`、`.claude/agents/test-designer.md` |
| 範囲照合（App） | `harness/lib/scope.ts`、`harness/gates/on-pr.ts`（`agent/scope`）、受け付け時にも再照合 |
| 判定（Reviewer・Risk Agent） | `.claude/agents/reviewer.md`、`.claude/agents/risk-agent.md`、`harness/lib/verdict.ts` |
| 確定（patch-id で受け付け） | `harness/gates/on-comment.ts` `onVerdict`、`harness/lib/patch-id.ts` |
| Check Run と順序制御 | `harness/gates/apply.ts`（auto-merge → merge-route → agent/risk → agent/review） |
| merge-route | `harness/lib/merge-route.ts`、`harness/gates/apply.ts`、`on-pr.ts`（hold・auto-merge の変化で再評価） |
| push で auto-merge 解除・判定の引き継ぎ | `harness/gates/on-pr.ts`（synchronize） |
| 修正ループ（通常2回・3回目は critical） | `harness/lib/verdict.ts` `fixAllowed`、`on-comment.ts`（App の変更要求レビューで数える） |
| Jev シャドー | `harness/lib/jev.ts`（8問を1回、事実のみの state、シャドー／enforce） |
| 依存解消・親 Close | `harness/gates/on-issue.ts` |
| 停滞検知 | `harness/gates/stale.ts`（3時間ごと、ダッシュボード Issue） |
| 停止スイッチ・revert で自動停止 | ダッシュボードの `agent:auto-merge-stopped`、`harness/gates/on-main-push.ts`、`on-issue.ts` |
| main 追従 | Ruleset の strict、`on-main-push.ts`（auto-merge 待ちの PR を update-branch） |
| 直接マージの防止 | `harness/templates/claude-settings.deny.json`（Phase 2 で `.claude/settings.json` に反映） |
| Ruleset・Environment | `harness/scripts/setup.ts` |
| PR フッターのメトリクス | `harness/scripts/agent.ts footer` |
| 書式検査（投稿時） | `agent.ts check / post-plan / post-verdict`、App 側でも受け付け時に検査 |
| runbook | `docs/runbook.md` |

## 計画からの差分（実装時の決定）

| # | 内容 | 理由 |
| --- | --- | --- |
| Q60 | ゲートは OWNER / MEMBER / COLLABORATOR のコメントだけ受け付ける | Q58 の穴（第三者の偽判定で自動 Merge）を1行で塞げるため（ユーザー承認済み） |
| Q61 | TypeScript（ビルドなし） | ユーザー決定 |
| Q62 | 質問8の対象に `harness/**`・`harness.config.json` を追加 | ゲートのコードと設定は「この仕組み自体」 |
| Q63 | ハーネスのコードを `harness/` に置く | 移行先の製品コード（`src/` など）と分け、質問8の対象を明確にするため |
| Q64 | 自動 Merge モードはダッシュボード Issue の `agent:auto-merge-stopped` ラベル | App の権限にリポジトリ変数の書き込みがないため。ダッシュボードが無い場合は停止（安全側） |
| Q65 | Agent PR ＝同じリポジトリの `claude/` ブランチからの PR。それ以外の PR は `agent/review` を「判定対象外」で通し、自動経路に乗せない | 人の PR も必須チェック `agent/review` で止まらないように。Routine が `claude/` 以外に push しても、自動では Merge されない |
| Q66 | 人の修正依頼は PR の Review（Comment）で行い、最後の push 以降のコラボレーターのレビューを修正依頼とみなす | 同じ名義の PR には Request changes を付けられないため。Reviewer の変更要求は App が付ける |
| Q67 | Routine の claim は、別の実行のもので 90 分を過ぎたら終了した実行とみなす | 実行が終わったかを GitHub から判定する手段がないため（Phase 0 で再確認） |
| Q68 | `.claude/settings.json` の deny は Phase 2（Routine 作成）で有効化 | 構築中の人のセッションで main への push などが必要なため（ユーザー決定） |
| Q70 | 外部レビューの反映：patch-id を `--verbatim` に、範囲パターンの最初の階層のワイルドカード禁止、受け付けの競合対策と定期照合、auto-merge できないときの直接 Merge、別リポジトリ参照の除外、ダッシュボードの作成者確認、`contents: read` | コードレビューで見つかったため |
| Q71 | 質問4を「挙動を変える変更」に限定（U1 の決定） | docs・typo を low で自動 Merge できるようにするため（ユーザー決定） |
| Q72 | Routine は GitHub の操作を MCP ツールだけで行い、queue は App が Actions で計算してダッシュボード Issue に公開する。`agent.ts` の Routine 用コマンドは API を呼ばず書式検査と本文生成だけ。メトリクスは PR コメントに残す（MCP の `update_pull_request` を deny にするため） | Routine の環境には `gh` も API 用トークンもなく、Routine のシステム側の決まりで GitHub は MCP ツールのみ（初回実行と診断で判明、U2）。状態の判定が App 側に移り、偽装されにくくなる |
| Q69 | 合格した判定を受け付けたら、App の過去の変更要求レビューを解除する | 変更要求が残ると Merge を妨げ得るため。修正回数は解除済みも数える |

## 未決事項

| # | 論点 | 選択肢 |
| --- | --- | --- |
| ~~U1~~ | docs だけの変更で質問4が `unsure` になり、自動 Merge されない | **決定（Q71）：(a) 質問4を「挙動を変える変更がテストで検証されているか（挙動を変えない変更だけなら yes）」に言い換える** |

| U2 | Routine の環境から GitHub API を呼べない（`gh` なし、`GITHUB_TOKEN` は仮の値で 401） | 診断の Routine で経路を確かめてから決める：(a) `NODE_USE_ENV_PROXY=1` や curl でプロキシを通すと差し替わるか (b) `gh` を入れて使う（外部バイナリの取得は要承認） (c) Routine の GitHub 操作を MCP ツールに寄せ、`agent.ts` は判断だけにする (d) fine-grained PAT を環境変数に置く（秘密を置けないため非推奨） |

## 進捗

| Phase | 状態 |
| --- | --- |
| 0 | App・Jev・Ruleset まで検証済み（[phase0.md](phase0.md)）。Routine が必要な項目（#1〜#5・#9）と #10 は未 |
| 1 | 実装済み（ラベル、Issue Forms とパーサのテスト、Risk ポリシー、書式）。ラベルの作成は App 作成後に `setup.ts all` |
| 2 | 通し確認済み（Issue #4 → PR #5、Routine の役は手元）。Routine 本体は未作成 |
| 3 | 判定・Check Run・merge-route・Jev シャドー・停滞検知は稼働確認済み。修正ループは未確認。集計スクリプトは `harness/scripts/report.ts` |
| 4 | 実装済み・未稼働（停止スイッチ、hold、revert で自動停止、runbook、依存解消、親 Close） |
| 5 | 未着手 |
