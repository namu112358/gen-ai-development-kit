# 構造化コメントの書式

Claude（Routine・付き添いのセッション）と App は、コメントに JSON のフェンスを埋め込んで状態を受け渡す。
投稿前に `node harness/scripts/agent.ts render-plan` / `render-verdict`（付き添いのセッションでは `post-plan` / `post-verdict`）で検査し、App も受け付け時に同じ検査をする。

| フェンス | 書く者 | 置き場所 | 検査 |
| --- | --- | --- | --- |
| ```` ```agent-plan ```` | Claude | Issue コメント | `harness/lib/plan.ts` |
| ```` ```agent-verdict ```` | Claude | PR コメント | `harness/lib/verdict.ts` |
| ```` ```agent-claim ```` | Claude | Issue / PR コメント | `harness/lib/queue.ts` |
| ```` ```agent-decision ```` | 付き添いのセッション（Routine は書かない） | Issue コメント | `harness/lib/decision.ts` |
| ```` ```agent-app ```` | App のみ | Issue / PR コメント | App の名義のものだけ信頼する |

共通ルール：

- Claude のコメントは先頭に `<!-- agent-harness:claude -->` を付ける。書いたセッションの ID が分かるときは `<!-- agent-harness:claude session=<id> -->` にする（付き添いのセッションは SessionStart の hook が書く `AGENT_HARNESS_SESSION`、Routine はセッションの URL）。どちらの形も目印として読む。
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

Issue に `agent:plan-review` が付いているときの出し直しは、App の最新の計画ゲートの記録（`agent-app` ブロックの `planReviewOrigin`）で扱いを決める。`planReviewOrigin` は停止の記録に書く出どころで、`gate` は App のゲートの停止（critical・ガードレール・`files` の欠落・`split-invalid`・`resplit` など。止めた計画に Planner の申告が無く、止める前に印が付いていなかった）、`planner` は Planner の申告（`needsHuman`・`acChangeProposed`・`openQuestions`）か、App が止める前から付いていた印（Planner か人が付けた）。記録が `gate` の停止で、最後に `agent:plan-review` を付けたのが App なら、前の印を理由に止めず新しい計画だけで判定する（通れば App が `agent:plan-review` を外して `agent:plan-ok` を付け、当たればまた `gate` で止まる）。記録が無い・`planner`・`planReviewOrigin` の無い古い記録なら、人が外すまで止める。`post-plan` / `render-plan` が先に付ける `agent:plan-review` は、Planner の申告があるときだけ。Planner の申告（`needsHuman`・`openQuestions`）で止まった計画は、付き添いのセッションが人の答えを[決定の記録](#決定の記録agent-decision)で残すと、App が Jev に確かめさせ、`jev.decisionRelease` が `enforce` でしきい値以上なら答え済みとして判定し直す（通れば App が印を外す。ほかの理由で当たれば `gate` の停止として残る）。

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

Reviewer と Risk Agent の出力を1つにまとめる。`headSha` は判定した時点の PR の head。判定の後に main の取り込みなどで今の head と違っても、PR 自身の差分（`<base>...<head>` の patch-id）が同じなら判定した head のまま組み立て・投稿する（App は patch-id の一致で受け付ける）。差分が違えば判定し直す。

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

- `review.blocking[].kind`：`ac-unmet` / `out-of-scope` / `typecheck-test-failure` / `data-destruction` / `secret-leak` / `regression` / `bug`（合体版のレビューの②〜⑤の観点で、確信度 80 以上の不具合） / `claude-md`（①の CLAUDE.md の決まりへの違反で、確信度 80 以上）。`bug`・`claude-md` は今の reviewer（`.claude/agents/reviewer.md`）は出さない。修正の上限は通常と同じ（critical でない）
- `review.pass` は `blocking` が空のときだけ `true`（矛盾していれば拒否）
- `review.humanNotes`（任意）：人にレビューを依頼するときの懸念点（`concerns`）と見てほしい箇所（`checkPoints`）。App の Human Merge の依頼コメントに載る
- `risk.answers` は `yes` / `no` / `unsure` の3択。安全側の答えは [risk-policy.md](risk-policy.md)
- `risk.probabilities` は記録のみ
- `facts` は記録と人の確認用の事実（日本語）。Jev には渡さない。Claude の判定を含めない


## 着手宣言（agent-claim）

`node harness/scripts/agent.ts render-claim`（付き添いのセッションでは `claim <番号> --manual`）が書く。

```agent-claim
{ "by": "routine", "session": "https://claude.ai/code/session_...", "at": "2026-09-26T12:00:00.000Z" }
```

付き添いのセッションの宣言（`claim <番号> --manual [--stage <段階>]`）には、任意で `session`（セッションの ID）と `stage`（`plan`・`plan-critique`・`plan-gate`・`implement`・`judge`・`fix`・`sync`）が入る。古い宣言（どちらも無い）も読む。

```agent-claim
{ "by": "manual", "session": "3f2a9c1e-…", "stage": "plan-critique", "at": "2026-09-27T12:00:00.000Z" }
```

- 宣言の `session` が今のセッションの ID と同じ（どちらも空でない）なら自分の宣言として扱い、`fleet-status`・`queue` は「ほかのセッションが着手中」にしない。段階とセッションの短い形は、`fleet-status` の表とダッシュボードの理由に出る。
- `claim --manual` は、ほかのセッションの有効な手動の宣言があれば止まる（期限を過ぎていても）。同じセッションなら段階の更新として通る。引き継ぐのは人が決めたときだけ `--takeover`（`--force` は領域の上限だけを飛ばす）。
- `critic-input`・`post-plan`・`worktree`（`claude/issue-<番号>-` のブランチ。開いた PR があれば PR の宣言）は、このセッションの宣言が無いと止まる（Routine では確かめない）。`post-plan` は投稿の後、ゲートを通る見込みなら段階 `plan-gate` の宣言を出し直し、通らない見込み（`agent:plan-review` で人の判断待ち）なら解除のコメントを出す（`harness/lib/queue.ts` の `claimAfterPlan`）。宣言より新しい計画コメントでも宣言は終わった扱いになるが、解除のコメントを出すのは、ほかのセッションとダッシュボードに「このセッションが手を離した」ことが見えるようにするため。

`"released": true` の解除コメントか、宣言より新しい計画・判定コメントで着手は終わる。`manual` の着手は Routine が奪わない（`humanClaimStaleHours` を過ぎると停滞として表示）。`routine` の着手は `routineClaimTakeoverMinutes`（既定 90 分）を過ぎたら引き継ぐ。

## 決定の記録（agent-decision）

Planner の申告（`needsHuman`・`openQuestions`）への人の答えを、付き添いのセッションが記録する（`node harness/scripts/agent.ts post-decision <番号> <ファイル>`）。人のいない Routine は書かない（[.claude/routine.md](../.claude/routine.md)）。

````markdown
<!-- agent-harness:claude -->
## 人の決定

（人が読める要約）

```agent-decision
{
  "version": 1,
  "issue": 151,
  "planCommentId": 1234567890,
  "answers": [
    { "to": "question:0", "choice": "shadow から始める", "quote": "shadow で。一致率を見てから決める", "at": "2026-09-27T10:00:00+09:00" },
    { "to": "reason:0", "quote": "Routine は禁止だけでよい", "at": "2026-09-27T10:02:00+09:00" }
  ]
}
```
````

- `planCommentId` は答える計画コメント（App の最新の計画ゲートの記録の `planCommentId` と同じもの）。
- `answers[].to` は `reason:<添字>`（計画の `needsHumanReasons`。`needsHuman` が true で理由が空なら `reason:0` の1件）か `question:<添字>`（`openQuestions`）。すべての項目に答えが要り、存在しない添字は拒否する。
- `quote` は人の言葉そのまま（空は不可）。選択肢で答えたときは `choice` に選んだ項目を書き、`quote` に書き添えた文を書く。`at` は ISO 8601 の日時。
- App が外すのは、最新の計画ゲートの記録が Planner の申告（`planReviewOrigin: planner`）の停止で、印がその計画の投稿（`post-plan`）か App の停止で付いたものだけ（`harness/lib/decision.ts` の `decisionEligibility`）。App のゲートの停止・人が付けた印・`acChangeProposed` は、この経路で外れない。
- App が Jev に渡すのは、App の記録にある計画の写しの `needsHumanReasons`・`openQuestions` と、答えの `to`・`choice`・`quote` だけ（本文の要約と `at` は渡さない）。

## App の記録（agent-app）

App はコメント先頭に `<!-- agent-harness:app kind=<種類> -->` を付け、機械可読の記録を ```` ```agent-app ```` に入れる。

| kind | 置き場所 | 内容 |
| --- | --- | --- |
| `plan-gate` | Issue | `{ planCommentId, planBodySha256, pass, reasons, plan, decisionCommentId? }`。`plan` はゲート時点の計画の写し。`decisionCommentId` は決定の記録で判定し直したときのコメント |
| `plan-decision` | Issue | 決定の記録を App が確かめた結果。`{ version, decisionCommentId, planCommentId, mode, questionSet, threshold, status, model, answers, pass, missing, regate }`。`status` は `ok` / `invalid`（書式・答えの無い項目）/ `ineligible`（対象外）/ `skipped`（鍵が無い・大きすぎる）/ `error`。`mode` が `shadow` なら記録だけでラベルは変えない。`regate` は `enforce` で判定し直したか。同じ `decisionCommentId` には二度問わない |
| `epic-split` | Issue（Epic の親） | `{ planCommentId, children }`。作った（または使い回した）子 Issue の番号を `split` の順に |
| `queue` | ダッシュボードの本文 | `{ computedAt, actions, skipped }`。Routine が次にやること |
| `acceptance` | PR | `{ verdictCommentId, verdictHeadSha, patchId, reviewPass, riskLevel, riskOk, scopeOk, outside, autoEligible, reasons, jev, delegate, bypass }`。`delegate`（`eligible`・`reasons`・`skipped`・`scopeOk`・`outside`・`exclude`）は委任 Merge なら自動経路に乗せてよいか：`skipped` は委任で飛ばす理由（ガードレール・Risk）、`reasons` は委任でも乗せない理由、`scopeOk`・`outside` はゲートを通った計画かゲートの停止（`planReviewOrigin: gate`）で止まった計画との範囲照合、`exclude` は `delegateMergeExclude` に当たったファイル（harness/lib/delegate.ts）。`delegate` の無い古い記録は委任の対象外。`bypass`（`eligible`・`reasons`・`skipped`）は bypass モードなら自動経路に乗せてよいか：`skipped` は bypass で飛ばす理由（Risk・ガードレール・`humanMergePaths`・`delegateMergeExclude`・Jev）、`reasons` は bypass でも乗せない理由（Agent の PR でない・base・ブロッキング指摘・`delegate` と同じ計画との範囲照合）（harness/gates/bypass.ts）。`bypass` の無い古い記録は bypass の対象外。`jev` の `questionSet` は Jev への問いの版（無い古い記録は版 1）。`jev.size`（`chars`・`jaRatio`・`inputTokens`・`diffChars`、Jev が応答したときだけ）は送った材料の大きさ：state と問いを JSON にした文字数、そのうち日本語の文字の割合、応答の `usage.input_tokens`（報告されなければ `null`）、diff の文字数 |
| `delegated-merge` | PR | 委任 Merge で auto-merge を付けたときの記録。`{ headSha, patchId, since, until, by, skipped }`。`since`・`until`・`by` は委任（ダッシュボードのラベル）を付けた時刻・期限・人、`skipped` は受け付けの `delegate.skipped`（委任で飛ばした理由）。同じ `patchId` と `until` の記録が最新なら書き直さない。期限切れの掃除とダッシュボードの「委任 Merge で Merge された PR」はこの記録で見る（harness/gates/delegation.ts） |
| `bypass-merge` | PR | bypass モードで auto-merge を付けたときの記録。`{ headSha, patchId, since, by, skipped }`。`since`・`by` は bypass（ダッシュボードのラベル）を付けた時刻・人、`skipped` は受け付けの `bypass.skipped`。同じ `patchId` と `since` の記録が最新なら書き直さない。ダッシュボードの「bypass で Merge された PR」はこの記録で見る（harness/gates/bypass.ts） |
| `bypass-merge-end` | PR | bypass で付けた auto-merge を外した記録。`{ headSha, reason }`。`reason` は `removed`（ラベルを外した）/ `stopped`（停止スイッチ）/ `ineligible`（bypass の条件を満たさなくなった。委任に引き継いだときも）。最新が `bypass-merge` の PR にだけ書く |
| `delegated-merge-end` | PR | 委任で付けた auto-merge を外して Human Merge に戻した記録。`{ headSha, reason }`。`reason` は `removed`（ラベルを外した）/ `expired`（期限切れ）/ `stopped`（停止スイッチ）/ `short`（期限までの残りが `minRemainingMinutes` 未満）/ `ineligible`（委任の条件を満たさなくなった）。最新が `delegated-merge` の PR にだけ書く |
| `verdict-rejected` | PR | 判定を受け付けなかった理由 |
| `test-exempt` / `review-exempt` | PR | 例外ラベルの付け外し。`{ label, action, by, patchId, headSha }`。`action` は `labeled` / `unlabeled`、`patchId` と `headSha` は人が付け外しした時点の差分と head。最新が `labeled` で `patchId` が現在の差分と同じときだけ例外が効く |
| `exempt-stale` | PR | 例外ラベルが付いているが効いていないことの通知。`{ label, headSha, patchId, reason }`。`reason` は `stale`（付けた後に差分が変わった）/ `unrecorded`（付けた記録が無い）。同じ `label` と `headSha` には1回だけ書く |
| `unclaimed-push` | PR | 着手宣言の無いセッションの push の通知（止めない）。`{ headSha, reason, commitSessions, claimSessions }`。`reason` は `no-claim`（push の時点で PR にも Close する Issue にも有効な宣言が無い）/ `session-mismatch`（commit の `Claude-Session` が宣言のセッションと食い違う）。セッションは短い形。同じ `headSha` には1回だけ書く |
| `fix-request` | PR（レビュー） | Reviewer のブロッキング指摘（修正回数はこの数で数える） |
| `issue-triage` | Issue | Jev による分類の提案と、その確率 |
| `label-triage` | Issue | `classification.issueTriage` が `label` のときに Jev に問った結果と付けたラベル。`{ model, answers, threshold, added, notApplied, size }`。`size`（`chars`・`jaRatio`・`inputTokens`）は `acceptance` の `jev.size` と同じ意味。`notApplied` は付けなかったもの（確率が下限未満、下限が未設定、当たるラベルが無い）と理由。`issue-triage` か `label-triage` がある Issue には二度と問わない |
| `label-mismatch` | Issue / PR | 人が付けた（App が付けたと確かめられない）`type:*` がタイトルと食い違う、または Epic に付いていることの通知。`{ title, labels }`。同じタイトルと同じラベルには1回だけ書く |
| `human-review` / `priority-conflict` / `hold-removed` / `plan-ok-removed` / `form-error` / `unblocked` / `parent-closed` / `epic-inherit` / `epic-split-failed` / `auto-merge-stopped` / `delegate-merge-switch` / `bypass-merge-switch` / `dashboard` | 各所 | 通知・記録 |
