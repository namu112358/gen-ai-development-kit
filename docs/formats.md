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

ゲート（App）は次のどれかに該当すると `agent:plan-review` で停止する：`needsHuman`、`acChangeProposed`、`openQuestions` が1件以上、`risk` が high 以上、`files` が空・不正、`issue` 不一致、Issue に `agent:plan-review` が付いている。

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
    "nonBlocking": ["関数名は動詞で始めるとよい"]
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
- `risk.answers` は `yes` / `no` / `unsure` の3択。安全側の答えは [risk-policy.md](risk-policy.md)
- `risk.probabilities` は記録のみ
- `facts` は Jev に渡す事実（英語）。Claude の判定を含めない


## 着手宣言（agent-claim）

`node harness/scripts/agent.ts render-claim`（人のセッションでは `claim <番号> --manual`）が書く。

```agent-claim
{ "by": "routine", "session": "https://claude.ai/code/session_...", "at": "2026-09-26T12:00:00.000Z" }
```

`manual` の着手は Routine が奪わない。`routine` の着手は `routineClaimTakeoverMinutes`（既定 90 分）を過ぎたら引き継ぐ。

## App の記録（agent-app）

App はコメント先頭に `<!-- agent-harness:app kind=<種類> -->` を付け、機械可読の記録を ```` ```agent-app ```` に入れる。

| kind | 置き場所 | 内容 |
| --- | --- | --- |
| `plan-gate` | Issue | `{ planCommentId, planBodySha256, pass, reasons, plan }`。`plan` はゲート時点の計画の写し |
| `queue` | ダッシュボードの本文 | `{ computedAt, actions, skipped }`。Routine が次にやること |
| `acceptance` | PR | `{ verdictCommentId, verdictHeadSha, patchId, reviewPass, riskLevel, riskOk, scopeOk, outside, autoEligible, reasons, jev }` |
| `verdict-rejected` | PR | 判定を受け付けなかった理由 |
| `fix-request` | PR（レビュー） | Reviewer のブロッキング指摘（修正回数はこの数で数える） |
| `issue-triage` | Issue | Jev による分類の提案と、その確率 |
| `human-review` / `priority-conflict` / `hold-removed` / `plan-ok-removed` / `form-error` / `unblocked` / `parent-closed` / `auto-merge-stopped` / `dashboard` | 各所 | 通知・記録 |
