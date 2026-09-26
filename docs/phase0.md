# Phase 0 検証

使い捨てリポジトリ [namu112358/agent-harness-sandbox](https://github.com/namu112358/agent-harness-sandbox) で確認する。崩れた項目があれば設計に戻る。

凡例：✅ 確認済み ／ ⏳ 未確認（必要なもの） ／ ⚠️ 設計に影響あり

## 結果

| # | 項目 | 結果 | 根拠・メモ |
| --- | --- | --- | --- |
| 1 | Team 組織で Routines と Claude Code on the web が有効か | ⏳ | 管理者設定の確認（人） |
| 2 | Routines の1日の実行上限と処理可能な Issue 数 | ⏳ | 上限は公開されていない。[claude.ai/settings/usage](https://claude.ai/settings/usage) で確認。毎時実行なら最大 24 回/日。1 Issue は計画・実装・判定の最低 3 段階（Routine 3 回）なので、1回に3件進めれば 1 日あたり最大 24 Issue 程度 |
| 3 | 1 Issue あたりのサブスク利用量 | ⏳ | Routine 稼働後、PR フッターのメトリクスで測る |
| 4 | Routine がラベル操作・コメント・Draft PR 作成をどの経路で行えるか | ⏳（文書上は可） | ドキュメント上は `gh` が GitHub プロキシ経由で使える。GraphQL（`closingIssuesReferences`、`blockedBy`）も要確認 |
| 5 | Routine が `.github/workflows/**` を push できるか | ⏳ | 文書に記載なし。Routine で確認 |
| 6 | PR の中で書き換えた・足した workflow が `github-actions[bot]` としてラベルや Check Run を書けるか | ✅ 書ける | sandbox PR #1：PR 側の workflow が `GITHUB_TOKEN` で Check Run `agent/review`（app=github-actions, id 15368）と `probe-label` を書けた。**信頼の根にしていない**ことが必要（設計どおり） |
| 7 | PR の中で足した workflow から Environment の鍵を読めないこと | ✅ 読めない | sandbox PR #1：`Branch "refs/pull/1/merge" is not allowed to deploy to gate due to environment protection rules.` でジョブ自体が拒否。`pull_request_target` のジョブは `refs/heads/main` として `gate` に入れた。※ Secret の実値での確認は下記「残り」 |
| 8 | Ruleset の必須チェックの出どころを App に固定できるか、bypass なし | ✅ 固定できる | `rules/branches/main`：`ci@15368`・`agent/review@5086671`・`merge-route@5086671`、bypass なし。PR #3・#5 で App の Check Run が必須チェックとして効いた。※ユーザー名義の同名 status で通らないことの実地確認は未 |
| 9 | Routine（本人名義）が medium の PR を直接マージできるか、deny で止まるか | ⏳（手元では止まることを確認） | 手元のセッションで `.claude/settings.json` の deny が `git push ... main`・`gh secret set`・`agent:plan-ok` を含むコマンドを実際に拒否した。Routine での確認は Phase 2 |
| 10 | App のトークンで行った auto-merge・Close・Ready 化の後に後続 workflow が起動するか | ⏳ | App 作成後 |
| 11 | merge-route と順序で古い判定のまま Merge されないか | ✅（結合テスト）／⏳（実地） | `harness/test/gates.test.ts`：push で最初に auto-merge 解除、書き込み中の auto-merge 付与で merge-route を failure に書き直す。実地は自動 Merge を有効にする Phase 4 で |
| 12 | `git patch-id` の差分同一判定が main 追従後に動くか | ✅ | ローカル（`harness/test/patch-id.test.ts`）に加え、PR #5 で compare API の diff から patch-id を計算して判定を受け付けた。外部レビューで `--stable` が空白を無視すると判明し `--verbatim` に変更 |
| 13 | Actions から Jev に到達でき、8問を1回で呼べるか | ✅ | PR #5：`jev-1.13.0` が 8問に1回で応答（P(low)=1.0、revertible=0.77、tested=0.76 ほか）。シャドー記録は受け付けコメントと `agent/risk` のサマリー |
| 14 | 軽い Actions の月間実行時間 | ✅ 見積もり | 下記 |

## 実行時間の見積もり（#14）

実測：checkout と setup-node（Node 24）を含むジョブは約 4 秒、CI（`npm ci`＋型検査＋テスト）は 11 秒。GitHub Actions はジョブごとに1分単位で切り上げるため、1回の起動を1分として数える。

| 起動 | 1 Issue あたり |
| --- | --- |
| `agent:ready`、計画コメント、判定コメント、Issue の Close | 4 |
| PR の opened、push（実装＋修正で平均 2 回）、main への push | 4 |
| CI（PR の push 2 回＋main） | 3 |
| 計 | 約 11 分 |

これに停滞検知（3 時間ごと＝月 240 分）が加わる。月 100 Issue でも約 1,350 分で、GitHub Team の無料枠（月 3,000 分）に収まる。起動条件は `gate.yml` の `if:` で絞っている（App 自身の操作、hold 以外のラベル変化では起動しない）。

## 手元で分かったこと

- **deny は人のセッションにも効く**：`.claude/settings.json` の deny はリポジトリで開いた全セッションに効き、しかもセッション開始時の内容が保持される。構築中は main への push などが必要なため、deny は Phase 2（Routine 作成）で有効にする仕様に変えた（Q68）。
- **Routine のブランチ制限**：ドキュメント上、`claude/` 以外のブランチにも push できる可能性がある。`claude/` プレフィックスは安全の境界にせず、Agent PR の識別にだけ使う（Q65）。

## 通し確認（Issue #4 → PR #5、Routine の役は手元のセッション）

| 段階 | 結果 |
| --- | --- |
| `agent:ready` → Issue Form の読み取り | ✅ `agent:blocked` にならず通過 |
| `queue` → plan → `post-plan` | ✅ 書式検査、`risk:low` 付与 |
| 計画ゲート（App） | ✅ `agent:plan-ok`＋計画の写し。`queue` が Timeline で App の付与を確認して implement へ |
| 実装 → Draft PR → 範囲照合 | ✅ `agent/scope`「計画の範囲内です」 |
| 判定（reviewer・risk-agent を別サブエージェントで） → `post-verdict` | ✅ |
| 受け付け（App） | ✅ patch-id 照合、Jev シャドー、Ready 化、`agent/review`・`agent/risk`・`merge-route` を App が記録、Human Merge の依頼コメント |

見つかった論点：**docs だけの変更は、Risk Agent が質問4（テストで検証されているか）に `unsure` と答えるため自動 Merge の対象外になる**。計画の「low の例：docs、typo」と食い違う→ 質問4を「挙動を変える変更」に限定して解決（Q71）。

## 残り（App・Routine・鍵の準備後）

1. ~~App を作成・インストールし、`setup.ts all` を実行~~（完了：App ID 5086671）。
2. （任意）sandbox の Environment `gate` に Secret を置き、#7 を実値で確認：`openssl rand -hex 16 | gh secret set PROBE_SECRET --env gate --repo namu112358/agent-harness-sandbox`、その後 sandbox PR #1 の workflow を再実行。
3. #10（App の Merge・Close の後に後続 workflow が起動するか）は Phase 4 で自動 Merge を有効にしたときに確認。
4. Routine を作成し、#1〜#5・#9 を確認。

<!-- probe fix -->
