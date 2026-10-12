---
name: patrol
description: 人が付き添うセッションの /loop から、保守の観測を回して今回まわすべき見直し（arch-review・qa-retro・test-prune）を選んで動かし、下書きを集める。「/loop で見直しを回して」「patrol で見回って」と頼まれたとき、`/loop <間隔> /patrol` の各回で使う。
---

# patrol（見直しのまとめ役）

付き添いのセッションの `/loop` から1つで呼ぶ、見直しのまとめ役。1回分で保守の観測（`harness/scripts/observe.ts`）を回し、観測の差と前回からの経過で今回まわす見直しを決め、選んだものだけを各 skill のループの回の形で動かして、回の要約を出す。patrol は中身の skill（[arch-review](../arch-review/SKILL.md)・[qa-retro](../qa-retro/SKILL.md)・[test-prune](../test-prune/SKILL.md)）を呼ぶだけで、各 skill の手順・記録・状態は書き直さない。Issue の段階ではないので着手宣言は要らない。

`/loop` で回すときの共通の規則（回すのは付き添いのセッションの `/loop` だけ、1回分で完結させ人の答えを待たない、ループの回は Issue を作らずラベルも付けない、止め方、結果を判定の材料にしない）は [docs/operations.md の「見直しを /loop で回す」](../../../docs/operations.md#見直しを-loop-で回す) に従う。ここには patrol に固有のことだけを書く。

## 入力

```
/loop 6h /patrol
```

- 間隔の目安：数時間〜1日おき（例 `/loop 6h /patrol`）。各見直しの間隔は下の決め方で patrol が絞るので、短めにしても回しすぎない。
- `--max <n>`：1回に動かす見直しの上限（既定 2）。`patrol.ts select` に渡す。形が suggest（人に勧めるだけ）の見直しは枠を使わない。
- `--state <path>`：状態のファイル（`patrol.ts previous`・`select`・`record` に渡す）。確かめるときの一時の状態に使う。既定は `git rev-parse --path-format=absolute --git-common-dir` の下の `agent-harness/patrol.json`（worktree をまたいで同じ。作業ツリーにも GitHub にも書かない）。
- `--dry-run`：見直しを動かさず、観測・選択・記録と要約だけを行う（確かめるときに arch-review・qa-retro・test-prune の本物の記録・状態を進めないため）。記録では `select` の `run` を `--ran` として渡す。`--dry-run` は `--state` と一緒のときだけ受け付け、`--state` が無ければその回を止めて理由を出す（既定の状態に、動かしていない見直しを記録しないため）。

## 手順

1回分の処理。回の中で人の答えを待たない。

1. `node harness/scripts/patrol.ts previous [--state <path>]` で前回の観測の JSON のパスを読む（何も出なければ初回）。状態のファイルが壊れている・`version` が違うと誤りで終わるので、その回は観測も見直しも動かさずに、理由（状態のファイルのパス。人が直すか消せば次の回から初回として回る）を出して終える。状態のファイルは上書きしない。
2. `node harness/scripts/observe.ts [--previous <前回の JSON>]` を実行し、最後の行の JSON のパスを得る（`--run-tests` は付けない。遅いテストの節は読めない扱いになり、差は null になる）。失敗したら、その回は見直しを動かさずに理由を出して終える（状態は変えない）。
3. `node harness/scripts/patrol.ts select <観測の JSON> [--max <n>] [--state <path>]` で今回まわす見直しを決める。出力の JSON は `run`（動かす見直し。動かす順）・`suggest`（人に勧めるだけの見直し）・`skipped`（回さないものと理由）・`reasons`（見直しごとの理由の文）・`alerts`（運用の健康のうち、しきい値を超えた項目と前回から値が増えた項目。id・題・値・しきい値）・`alertsNote`（知らせが空の理由など）。
4. `run` の順に、各 skill の「/loop で回すとき」の1回分の処理を行う（`--dry-run` なら動かさない）。
   - arch-review：`arch-review --loop` の回（[arch-review の「/loop で回すとき」](../arch-review/SKILL.md)）。観測は arch-review の回が自分で回すので、patrol の観測の JSON は渡さない。
   - qa-retro：`qa-retro --loop` の回（[qa-retro の「/loop で回すとき」](../qa-retro/SKILL.md)）。
   - test-prune：`test-prune --loop` の回（[test-prune の「/loop で回すとき」](../test-prune/SKILL.md)）。手順2の観測の JSON を `test-prune.ts` の `--health` に渡す。
   - 1つの見直しが失敗・中断しても、残りの見直しは続ける。失敗したものは次の手順で「回した」に数えない。
5. `node harness/scripts/patrol.ts record <観測の JSON> [--ran <回した見直し>]... [--suggested <勧めた見直し>]... [--state <path>]` で回を記録する（回した見直しの時刻・勧めた見直しの時刻を更新し、観測の JSON を状態の置き場所に写す）。回した見直しが無くても記録する（観測の写しが次の回の `--previous` になる）。`--suggested` は `suggest` に入った見直しがあるときだけ渡す。
### 5a. auto mode の間の自動の供給

`--dry-run` の回では行わない。上限は `patrolAutoSupply.dailyLimit`（下の「設定」）。

- (1) `{ "version": 1, "candidates": [] }` を scratchpad に書き、`node harness/scripts/agent.ts patrol-supply check <そのファイル>` を流す。`active` が偽か `remaining` が 0 なら、この手順を終えて理由を要約に書く。
- (2) 各見直しの未採用の下書き（`node harness/scripts/agent.ts arch-review-pending`・`node harness/scripts/qa-retro-loop.ts pending`・`node harness/scripts/test-prune-loop.ts pending`）を候補にする。
   - `ref` は見直しと下書きの位置から作る（`arch-<記録のコメントID>-<下書きの番号>`・`qa-<回の番号>-<下書きの番号>`・`prune-<回の番号>-<下書きの番号>`）。
   - `risk` はセッションが下書きを [docs/risk-policy.md](../../../docs/risk-policy.md) の目安で見積もる（決められなければ `null`）。
   - `files` は下書きの本文の Background の「触るファイルの見込み」の行（無ければ本文に書かれたファイルのパス）から取る（取れなければ空。`files-unknown` で人の側に残る）。
   - arch-review の下書きで `duplicateOf` があるものは、`overlap` を `comment` にする（人の側に残る）。
   - `overlap` は `null` で1度 `check` を流し、`manual` の理由が `overlap` の下書き（ほかの条件は満たすもの）だけを、[issue-creator](../issue-creator/SKILL.md) の下書きの役目（`from=patrol`、`ref` は上の ref）で重複を判定する。その結果の `kind` を `overlap`、下書きのパスを `draftPath` にして、もう一度 `check` を流す。
- (3) `check` の `create` の順に、1件ずつ issue-creator の作成の役目で Issue を作る（名指しはその下書きだけ）。
- (4) 作った Issue ごとに、作成の役目が返した URL（作った Issue か、目印で既にあった Issue）の末尾から番号を取り、`node harness/scripts/agent.ts patrol-supply ready <番号>` を流す。`added` が偽なら理由を要約に書き、ラベルはそのまま（人が決める）。
- (5) 各見直しの採用を書き戻す（`node harness/scripts/agent.ts arch-review-adopt <記録のコメントID> <下書きの番号> <Issue 番号>`・`node harness/scripts/qa-retro-loop.ts adopt <回の番号> <下書きの番号> <Issue 番号>`・`node harness/scripts/test-prune-loop.ts adopt <回の番号> <下書きの番号> <Issue 番号>`）。
- (6) 回の要約に、作った Issue・`agent:ready` を付けたか・人の側に残した下書きと理由（`manual` の `reason`・`detail`）を足す。

6. 回の要約を文章で出す（PR・Issue には投稿しない）。
   - 先頭に `alerts`（超えた項目・前回から増えた項目）を出す。`alerts` が空で `alertsNote` があればその旨を出す。知らせるだけで、見直しの skill は動かさない。直すのは各 Issue で行う（項目の一覧と個別の直しの Issue は [docs/operations.md の「patrol が知らせる観測の項目」](../../../docs/operations.md)）
   - 観測の差：節ごとの増えた・消えた件数。差が読めない節はその旨
   - 動かした見直しと、回さなかった見直し（`skipped` と `reasons` の理由）
   - 勧める見直し：`suggest` にあれば、その見直しと理由（人がその skill を呼ぶ）
   - たまった下書きの数：`node harness/scripts/agent.ts arch-review-pending`・`node harness/scripts/qa-retro-loop.ts pending`・`node harness/scripts/test-prune-loop.ts pending` の未採用の数
   - 「Issue にするなら『arch-review の下書きを選ぶ』『qa-retro の下書きを選ぶ』『test-prune の下書きを選ぶ』と頼む」（人が選ぶ場面は各 skill の手順のまま）

- 止め方：`/loop` を止める（止めるよう頼む・セッションを閉じる）。手順5の前に止めた回は、次の回が同じ前回から観測の差を出し、見直しの時刻も進んでいない。
- 同時に2つのセッションで patrol を回さない（状態のファイルは1つ。後から書く側は上書きせずに誤りで止まり、その回は記録されないので、もう一度 record を流す）。

## 設定

`harness.config.json` の `patrolAutoSupply.dailyLimit`：直近 24 時間に自動で Issue にする数の上限。0 以上の整数、既定 1、0 で自動にしない。数えるのは、本文に `<!-- agent-harness:issue-source from=patrol ref=… -->` の目印があり、自分が作った、PR でない Issue。

## 決め方

`harness/lib/patrol.ts` の `selectReviews`（決まる部分。テストは `harness/test/patrol.test.ts`）。見直しごとの定数は `PATROL_REVIEWS`。

| 見直し | 形 | 見る観測の節 | 下限 | 上限 |
| --- | --- | --- | --- | --- |
| arch-review | 動かす（`run`） | `docs` | 12 時間 | 3 日 |
| qa-retro | 動かす（`run`） | `flakyTests`・`mutants` | 1 日 | 7 日 |
| test-prune | 動かす（`run`） | `slowTests`・`flakyTests`・`mutants` | 1 日 | 14 日 |

- 見直しごとに、上から最初に当たったもの：一度も回していない（勧めていない）→ 選ぶ（`never`）／前回から上限以上 → 選ぶ（`overdue`）／下限未満 → 選ばない（`too-soon`）／対応する節に差がある → 選ぶ（`diff`）／それ以外 → 選ばない（`no-diff`）。
- 経過は、動かす形なら前回回した時刻（`lastRunAt`）、勧めるだけの形なら前回勧めた時刻（`lastSuggestedAt`）から測る。今は3つとも動かす形（前の状態のファイルで test-prune に `lastSuggestedAt` しか無ければ、次の回は `never` として回す）。
- 読めない節（null）と、前回の観測が無いとき（初回・写しが消えた）は差なしとして数える。
- 運用の健康（`opsHealth`）は見直しの選び方に使わない。`alerts` に知らせるだけ。
- 動かすものが `--max` を超えたら、`never` → `overdue`（超えた時間の長い順）→ `diff`（差の件数の多い順）で上限までにし、残りは `limit` で次の回に回す。

## 出力

- 回の要約（手順6）。PR・Issue には投稿しない。
- 状態のファイルと観測の写し（手元だけ）。動かした見直しの記録・状態は、各 skill の手順どおりその skill が残す。

## やってはいけないこと

- 無人の回で AskUserQuestion を呼ばない。人の判断が要る状態に当たったら、その見直しを止めて理由を要約に書く
- `gh issue create` をしない（Issue にするのは、人が「〜の下書きを選ぶ」と頼んだときに各 skill の手順で。例外は auto mode の間の自動の供給の、issue-creator の作成の役目だけ）
- ラベルを付けない（`agent:ready`・`priority:*`・`area:*` も）。例外は auto mode の間の自動の供給の `patrol-supply ready` が付ける `agent:ready` だけ。`gh issue edit` でラベルを付けない。`agent:ready` 以外のラベル（`priority:*`・`area:*` を含む）は付けない
- PR・Issue に要約を投稿しない
- 各 skill の記録・状態（arch-review の記録、`qa-retro-loop.json`・`test-prune-loop.json` など）を patrol が書き換えない
- schedule（Actions・クラウドの Routine）で動かさない
- 要約を判定の材料にしない（reviewer・risk-agent・review-panel に渡さない）

## 終わりの状態

- 回の要約を出した。状態のファイルに回が1件増えている（手順1・2で止めた回、手順5の前に止めた回は増えない）。
- Issue は作られず、ラベルも付いていない（例外は、auto mode の間の自動の供給で作った Issue と、`patrol-supply ready` が付けた `agent:ready`）。
