# 構造化コメントの書式

Claude（Routine・人のセッション）と App は、コメントに JSON のフェンスを埋め込んで状態を受け渡す。
投稿前に `node harness/scripts/agent.ts render-plan` / `render-verdict`（人のセッションでは `post-plan` / `post-verdict`）で検査し、App も受け付け時に同じ検査をする。

| フェンス | 書く者 | 置き場所 | 検査 |
| --- | --- | --- | --- |
| ```` ```agent-plan ```` | Claude | Issue コメント | `harness/lib/plan.ts` |
| ```` ```agent-verdict ```` | Claude | PR コメント | `harness/lib/verdict.ts` |
| ```` ```agent-claim ```` | Claude | Issue / PR コメント | `harness/lib/queue.ts` |
| ```` ```agent-app ```` | App のみ | Issue / PR コメント | App の名義のものだけ信頼する |

共通ルール：

- Claude のコメントは先頭に `<!-- agent-harness:claude -->` を付ける。
- 1つのコメントに同じ種類のフェンスは1つだけ（2つあれば曖昧として拒否）。フェンスはバッククォート（```）のみ（`~~~` は読まない）。
- 信頼するのは App の名義で書かれた記録だけ。本文の目印は区別のためであり、信頼の根拠ではない。

## 計画（agent-plan）

````markdown
<!-- agent-harness:claude -->
## 計画

（方針、変更点、テスト方針、AC ごとの対応などを人が読める形で）

```agent-plan
{
  "version": 1,
  "issue": 12,
  "risk": "low",
  "needsHuman": false,
  "needsHumanReasons": [],
  "acChangeProposed": false,
  "openQuestions": [],
  "files": ["harness/lib/foo.ts", "harness/test/foo.test.ts", "docs/foo.md"]
}
```
````

| フィールド | 型 | 意味 |
| --- | --- | --- |
| `version` | `1` | 書式の版 |
| `issue` | 整数 | この計画の Issue 番号（コメント先と一致しなければゲートで停止） |
| `risk` | `low` / `medium` / `high` / `critical` | 想定 Risk（表示用。Merge 可否は実 diff の判定で決まる） |
| `needsHuman` | 真偽値 | 人間の判断が必要か |
| `needsHumanReasons` | 文字列の配列 | その理由 |
| `acChangeProposed` | 真偽値 | 要件・AC の変更提案があるか |
| `openQuestions` | 文字列の配列 | 人に確認したいこと |
| `files` | 文字列の配列 | **触るファイル一覧（必須）**。`*` と `**` が使える（`?` は文字どおり）。最初の階層にワイルドカードがあるものは不可 |
| `split` | 配列（任意） | Epic として子課題に分けるとき（2件以上）。下記 |
| `critique` | オブジェクト（任意） | 投稿前の批評の結果。`verdict`（`go` / `revise` / `split` / `drop`）と、批評させた回数 `rounds`（1以上の整数）と、任意で最後の回の必須の指摘の件数 `mustRemaining`（0以上の整数）。記録用で、ゲートの判断には使わない |

ゲート（App）は次のどれかに該当すると `agent:plan-review` で停止する：`needsHuman`、`acChangeProposed`、`openQuestions` が1件以上、`risk` が high 以上、`files` がガードレール（`harness.config.json` の `guardrailPaths`）に触れる（パターンどうしが重なりうれば触れるとし、除外に完全に含まれるパターンだけ外す）（`split` の子課題の `files` は見ない）、`files` が空・不正、`issue` 不一致、Issue に `agent:plan-review` が付いている。

### 子課題に分ける（split）

大きな課題は、計画に `split` を足して Epic にする。分け方は人が承認しない。ゲートの検査に通れば、App が子 Issue を作る（流れは [operations.md](operations.md#epic大きな課題を分ける)）。

```json
"files": [],
"split": [
  { "title": "feat(api): 認証の土台", "goal": "…", "requirements": ["…"], "acceptanceCriteria": ["…"], "files": ["src/auth/**"], "dependsOn": [] },
  { "title": "feat(ui): ログイン画面", "goal": "…", "requirements": ["…"], "acceptanceCriteria": ["…"], "files": ["web/login/**"], "dependsOn": [0] }
]
```

| フィールド | 型 | 意味 |
| --- | --- | --- |
| `title` | 文字列 | 子 Issue のタイトル（Conventional Commits） |
| `goal` | 文字列 | 子 Issue の Goal |
| `requirements` / `acceptanceCriteria` | 文字列の配列 | 子 Issue の Requirements・AC（1件以上） |
| `files` | 文字列の配列 | 子課題で触るファイル（`files` と同じ規則、1件以上）。兄弟どうしで重ならないこと |
| `dependsOn` | 整数の配列（省略可） | 先に終わらせる兄弟の添字。自分より前に並ぶものだけ（循環しない） |

`split` がある計画では、`files` は空でよく、`risk` は子課題の中で最も高いものを書く（表示用。Risk と空の `files` では止めない）。`needsHuman`・`acChangeProposed`・`openQuestions`・`issue` 不一致は通常どおり止める。子課題の `files` がガードレールに触れても止めない（分ける段階では子 Issue を作るだけで、子課題はそれぞれの計画でゲートがもう一度見る）。次のどれかに当たると、理由コード `split-invalid` で `agent:plan-review` にする：2件未満、タイトルの形式違い、Requirements・AC・`files` が空、`files` の規則違反、兄弟の `files` の重なり（同じパス、片方のパターンがもう片方に一致する、または両方がワイルドカードを含み、最初のワイルドカードより前の部分の片方がもう片方の先頭に一致する。例：`src/**/a.ts` と `src/x/**`）、`dependsOn` が自分より前の兄弟でない。

## 判定（agent-verdict）

Reviewer と Risk Agent の出力を1つにまとめる。`headSha` は判定した時点の PR の head。

````markdown
<!-- agent-harness:claude -->
## 判定

（Reviewer と Risk Agent の要約）

```agent-verdict
{
  "version": 1,
  "pr": 34,
  "headSha": "0123456789abcdef0123456789abcdef01234567",
  "review": {
    "pass": true,
    "blocking": [],
    "nonBlocking": ["関数名は動詞で始めるとよい"],
    "humanNotes": {
      "concerns": ["リンク先の見出しを変えるとアンカーが切れる"],
      "checkPoints": ["docs/glossary.md のリンク"]
    }
  },
  "risk": {
    "level": "low",
    "answers": {
      "q2_revertible": "yes",
      "q3_publicInterface": "no",
      "q4_tested": "yes",
      "q5_persistentData": "no",
      "q6_authBillingSecrets": "no",
      "q7_dependencies": "no",
      "q8_harnessConfig": "no"
    },
    "probabilities": { "low": 0.9, "medium": 0.08, "high": 0.02, "critical": 0 },
    "rationale": "docs のみの変更で、コードの参照元はない。"
  },
  "facts": {
    "references": "No code references the changed files.",
    "tests": "No tests needed; documentation only.",
    "fileKinds": "1 Markdown file under docs/."
  },
  "metrics": { "model": "claude-opus-5-5", "minutes": 6 }
}
```
````

- `review.blocking[].kind`：`ac-unmet` / `out-of-scope` / `typecheck-test-failure` / `data-destruction` / `secret-leak` / `regression`
- `review.pass` は `blocking` が空のときだけ `true`（矛盾していれば拒否）
- `review.humanNotes`（任意）：人にレビューを依頼するときの懸念点（`concerns`）と見てほしい箇所（`checkPoints`）。App の Human Merge の依頼コメントに載る
- `risk.answers` は `yes` / `no` / `unsure` の3択。安全側の答えは [risk-policy.md](risk-policy.md)
- `risk.probabilities` は記録のみ
- `facts` は Jev に渡す事実（英語）。Claude の判定を含めない


## 着手宣言（agent-claim）

`node harness/scripts/agent.ts render-claim`（人のセッションでは `claim <番号> --manual`）が書く。

```agent-claim
{ "by": "routine", "session": "https://claude.ai/code/session_...", "at": "2026-09-26T12:00:00.000Z" }
```

`"released": true` の解除コメントか、宣言より新しい計画・判定コメントで着手は終わる。`manual` の着手は Routine が奪わない（`humanClaimStaleHours` を過ぎると停滞として表示）。`routine` の着手は `routineClaimTakeoverMinutes`（既定 90 分）を過ぎたら引き継ぐ。

## App の記録（agent-app）

App はコメント先頭に `<!-- agent-harness:app kind=<種類> -->` を付け、機械可読の記録を ```` ```agent-app ```` に入れる。

| kind | 置き場所 | 内容 |
| --- | --- | --- |
| `plan-gate` | Issue | `{ planCommentId, planBodySha256, pass, reasons, plan }`。`plan` はゲート時点の計画の写し |
| `epic-split` | Issue（Epic の親） | `{ planCommentId, children }`。作った（または使い回した）子 Issue の番号を `split` の順に |
| `queue` | ダッシュボードの本文 | `{ computedAt, actions, skipped }`。Routine が次にやること |
| `acceptance` | PR | `{ verdictCommentId, verdictHeadSha, patchId, reviewPass, riskLevel, riskOk, scopeOk, outside, autoEligible, reasons, jev }` |
| `verdict-rejected` | PR | 判定を受け付けなかった理由 |
| `test-exempt` / `review-exempt` | PR | 例外ラベルの付け外し。`{ label, action, by, patchId, headSha }`。`action` は `labeled` / `unlabeled`、`patchId` と `headSha` は人が付け外しした時点の差分と head。最新が `labeled` で `patchId` が現在の差分と同じときだけ例外が効く |
| `exempt-stale` | PR | 例外ラベルが付いているが効いていないことの通知。`{ label, headSha, patchId, reason }`。`reason` は `stale`（付けた後に差分が変わった）/ `unrecorded`（付けた記録が無い）。同じ `label` と `headSha` には1回だけ書く |
| `fix-request` | PR（レビュー） | Reviewer のブロッキング指摘（修正回数はこの数で数える） |
| `issue-triage` | Issue | Jev による分類の提案と、その確率 |
| `human-review` / `priority-conflict` / `hold-removed` / `plan-ok-removed` / `form-error` / `unblocked` / `parent-closed` / `epic-inherit` / `epic-split-failed` / `auto-merge-stopped` / `dashboard` | 各所 | 通知・記録 |
