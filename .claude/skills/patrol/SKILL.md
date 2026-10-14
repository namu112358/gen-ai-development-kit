---
name: patrol
description: 人が付き添うセッションの /loop から、保守の観測を回して今回まわすべき見直し（arch-review・qa-retro・test-prune）を選んで動かし、下書きを集める。「/loop で見直しを回して」「patrol で見回って」と頼まれたとき、`/loop <間隔> /patrol` の各回で使う。クラウドの Routine からは `/patrol --routine` で1回分を回す。「patrol の下書きを選ぶ」と頼まれたときにも使う。
---

# patrol（見直しのまとめ役）

付き添いのセッションの `/loop` か、クラウドの Routine から `--routine` で1つで呼ぶ、見直しのまとめ役。1回分で保守の観測（`harness/scripts/observe.ts`）を回し、観測の差と前回からの経過で今回まわす見直しを決め、選んだものだけを各 skill のループの回の形で動かして、回の要約を出す。patrol は中身の skill（[arch-review](../arch-review/SKILL.md)・[qa-retro](../qa-retro/SKILL.md)・[test-prune](../test-prune/SKILL.md)）を呼ぶだけで、各 skill の手順・記録・状態は書き直さない。Issue の段階ではないので着手宣言は要らない。

`/loop` で回すときの共通の規則（回すのは付き添いのセッションの `/loop` か、クラウドの Routine の patrol（`--routine`）、1回分で完結させ人の答えを待たない、ループの回は Issue を作らずラベルも付けない、止め方、結果を判定の材料にしない）は [harness/docs/operations.md の「見直しを /loop で回す」](../../../harness/docs/operations.md#見直しを-loop-で回す) に従う。ここには patrol に固有のことだけを書く。

## 入力

```
/loop 6h /patrol
```

- 間隔の目安：数時間〜1日おき（例 `/loop 6h /patrol`）。各見直しの間隔は下の決め方で patrol が絞るので、短めにしても回しすぎない。
- `--max <n>`：1回に動かす見直しの上限（既定 2）。`patrol.ts select` に渡す。形が suggest（人に勧めるだけ）の見直しは枠を使わない。
- 状態：`/loop` の回も Routine の回も、まとめの Issue の本文の状態（`patrol-state`）を `patrol-pull --dir <dir>` で `<dir>` に写して読み書きし、`patrol-push --dir <dir>` で書き戻す（書式は [harness/docs/formats.md](../../../harness/docs/formats.md) の「patrol のまとめの Issue」）。`/loop` の `<dir>` は scratchpad の `patrol/` に決め、回ごとに使い回す（同じセッションの中では前回の観測の写し `<dir>/patrol-observe.json` が残る）。
- `--dry-run`：見直しを動かさず、pull と観測・選択・記録と要約だけを行い、push しない（確かめるときに arch-review・qa-retro・test-prune の本物の記録・状態と、まとめの Issue の状態を進めないため）。記録では `select` の `run` を `--ran` として渡す。
- `--routine`：クラウドの Routine の1回分として動く（手順は下の「Routine で回すとき（--routine）」）。`--dry-run` と同時には使わない（渡されたらその回を止めて理由を出す）。

## 手順

1回分の処理。回の中で人の答えを待たない。`/loop` の回も、最初に pull、最後に push する（Routine の回と同じ経路）。

0. `node harness/scripts/agent.ts patrol-pull --dir <dir>` でまとめの Issue の状態を `<dir>` に写す（まとめの Issue が無ければ作る）。失敗したら、その回は何も動かさずに理由を出して終える。
1. `node harness/scripts/patrol.ts previous --dir <dir>` で前回の観測の JSON のパスを読む（何も出なければ初回）。状態のファイルが壊れている・`version` が違うと誤りで終わるので、その回は観測も見直しも動かさずに、理由（`<dir>` の状態のファイルのパス）を出して終える（push しない）。
2. `node harness/scripts/observe.ts [--previous <前回の JSON>]` を実行し、最後の行の JSON のパスを得る（`--run-tests` は付けない。遅いテストの節は読めない扱いになり、差は null になる）。失敗したら、その回は見直しを動かさずに理由を出して終える（状態は変えない）。
3. `node harness/scripts/patrol.ts select <観測の JSON> [--max <n>] --dir <dir>` で今回まわす見直しを決める。出力の JSON は `run`（動かす見直し。動かす順）・`suggest`（人に勧めるだけの見直し）・`skipped`（回さないものと理由）・`reasons`（見直しごとの理由の文）・`alerts`（運用の健康のうち、しきい値を超えた項目と前回から値が増えた項目。id・題・値・しきい値）・`alertsNote`（知らせが空の理由など）。
4. `run` の順に、各 skill の「/loop で回すとき」の1回分の処理を行う（`--dry-run` なら動かさない）。
   - arch-review：`arch-review --loop` の回（[arch-review の「/loop で回すとき」](../arch-review/SKILL.md)）。観測は arch-review の回が自分で回すので、patrol の観測の JSON は渡さない。
   - qa-retro：`qa-retro --loop` の回（[qa-retro の「/loop で回すとき」](../qa-retro/SKILL.md)）。pull と push は patrol がするので、`qa-retro-loop.ts` の `data`・`advance` に同じ `--dir <dir>` を渡す。
   - test-prune：`test-prune --loop` の回（[test-prune の「/loop で回すとき」](../test-prune/SKILL.md)）。手順2の観測の JSON を `test-prune.ts` の `--health` に渡す。`test-prune-loop.ts` の `pending`・`record` に同じ `--dir <dir>` を渡す。
   - 1つの見直しが失敗・中断しても、残りの見直しは続ける。失敗したものは次の手順で「回した」に数えない。
5. `node harness/scripts/patrol.ts record <観測の JSON> [--ran <回した見直し>]... [--suggested <勧めた見直し>]... --dir <dir>` で回を記録する（回した見直しの時刻・勧めた見直しの時刻を `<dir>/patrol.json` に書き、観測の JSON を `<dir>/patrol-observe.json` に写す）。回した見直しが無くても記録する（観測の写しが次の回の `--previous` になる）。`--suggested` は `suggest` に入った見直しがあるときだけ渡す。
### 5a. auto mode の間の自動の供給

`--dry-run` の回では行わない。上限は `patrolAutoSupply.dailyLimit`（下の「設定」）。

- (1) `{ "version": 1, "candidates": [] }` を scratchpad に書き、`node harness/scripts/agent.ts patrol-supply check <そのファイル>` を流す。`active` が偽か `remaining` が 0 なら、この手順を終えて理由を要約に書く。
- (2) 各見直しの未採用の下書き（`node harness/scripts/agent.ts arch-review-pending`・`node harness/scripts/qa-retro-loop.ts pending --dir <dir>`・`node harness/scripts/test-prune-loop.ts pending --dir <dir>`）を候補にする。
   - `ref` は見直しと下書きの位置から作る（`arch-<記録のコメントID>-<下書きの番号>`・`qa-<回の番号>-<下書きの番号>`・`prune-<回の番号>-<下書きの番号>`）。
   - `risk` はセッションが下書きを [harness/docs/risk-policy.md](../../../harness/docs/risk-policy.md) の目安で見積もる（決められなければ `null`）。
   - `files` は下書きの本文の Background の「触るファイルの見込み」の行（無ければ本文に書かれたファイルのパス）から取る（取れなければ空。`files-unknown` で人の側に残る）。
   - arch-review の下書きで `duplicateOf` があるものは、`overlap` を `comment` にする（人の側に残る）。
   - `overlap` は `null` で1度 `check` を流し、`manual` の理由が `overlap` の下書き（ほかの条件は満たすもの）だけを、[issue-creator](../issue-creator/SKILL.md) の下書きの役目（`from=patrol`、`ref` は上の ref）で重複を判定する。その結果の `kind` を `overlap`、下書きのパスを `draftPath` にして、もう一度 `check` を流す。
- (3) `check` の `create` の順に、1件ずつ issue-creator の作成の役目で Issue を作る（名指しはその下書きだけ）。
- (4) 作った Issue ごとに、作成の役目が返した URL（作った Issue か、目印で既にあった Issue）の末尾から番号を取り、`node harness/scripts/agent.ts patrol-supply ready <番号>` を流す。`added` が偽なら理由を要約に書き、ラベルはそのまま（人が決める）。
- (5) 各見直しの採用を書き戻す（`node harness/scripts/agent.ts arch-review-adopt <記録のコメントID> <下書きの番号> <Issue 番号>`・`node harness/scripts/qa-retro-loop.ts adopt <回の番号> <下書きの番号> <Issue 番号> --dir <dir>`・`node harness/scripts/test-prune-loop.ts adopt <回の番号> <下書きの番号> <Issue 番号> --dir <dir>`）。採用の印は手順7の push でまとめの Issue に書き戻る。
- (6) 回の要約に、作った Issue・`agent:ready` を付けたか・人の側に残した下書きと理由（`manual` の `reason`・`detail`）を足す。

6. 回の要約を文章で出し、scratchpad のファイルにも書く（PR には投稿しない。まとめの Issue の回のコメントには手順7の push が載せる）。
   - 先頭に `alerts`（超えた項目・前回から増えた項目）を出す。`alerts` が空で `alertsNote` があればその旨を出す。知らせるだけで、見直しの skill は動かさない。直すのは各 Issue で行う（項目の一覧と個別の直しの Issue は [harness/docs/operations.md の「patrol が知らせる観測の項目」](../../../harness/docs/operations.md)）
   - 観測の差：節ごとの増えた・消えた件数。差が読めない節はその旨
   - 動かした見直しと、回さなかった見直し（`skipped` と `reasons` の理由）
   - 勧める見直し：`suggest` にあれば、その見直しと理由（人がその skill を呼ぶ）
   - たまった下書きの数：`node harness/scripts/agent.ts arch-review-pending`・`node harness/scripts/qa-retro-loop.ts pending --dir <dir>`・`node harness/scripts/test-prune-loop.ts pending --dir <dir>` の未採用の数
   - 「Issue にするなら『arch-review の下書きを選ぶ』『qa-retro の下書きを選ぶ』『test-prune の下書きを選ぶ』と頼む」（人が選ぶ場面は各 skill の手順のまま）。`--routine` の回の下書きは「patrol の下書きを選ぶ」で選ぶと頼む
7. `node harness/scripts/agent.ts patrol-push --dir <dir> --summary <要約のファイル> [--arch-review <記録の URL>]` でまとめの Issue に書き戻す（`--dry-run` の回は push しない）。push が「pull の後にまとめの Issue の本文が変わりました」で止まったら、手順0の pull からその回をやり直す。2回目も止まったら、その回を終えて理由を出す（状態はまとめの Issue に書かれないので、次の回が同じ前回から回る）。

- 止め方：`/loop` を止める（止めるよう頼む・セッションを閉じる）。手順7の push の前に止めた回は、まとめの Issue に書かれないので、次の回が同じ前回から観測の差を出し、見直しの時刻も進んでいない。
- 2つのセッション（`/loop` と Routine を含む）で同時に回すと、両方の pull が同じ本文を読み、先に push した側が書き、後から push した側は本文の変化で止まる（後の側は書かず、手順7のとおり pull からやり直す）。
- 引き継がれないもの：#1025 より前に手元（git の共通ディレクトリの下の `agent-harness/patrol.json`・`qa-retro-loop.json`・`test-prune-loop.json`・`patrol-observe.json`）にしか無かった状態は、まとめの Issue に移さず、読まなくなった。手元にしか無かった未採用の下書きと前回の位置は引き継がれず、まとめの Issue の状態が `null` の見直しは初回として回る（qa-retro は初回の14日幅）。手元のファイルは消さない（読まれないだけ）。

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
- 経過は、動かす形なら前回回した時刻（`lastRunAt`）、勧めるだけの形なら前回勧めた時刻（`lastSuggestedAt`）から測る。動かす形の見直しに `lastRunAt` が無ければ（`lastSuggestedAt` だけがあっても）、`never` として回す。今は3つとも動かす形。
- 読めない節（null）と、前回の観測が無いとき（初回・写しが消えた）は差なしとして数える。
- 運用の健康（`opsHealth`）は見直しの選び方に使わない。`alerts` に知らせるだけ。
- 動かすものが `--max` を超えたら、`never` → `overdue`（超えた時間の長い順）→ `diff`（差の件数の多い順）で上限までにし、残りは `limit` で次の回に回す。

## Routine で回すとき（--routine）

クラウドの Routine の1回分。回の中で人の答えを待たない（AskUserQuestion を呼ばない）。下書きごとの Issue を作らず、ラベルも付けない（まとめの Issue は `patrol-pull` が初回に1回作るだけ）。上の「手順」の 5a（auto mode の間の自動の供給）は、`--routine` の回では行わない。Routine の下書きは「patrol の下書きを選ぶ」で人が選ぶ。

1. 浅い clone を解く：`git rev-parse --is-shallow-repository` が `true` なら `git fetch --unshallow`（Routine は毎回既定ブランチから浅く clone し直す。arch-review の範囲・qa-retro の期間に履歴が要る）。
2. `<dir>` を scratchpad の `patrol-routine/` に決め、`node harness/scripts/agent.ts patrol-pull --dir <dir>` を流す（まとめの Issue が無ければ作る）。失敗したら、その回は何も動かさずに理由を出して終える。
3. 「手順」の 1〜5 を、この `<dir>` で行う（手順0の pull はこの手順2）。手順2の `observe.ts` は約4分かかる（CI の実行を1000件まで読む）ので、背景で動かして終わるのを待ち、最後の行の JSON のパスを読む（Bash の 120 秒の上限で止めない）。
4. 手順4の見直しの回：
   - qa-retro の回は `qa-retro-loop.ts` の `data`・`advance` に、test-prune の回は `test-prune-loop.ts` の `pending`・`record` に、`--dir <dir>` を渡す。
   - 下書きは `advance`・`record` の前に `node harness/scripts/agent.ts patrol-dedupe <下書きの JSON> --out <パス> --max <残りの枠>` を通し、出力の `--out` を `--drafts` に渡す。枠は回の合計で3件で、qa-retro → test-prune の順に使う（qa-retro の `kept` を引いた残りを test-prune の `--max` に。残りが 0 なら空の配列が書かれる）。
   - arch-review の回は今までどおりダッシュボード Issue に記録を残し（`arch-review-record`）、出力の記録のコメントの URL を控える（arch-review の下書きは自分の記録の3件のまま。枠には数えない）。
5. 回の中で各 skill が `gh issue`・`gh pr` で読むところ（GraphQL で 403 になる）は、`gh api` の REST と `node harness/scripts/agent.ts rest issue-search <語>...` で読む（各 skill の文は変えない）。

   | 各 skill の読み方 | Routine での読み方 |
   | --- | --- |
   | PR の情報（`gh pr view <番号>`） | `gh api repos/{owner}/{repo}/pulls/<番号>` |
   | PR の diff・ファイル（`gh pr diff`） | `gh api repos/{owner}/{repo}/pulls/<番号>/files` |
   | PR・Issue のコメント（`gh pr view --comments`） | `gh api repos/{owner}/{repo}/issues/<番号>/comments` |
   | 開いた Issue の検索（`gh issue list --search`） | `node harness/scripts/agent.ts rest issue-search <語>...` |
   | Issue の作成 | しない |

6. 「手順」の6・7（要約と push）を行う。push が止まったときのやり直しの pull は、この手順2から。

作り方は [docs/patrol-routine.md](../../../docs/patrol-routine.md)。

## 人が選ぶ場面（patrol の下書きを選ぶ）

付き添いのセッションだけ。Routine では行わない。「patrol の下書きを選ぶ」と頼まれたとき、`/loop` と Routine がまとめの Issue に積んだ下書きと、ダッシュボードの arch-review の下書きから選ばせる。

1. `node harness/scripts/agent.ts patrol-pull --dir <一時のディレクトリ>` でまとめの Issue の状態を写す。
2. 未採用の下書きを読む：`node harness/scripts/qa-retro-loop.ts pending --dir <一時>`・`node harness/scripts/test-prune-loop.ts pending --dir <一時>`（ファイルが無ければその見直しの下書きは無い）・`node harness/scripts/agent.ts arch-review-pending`（ダッシュボードの記録）。
3. どれを作るかを AskUserQuestion（複数選択、1回4問まで）で聞く。
4. 人が選んだものだけを `gh issue create --title <題> --body-file <本文のファイル>` で作る（ラベルは指定しない。クラウドの付き添いのセッションでは `node harness/scripts/agent.ts rest-create issue --title <題> --body-file <ファイル>` を `--label` なしで使う）。
5. 作るたびに採用の印を書き戻す：qa-retro は `node harness/scripts/qa-retro-loop.ts adopt <回の番号> <下書きの番号> <Issue 番号> --dir <一時>`、test-prune は `node harness/scripts/test-prune-loop.ts adopt <回の番号> <下書きの番号> <Issue 番号> --dir <一時>`、arch-review は `node harness/scripts/agent.ts arch-review-adopt <記録のコメントID> <下書きの番号> <Issue 番号>`。回の番号と下書きの番号は、同じ pull の写しの中でだけ使う（別の pull の番号を使い回さない）。
6. `node harness/scripts/agent.ts patrol-push --dir <一時のディレクトリ>` で採用の印をまとめの Issue に書き戻す。本文の変化で止まったら（その間に Routine が回った）、もう一度 pull し、作った Issue の題で下書きを探して `adopt` をやり直してから push する（Issue は作り直さない）。
7. 作った Issue は、[qa-retro](../qa-retro/SKILL.md)・[test-prune](../test-prune/SKILL.md) の「出力」の手順4と同じく、人が「作るだけ」と言わない限り聞かずに plan に進める。

## 出力

- 回の要約（手順6）。PR には投稿しない。
- まとめの Issue の本文と回のコメントが更新される（`patrol-push`。`/loop` の回も `--routine` の回も。`--dry-run` の回は更新しない）。Issue は作られず（まとめの Issue の初回を除く）、ラベルも付かない。
- 観測の写し（`<dir>/patrol-observe.json`。本文には入らない）。動かした見直しの記録・状態は、各 skill の手順どおりその skill が残す。

## やってはいけないこと

- 無人の回で AskUserQuestion を呼ばない。人の判断が要る状態に当たったら、その見直しを止めて理由を要約に書く
- `gh issue create` をしない（Issue にするのは、人が「〜の下書きを選ぶ」「patrol の下書きを選ぶ」と頼んだときに各 skill の手順で。まとめの Issue は `patrol-pull` が作る。例外は auto mode の間の自動の供給の、issue-creator の作成の役目だけ。`--routine` の回では、この例外も使わない）
- ラベルを付けない（`agent:ready`・`priority:*`・`area:*` も）。例外は auto mode の間の自動の供給の `patrol-supply ready` が付ける `agent:ready` だけ。`gh issue edit` でラベルを付けない。`agent:ready` 以外のラベル（`priority:*`・`area:*` を含む）は付けない。`--routine` の回では `patrol-supply ready` の例外も使わない
- PR・Issue に要約を投稿しない（まとめの Issue の回のコメントは `patrol-push` が書く）
- 各 skill の記録・状態（arch-review の記録、`qa-retro-loop.json`・`test-prune-loop.json` など）を patrol が書き換えない
- Routine で動かすのは patrol の `--routine` だけ（Actions では動かさない。ほかの skill の段階は動かさない）
- 要約を判定の材料にしない（reviewer・risk-agent・review-panel に渡さない）

## 終わりの状態

- 回の要約を出した。まとめの Issue の本文の状態に回が1件増えている（手順0〜2で止めた回、手順7の push の前に止めた回、`--dry-run` の回は増えない）。
- まとめの Issue の本文と回のコメントを更新した（手順の途中で止めた回は、状態を書き戻していない）。
- Issue は作られず、ラベルも付いていない（例外は、auto mode の間の自動の供給で作った Issue と、`patrol-supply ready` が付けた `agent:ready`）。
