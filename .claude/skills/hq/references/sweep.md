# hq の参照用のファイル：手順8 進んでいない fleet を見つける

hq の skill（[SKILL.md](../SKILL.md)）の参照用のファイル。手順・節の番号は SKILL.md のもの。

## 手順8 進んでいない fleet を見つける

- `stalled` が true の fleet：`staleSnapshot`（スナップショットの `at` が `hq.staleSnapshotMinutes` より古い＝collect が止まっている）、`missing`（スナップショットが無い）、`stuck`（AI の番の行の `since` が `hq.stuckMinutes` より長い＝進んでいない）。
- hq がまだ答えていない `question` のある Issue の行は、人の答え待ちなので `stuck` から外して数える。
- 起こし直さず、`ORCA orchestration send --to dispatch:<Dispatch ID> --subject "状況の確認" --body "<何が古い・長いか>。今の状況を hq に返してください" --json` で状況を聞く（Orca の `ask` は worker から coordinator への問いなので、hq から聞くのは `send`。fleet は段階の切れ目の `check` で読む）。同じ fleet に同じ理由で聞くのは、状況が変わるまで1回。
- 次の待ち（15分）の間にその fleet から何も届かなければ、人に知らせる（テーマ・何が古い／長いか・経った時間）。窓口は hq。
- **context を縮める**（#737）：同じ回に、控えの各 fleet（`stalled`・交代中（`handover`）の fleet を除く）で `node harness/scripts/hq-compact.ts fleet --theme <テーマ>` を流す。fleet の端末に `/compact` を送るのは、前に縮めてから（無ければ起こしてから）`hq.compactMinutes`（既定 180 分）以上経ち、受け持ちの Issue に `plan-gate` 以外の着手宣言が無く（ship が動いていない）、fleet の端末がターンを終えている（Orca の `tui-idle`）ときだけ。ターンの途中・ship が動いている間は送らない（判定はスクリプト。標準出力の `sent` が真なら送った）。縮めた記録は `agent-harness/hq/hq-compact.json`。縮めた後の fleet は控えと `fleet-status` から受け持ちを読み直して続ける。
- **長く出力の無いタブ**（#826）：同じ回（見張りが `timeout` で返るたび）に `node harness/scripts/panes.ts idle --exclude <hq 自身の handle> --exclude <intel の handle>` を流す（読むだけ。しきい値は `hq.stuckMinutes`、`--minutes` で上書き）。出力は「長く出力の無いタブ：<handle>・<分>分・<title>（<worktreePath>）」の行で、claude のタブのうち長く出力の無いもの（例：8時間止まった ship）。hq の起こし直し・引き継ぎの後や intel が既にいたときも、handle の取り方は同じ。
  - hq 自身の handle：毎回 `ORCA terminal list --worktree current --json` を読み、hq の Claude の端末の handle を使う（手順6の「自分の端末を閉じない」で比べるのと同じ取り方）。
  - intel の handle：控えの `intelHandle` を使う。控えに無い（intel が既にいて hq が起こさなかった・前の hq の控えにも無い）ときは、`ORCA terminal list --worktree current --include-visual-layouts --json` のペインの木で、手順6の並びの右の列（真ん中の列との `vertical` の分け目の `second`）のペインの handle を使い、控えの `intelHandle` に書いて `hq-state.ts ledger-save` で置く（控えのほかのキーはそのまま残す）。それでも決まらない（右の列が無い）ときは、`ListAgents` に intel がいるなら、hq の Claude の端末と hq の表示のペイン（`paneHandles`）以外で本体（`worktreePath` が本体の絶対パス）の claude のタブの行に「intel かもしれない」と添えて一覧に出す（除外を推測で決めない）。intel がいなければ intel の `--exclude` は付けない。
  - 出た行は手順12の一覧に「長く出力の無いタブ」として出す。hq はタブを閉じない（閉じるかは人が決める）。前の回と同じ行は数え直すだけ。「Orca のタブの一覧を読めません（理由）」の1行が出たら、そのまま一覧に出す（見回しは止めない）。
- **止まったタスクの見回し**（同じ回に、fleet の外で止まっているものを見つけて割り振る。#407）：
  - 読むもの（GitHub の API を使いすぎないため、この4つだけ。Issue・PR を1件ずつ `gh` で読みに行かない）：
    - ダッシュボードの節：ダッシュボード Issue（`harness.config.json` の `dashboardIssueTitle`）の本文を1回読む。使うのは「人の対応待ち」の「引き継ぐか決める」（#371）・「停滞している Agent PR」・「停滞している Issue」と、「止まっていそうな着手宣言」の節（#391）、「担当のいない判定待ちの PR」の節（#493）、「Epic に入っていない Issue」の節（#565。App の Epic の振り分けの結果。節が無ければ読まない）。
    - patrol の結果（#370）：`node harness/scripts/agent.ts arch-review-pending` と `node harness/scripts/qa-retro-loop.ts pending` の未採用の下書きの数。hq は割り振らず、数を手順12の一覧に出すだけ（Issue にするかは人が「〜の下書きを選ぶ」で決める）。
    - `fleet-status` の結果：番号を渡さない `node harness/scripts/agent.ts fleet-status --json` と、控えの各 fleet の Issue 番号の集合。番号なしの対象は `fleetTargets`（`agent:ready`・`agent:plan-ok`・`agent:plan-review` と、`agent:*` の無い開いた Issue）だけで、`agent:blocked`・`agent:hold`・`agent:waiting` などの Issue は入らない（下の「どの fleet にも入っていない開いた Issue」はこの範囲。止まった宣言・担当のいない PR はダッシュボードの節で拾う）。
    - 開いた Epic の子の一覧（App の記録 `kind=epic-split` と GitHub の sub-issues）：どの fleet にも入っていない候補が今の fleet の Epic に入るか（割り振り）を見分けるのに要る。`fleet-status` の行に「どの fleet にも入っていない」候補があるときだけ、開いた Epic ごとに1回読み、scratchpad の `hq-epic-children.json` に書いて（`assign --epic-children` に渡す）、次の回は Epic の数か更新が変わったときだけ読み直す。
  - `directEpics` の Issue（直接の進め方の Epic の子）は、下の「どの fleet にも入っていない開いた Issue」と空いた枠の割り当ての対象から外す（hq が節「ship を直接起こす進め方（`--direct`）」で起こす）。
  - 見つけるもの4つ：
    - **担当のいない PR**：着手宣言が無い・解除された・古い開いた Agent PR（ダッシュボードの「引き継ぐか決める」「停滞している Agent PR」「担当のいない判定待ちの PR」と、`fleet-status` の行の PR の着手宣言（`prClaim` の `stale` が真のもの））
    - **止まった宣言**：ダッシュボードの「止まっていそうな着手宣言」の節（#391）と、`fleet-status` のメモの着手宣言のうち、控えのどの fleet のセッションでもなく、`claim`／`prClaim` の `stale` が真のもの（期限は `routine.humanClaimStaleHours`・`routineClaimTakeoverMinutes`。#639）。控えに無く `stale` が偽の宣言は hq の外のセッション（Claude Desktop など）が着手中とみなし、引き継ぎの問いにも割り振りにも入れない。この集合（`stale` が真のもの）だけを、手順12の一覧に「期限切れの着手宣言」として1行ずつ（#番号・段階・session の短い ID）出す。引き継ぎの問い（AskUserQuestion）は同じ行について聞き、別の集合・別の扱いで2か所に出さない。hq は `release` も `--takeover` もしない（引き継ぎは人が決め、受け持つ fleet の指示で行う）
    - **どの fleet にも入っていない開いた Issue**：`fleet-status --json` の行のうち、控えのどの fleet の Issue 番号の集合にも無いもの
    - **Epic に入っていない単発の Issue**：ダッシュボードの節「Epic に入っていない Issue」の行（番号・Jev の一番高い Epic と確率か「未判定」）。節が無いか空なら無し。hq は Epic の子の一覧から自分で探し直さない
  - 前の回と同じものは数え直すだけにし、人に同じことを繰り返し聞かない（控えに聞いたものを残す。止まった宣言・担当のいない PR の聞き直しは `hq-decide.ts` の `takeover-record` が書く記録で決める）。
  - 割り振り（hq が決めて、手順12の一覧でまとめて知らせる）：
    - 動いている ship の数と空いた枠の割り当ては、hq が数えず、`node harness/scripts/hq-decide.ts assign --fleet-status <番号を渡さない fleet-status --json のファイル> --epic-children <ファイル> [--live-fleets <n>]` の結果に従う（`--epic-children` は、上の開いた Epic の子の一覧を scratchpad の `hq-epic-children.json` に `{"<Epic番号>": [Issue 番号…]}` で書いたもの。読んだら必ず書き、`assign` の前に置く。無いと Epic の子が単発の fleet で起きる。`--live-fleets` は「空きの補充」の数え方の settle していない Dispatch の数で、無ければ控えの `fleets` の数。控えの各 fleet の Issue 番号の集合は、要素の `issues`（Issue 番号の配列）に書く）。
      - `directEpics` の Issue は `assign` に渡す前に `fleet-status` の表から外す（直接の Epic の子は hq が節「ship を直接起こす進め方（`--direct`）」で起こすので、fleet への割り当てに入れない）。
      - 結果は `{ running, perFleet, free, actions }`。`running` が動いている ship の数（宣言があり `plan-gate` でない行。宣言のセッションは問わない）、直接の進め方の ship は含まない。全体の「動いている ship の数」は `running` に、控えの `ships` の settle していない Dispatch の数を足したもの、`free` が空き（`hq.maxParallelShips` − `running`）。直接の ship を足すので、`free` から控えの `ships` の settle していない数を引いたものを空きとして使う、`perFleet` が fleet ごとの数。`actions` を並びの順に実行する。
      - `add`：その fleet（`theme`・`dispatch`）に `ORCA orchestration send --to dispatch:<Dispatch ID> --subject "Issue の追加" --body "fleet-status に渡す集合に #<番号> を足してください" --json` で渡し、控えの Issue 番号の集合にも足す（fleet は fleet の skill の「hq からの追加の指示」で読む）。`newFleet` が null でないときは、同じ回の `start-fleet`（`index` が同じもの）で起こした fleet の Dispatch に送る。
      - `start-fleet`：新しい fleet を人に聞かずに起こす。`epic` があればその Epic の fleet を、下の空きの補充と同じ起こし方（hq の Run に `worker-start`）で起こす。`epic` が null なら `--epic` を付けない fleet（表示名 `fleet: 単発 <短い名前>`、`--comment "単発"`）で、`--spec` に「受け持つ Epic は無い（`--epic` を付けない `/fleet <番号…>`）」と書き、控えの `hq-fleets.json` には `epic` を null、テーマを短い名前、Issue 番号の集合を割り当てた番号にして `ledger-save` で置く。起こしたら手順12の一覧で知らせる。
      - `wait`：手順12の一覧に「空き待ち」として出す。
      - 触るファイルの重なり・依存・着手宣言は `fleet-status` の `selected` が見るので、割り当てで変えない。動いている ship の数が上限を超えていても、動いている ship は止めない（新しく割り当てないだけ）。割り当ての順と数え方は `hq-decide.ts` の `assignSlots` にあり、hq は写さない。
    - 止まった宣言・担当のいない PR：引き継ぐかは人が決める。hq は自分で引き継がない。見回しのたびに聞かず、見つけたものはためて、`hq.takeoverAskHours`（既定 24 時間＝1日1回）に1回、1回にまとめて AskUserQuestion で聞く（#771）。手順：
      1. 見回しのたびに、見つけたもの（上の「担当のいない PR」「止まった宣言」）を `{ "key", "state", "line" }` の配列にして scratchpad の `hq-takeover-found.json` に書き、`node harness/scripts/hq-decide.ts takeover-ask --found <ファイル>` を流す（記録は書かない。標準出力は `{ due, ask, held, skippedDeclined, nextAskAt }`）。見つけたものが無ければ空の配列で流す。
         - `key`：Issue の着手宣言は `#N`、PR に関わるもの（PR の着手宣言・担当のいない PR）は `PR #N`。同じ `key` が複数の元（ダッシュボードの節と `fleet-status`）に出たら1件にまとめる。`line` は人に示す1行（#番号・段階・session の短い ID・理由）。
         - `state`：`<元>|<段階>|<session>`。`<元>` はその `key` が出た元の名前（`fleet-status`・「引き継ぐか決める」・「停滞している Agent PR」・「担当のいない判定待ちの PR」・「止まっていそうな着手宣言」）を並べ替えて `+` でつないだもの。`<段階>`・`<session>` は `fleet-status --json` の行の `claim`（`#N`）か `prClaim`（`PR #N`）の `stage` と session の先頭8文字で、その行・宣言が無いときは `-`。ダッシュボードの行の経過時間などの文は入れない（見回しのたびに変わり、見送りが効かなくなる）。例：`fleet-status|plan|4559340b`、`停滞している Agent PR|-|-`。
      2. `due` が偽なら聞かず、ためるだけ（`held` と `nextAskAt` は手順12の一覧へ）。
      3. `due` が真なら、`ask` の全件を1問にまとめ、選択肢「全部引き継ぐ／全部見送る／選ぶ」で AskUserQuestion で聞く（おすすめを先頭に置き、なぜ人が要るかの1行を添える）。「選ぶ」なら続けて `ask` の `line` を選択肢にした複数選択で聞く（1問の選択肢は4つまでなので、多ければ4件ずつに分け、1回の AskUserQuestion の4問（16件）の中に収める）。
      4. 答えを `node harness/scripts/hq-decide.ts takeover-record --answer <ファイル>` で残す。ファイルは `{ "declined": [{ "key", "state" }…], "taken": ["<key>"…] }`。全部引き継ぐ＝`ask` の全件の `key` を `taken`。全部見送る＝`ask` の全件の `{key,state}` を `declined`。選ぶ＝選ばれた行の `key` を `taken`、示したが選ばれなかった行の `{key,state}` を `declined`（16件に収まらず示さなかった行はどちらにも入れない）。答えなかった・拒んだ＝`declined` も `taken` も空。`takeover-record` は聞いた時刻を進めるので、示さなかった行と答えの無かった行は、次の見回しではなく `hq.takeoverAskHours` が経った次の `due` の回に聞く。
      5. 引き継ぐものは、手順10と同じく受け持つ fleet の指示に `--takeover` での出し直しを書く。見送った行は、`state` が変わるまで聞き直さない（手順12では `skippedDeclined` の数だけ出す）。
  - Epic の振り分け（App が行い、hq は一覧に出すだけ）：
    - Epic に入っていない単発の Issue は、App の定期実行が Jev に問い、`jev.epicTriage` が `enforce` のときだけ App が Epic の sub-issues に足す（規則は [harness/docs/operations.md](../../../../harness/docs/operations.md) の「Epic の振り分け」）。
    - hq は Epic の案を人に聞かず、sub-issues に足さず、新しい Epic の Issue も作らない（intel にも作らせない）。
    - Epic の振り分け（sub-issues に足すこと）は一覧に出すだけにする（前の回と同じ行は数え直すだけ）。fleet への割り当ては上の空いた枠の割り当て（`assign` の `actions`）で行う。
- **空きの補充**（#663）：受け持ちの Epic が閉じて fleet に空きが出たら、待つだけにせず、開いている Epic から次の fleet を起こす。
  - いつ：見張り（`hq-watch.ts`）が `timeout` で返った回と、手順11で片付けた直後。
  - 数え方：`ORCA orchestration worker-list --run <hq の Run ID> --json` の settle していない Dispatch のうち控えの `fleets` の Dispatch の数（手順4と同じ数え方）が `hq.maxFleets` より少ないときだけ行う。起こすのは空きの数まで。
  - 候補：開いた Epic（`epic` のラベル）のうち、控え（`hq-fleets.json`）の `fleets` のどの `epic` でもなく、`directEpics` の `epic` でもないもの。選び方は手順3のとおり。`fleet-status --json` の出力・`hq-epic-children.json`・`gh issue list --state open --limit 300 --json number,title,labels` の出力を scratchpad に書いて `node harness/scripts/hq-decide.ts themes --fleet-status <ファイル> --epic-children <ファイル> --issues <ファイル>` を流し（条件を自分で読み分けない）、`judge` が `theme` なら担当（hq-judge）の `start` の並びで空きの数まで起こす。動いている fleet と `files` が重なる Epic は起こさない。人が指示したテーマ・順番があれば `themes` も担当も使わず、そちらに従う。
  - 起こさないもの：(a) 人が止めるよう言った Epic（止めるよう言われたら控えのキー `stoppedEpics`（Epic 番号の配列）に足し、再開を言われたら外して、どちらも `hq-state.ts ledger-save` で置く。hq が替わっても読めるように）。(b) `fleet-status` に「選ぶ」の行が1つも無い Epic（子が人の判断待ち・依存待ち・ほかのセッションの着手だけ）。
  - 起こし方：人の承認を待たずに起こす。hq の Run は作り直さず、控えの `runId` の Run に `worker-start ... --run <hq の Run ID>` で起こす（手順4の `run-create` は行わない。作り直すと `worker-list --run <hq の Run ID>` で数えられず `hq.maxFleets` を超えうるため。控えに `runId` が無いときだけ手順4のとおり作る）。指示・表示名・`turn_start_unobserved` の扱い・印・控えへの書き込みは手順4・5のまま。
  - 知らせ方：起こしたら、その場で文章で一言（テーマ・選んだ理由）知らせ、手順12の一覧に「空きの補充で起こした fleet」として載せる。AskUserQuestion にしない。
  - 候補が1つで空きがあるとき（`judge` が null）は、担当を呼ばずにその Epic を起こす。
  - 候補が無いとき：起こさず、手順12の一覧に「起こせる Epic なし」と理由（全部人の判断待ち・`files` の重なり・人が止めた）を1行書く。前の回と同じなら数え直すだけ。
  - Epic に入っていない単発の Issue を空いた枠に割り当てるのは、上の「空いた枠の割り当て」で行う。
