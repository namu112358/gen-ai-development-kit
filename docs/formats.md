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
| ```` ```arch-review ```` | 付き添いのセッション（arch-review の skill） | ダッシュボード Issue のコメント | `harness/lib/arch-review.ts` |

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
| `critique` | オブジェクト（任意） | 投稿前の批評の結果。`verdict`（`go` / `revise` / `split` / `drop`）と、批評させた回数 `rounds`（1以上の整数）と、任意で最後の回の必須の指摘の件数 `mustRemaining`（0以上の整数）。無い計画は計画ゲートで止まる（`verdict` の値そのものでは止めない） |

ゲート（App）は次のどれかに該当すると `agent:plan-review` で停止する：`needsHuman`、`acChangeProposed`、`openQuestions` が1件以上、`risk` が high 以上、`files` がガードレール（`harness.config.json` の `guardrailPaths`）に触れる（パターンどうしが重なりうれば触れるとし、除外に完全に含まれるパターンだけ外す）（`split` の子課題の `files` は見ない）、`files` が空・不正、`issue` 不一致、Issue に `agent:plan-review` が付いている、`critique` が無い、計画コメントより前に同じ Issue への段階 `plan-critique` の着手宣言（コラボレーターの、Claude の目印付きの `agent-claim`。解除は数えない。`manual`・`routine` のどちらでもよい）が無い（批評の関所。`split` の計画も同じ。「前」はコメントの ID の大小で決める）。批評の関所だけで止めたときの理由コードは `no-critique`（ほかの理由と重なるときは今までのコード）。`critique` が `revise` で `mustRemaining` が1以上の計画は、人が必須の指摘を残して進めると決めた計画として止めず、ゲートの記録の `critiqueProceeded` に残す。

委任承認（ダッシュボードの `agent:delegate-plan` か `agent:delegate-merge`。[risk-policy.md](risk-policy.md#委任承認)）が有効な間は、止まる理由が `risk` の high 以上とガードレールだけなら、App は止めずに `agent:plan-ok` を付け、記録 `plan-gate` に `delegated` を書く。Planner の申告、`issue` 不一致、`files` の欠落・書式の誤り、`split` の不正、人が付けた `agent:plan-review`、批評の関所（`critique` が無い・`plan-critique` の着手宣言が無い）、`delegateMergeExclude` か `harness.config.json` に重なりうる `files`（`harness/**` のような広いパターンも重なりうれば当たる。`delegateMergeExclude` が無い設定ではすべて当たる）は、委任の間も止まる。委任が有効になったときと定期実行で、App のゲートの停止（ガードレール・Risk だけ、印は App が付けた）で止まっている Issue を判定し直し、通れば `agent:plan-ok` にする（Planner の申告・人の印・exclude に当たるもの・批評の関所に当たるもの・計画コメントの本文が変わったものは止まったまま）。ラベルの名前は `harness.config.json` の `"delegate": { "planLabel": "agent:delegate-plan", "mergeLabel": "agent:delegate-merge" }`。古い `delegateMerge.label` だけの設定は `mergeLabel` として読み（`delegate` が優先）、古い `hours`・`minRemainingMinutes` は読まない。

Issue に `agent:plan-review` が付いているときの出し直しは、App の最新の計画ゲートの記録（`agent-app` ブロックの `planReviewOrigin`）で扱いを決める。`planReviewOrigin` は停止の記録に書く出どころで、`gate` は App のゲートの停止（critical・ガードレール・`files` の欠落・`split-invalid`・`resplit` など。止めた計画に Planner の申告が無く、止める前に印が付いていなかった）、`planner` は Planner の申告（`needsHuman`・`acChangeProposed`・`openQuestions`）か、App が止める前から付いていた印（Planner か人が付けた）。記録が `gate` の停止で、最後に `agent:plan-review` を付けたのが App なら、前の印を理由に止めず新しい計画だけで判定する（通れば App が `agent:plan-review` を外して `agent:plan-ok` を付け、当たればまた `gate` で止まる）。`planReviewOrigin` の無い古い記録（64f6e68 より前の記録）は、止まった記録で、記録の計画に `needsHuman`・`acChangeProposed`・`openQuestions` がそろっていて Planner の申告が無く、理由に前の印で止めたもの（「`agent:plan-review` が付いています」で始まる理由）が無ければ `gate` とみなす（`harness/lib/plan.ts` の `recordedOrigin`）。記録が無い・`planner`・`gate` とみなせない古い記録なら、人が外すまで止める。`post-plan` / `render-plan` が先に付ける `agent:plan-review` は、Planner の申告があるときだけ。Planner の申告（`needsHuman`・`openQuestions`）で止まった計画は、付き添いのセッションが人の答えを[決定の記録](#決定の記録agent-decision)で残すと、App が Jev に確かめさせ、`jev.decisionRelease` が `enforce` でしきい値以上なら答え済みとして判定し直す（通れば App が印を外す。ほかの理由で当たれば `gate` の停止として残る）。

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

- `review.blocking[].kind`：`ac-unmet` / `out-of-scope` / `typecheck-test-failure` / `data-destruction` / `secret-leak` / `regression` / `bug`（合体版のレビューの②〜⑤の観点で、確信度 75 以上の不具合） / `claude-md`（①の CLAUDE.md の決まりへの違反で、確信度 75 以上）。`bug`・`claude-md` は今の reviewer（`.claude/agents/reviewer.md`）は出さない。修正の上限は通常と同じ（critical でない）
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

付き添いのセッションの宣言（`claim <番号> --manual [--stage <段階>]`）には、任意で `session`（セッションの ID）と `stage`（`plan`・`plan-critique`・`plan-gate`・`implement`・`judge`・`fix`・`sync`）が入る。古い宣言（どちらも無い）も読む。`--takeover` で出した宣言には `"takeover": true` が入る（ほかのセッションの持ち主から引き継いだ印。`--takeover` でない宣言には書かない）。

```agent-claim
{ "by": "manual", "session": "3f2a9c1e-…", "stage": "plan-critique", "at": "2026-09-27T12:00:00.000Z" }
```

- 宣言の `session` が今のセッションの ID と同じ（どちらも空でない）なら自分の宣言として扱い、`fleet-status`・`queue` は「ほかのセッションが着手中」にしない。段階とセッションの短い形は、`fleet-status` の表とダッシュボードの理由に出る。
- 持ち主の決め方（`harness/lib/facts.ts` の `claimOf`）：**最初の宣言が持ち主**。コメントを古い順に見て、持ち主がいなければ解除でない宣言のセッションが持ち主になる。持ち主と同じセッション（`by` と `session` が同じ。`session` の無い古い宣言同士も含む）の宣言は段階の更新で、解除なら持ち主がなくなる。ほかのセッションの宣言は、`takeover: true` か、持ち主が `routine` の宣言のときだけ持ち主を移し、それ以外（ほかのセッションの解除も）は無視する。計画・判定コメントで持ち主がなくなる。有効な着手宣言は持ち主の最新の段階の宣言。
- `claim --manual` は、ほかのセッションの有効な手動の宣言があれば止まる（期限を過ぎていても）。同じセッションなら段階の更新として通る。引き継ぐのは人が決めたときだけ `--takeover`（`--force` は領域の上限だけを飛ばす）。このセッションの ID が得られなければ投稿せずに止まる（`release` も同じ）。
- 読み直し（`harness/lib/claim.ts` の `postClaim`）：`claim` は投稿の後に少し（5秒）待って読み直し、持ち主が自分でなければ（ほぼ同時にほかのセッションが先に宣言した）、自分の宣言を取り下げる解除のコメント（`released: true`）を書き、先に宣言したセッションを示して 0 以外で終わる。ほかのセッションの解除は持ち主を消さないので、取り下げで先の側の宣言は消えない。
- `critic-input`・`post-plan`・`worktree`（`claude/issue-<番号>-` のブランチ。開いた PR があれば PR の宣言）・`ensure-claim <番号>`（PR を作る前に使う）は、このセッションの宣言（持ち主）が無いと止まる。読み直しで気づかなくても、ここで同じ決め方で止まる。定期 Routine は `worktree … --routine` で確かめを飛ばす（Routine の環境には `gh` が無い）。`post-plan` は投稿の後、ゲートを通る見込みなら段階 `plan-gate` の宣言を出し直し、通らない見込み（`agent:plan-review` で人の判断待ち）なら解除のコメントを出す（`harness/lib/queue.ts` の `claimAfterPlan`）。宣言より新しい計画コメントでも宣言は終わった扱いになるが、解除のコメントを出すのは、ほかのセッションとダッシュボードに「このセッションが手を離した」ことが見えるようにするため。

持ち主の `"released": true` の解除コメントか、宣言より新しい計画・判定コメントで着手は終わる。`manual` の着手は Routine が奪わない（`humanClaimStaleHours` を過ぎると停滞として表示）。`routine` の着手は `routineClaimTakeoverMinutes`（既定 90 分）を過ぎたら引き継ぐ。

## agent.ts step の出力

`node harness/scripts/agent.ts step <番号> [--plan <計画のファイル> | --critique <批評のファイル>] [--proceed]` は、付き添いのセッションで今やってよいノードを1つだけ返す（JSON。判断は `harness/lib/step.ts` の `decideStep`、#306）。段階は `fleet-status` と同じ事実と判断（`harness/lib/fleet.ts` の `issueNode`）で決め、前提（セッションの ID・担当・着手宣言）、ループの上限、同じ指摘の繰り返しを確かめる。`kind` は次の3つで、終了コードは `node`・`wait` が 0、`stop` が 2（引数・設定の誤りは 1）。

```json
{ "version": 1, "kind": "node", "issue": 306, "pr": null, "node": "implement", "skill": "implement",
  "claim": { "target": 306, "stage": "implement" }, "preconditions": ["…"], "allowed": ["…"], "inputs": ["…"], "output": "…",
  "branch": null, "branchPrefix": "claude/issue-306-", "files": ["harness/lib/step.ts"] }
```

| `kind` | 中身 |
| --- | --- |
| `node` | `node`（`plan`・`plan-critique`・`implement`・`judge`・`fix`・`sync`）と使う `skill`、宣言する番号と段階 `claim`（judge・fix・sync は PR 番号）、確かめ済みの前提 `preconditions`、使ってよい操作 `allowed`、読むもの `inputs`、出すものの書式 `output`、ブランチ `branch`（PR の head。無ければ null）と接頭辞 `branchPrefix`、計画ゲートの記録の計画の `files`（計画の前は null）。`step` がこの宣言を出す（同じ段階の自分の宣言があれば出さない） |
| `wait` | `waitingFor`：`app`（計画ゲート・判定の受け付け・Merge の経路・auto-merge）、`human`（人の Merge 待ち、人の PR の修正・取り込み）、`area-limit`（`areaConcurrency` の上限。`--force` は付けず人・fleet が決める）、`done`（Merge 済み）と `detail`。宣言は変えない |
| `stop` | 理由コード `reason`、`detail`、このセッションの宣言を解除したか `released` |

`stop` の理由コード：

| 理由 | いつ | 宣言 |
| --- | --- | --- |
| `no-session` | このセッションの ID が無いか、付き添いのセッションの形（英数字と `-` `_`）でない（Routine は `queue` を使う） | 書き込まない |
| `hold`・`blocked`・`waiting`・`epic`・`dependency` | Issue・PR の止まる印、Epic、未解決の依存 | 解除する |
| `fix-limit` | PR が `agent:blocked` で、App・Claude の最新の理由コードが `fix-limit` | 解除する |
| `plan-review` | 計画ゲートで人の判断待ち（`--proceed` が無い） | 解除する |
| `assignee` | `requireAssignee` が有効で、Assignee が自分1人でない | 解除する |
| `claimed` | ほかのセッションの有効な手動の宣言がある（`claim` と同じ `claimBlocker`。期限切れでも）か、宣言の読み直しで後の側になった | 解除しない（自分のものではない） |
| `sync-limit` | PR の main からの取り込み（親が2つの commit）が `syncLoop.limit` に達した後に、もう一度 sync が要る | 解除する |
| `repeated-finding` | fix：App の直近2つの変更要求レビュー（`kind=fix-request`）に同じ指摘（`kind` と `file` が同じ。`file` の無い指摘は `kind` と `detail` が同じ）がある。批評：前回と同じ必須の指摘が残る `revise` | fix は解除する。批評は解除しない |
| `critique-limit` | 3回目の批評でも必須の指摘が残る | 解除しない |
| `other` | plan-critic の判定が `drop` | 解除しない |

- 批評の止まり方（`critique-limit`・批評の `repeated-finding`・`drop`）は、Issue の Requirements の「stop のときは自分の宣言だけを解除する」の例外で、宣言を残す。有人セッションで人が「進める」と決めれば `post-plan` で投稿し、`post-plan` は `ensureOwnClaim` でこのセッションの宣言を確かめるため。「やめる」なら skill の手順で `release` する。ほかの stop で `step` が解除した後は、`release` を呼ばなくてよい。
- 計画の段階は、段階のファイルの中だけで進む：`--plan <file>` は計画を書いた後（`agent.ts check` と同じ検査。通れば宣言を `plan-critique` にして node `plan-critique`、誤りがあれば node `plan` の `inputs` に誤り）、`--critique <file>` は plan-critic の出力を渡すとき（`go`・`split` なら node `plan-critique` の `allowed` に `post-plan`、`revise` は上限と繰り返しを見て node `plan`）。
- `--proceed` は、人が `agent:plan-review` の計画を進めると決めたとき（計画コメントがあれば node `implement`）。人の答えが Planner の申告への答えなら、先に決定の記録（`post-decision`）を残す。
- `step` は1件の Issue で読むので、自分の PR が開いている間は「Merge 済みの PR があり main に追従していない」の sync は起きず、sync は main と衝突したときだけ（fleet は `fleet-status` で集合を見て決める）。
- `sync ⇄ judge` の上限は `harness.config.json` の `"syncLoop": { "limit": 3 }`（正の整数。無ければ 3。`harness/lib/config.ts` の `syncLoopConfig`。書式が違えば `step` は GitHub を読む前にエラー）。

### 段階のファイル

`step` は結果を、git の共通ディレクトリ（`git rev-parse --path-format=absolute --git-common-dir`。worktree からも同じ）の下の `agent-harness/stage/<セッションの ID>.json` に毎回書き直す（`harness/lib/stage-file.ts`。commit されない）。段階に合わない操作を止める hook（別 Issue）がこれを読む。

```json
{ "version": 1, "session": "3f2a9c1e-…", "at": "2026-09-30T12:00:00.000Z", "issue": 306, "pr": null, "node": "implement", "kind": "node",
  "branch": null, "branchPrefix": "claude/issue-306-", "files": ["harness/lib/step.ts"],
  "critique": { "issue": 306, "gateAt": null, "rounds": [{ "verdict": "revise", "must": ["…"] }, { "verdict": "go", "must": [] }] } }
```

`critique` は批評の回（判定と必須の指摘の文）で、同じ Issue・同じ計画ゲートの記録の時刻（`gateAt`）の間だけ引き継ぐ（Issue が変わるか、計画ゲートの記録が新しくなれば空に戻す）。読めない・書式が違うファイルは無いものとして扱う。

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

## arch-review の記録

arch-review の skill（[.claude/skills/arch-review/SKILL.md](../.claude/skills/arch-review/SKILL.md)）が、見た範囲と要約を残す（`node harness/scripts/agent.ts arch-review-record <ファイル>`。`--dry-run` は本文を出すだけ）。置き場所は App が作ったダッシュボード Issue（`dashboardIssueTitle`）へのコメント。ダッシュボードの本文は App が書き換えるので本文には書かない。

````markdown
<!-- agent-harness:claude session=<id> -->
arch-review の記録です（…）。次の arch-review はここから読みます。

見つけたずれ：
- 着手宣言の読み取りが2か所にある

作った Issue：
- #201 refactor(harness): 着手宣言の読み取りを1か所にする

```arch-review
{
  "version": 1,
  "baseSha": "前回の headSha（無ければ null）",
  "headSha": "今回見た main の SHA（40桁）",
  "prs": [157, 158],
  "summary": ["着手宣言の読み取りが2か所にある"],
  "drafts": [{ "title": "refactor(harness): 着手宣言の読み取りを1か所にする", "created": 201 }]
}
```
````

| フィールド | 内容 |
| --- | --- |
| `version` | 書式の版（`1`） |
| `baseSha` | 見た範囲の始まり（前回の記録の `headSha` か `--since`。直近 N 本を見たときは `null`） |
| `headSha` | 見た既定ブランチの SHA（40桁）。次の実行はここから読む |
| `prs` | 見た Merge 済みの PR の番号 |
| `summary` | 見つけたずれの要約（1件1行） |
| `drafts` | 人に示した下書き。`created` は人が選んで作った Issue の番号（作らなかったものは `null`） |

- フェンスの名前は `agent-` で始まらない。App の記録（`agent-*`）と混同せず、`gate.yml` の `if:` にも当たらないので、ゲートは起動しない。App の記録ではなく、PR ごとの判定の材料にもしない。
- 次の実行（`arch-review-range`）は、ダッシュボード Issue のコメントのうち、コラボレーター（OWNER・MEMBER・COLLABORATOR。App を除く）が書いた Claude の目印付きで、```` ```arch-review ```` が1つだけあり JSON が正しいものの最新を前回とする（`harness/lib/arch-review.ts` の `latestArchReviewRecord`）。ダッシュボードが無ければ前回なしとして扱う。
- 下書きは `node harness/scripts/agent.ts arch-review-drafts <ファイル>` で検査する（`[{ title, body, duplicateOf? }]`。タイトルは Conventional Commits、本文は Issue Form の必須の見出し、`labels` に `agent:ready` があれば誤り）。

## App の記録（agent-app）

App はコメント先頭に `<!-- agent-harness:app kind=<種類> -->` を付け、機械可読の記録を ```` ```agent-app ```` に入れる。

| kind | 置き場所 | 内容 |
| --- | --- | --- |
| `plan-gate` | Issue | `{ planCommentId, planBodySha256, pass, reasons, plan, decisionCommentId?, critiqueProceeded?, delegated? }`。`plan` はゲート時点の計画の写し。`decisionCommentId` は決定の記録で判定し直したときのコメント。`critiqueProceeded`（`{ verdict: 'revise', mustRemaining }`）は、批評で必須の指摘が残ったまま人が進めると決めて通った計画（古い記録には無い）。`delegated`（`{ skipped, label, mode, by, since }`）は委任承認で通したときだけ：`skipped` は委任で飛ばした理由（ガードレール・Risk）、`label` は有効だったラベル、`mode` は `plan`（`agent:delegate-plan`）か `plan+merge`（`agent:delegate-merge`）、`by`・`since` はラベルを付けた人と時刻 |
| `plan-decision` | Issue | 決定の記録を App が確かめた結果。`{ version, decisionCommentId, planCommentId, mode, questionSet, threshold, status, model, answers, pass, missing, regate }`。`status` は `ok` / `invalid`（書式・答えの無い項目）/ `ineligible`（対象外）/ `skipped`（鍵が無い・大きすぎる）/ `error`。`mode` が `shadow` なら記録だけでラベルは変えない。`regate` は `enforce` で判定し直したか。同じ `decisionCommentId` には二度問わない |
| `epic-split` | Issue（Epic の親） | `{ planCommentId, children }`。作った（または使い回した）子 Issue の番号を `split` の順に |
| `queue` | ダッシュボードの本文 | `{ computedAt, actions, skipped }`。Routine が次にやること |
| `acceptance` | PR | `{ verdictCommentId, verdictHeadSha, patchId, reviewPass, riskLevel, riskOk, scopeOk, outside, autoEligible, reasons, jev, delegate, bypass }`。`delegate`（`eligible`・`reasons`・`skipped`・`scopeOk`・`outside`・`exclude`）は委任承認（計画＋Merge）なら自動経路に乗せてよいか：`skipped` は委任で飛ばす理由（ガードレール・Risk）、`reasons` は委任でも乗せない理由、`scopeOk`・`outside` はゲートを通った計画かゲートの停止（`planReviewOrigin: gate`）で止まった計画との範囲照合、`exclude` は `delegateMergeExclude` に当たったファイル（harness/lib/delegate.ts）。`delegate` の無い古い記録は委任の対象外。`bypass`（`eligible`・`reasons`・`skipped`）は bypass モードなら自動経路に乗せてよいか：`skipped` は bypass で飛ばす理由（Risk・ガードレール・`humanMergePaths`・`delegateMergeExclude`・Jev）、`reasons` は bypass でも乗せない理由（Agent の PR でない・base・ブロッキング指摘・`delegate` と同じ計画との範囲照合）（harness/gates/bypass.ts）。`bypass` の無い古い記録は bypass の対象外。`jev` の `questionSet` は Jev への問いの版（無い古い記録は版 1）。`jev.size`（`chars`・`jaRatio`・`inputTokens`・`diffChars`、Jev が応答したときだけ）は送った材料の大きさ：state と問いを JSON にした文字数、そのうち日本語の文字の割合、応答の `usage.input_tokens`（報告されなければ `null`）、diff の文字数 |
| `delegated-merge` | PR | 委任承認（計画＋Merge）で auto-merge を付けたときの記録。`{ headSha, patchId, since, until, by, skipped }`。`since`・`by` は委任（ダッシュボードのラベル）を付けた時刻・人、`until` は新しい記録では `null`（期限のあった古い記録のために残す）、`skipped` は受け付けの `delegate.skipped`（委任で飛ばした理由）。同じ `patchId` の記録が最新なら書き直さない。ダッシュボードの「委任承認で Merge された PR」はこの記録で見る（harness/gates/delegation.ts） |
| `bypass-merge` | PR | bypass モードで auto-merge を付けたときの記録。`{ headSha, patchId, since, by, skipped }`。`since`・`by` は bypass（ダッシュボードのラベル）を付けた時刻・人、`skipped` は受け付けの `bypass.skipped`。同じ `patchId` と `since` の記録が最新なら書き直さない。ダッシュボードの「bypass で Merge された PR」はこの記録で見る（harness/gates/bypass.ts） |
| `bypass-merge-end` | PR | bypass で付けた auto-merge を外した記録。`{ headSha, reason }`。`reason` は `removed`（ラベルを外した）/ `stopped`（停止スイッチ）/ `ineligible`（bypass の条件を満たさなくなった。委任に引き継いだときも）。最新が `bypass-merge` の PR にだけ書く |
| `delegated-merge-end` | PR | 委任で付けた auto-merge を外して Human Merge に戻した記録。`{ headSha, reason }`。`reason` は `removed`（`agent:delegate-merge` を外した）/ `stopped`（停止スイッチ）/ `ineligible`（委任の条件を満たさなくなった）。bypass モードに引き継いだとき（auto-merge は外さない）も書く。古い記録には `expired`・`short` もある。最新が `delegated-merge` の PR にだけ書く |
| `verdict-rejected` | PR | 判定を受け付けなかった理由 |
| `test-exempt` / `review-exempt` | PR | 例外ラベルの付け外し。`{ label, action, by, patchId, headSha }`。`action` は `labeled` / `unlabeled`、`patchId` と `headSha` は人が付け外しした時点の差分と head。最新が `labeled` で `patchId` が現在の差分と同じときだけ例外が効く |
| `exempt-stale` | PR | 例外ラベルが付いているが効いていないことの通知。`{ label, headSha, patchId, reason }`。`reason` は `stale`（付けた後に差分が変わった）/ `unrecorded`（付けた記録が無い）。同じ `label` と `headSha` には1回だけ書く |
| `test-tamper-jev` | PR | `agent/tests` が見つけたアサーションの書き換えを Jev に問うた結果（Q95）。`{ version, patchId, headSha, mode, model, probabilities, probability, threshold, allows }`。`probabilities` は対ごとの「弱めていない」の確率、`probability` はその最小値（答えが欠けたら null）、`threshold` は `jev.thresholds.testTamperProbability`（無ければ null）、`allows` は `probability ≥ threshold`。`mode` が `shadow` なら記録だけで結果は変えない。同じ `patchId` には二度問わず、使い回すときは `probability` と今の設定で通すかを決め直す。Jev のエラーは記録しない |
| `unclaimed-push` | PR | 着手宣言の無いセッションの push の通知（止めない）。`{ headSha, reason, commitSessions, claimSessions }`。`reason` は `no-claim`（push の時点で PR にも Close する Issue にも有効な宣言が無い）/ `session-mismatch`（commit の `Claude-Session` が宣言のセッションと食い違う）。セッションは短い形。同じ `headSha` には1回だけ書く |
| `stack-link` | PR | Stacked PR の層を計画に紐付けた記録。`{ issues, stack }`。`issues` は本文の `Refs #N`・`Closes #N` の Issue、`stack` はスタックの番号。層が既定ブランチに Merge されたら、App がこの `issues` を閉じる（harness/gates/plan-link.ts・on-main-push.ts）。最新の記録と同じなら書き直さない |
| `orphan-base` | PR | スタックでないのに base が既定ブランチ以外の PR を Draft に留め、`agent:blocked`（理由コード `orphan-base`）を付けた通知。`{ base, headSha }`。Stacked PR の上の層は `gh stack link` で組むまでこの状態になる |
| `base-resolved` | PR | orphan-base が解消した記録。`{ base, kind }`。`kind` は `stacked`（スタックに組み込まれた）か `default`（base が既定ブランチになった）。通常の流れに戻す |
| `fix-request` | PR（レビュー） | Reviewer のブロッキング指摘（修正回数はこの数で数える） |
| `issue-triage` | Issue | Jev による分類の提案と、その確率 |
| `label-triage` | Issue | `classification.issueTriage` が `label` のときに Jev に問った結果と付けたラベル。`{ model, answers, threshold, thresholdByLabel, added, notApplied, size }`。`thresholdByLabel` は問うたときの `jev.thresholds.labelProbabilityByLabel` の写し（無ければ `{}`）。`size`（`chars`・`jaRatio`・`inputTokens`）は `acceptance` の `jev.size` と同じ意味。`notApplied` は付けなかったもの（確率が下限未満、下限が未設定、当たるラベルが無い）と理由。`issue-triage` か `label-triage` がある Issue には二度と問わない |
| `label-reapply` | Issue | ラベルの下限を見直した後、最新の `label-triage` の記録の確率で、下限に届かず付かなかったラベルを付けた記録。`{ triageCommentId, added }`。`added` は `{ label, probability, threshold }` の一覧。Jev には問い直さない。1つの Issue に1回だけ（この記録があれば二度と付け直さない） |
| `label-mismatch` | Issue / PR | 人が付けた（App が付けたと確かめられない）`type:*` がタイトルと食い違う、または Epic に付いていることの通知。`{ title, labels }`。同じタイトルと同じラベルには1回だけ書く |
| `human-review` / `stack-closed`（Issue。Stacked PR の層が Merge されて閉じた） / `priority-conflict` / `hold-removed` / `plan-ok-removed` / `form-error` / `unblocked` / `parent-closed` / `epic-inherit` / `epic-split-failed` / `auto-merge-stopped` / `delegate-merge-switch` / `bypass-merge-switch` / `dashboard` | 各所 | 通知・記録 |
