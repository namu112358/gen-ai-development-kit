# 運用

運用：Issue の書き方、ラベル、人が関わる場面、止める仕組み、困ったときの対応。

## Issue の書き方

「Agent タスク」の Issue Form で作り、着手してよければ `agent:ready` を付ける。タイトルは Conventional Commits の形式（`type(scope): 説明`、type は feat / fix / docs / refactor / test / chore / ci / build / perf / style / revert）で、PR とコミットのタイトルにもそのまま使われる。タイトルの形式や見出しが違うとゲートが読めず `agent:blocked` になる。PR のタイトルは必須チェック `agent/title` で検査される。

| 見出し | 必須 | 書くこと |
| --- | --- | --- |
| Goal | ○ | 何をしたいかを人の言葉で1〜2文。ファイル名・関数名は書かない |
| Background | | 最初の3行に、なぜ要るか（起きたこと・人の言葉）。根拠のファイルや行はその後に |
| Requirements | ○ | 満たすべき要件を5つまで。作り方の細部は計画に任せる |
| Non-goals | | やらないこと |
| Acceptance Criteria | ○ | 検証できる受け入れ条件を3つまで。`- [ ]` で1項目1条件、観測できる形で書く |
| Dependencies | | 補足のみ。順序は Issue Dependencies（blocked by）で設定する |
| Validation Requirements | | 検証方法 |

Issue を開いた人が Goal と最初の数行で「何をしたいか・なぜか」を分かるように書き、ファイル名・行番号・関数名は Background の後ろか計画に回す（人が一度に頭に保てるのは3〜5のまとまり程度なので、要件と AC の数も上の上限に絞る）。

1つの Issue は1つの変更に絞る。層（`harness/lib/`・`harness/gates/`・skill・docs・設定）をまたぐなら、Issue を分けるか Epic にして子課題に分ける（大きい PR は判定の見落とし・取り込みの衝突・判定のやり直しを増やす）。AC に skill や docs の文をテストで確かめる項目を入れない（AC が多いほど test-designer のテストが増え、PR が大きくなる）。例外は、ゲートや hook が実行時に読む文（Issue Form の見出しや `agent-plan` の書式など）。

`agent:ready` を付けたときに App が Jev に種類・領域・優先度・AC の書き方を問うかは、`harness.config.json` の `classification.issueTriage` で決める。`off` は問わない。`shadow` は提案をコメントするだけでラベルは付けない。`label` は提案のコメントを続け、そのうえで足りない `priority:*` と（計画が無ければ）`area:*` を Jev の答えから付ける（下記「足りないラベルを付ける」）。`label` では Issue を作ったとき（`opened`）にも、`agent:ready` を待たずに足りないものを Jev に問うて付ける。同じ Issue には一度だけ問うので、作成で問い済みなら `agent:ready` を付けても提案のコメントは出ない。Risk と Priority は本文に書かない。優先度は `priority:*` の5段階（highest・high・medium・low・lowest）で、急ぐものには `priority:high` か `priority:highest` を付ける（queue は優先度 → `agent:ready` が付いた順に並ぶ。付いていなければ medium、複数付いていれば最も高いものとして扱う。PR の段階は元の Issue の優先度を引き継ぐ）。大きな機能は親 Issue と Sub-issues に分ける（全部閉じると App が親を閉じる）。計画の段階で Claude が分けることもある（下記「Epic」）。

気づき・観測から Issue を作るときの下書き・重複の確かめ・作成は、[issue-creator](../../.claude/skills/issue-creator/SKILL.md) の skill にまとめてある（intel の手順3・4と patrol がサブエージェントで呼ぶ。#783）。

## 付き添いのセッションで進める

Issue を進めるのは、人が付き添う Claude のセッション。「#番号 を ship して」と頼むと、ship の skill（[.claude/skills/ship/SKILL.md](../../.claude/skills/ship/SKILL.md)）が Issue の状態を読み、段階ごとの skill を次の順につなぐ。

| skill | 段階 |
| --- | --- |
| plan | 計画を書き、plan-critic に批評させて投稿する。App の計画ゲートの結果を待つ |
| implement | 計画ゲートを通った計画を実装し、Draft PR を出す |
| judge | Reviewer と Risk Agent に判定させ、判定コメントを投稿する。合格なら App が Ready にする |
| fix | ブロッキング指摘や人のレビューを直し、判定をやり直す |
| sync | main を取り込んで衝突を解消し、判定が引き継がれたかを確かめる |

ship は人の Merge 待ち（App が auto-merge を付けたか、`kind=human-review` のコメントを付けた）か、人の判断待ち（計画ゲートで止まった、修正の上限、判断できない衝突など）で止まり、人がすること（Merge、例外ラベルを付けるかの判断（`test:exempt` は自動 Merge の対象の PR で `agent/tests` が止まったときだけ。Human Merge の PR では依頼のコメントのテストの変更を Merge の前に確かめる）、`setup.ts` の実行が要るか、Merge 後の確かめ）を一覧にする。段階を1つだけ頼めば、その skill だけを行う。

段階を始める前に、`node harness/scripts/agent.ts claim <番号> --manual --stage <段階>` で着手宣言を出し、段階が変わるたびに更新する（計画は `--stage plan`、批評は `--stage plan-critique`（計画より前のこの宣言が無い計画は、計画ゲートが `agent:plan-review` で止める）、実装は `--stage implement`、判定・修正・main の取り込みは PR 番号で `--stage judge`・`--stage fix`・`--stage sync`。`post-plan` は投稿の後、ゲートを通る見込みなら `plan-gate` の宣言を出し直し、通らない見込み（`agent:plan-review` で人の判断待ち）なら解除する）。見込みが外れて `agent:plan-review` になったときや、ほかの人の判断待ちで止めてセッションを終えるときは `release <番号>`。ほかのセッションの着手宣言があれば `claim` は止まり、引き継ぐのは人が決めたときだけ `--takeover` を付ける。最初の宣言が持ち主で、ほぼ同時に宣言したときは、`claim` が投稿の後に読み直し、後の側が自分の宣言を取り下げて止まる。止まった側はその Issue を進めず（fleet なら飛ばして次へ）、人がすることの一覧に「#番号 は session … が着手中」と書く。`critic-input`・`post-plan`・`worktree`・`ensure-claim`（PR を作る前）は、このセッションの着手宣言が無いと止まる。`ensure-claim` は PR 番号なら PR が開いているかも確かめ、fix・sync は push の前に流す。`claim <PR番号> --stage fix|sync` は Merge 済み・Closed の PR では宣言せずに止まる（消えたブランチを push で作り直さないため。#638）。セッションの ID が得られないと手動の宣言は止まる。ローカルのセッションを複数動かすときは、段階を始める前に着手宣言を確かめ、セッション間でやり取りできる手段（`ListAgents`・`SendMessage` など）があれば、ほかのセッションと話して担当を決める。判定の着手宣言（`--stage judge`）が有効な間は、App は main への push でその PR を追従させない（auto-merge の PR を除く。判定の途中で head が動かないようにするため）。判定コメントの投稿で宣言が終わると、次の main への push か定期の照合で追従する。期限（手動は `routine.humanClaimStaleHours`、Routine は `routine.routineClaimTakeoverMinutes`）を過ぎた宣言では止めない。Routine の判定の着手宣言には段階が付かないため、Routine の判定ではこれまでどおり判定の途中でも head が動く。

担当（Issue の Assignee）：複数人で開発するときは、`harness.config.json` の `requireAssignee` を `true` にする（無い・`false` なら確かめない。既定は `false`）。有効な間は、人が Issue に担当を常に1人だけアサインし、それを正とする。アサインは人か、人に頼まれた付き添いのセッションが決め、エージェントは自分の判断ではアサインしない（アサインは追加する操作で、「空なら自分を入れる」を1回でできないため）。`claim <番号> --manual` は、Issue の Assignee がちょうど1人で今の GitHub のユーザー（`GET /user` の login）のときだけ宣言し、誰もいない・ほかの人・2人以上（自分を含んでも）なら宣言を投稿せずに理由を示して止まる（`--force`・`--takeover` でも確かめる）。PR の段階（`claim <PR番号> --stage judge|fix|sync`）は、その PR が Close する Issue の Assignee で確かめる。`critic-input`・`post-plan`・`worktree`・`ensure-claim` も同じことを確かめるので、作業の途中でアサインが変われば次の段階で止まる。止まったら ship はその Issue を進めず人に返し、人がアサインを直してから続ける。fleet は Assignee が自分1人でない Issue を選ばず、`fleet-status` の表の「選択」に理由を出す。Routine の宣言（`--manual` でない）は確かめない。

付き添いのセッションが人に聞くのは「人に上げる場面」だけ（ガードレール・`delegateMergeExclude`・`harness.config.json` に触れる計画の `agent:plan-review`、守りを弱める・データを壊しうる変更、要件・AC の変更、決まらない Planner の質問、引き継ぎ、Issue の目的と計画の食い違い、批評の止める条件で必須の指摘が残るとき）で、AskUserQuestion で選択肢つきで聞く（おすすめが先頭、1回に4問まで、質問ごとに「なぜ人が要るか」を1行）。止めた理由が想定 Risk だけで `files` がガードレール・`delegateMergeExclude`・`harness.config.json` に触れない `agent:plan-review`（`plan-review-check` の `riskOnly` が真）、計画で直せる理由、`files` の外の変更の計画の出し直し、領域の上限で待つこと、記録済みの決定で決まることは、聞かずにセッションが決め、`post-judgment` で「セッションの判定」（決めたこと・当たった基準・理由・覆すなら）を Issue か PR のコメントに残す。ship・fleet の最後の一覧に「決めたこと（覆すなら）」として載り、人は `agent:hold` かコメントで覆せる（書式は [formats.md](formats.md#セッションの判定agent-session-judgment)）。拒んだり答えなかったりすると、セッションは同じ質問を繰り返さず、要点を文章で示して止まる。規則は [harness/CLAUDE.harness.md](../CLAUDE.harness.md) の進め方。

開いた Issue をまとめて見るときは backlog の skill（[.claude/skills/backlog/SKILL.md](../../.claude/skills/backlog/SKILL.md)）を使う。`node harness/scripts/agent.ts backlog-scan` が事実（対象・触りそうなファイルの重なり・似た組）を出し（読むだけ）、重複か・どちらを先にするか・AC の書き直しの案・着手順の案は skill が決めて人に一覧で示す。Issue にコメントするのは人が AskUserQuestion で選んだ提案だけで、Issue の本文・ラベルは触らない。着手順の案は理由（依存・重なり・今の `priority:*`）だけを書き、ラベルの不足としては書かない。

複数の Issue をまとめて進めるときは fleet の skill（[.claude/skills/fleet/SKILL.md](../../.claude/skills/fleet/SKILL.md)）を使う。`node harness/scripts/agent.ts fleet-status` で選び（番号を渡さなければ、`agent:ready`・`agent:plan-ok`・`agent:plan-review` の Issue と、`agent:*` の無い、コラボレーターか App（Epic の子課題など）が立てた Issue（作ったまま計画に進んでいないもの。次にやることは plan）が対象。衝突しない範囲で本数を制限しない。PR が無い段階は触るファイルの重なりで（`harness.config.json` の `fleet.sharedFiles` だけが重なる組は待たない。人の判断待ちの `plan-review` の Issue は、ほかの Issue を待たせる相手にしない）、両方に PR がある組は `git merge-tree` で試して衝突すれば後の側が待つ。本数を絞るときだけ `--max`）、ship を Issue ごとに進めて、人がすることを1つの一覧にする。

進め方は `harness.config.json` の `fleet` で決まり、`fleet-status` の表の末尾の「進め方」の行に出る。

| `fleet.nesting` | 進め方 |
| --- | --- |
| `orca`（既定） | サブエージェントの中でさらにサブエージェントを呼べる環境（Orca）向け。Issue ごとに ship をサブエージェントとして並行に動かす（fleet > ship > plan-critic・test-designer・reviewer・risk-agent）。ship は段階ごとに新しいサブエージェントで呼び、段階の間は引き継ぎ（[formats.md](formats.md) の agent-handoff）と GitHub の事実で渡す。同時に動かす ship の数は `--max`、無ければ `fleet.maxParallelShips`（既定 3）。ship は人に聞かずに止まって fleet に返し、fleet がまとめて聞く。ship が入れ子にできない（Agent ツールが無い）と返したら、そのセッションは `flat` の進め方に切り替える |
| `flat` | 1つのセッションで、ship の段階を Issue ごとに交互に進める |

クラウドの付き添いのセッション（`CLAUDE_CODE_REMOTE` が `true`）ではサブエージェントの入れ子が1段までなので、`orca` のままでも ship が入れ子にできないと返し、fleet は交互の方式（`flat`）になる。hq とペインは無い。作り方は [setup.md](../../docs/setup.md#12-クラウドの付き添いのセッション)。

bypass と委任承認の状態（#718）：`fleet-status` の表の末尾の「進め方」の行の後に、bypass と委任承認の今の状態を2行で出す（`bypass：有効（@人）`・`bypass：無効（理由）`、`委任承認：計画＋Merge`・`計画のみ`・`無効（理由）`、読めないときは `読めない（理由）`）。`--json` は `merge` に入れる（`{ readable: true, bypass: { active, by, since, reason }, delegate: { mode, active, planActive, by, since, reason } }`。読めないときは `{ readable: false, error }`）。状態は gates の `bypassState` と `delegateState` で決める表示だけで、Merge の判定は変えない。1回の `fleet-status` で GitHub の API が増えるのは、ダッシュボードを探す `GET /issues?state=open&creator=<App>`（ふだん1回）と、ダッシュボードに bypass か委任のラベルが付いているときだけの `GET /issues/<ダッシュボード>/timeline`（ページの数だけ）。

キーは Issue #243 の例の `agentNesting` ではなく、fleet だけが読む設定として `fleet.nesting` にまとめた。入れ子の ship も着手宣言は同じセッションの ID（`AGENT_HARNESS_SESSION`）で出すので、同じセッションの宣言どうしは実装中（`implement`）のものだけを重なりの相手にし、それ以外は並べた順の先の側を選ぶ。

ハーネスが更新されたときの交代（#199）：Claude Code は担当の定義・CLAUDE.md・skill をセッションの開始時に読むので、始めた後に main でハーネスが変わっても、そのセッションは古いまま動く。SessionStart の hook が始めたときに読み込んだハーネスのファイルの版を記録し（書式は [formats.md](formats.md) の「読み込みの記録」）、`node harness/scripts/agent.ts harness-drift`・`claim`・`fleet-status` がそれを `origin/<既定ブランチ>` と比べる（比べる元は本体の HEAD ではなく読み込んだ中身なので、本体の checkout が古いまま始めた場合も最初の `fleet-status`・`claim` で分かる。ブランチが自分で変えたファイルは数えない）。origin で変わったファイルは、一番古い変更から猶予（`harnessDrift.graceHours`、既定 6 時間）を過ぎるまで古いとせず、変わったことを1行で知らせるだけにする。規則（`harness/CLAUDE.harness.md`）・`.claude/settings.json`・判定の担当（reviewer・risk-agent・review-* の agent、judge・review-panel の skill）は猶予を置かずに古いとする（判定の担当を入れるのは、judge だけが止まって交代が起きない場面を作らないため。#812）。古いと `fleet-status` の表の下に「このセッションの読み込みは古い」が出て、`claim --stage judge` と `step` は judge を始めない（止まる理由 `harness-stale`）。fleet（と人が付き添う単独の ship）は段階の切れ目で着手宣言を全部解除してから、人に聞かずに（Orca の worker の fleet は hq に聞き、hq が人に聞かずに答える。#806）、Orca で本体（main の checkout。hq と同じ）を `git pull --ff-only` で追いつかせてから `claude --permission-mode auto "/fleet --epic <Epic番号> <番号…>"` を起動し、画面の `auto mode` を確かめて元のセッションを終える。Orca が無いときは、tmux の中なら `harness/scripts/relaunch.ts` で本体に新しいセッションを `auto mode` で起動し、画面の `auto mode` を確かめてから1行を渡す（確かめられなければ1行を渡さず人に返す）。起動の手段が無い（tmux の外・本体が既定ブランチでない・未 commit の変更がある）ときは、人が新しいセッションに渡す1行を示して止まる（手順は fleet・ship の SKILL.md の「ハーネスが更新されたときの交代」）。docs/plan.md の Q92（ノードごとに `claude -p` を呼ぶ実行役は作らない）とは違い、`claude -p` は使わず、人が画面で見られる対話のセッションを1つ起動するだけで、段階の判断は新しいセッションが今の skill のまま行う。

待つ間の読み直し（#199）：fleet は、選んだ Issue が App・CI や人の Merge を待つだけになっても終わらず、`fleet.watch.intervalMinutes` 分おきに `fleet-status --watch` を読み直す（schedule・Actions・Routine は使わず、付き添いのセッションの中で待つ）。Merge・plan-ok などで次にやることが出たら ship を呼び直し、自分の PR の次にやることが `sync` になったら Merge 待ちでも ship を呼び直して sync させる。App が `fleet.watch.appStallMinutes` 分以上動かない行は1回だけ人に知らせる。fleet が終わるのは、受け持つ Epic が Close したときか、人の判断待ちだけが残ったとき。人の判断待ち（plan-review・Issue の止まる印）が `hq.humanWaitMinutes` を超えた Issue と PR の止まる印の Issue は `fleet-status` が脇に置き、fleet は表の下に出たこのセッションの着手宣言を解除して、聞き直さず一覧に1行で出す。受け持ちが全部そうなった fleet は「今は進められない」として終える（#667）（手順は fleet の SKILL.md の「待つ間の読み直し」。記録の書式は [formats.md](formats.md) の「見張りの記録」）。クラウドの付き添いのセッションでは、ship が購読した PR を数分おきの読み直しから外し、PR のイベントと30分おきの見回り（変わらない見回りが3回続いたら止める）で進める（ship の SKILL.md の「クラウドで PR を出した後」。#892）。

worktree（作業の置き場所）：`node harness/scripts/agent.ts worktree <ブランチ>` が作る worktree の置き場所は、既定では本体の隣の `../<リポジトリ名>.worktrees/<ブランチ名を安全にした名前>`。全員で変えるなら `harness.config.json` の `worktreeRoot`、そのパソコンだけ変えるなら環境変数 `AGENT_HARNESS_WORKTREE_ROOT`（例：WSL の中の FS。環境変数が設定より優先）。書き方は、`~/` はホーム、相対パスは本体のルートから、`{repo}` はリポジトリ名に置き換える（複数のリポジトリで同じ場所を使うなら `{repo}` を入れる。入れないと、ダッシュボードがほかのリポジトリの worktree のセッションも拾いうる）。リポジトリの中になる値と、本体を含む祖先（`..` など）は拒む（`worktree`・`worktree-remove`・合体版のレビューの⑧・ダッシュボードが同じ関数（`harness/lib/worktree.ts` の `worktreeRoot`）で決め、同じく止まる）。本体の `.git` は元の場所に残るので、速くなるのは作業ツリーの分だけ。置き場所を変える前に作った worktree は `worktree-remove` が見つけられないので、先に消しておくか `git worktree remove <パス>` で消す。Orca があっても worktree は `agent.ts worktree` で作り、Orca はその worktree での起動と監視に使う（規則は [harness/CLAUDE.harness.md](../CLAUDE.harness.md)）。Orca があれば `worktree` が Issue のブランチ（`claude/issue-<番号>-<短い名前>`）の worktree に表示名「#番号 短い名前」（短い名前は Issue のタイトルから `type(scope): ` を除いて24字までに詰めたもの。タイトルが取れなければブランチの後ろ）と Issue を付ける（親子は付けない。表示のためだけ）。Orca が無ければ何もせず、失敗したときは警告だけで続ける（Orca のアプリは起動しない）。

### hq（テーマごとの fleet をまとめる）

Orca がある環境では、hq の skill（[.claude/skills/hq/SKILL.md](../../.claude/skills/hq/SKILL.md)）で、テーマ（Epic）ごとに fleet を Orca の worker として起こし、人に聞く窓口を hq にまとめられる（ship → fleet → hq → 人）。役割は、hq が Epic と fleet の管理、fleet が Epic の終了、ship が Issue と PR の Close（Epic #281 の人の決定）。

- hq は Orca のプライマリ（main の checkout。`orca worktree current` の `isMainWorktree` が true）で動き、表示名は `hq`。リポジトリのファイル（本体・fleet のワークスペース・Issue の worktree）は書き換えない。リポジトリの中で書くのは印のファイルだけ（fleet のワークスペースの直下の `.agent-harness-workspace`。`.gitignore` に入っている。書き換えの場所の見張りの hook がこの印を見て、ワークスペースの中の書き換えを止める）。リポジトリの外の控え（scratchpad と、スクリプトが git の共通ディレクトリの下に置く状態（段階のファイル・`harness/scripts/hq-state.ts` の控え））は書く（作業ツリーの外で、書き換えに数えない）。
- テーマ（どの Epic を進めるか・順番）は hq が依存・重なり・優先度から決めて、fleet を `orca orchestration worker-start --worktree new-top-level` で起こし、決めたことを人がすることの一覧で知らせる（人には聞かない。人が指示した・止めるよう言ったテーマは人に従う。Epic に入っていない Issue のまとめ方は App の「Epic の振り分け」に任せる）。表示名は `fleet: #<Epic番号> <日本語の短い言葉>`（例：`fleet: #520 claude の mod`。言葉は hq が Epic のタイトルと Goal から作り、ペインの `--label` と、fleet の交代で起こし直す端末の表示名も同じ名前にする）。同時に動く fleet は `hq.maxFleets` まで、同時に動く ship は全体で `hq.maxParallelShips` まで。
- 起こした fleet に指示が入らなかった（Orca の stage が `turn_start_unobserved`）ときは、hq が画面を `hq-state.ts start-failure-save` で控え、入力欄に指示が残っていれば Enter だけを1回送る（#551）。
- fleet のワークスペースのペインは、左に fleet の Claude（縦いっぱい）、右に上から 進み具合（`panes.ts collect`）→ あなたがすること（`panes.ts todo`）→ PR と費用（`panes.ts prs`）。分ける向きは Orca 1.4.216 の実際の動き（`--direction vertical` で左右、`horizontal` で上下。orca-cli の案内とは逆）に従い、分けた後に `terminal list --include-visual-layouts` のペインの木で並びを確かめ、違えば表示のペインだけを閉じて分け直す（#430）。終わるときは `worker_done` を送ってから表示のペインだけを閉じ、残った空のシェルのペインは hq の片付けに任せ、fleet 自身の Claude の端末は閉じない（閉じる前に、閉じる handle が自分の端末の handle でないことを確かめる。#666）。手順は fleet の SKILL.md の「Orca の worker として動くとき」の3・7。
- hq のワークスペース（本体）のペインは、左に hq の Claude、真ん中の列に上から ① Epic/Issue（`panes.ts hq board`。Tab・`e`・`i` で、Epic ごとに子課題の状態で色分けした棒（緑■ Close・青■ AI が作業中・黄■ App の番・マゼンタ■ 人の番・灰■ 待ち・灰□ まだ。10件を超えると色ごとの割合で10マス。#501）と Close の数・人待ちの数・Epic に入っていない Issue の件数と、ページの下に凡例を出す Epic のページと、Epic ごとに Issue の6段階の横棒を出し Merge 済みを1行に畳む Issue のページを切り替える）→ ② 人待ち（`node harness/scripts/panes.ts hq todo`。全 fleet の人がすること。無ければ「今はありません」と AI・App が進行中の件数）→ ③ ログ（`panes.ts hq log`。状態が変わった Issue と、fleet の heartbeat の一言（控えの隣の `hq-heartbeat.json`。hq が `hq-state.ts heartbeat-save` で書く。`hq.staleSnapshotMinutes` より古いものと控えに無い fleet のものは出さない。#438）を新しい順に、ペインの高さに収まる分だけ）、右に intel の Claude（intel の skill が無い・起こせなければ開かない）。3つのペインは `--session` を受け取らず、数秒ごとに hq の控え（下の `hq-fleets.json` の `fleets`）を読み直して、各 fleet の `session` のスナップショットだけを読む（ログはその隣の `hq-heartbeat.json` も読む）。fleet を起こし直して控えの `session` が変われば、ペインを作り直さずに新しい fleet を出す。`session` がまだ無い fleet と、起こした直後（`startedAt` から `hq.staleSnapshotMinutes` 以内）でスナップショットが無い fleet は「起動中」、それより長く無い・古い・読めなかったものがあるスナップショットは各ペインの見出しの下に1行の注意で出る。Epic は collect が開いた `epic` のラベルの Issue を一覧し、Epic ごとに子課題（sub-issues と App の `epic-split` の記録）を読んでスナップショットに入れ（1つの Epic が読めなくてもほかは出る。読めなかった Epic は前回の値を使い、前回が無ければその子は Epic なしに出て、見出しの下の注意に「Epic #番号 が読めませんでした」と出る。呼び出しは Epic あたり2〜3回）、描くペインは GitHub を読まない。`epic` のラベルの無い Epic は拾えない（label-apply が子を持つ Issue に付ける前提）。タイトルは省略せずに幅で折り返す（英数字の語は途中で切らない）。手順は hq の SKILL.md の手順6（#402）。
- fleet の `ask` は hq がまとめて AskUserQuestion で人に聞き、`reply` の本文には人の答えだけを載せる。人が拒んだ・答えなかったら本文は `答え無し`。
- fleet は途中の報告・連絡を `orchestration send --type status` の件名（`ready-<PR>`・`merged-<PR>`・`verdict-<PR>`・`wait-<Issue>`・`notice`）で hq に送り、hq は人の Merge 待ち（`ready-<PR>`）と人の判断が要る `notice` を人にすぐ伝え、ほかは人がすることの一覧にためる（#395。振り分けの判定は `harness/scripts/hq-decide.ts` の `route`）。相談は今までどおり `ask`。fleet は hq に聞いて答えを待っている Issue があるうちは `worker_done` しない。
- hq はターンを終える前に必ず見張り（`harness/scripts/hq-watch.ts`）を run_in_background で置く。heartbeat だけの束は見張りが一言を控えて ack し、hq を起こさない。question・escalation・worker_done・status が届くと hq が起きて処理し、見張りを置き直す。fleet は heartbeat の本文に今の状況を一言（Issue 番号・段階・次にすること・待っているもの）入れ、hq はそれを人がすることの一覧の「今の状況」に使う（ログのペインにも出る。#438）。手順は hq の SKILL.md の手順7と、fleet の SKILL.md の「Orca の worker として動くとき」の6〜8。
- 進んでいない fleet（ペインのスナップショットの `at` が `hq.staleSnapshotMinutes` より古い、AI の番の行が `hq.stuckMinutes` より長い）は起こし直さず、`orchestration send` で状況を聞き、答えが無ければ人に知らせる。hq がまだ答えていない質問のある Issue は、人の答え待ちなので数えない。判定は `node harness/scripts/panes.ts fleets --session <ID>...`。
- hq は見回し（手順8）で、前に縮めてから（無ければ起こしてから）`hq.compactMinutes` 以上経ち、ship が動いておらず（`plan-gate` 以外の着手宣言が無い）、端末がターンを終えている fleet に `/compact` を送り（`hq-compact.ts fleet`）、hq 自身は見張りが `timeout` の切れ目で同じ条件で送る。記録は git の共通ディレクトリの下の `agent-harness/hq/hq-compact.json`。縮めた後は控えと `fleet-status` から受け持ちを読み直す。
- 止まった fleet を起こし直すのは、`orca orchestration worker-list` で `exited` と確かめたときだけ（`unverifiable` は止まった証拠にしない）。同じ fleet は1時間に2回まで（Epic への hq の記録のコメントで数える）、超えたら人に知らせる。起こし直すときは、前の fleet の着手宣言を新しい fleet に引き継ぐかを1問で人に聞き、引き継ぐなら新しい fleet が `--takeover` で出し直す。
- fleet が人の Merge 待ちで終わっても、Epic が開いていればワークスペースを残す。片付け（worker の解放とワークスペースの削除）は Epic が Close したとき。ただし hq が足した Epic の外の Issue があって `worker_done` がまだなら、`worker_done` を受けてから片付ける。Epic の無い単発の fleet は、`worker_done` を受け、集合の Issue が全部 Close したら片付ける（人の判断待ちが残れば残す）。
- fleet が「今は進められない」で終わったら、hq はその Epic に起こし直さず、空いた枠をほかの Epic の fleet で埋める（空きの補充。#663）。
- 15分ごとの確かめのついでに、fleet の外で止まっているタスク（担当のいない PR・止まった宣言・どの fleet にも入っていない開いた Issue・Epic に入っていない単発の Issue）を見つける（#407）。読むのはダッシュボードの節・patrol の未採用の下書きの数・番号なしの `fleet-status --json` と、候補があるときだけ開いた Epic の子の一覧。今の fleet の Epic に入るものはその fleet に `orchestration send` で渡す。それ以外の選べる Issue は、空いた枠（割り当ての判定は `harness/scripts/hq-decide.ts` の `assign`。`hq.maxParallelShips` − 動いている ship の数。番号なしの `fleet-status --json` の、控えの fleet の集合に入り着手宣言のある `plan-gate` でない行の数）に Epic に縛らず割り当てる（その Epic の fleet → 枠の空いた fleet（`fleet.maxParallelShips` 未満）→ `hq.maxFleets` 未満なら新しい fleet（単発の Issue は Epic なしの fleet）。人に聞かずに起こし、一覧で知らせる。どれにも当たらなければ「空き待ち」）。fleet のいない開いた Epic は、`hq.maxFleets` に空きがあれば、人の承認を待たずに次の fleet を起こし（空きの補充。Epic の Close の片付けの直後にも行う。人が止めた Epic・`fleet-status` に「選ぶ」の無い Epic は起こさない）、起こしたことを人がすることの一覧で知らせる。引き継ぎは人が決め、1回にまとめて聞く。Epic に入っていない単発の Issue は、ダッシュボードの節「Epic に入っていない Issue」（App の振り分けの結果。下の「Epic の振り分け」）を読んで人がすることの一覧に出すだけで（Epic の振り分けは一覧に出すだけ。fleet への割り当ては空いた枠で行う）、hq は人に聞かず、sub-issues に足さず、新しい Epic も作らない。
- 相談・アイデアの振り分け（#396）：人の判断が要る相談（fleet の `ask`・`agent:plan-review` で進めてよいか・引き継ぎなど、今の進め方を決めるもの）は、今までどおり hq が人に聞く。今すぐの判断が要らない気づき・改善案・Issue の種は、hq も fleet も intel（本体のタブ。`SendMessage` の `to: intel`）に回す（fleet は hq を通さない）。人が hq に言ったアイデアは hq が intel に回し、次からは intel のタブに直接送るよう案内する。intel のタブは hq が本体に起こす（既にいれば起こさない。auto mode で起きなければ閉じる）。intel がいなければ、hq の人がすることの一覧（fleet なら `worker_done` のレポート）に書く。hq がいないときは、人が intel に話しかけると、intel が判断待ちを GitHub から拾って聞き、答えを決定の記録に残す（fleet・ship は次の読み直しで読む）。
- hq の控え（hq の Run・hq の Claude の端末・ペイン・fleet の対応）は、git の共通ディレクトリの下の `agent-harness/hq/hq-fleets.json` に `node harness/scripts/hq-state.ts ledger-save` で置く（scratchpad ではないので、hq が落ちても新しい hq が読める）。heartbeat の一言は同じディレクトリの `hq-heartbeat.json` に `hq-state.ts heartbeat-save` で置く（#438）。起動の失敗は同じディレクトリの `hq-start-failures.json` に `hq-state.ts start-failure-save` で置く（#551）。`ledger-save` は、前の控えの印 `"handover": true` の fleet（hq が「交代する」と返して、まだ起こし直していないもの）を、新しい控えに同じテーマが無くても残し、外すときは `--release-handover <テーマ>` を付ける（#618）。hq はペインを閉じる前に、閉じる handle が自分の Claude の端末（控えの `hqHandle`）でないことを確かめ、本体に `orca terminal close --tab`・`--all` を使わない（#409）。
- **hq がいない間の見方と戻し方**（#409。hq が落ちた・タブが閉じられた）：
  - fleet は、hq への `ask` の時間切れや `check` の失敗の後、Orca が動いているのに hq の端末が無いことを5分以上あけて2回確かめたら、hq がいないとみなす。人の判断が要る Issue だけ宣言を解除して止め、ほかの Issue は進める。質問は fleet の控え（`agent-harness/hq/pending/<fleet のセッション ID>.json`）に書き、fleet のワークスペースの「あなたがすること」のペインの先頭に「hq がいない間の質問（fleet のタブで答える）」として出す。hq と人に同じ質問を二重に出さない。
  - 人は、fleet のワークスペースの「進み具合」「あなたがすること」のペインで状況を見て、質問には fleet のタブ（fleet の Claude）で答える。intel がいれば、intel に状況を聞き、判断待ちに答えられる。
  - 戻し方：新しいタブ（本体）で `/hq` を呼ぶ。新しい hq は `hq-fleets.json` を読み、前の Run を `orca orchestration run-use` で引き継いで未処理の質問と fleet の控えを処理し、fleet に `hq-back` を送る。fleet は答えの無い控えを hq に上げ直してペインから外す。前の hq の端末が残っていて応答しない（固まった）ときは、人が前の hq のタブを閉じてから `/hq` を呼び直す（新しい hq は、前の hq の端末が live なら始めない）。hq の自動の起こし直しはしない。
- Orca が無い環境では hq を使わず、今までどおり fleet・ship を使う。

fleet と hq の設定（`harness.config.json`。無いキーは既定値）：

| キー | 既定 | 内容 |
| --- | --- | --- |
| `fleet.shipMode` | `subagent` | ship の動かし方。`subagent` は fleet の中のサブエージェント。`worker` は Orca があれば ship を Orca の worker で動かす（無ければ今の手順） |
| `fleet.implementModel` | `sonnet` | fleet から起こされた ship が、実装（implement・fix・sync のコードを書く部分）を任せるサブエージェントのモデル（`sonnet` か `opus`）。計画・判定・test-designer のモデルは変えない。人が付き添う単独の ship は切り替えない（ship の skill の節「実装のモデル（fleet から起こされた ship）」） |
| `jev.modelRouting` | `shadow` | 計画ゲートで、実装に勧めるモデル（`opus` / `sonnet`）を Jev に問って記録（`plan-gate` の `modelRouting`）に残す。`off` は問わない。`shadow` は記録だけで、実装は `fleet.implementModel`。`enforce` はゲートを通った計画だけ勧めのモデルで実装し（`show-plan` の `modelRouting.use`）、ほかは `fleet.implementModel`。切り替えの基準は [plan.md](../../docs/plan.md) の決定ログ（Q106）。`jev.mode` とは独立 |
| `hq.maxFleets` | 2 | 同時に動かす fleet の数の上限（正の整数）。hq の人待ちのペインは超えると警告する |
| `hq.maxParallelShips` | 6 | 全体で同時に動かす ship の数の上限（正の整数）。hq が空いた枠に Issue を割り当てる上限。全体の枠に届くのは `hq.maxFleets` × `fleet.maxParallelShips` が `hq.maxParallelShips` 以上のとき |
| `hq.staleSnapshotMinutes` | 30 | fleet のペインのスナップショットの `at` がこれ以上古ければ、collect が止まっているとみなす（正の整数、分） |
| `hq.stuckMinutes` | 120 | AI の番の行がこれ以上同じ状態なら、進んでいないとみなす（正の整数、分） |
| `hq.compactMinutes` | 180 | hq が fleet・hq 自身の端末に `/compact` を送るまでの間隔（前に縮めてから、無ければ起こしてから。正の整数、分） |
| `hq.humanWaitMinutes` | 120 | 人の判断待ち（plan-review・止まる印）がこれ以上続いた Issue を、fleet・hq の選ぶ対象から一時的に外し、このセッションの着手宣言を解除する（正の整数、分） |
| `panes.collectIntervalSeconds` | 180 | fleet の進み具合のペイン（`panes.ts collect`）が GitHub と記録を読む間隔（60 以上の整数、秒） |

`hq.staleSnapshotMinutes`・`hq.stuckMinutes`・`hq.humanWaitMinutes`・`hq.compactMinutes` は既定値で動くので、`harness.config.json` と雛形には書いていない。変えるときは `"hq": { "maxFleets": 2, "staleSnapshotMinutes": 30, "stuckMinutes": 120 }` のように書き足す。

`fleet.implementModel` を戻す目安：数日分の PR で、実装のモデルごとの判定に1回で合格した割合（`report.ts` の「実装のモデルごとの品質」の節）を比べ、`sonnet` が `opus` のときより大きく落ちたら、`opus` に戻すかを人が決める。戻すときは `"implementModel": "opus"` と書く。

Merge 済みの変更をまとめて見直すときは arch-review の skill（[.claude/skills/arch-review/SKILL.md](../../.claude/skills/arch-review/SKILL.md)）を使う（「設計を見直して」「最近の変更をまとめて見て」と頼む）。PR ごとの判定は1つの PR の diff しか見ないため、Issue をまたいで積み重なったずれ（同じ役割の関数の重複、`harness/lib/`・`harness/gates/`・`harness/scripts/` の置き場所の崩れ、docs と実装の食い違い、コードの書き方の規則の外れ）を、観点ごとに arch-reviewer が読む。範囲は前回の arch-review の記録（ダッシュボード Issue へのコメント。書式は [formats.md](formats.md) の「arch-review の記録」）から既定ブランチの先頭までで、前回が無ければ Merge 済みの直近 10 本（`--since`・`--until`・`--last` で変える）。結果は直す Issue の下書きとして人に示し、どれを作るかは人が決める（作った Issue にラベルは付けず、`agent:ready` も付けない）。人が呼んだときか、人が付き添うセッションで始めた `/loop` の各回（`/loop 6h /arch-review --loop`。下の「見直しを /loop で回す」）か、patrol の `--routine` から呼ばれるループの回に動き、結果は PR ごとの判定（reviewer・risk-agent・review-panel）の材料にしない。ループの回は下書きを記録に残すまでで、Issue にするのは人が「arch-review の下書きを選ぶ」と頼んだときに選んだものだけ。

いま動いているエージェントの様子は、手元のダッシュボード（[harness/scripts/dashboard/README.md](../scripts/dashboard/README.md)）で見られる。`npm run dashboard` で起動すると既定のブラウザで開き（`--no-open` で開かない）、どの Issue / PR がどの段階にいるか（着手宣言の段階を優先し、無ければ fleet-status と同じ判断）、依存・Epic・Closes・Stacked PR・担当のセッションの関係、手元のセッションで動いているサブエージェントが1画面に出る。GitHub に書くのは、人がすることへの答え（`POST /decisions` の決定の記録のコメント。[formats.md](formats.md#決定の記録agent-decision)）だけ（画面の「気づきを送る」欄から送った文は、手元の受け箱に書き、intel が拾う）。

intel は、人に頼まれたときと決まった時刻（既定 08:30・17:30、手元の時刻）に、`node harness/scripts/dashboard/digest.ts show` のまとめ（前回からの Merge（App と人）・閉じた Issue と Epic・人の判断待ち・人の Merge 待ち・止まっていそうな着手宣言・人がすること3つまで）を出す。時刻は intel が `run_in_background` で置く見張り（`harness/scripts/intel-watch.ts`）が知らせ、intel が止まっていた間に過ぎた時刻は、置いた時にすぐ出す。すぐ知らせるのは、人の Merge 待ち（Human Merge）の PR と計画ゲートで止まった Issue が新しく出たときだけで、intel のタブに書く（OS の通知は出さない。hq が動いているときは hq が伝え、mods/agent-harness の通知が出るので intel は書かない）。GitHub には書かず、Routine も使わない。控えは git の共通ディレクトリの下の `agent-harness/digest/`（見張りは置き直すたびに最初に開いた Issue・PR を全部読み直す）。手順は intel の skill の手順9（[intel](../../.claude/skills/intel/SKILL.md)）。

毎時の Routine（[.claude/routine.md](../../.claude/routine.md)）が queue に従って同じ段階を進めるのは将来の構想。この文書の「Routine」は、付き添いのセッションで同じ段階を行うときはそのセッションに読み替える。

## ラベル

| ラベル | 付ける者 | 意味 |
| --- | --- | --- |
| `agent:ready` | 人 / patrol（auto mode の間、`patrol-supply ready` が条件を確かめて付ける） | 着手してよい |
| `agent:plan-review` | App（計画ゲート）/ Planner（申告のとき） | 計画に人の判断が必要。付き添いのセッションで実装する。外せるのは人と、App（ゲートの停止で、出し直した計画が通ったとき。Planner の申告で、人の決定の記録を Jev が確かめ、`jev.decisionRelease` が `enforce` のとき。Planner の申告で、条件を満たす `split` の計画を出し直したとき） |
| `agent:plan-ok` | App のみ | 計画ゲート通過 |
| `agent:waiting` | Routine / App | 依存待ち（blocker が閉じると App が外す） |
| `agent:blocked` | Routine / App / 人 | 人の対応が必要。付けるときは理由コードを残す（下記） |
| `agent:hold` | 人 | 個別停止 |
| `epic` | App | 子課題に分けた親 Issue。queue は計画・実装の対象にしない。Close しても残る |
| `risk:*` | Routine（Issue） / App（PR） | Issue：計画時の想定 Risk（表示用）。PR：App が受け付けた判定の Risk（判定し直せば付け替える） |
| `priority:highest` / `priority:high` / `priority:medium` / `priority:low` / `priority:lowest` | 人 / App | queue の優先度（高い順）。付いていなければ medium、複数付いていれば最も高いものとして扱う。2つ以上付いたら App が指摘する |
| `type:*` | 人 / App | 課題の種類。タイトルの type（feat / fix / docs / refactor / test / chore / ci / build / perf / style / revert）と同じ一覧。`epic` の Issue には付けない |
| `size:*` | App | PR の差分の行数（XS〜XXL、lockfile は数えない）。push のたびに付け替える |
| `review:exempt` | 人 | 判定を待たずに `agent/review` を通す（人の PR の急ぎ、fork からの PR）。付けた時点の差分にだけ効く（下記「例外ラベルの効く範囲」）。付け外しを App が記録する |
| `plan:exempt` | 人 | 計画のある Issue に紐付かない PR を例外として通す（付け外しを App が記録する） |
| `test:exempt` | 人 | テストを弱める変更を例外として `agent/tests` を通す（Issue 本文にテストを変える理由があるとき）。付けた時点の差分にだけ効く（下記「例外ラベルの効く範囲」）。付け外しを App が記録する。自動 Merge の対象の PR で使う（Human Merge の PR では要らない。下記「テストの改ざん検査」） |
| `area:*` | App | PR の変更ファイルの領域、Issue の計画（計画ゲートを通ったもの。止まった計画でも、`split` でなく files がすべて1つの領域に収まればその領域）の files の領域（`harness.config.json` の `classification.areas`）。計画の無い Issue には Jev が付ける。足すだけで外さない |
| `agent:delegate-plan` | 人のみ | ダッシュボード専用。計画ゲートの承認だけを App に委ねる「委任承認（計画）」のスイッチ（`harness.config.json` の `delegate.planLabel`・`delegateMergeExclude`）。セッションは付け外ししない（hook と deny で止める）。付けている間、ガードレール・想定 Risk だけで止まる計画に App が `agent:plan-ok` を付け、付けたときと定期実行で、その理由だけで止まっている Issue を判定し直す（[risk-policy.md](risk-policy.md#委任承認)）。期限は無い。外すと計画の委任が終わるだけで、委任で付けた `agent:plan-ok` は外さない |
| `agent:delegate-merge` | 人のみ | ダッシュボード専用。計画ゲートの承認と Merge の判断を App に委ねる「委任承認（計画＋Merge）」のスイッチ（`harness.config.json` の `delegate.mergeLabel`・`delegateMergeExclude`）。セッションは付け外ししない（hook と deny で止める）。付けている間、`agent:delegate-plan` と同じく計画を通し、条件を満たす Agent PR にガードレール・Risk の理由を飛ばして auto-merge を付ける（[risk-policy.md](risk-policy.md#委任承認)）。期限は無い。外すと、委任で付けた auto-merge を外して人にレビューを依頼する（委任で付けた `agent:plan-ok` は外さない） |
| `agent:bypass-merge` | 人のみ | ダッシュボード専用。ブロッキング指摘の無い Agent PR の Merge を App に任せる「bypass モード」のスイッチ（`harness.config.json` の `bypassMerge`）。セッションは付け外ししない（hook と deny で止める）。付けている間（期限なし）、ブロッキング指摘が無く範囲照合と `agent/tests` を通る Agent PR に、Risk・ガードレール・`humanMergePaths`・`delegateMergeExclude`・Jev の理由を飛ばして auto-merge を付ける（[risk-policy.md](risk-policy.md#bypass-モード)）。外す・停止スイッチで、bypass で付けた auto-merge を外して人にレビューを依頼する |
| `agent:auto-mode` | 人のみ | ダッシュボード専用。計画ゲートと Merge の両方を App に任せ、危険なものだけを人の判断に保留する「auto mode」のスイッチ（`harness.config.json` の `autoMode`）。セッションは付け外ししない。有効な条件は bypass と同じ（人が付けたもの、期限なし、停止スイッチが優先）。危険の判定は Jev だけに問い（`autoMode.jev` の問いと下限。Claude には問わない、#382）、Jev が危険と答えた、記録が無い・読めないときは保留する。付けている間、ガードレール・Risk・`delegateMergeExclude` を理由に止まる計画と Agent PR も、ほかの条件を満たし保留にならなければ App が通して自動 Merge する。詳細は [risk-policy.md](risk-policy.md#auto-mode) |

着手中かどうかと PR の有無はラベルにしない。着手宣言コメントと、Issue を `Closes` する開いた PR から App が判断し、ダッシュボードの queue に出す。queue は定期実行（1時間ごと）と手動の起動のときだけ公開し直す（定期実行が `periodicCatchUpMinutes` 分以上来なければ、イベントで動いた gate が補う）ので、宣言の変化もそのときに queue へ出る（今すぐ出したいときは gate の手動実行。下の「ゲートの失敗」）。今の宣言は `claim`・`fleet-status` がコメントから直接読む。Agent PR に Claude の commit（`Claude-Session` か Claude の `Co-Authored-By` の trailer がある）が push されたとき、push の時点で有効な宣言が無い、または宣言のセッションと食い違えば、App が PR にコメント（`kind=unclaimed-push`）で知らせる（止めない）。

止めた理由は、`agent:blocked` / `agent:plan-review` を付けるコメントに理由コード（`<!-- agent-harness:reason code=… -->`）で残す。ダッシュボードの「人の対応待ち」は理由別に並び、理由が無いものは「要確認」になる。main と衝突していて持ち主のいない Agent PR（PR と Close する Issue の着手宣言が期限切れ（`routine.humanClaimStaleHours`）か、宣言が無い）も「引き継ぐか決める」の1行で出る（PR・Issue・宣言のセッションの短い ID と時刻）。引き継ぐかは人が決め、引き継ぐならどのセッションにでも「#<PR番号> を引き継いで sync」と言う（hq は見回しで見つけて人に聞くが、自分では引き継がない。fleet は拾いに行かない。#371・#407）。

ダッシュボードの「止まっていそうな着手宣言」には、judge・fix・sync の着手宣言の後に `routine.stalledClaimMinutes` 分（既定 60）動き（宣言の更新・判定コメント・新しい commit）の無い Agent PR が出る（PR・段階・セッションの短い ID・経過時間）。知らせるだけで、宣言は取り消さない。commit の時刻は commit を作った時刻なので、前に作った commit を後で push すると動きが無いように見えることがある（#391）。

ダッシュボードの「担当のいない判定待ちの PR」には、宣言の無い Agent PR で、今の差分の判定の受け付けが無く、最後の動き（head の commit・Claude のコメント）から `routine.stalledClaimMinutes` 分（既定 60。「止まっていそうな着手宣言」と同じ設定）たったものが出る。`agent:hold`・`agent:blocked` の PR と衝突している PR は別の節の受け持ちなので出ない。知らせるだけで、宣言は取り消さない（#493）。

ダッシュボードの見返しの節（「委任承認で Merge された PR」「bypass で Merge された PR」「auto mode で通した計画」「auto mode で保留にした計画」「auto mode で Merge した PR」）は、そのスイッチのラベルがダッシュボードにあるとき、または前回の定期実行でその節に行があった・読めなかったとき（本文の印 `<!-- agent-harness:switch-reads … -->`。印が無ければ全部読む）だけ、最近の Issue・閉じた PR を読む。読まなかった節は「…が無効です」と出る（App の API の節約。#441）。

計画ゲートで止まった Issue に計画を出し直すとき、App は自分の計画ゲートの記録で前の印の出どころを見る。ゲートの停止（critical・ガードレールなど）で、最後に印を付けたのが App なら、新しい計画だけで判定し、止めた理由が当たらなければ `agent:plan-review` を外して通す。`acChangeProposed` や人が付けた印は、人が外すまで止める。出どころの無い古い記録は、記録の計画に Planner の申告・`acChangeProposed` が無く、前の印で止めた停止でもなければゲートの停止とみなし、そう読めないものは人が外すまで止める（[formats.md](formats.md#計画)）。付き添いのセッションは、Planner の質問（`openQuestions`・`needsHumanReasons`）を計画の投稿の前に人に聞いて計画に書き込み、答えで解消したものを申告から除く（plan の skill の手順3。定期 Routine は聞かない。fleet の入れ子の方式では ship が投稿せずに質問を fleet に返し、fleet がまとめて聞いて呼び直す）。申告として残るのは答えの無かったものだけで、委任承認・bypass の範囲照合に使えない計画（Planner の申告で止まった計画）を減らす。残った Planner の申告（`needsHuman`・`openQuestions`）は、付き添いのセッションが人の答えを決定の記録（```` ```agent-decision ````、`agent.ts post-decision`）で残すと、App が Jev に答え済みかを問い、`plan-decision` の記録を付ける。`jev.decisionRelease` が `shadow`（既定）なら記録だけ、`enforce` でしきい値（`jev.thresholds.decisionProbability`）以上なら答え済みとして判定し直す（通れば App が印を外し、ガードレール・critical などに当たれば `gate` の停止として残る）。人が付けた印は、ラベルの時刻（計画コメントの投稿の 60 秒前から、その計画ゲートの記録まで）の外で付いたものとして見分ける。`agent:plan-review` で止まった計画を人が「進める」と決めたときは、付き添いのセッションがその言葉を進める記録（`agent-decision` の `proceed`、`post-decision`）で残す。App は `plan-proceed` の記録を付け、計画コメントの本文が変わらない間、委任承認の Merge と bypass の範囲照合にその計画を使う（ラベルは変えない。[formats.md](formats.md#進める記録proceed)）。そのため Planner の申告の印を外さないまま申告付きの計画を出し直すと、2回目以降は印が窓より前から付いているので対象外になる（人が外す今までの運用に戻るだけ）。ゲートの停止の印は出し直しで外れうるので、計画を出し直しても止めておきたいときは `agent:hold` を付ける。書式は [formats.md](formats.md#計画)。

| 理由コード | 意味 |
| --- | --- |
| `form-error` | Issue 本文が Issue Form の書式でない |
| `plan-invalid` | 計画の構造化出力が読めない |
| `needs-decision` | 仕様・設計・AC について人の判断が必要 |
| `high-risk` | 想定 Risk が high 以上 |
| `no-critique` | 計画の批評（plan-critic）の記録（`critique`）か、計画より前の段階 `plan-critique` の着手宣言が無い（計画ゲートの批評の関所だけで止めたとき） |
| `split-invalid` | Epic の分け方（`split`）が検査に通らない |
| `resplit` | Epic を子課題に分けた後に、別の分け方の計画が来た |
| `split-failed` | Epic の子課題を作る途中で失敗した |
| `fix-limit` | 修正回数の上限に達した |
| `orphan-base` | スタックでないのに base が既定ブランチ以外の PR（Draft に留めている）。Stacked PR の上の層は `gh stack link` で組むまでの一時的な状態 |
| `external` | 権限・外部サービス・手作業など Claude の外の対応が必要 |
| `other` | その他（コメントに詳細） |

### 必須ラベルの規則

| 対象 | 必須のラベル |
| --- | --- |
| Issue | `type:*`・`area:*`・`priority:*` |
| 子を持つ Issue（Epic） | `epic`・`area:*`・`priority:*`（`type:*` は付けない） |
| PR | `type:*`・`area:*`・`size:*` |

人が付けたラベルは上書きしない（足りないものだけを足す）。

#### 足りないラベルを付ける

`harness/gates/label-apply.ts` が、Issue・PR の作成とタイトルの編集（イベント）と、定期実行で付ける。定期実行は、開いた Issue（ダッシュボードを除く。`agent:ready` の有無は問わない）と Agent PR を見て、ダッシュボードを書き直す前に付ける（「ラベルが足りない Issue・PR」は付けた後の状態を映す）。

- App（決定的に決まるもの）：タイトルの type から `type:*`。子（Sub-issues）を持つ Issue に `epic`。計画ゲートを通った Issue に、計画の files から `area:*`（計画ゲートの通過時にも付ける）。計画ゲートで止まった（`agent:plan-review`）計画でも、`split` でなく、files がすべて1つの領域に収まり、Issue に `area:*` が無ければ、その `area:*` を付ける（停止のコメントの後に付け、コメントに一文書く。定期実行でも同じ）。Jev より機械的な判別を優先する。1つの領域に収まらない計画の Issue には、計画の記録があるので Jev も `area:*` を問わない（ダッシュボードの「ラベルが足りない Issue・PR」に出る）。タイトルの形式が違う Issue・PR には `type:*` を付けない（ダッシュボードに出る）。
- `type:*` の付け替え：タイトルと食い違う `type:*` と、Epic の `type:*` は、App が付けたもの（Issue・PR の events API で、そのラベルを最後に付けた actor が App）だけを外して付け直す。人が付けたもの（見分けられないものを含む）は外さず、`label-mismatch` のコメントで知らせる。
- Jev（決まらないもの）：`classification.issueTriage` が `label` のとき、優先度の無い Issue に `priority:*`、計画が無く `area:*` の無い Issue に `area:*` を、Jev の答えの確率がそのラベルの下限以上のときだけ付ける。下限未満のもの、下限が未設定のとき（提案のみ）は付けずに `label-triage` のコメントで知らせる。本文が Issue Form として読めない Issue には問わない。同じ Issue には一度だけ問う（`issue-triage` か `label-triage` の記録があれば問い済み）。問うのは、Issue の作成（`opened`。タイトルの編集では問わない）、`agent:ready` が付いたとき、定期実行。作成では、問う直前に Issue を読み直し、開いていてタイトルの形式が正しく、足りないものがあるときだけ問う。App が作った Issue（Epic の子課題。親の `priority:*` を App が後で引き継がせる）には作成時に問わない。`agent:ready` が付いたときは提案のコメントを出したうえで足りないものを付ける。例外として、作成の直後に定期実行か `agent:ready` の問いが重なると、互いの `label-triage` をまだ見られず二重に問うことがある（付くのは同じ答えのラベルで、足すだけなので仕組みは足していない）。1回の定期実行で問う Issue は 5 件まで（残りは次の実行）。
  - Jev に渡す材料：タイトルと本文の節（Goal・Background・Requirements・Non-goals・AC・Dependencies）、Issue に付いている `type:*`・`risk:*`・`area:*`・`epic`（名前順。`priority:*`・`agent:*` は渡さない）、子（Sub-issues）の数（1以上のとき）。どれも App が API から集めたもので、計画などセッションが書いたものは渡さない。priority の段階ごとの基準は `classification.priorityCriteria`（段階名 → 英文）で導入先に合わせて上書きでき、空でない文字列の段階だけ既定（`harness/lib/issue-triage.ts` の `DEFAULT_PRIORITY_CRITERIA`）に代わる。このリポジトリでは、判定・Merge・ゲートの流れを止めている／誤らせているものを high、手戻り・費用・待ちを減らすものを medium、表示・説明の改善を low にしている（Q97）。
  - 下限はラベルごとに `jev.thresholds.labelProbabilityByLabel`（ラベル → 0〜1）で決め、当たらないラベルは `jev.thresholds.labelProbability` を使う。既定では `priority:medium` が 0.5、ほかの `priority:*`・`area:*` は 0.8。`labelProbability` が未設定なら、`labelProbabilityByLabel` があっても付けない（提案のみ）。
  - 値の理由（[plan.md](../../docs/plan.md) の Q94）：ラベルの無い Issue は queue で medium として並ぶので、`priority:medium` を誤って付けても並び順は変わらず、害は付けないときと同じ程度で小さい。0.5 以上なら medium がほかの選択肢を全部足したより確からしい（過半）。`priority:high`・`low` などは並び順を変え、`area:*` は同時 PR の上限（`areaConcurrency`）の数え方に効くので、0.8 のまま。
  - 付け直し：下限を見直した後の定期実行で、最新の `label-triage` の記録（App の名義）の `notApplied` のうち、今も足りず、記録の確率が今の下限以上のラベルを付け、`label-reapply` の記録を残す。Jev には問い直さない（費用がかからず、1回に問う 5 件の上限にも数えない）。`jevApiKey` が無くても動く。`label-reapply` の記録がある Issue には二度としない（付けた後に人が外しても付け直さない）。付けるものが無ければコメント（記録）を書かないので、下限をまた見直せば、その Issue もまた付け直しの対象になる。
- PR の `risk:*`：App が判定を受け付けたとき、受け付けた判定の Risk を付け、ほかの `risk:*` を外す（判定し直せば付け替える）。判定を受け付けなかったときは変えない。

`priority:*`・`area:*` の付与は、まず Jev に任せる（2026-09-29 の人の決定）。付き添いのセッションは、ラベルの不足を人に聞かず、伝えない。Jev が下限未満で付けなかったもの（App の名義の `label-triage` の記録の `notApplied`）は、セッションが Issue の本文と Jev の提案を見て決めて付け、付けたラベルと理由（Jev の提案と確率、同じか変えたか、決めた根拠）を Issue のコメントに残す（#235）。`label-triage` の記録が無いうちは、セッションは付けない。人や App が付けたラベル、`type:*`、違反はセッションは変えない。付かなかったものは、ダッシュボードの「ラベルが足りない Issue・PR」に出る。

必須ラベルの検査（`harness/lib/label-rules.ts`）は、足りないラベルと次の違反を返す：優先度（`priority:*`）が2つ以上、子（Sub-issues）を持つのに `epic` が無い、Epic に `type:*` がある、`type:*` がタイトルの type と食い違う（`type:*` が2つ以上を含む）、タイトルが `type(scope): 説明` の形式でない。`epic` が付いた Issue は、子課題を作る途中で子が 0 でも Epic として扱う。`area:*` と `size:*` は `harness.config.json` にある名前だけを数える。

- ダッシュボードの「ラベルが足りない Issue・PR」の節：定期実行のたびに、開いた Issue のうち `agent:*` か `epic` の付いたものと Agent PR を検査し、番号・タイトル・足りないもの・違反を1行ずつ出す（人がまだ整えていない Issue、人や bot の PR は出さない）。
- `node harness/scripts/agent.ts label-audit [番号..]`：同じ検査の一覧を出す。番号を渡せばその Issue・PR だけ、渡さなければダッシュボードと同じ範囲。ダッシュボードと同じ検査を人が手元で見るためのもので、セッションは走らせない。
- `node harness/scripts/agent.ts label-fill <番号> --label <ラベル> [--label ..] --reason <根拠>`：最新の `label-triage` の記録の `notApplied` にある `priority:*`・`area:*` だけを、同じ種類のラベルが無いときに付け、理由（Jev の提案と確率・根拠）のコメントを Issue に書く。記録が無ければ何もしない。提案と違うラベルはこのコマンドでは付けられない。

## Epic（大きな課題を分ける）

1つの PR に収まらない課題は、Claude が計画に `split`（子課題の一覧。書式は [formats.md](formats.md#子課題に分けるsplit)）を書いて Epic にする。分け方は人が承認しない。

1. 計画ゲートが `split` を検査する（タイトルの形式、各子課題の `files` の規則、兄弟どうしの `files` の重なり、依存の順序）。Risk と空の `files` では止めない。通らなければ `agent:plan-review`（理由コード `split-invalid`）。前の計画の Planner の申告で付いた `agent:plan-review` は、条件を満たす `split` の計画なら App が外して分ける（[formats.md](formats.md#計画)）。
2. 通ったら App が親に `epic` を付け（`agent:plan-ok` は付けない）、親の `type:*` のうち App が付けたもの（events API でそのラベルを最後に付けた actor が App）を外し（人が付けたものは外さず、定期実行の `label-mismatch` で知らせる）、子 Issue を Issue Form の見出しで作り、Sub-issues と依存（blocked by）を登録する。親の停止（`agent:hold`・`agent:blocked`・`agent:waiting`）と、親の開いた blocker（同じリポジトリのもの）は全部の子に引き継ぐ。その後で子に親の `agent:ready` と `priority:*` を付け、最後に `kind=epic-split` の記録を親に残す。
3. 途中で失敗したら、App が親に `agent:blocked`（理由コード `split-failed`）を付け、実行を失敗にする。人が原因を直して `agent:blocked` を外し、失敗した実行をやり直すと続きから作る（本文の目印 `<!-- agent-harness:epic-child parent=N index=i -->` で子 Issue を見つけて使い回し、二重に作らない）。
4. 既に子課題に分けた親（`epic-split` の記録か、App が作った目印付きの子がある）に別の計画が来て検査を通っても、分け直さずに `agent:plan-review`（理由コード `resplit`）で止める。既存の子課題をどうするかは人が決める。同じ計画コメントの再実行は分け直しとみなさない。
5. 子 Issue はふつうの Issue として、それぞれ計画ゲート・批評・判定を通る。分け方の誤りはそこで拾う。queue は `epic` の親を飛ばす。
6. 子 Issue がすべて閉じると、App が親を閉じる。子を付け替え・外した後に、子が1件以上あって全部閉じている Epic が残ったときは、定期実行（1時間ごと）で閉じる（子が0件の Epic は閉じない）。

### Epic の振り分け

Epic に入っていない Issue を、App の定期実行（label-apply の後）が Jev に問い、Epic の sub-issues に足す（Epic #436。判断は `harness/lib/epic-triage.ts`、組み込みは `harness/gates/epic-triage.ts`）。人にもセッションにも聞かない。

- 対象：開いた Issue から、PR・ダッシュボード・Epic（`epic` のラベル）・子（Sub-issues）を持つ Issue・既にいずれかの開いた Epic の子（sub-issues か `epic-split` の記録の子）を除く。開いた Epic が無ければ問わない。
- Epic ごとに独立に問う：1件の Issue につき開いた Epic ごとに「その Epic の目的を直接進める子課題か」を1問ずつ問い、Epic どうしを比べさせない。材料は App が API から集めた Issue のタイトルと本文、Epic のタイトル・Goal・子課題のタイトルだけ。
- 一度だけ問う：`epic-triage` の記録にある Issue と Epic の組は、答えが無くても問い済み。後から開いた Epic だけを問う。1回の定期実行で問う Issue は `jev.epicTriagePerRun` 件まで、残りは次の実行。`JEV_API_KEY` が無ければ問わない。
- 下限と差：前の記録と今回の答えを合わせ、今開いている Epic の中で確率の一番高い Epic が `jev.thresholds.epicProbability` 以上で、2番目との差が `jev.thresholds.epicMargin` 以上のときだけ足すと判定する。下限が 0〜1 の数として読めなければ足さない。
- shadow と enforce：`jev.epicTriage` が `off` なら問わず、節も出ない。`shadow`（既定）は記録だけで sub-issues を変えない。`enforce` は判定した Epic の sub-issues に App が足し、理由のコメント（Epic・確率・2番目の Epic と確率・外し方）を残す。shadow から enforce に切り替えた後は、Jev に問い直さずに記録の確率で判定して足す。
- 足さないとき：Issue に親がある。記録の `added` にある組（前に足した Epic）は、人・セッションが外しても入れ直さない。人・セッションが足した・外した sub-issues を App は変えない。
- 新しい Epic は作らない：どの Epic にも足さなかった Issue は、ダッシュボードの節「Epic に入っていない Issue」に、Jev の一番高い Epic と確率（記録が無ければ「未判定」）とともに出る。hq はこの節を読んで人がすることの一覧に出すだけ。
- 記録の形は [formats.md](formats.md) の `epic-triage`。

| キー | 既定 | 内容 |
| --- | --- | --- |
| `jev.epicTriage` | `shadow` | `off` / `shadow` / `enforce`。`jev.mode` とは独立。読めない値は `off` |
| `jev.epicTriagePerRun` | 3 | 1回の定期実行で問う Issue の数の上限（正の整数） |
| `jev.thresholds.epicProbability` | 0.9 | 足す Epic の確率の下限（0〜1） |
| `jev.thresholds.epicMargin` | 0.2 | 1番目と2番目の確率の差の下限（0〜1） |

## Stacked PR

Stacked PR は、下の層のブランチを base にした PR を重ねたもの（GitHub のスタック）。層ごとの diff が小さくなり、判定も層ごとに行える。

- 使える場所：付き添いのセッションだけ（クラウドの Routine では `gh api` の REST は通るが、GraphQL は 403 なので `gh stack`・`gh pr` は使えない）。組み方は [gh-stack の skill](../../.claude/skills/gh-stack/SKILL.md)、実装の手順は implement の skill の「Stacked PR で出すとき」。
- 積んでよい条件：上の層が (1) 下の層と同じファイルを触る、(2) 下の層が足したもの（関数・型・設定・ファイル）を使う、(3) PR 本文に `Stack: 理由` がある、のどれかに当たるときだけ。当たらなければ別々に `main` 宛てで出す。Reviewer は、どれにも当たらない層をブロッキング指摘（`out-of-scope`）にする。
- 紐付け：1層＝1 Issue。下の層の本文は `Refs #N`、一番上の層は `Closes #N`（どちらも1つだけ）。App は層を計画に紐付け（`agent/plan-link`）、紐付けの記録（`kind=stack-link`）を PR に残す（[formats.md](formats.md#app-の記録agent-app)）。
- 組み方：層ごとに `gh pr create --draft --base <下の層のブランチ>` で Draft PR を出し、全部そろったら `gh stack link <下の PR 番号> <上の PR 番号>` で組む。上の層は組むまで base が既定ブランチでもスタックでもないので、App が一時的に orphan-base（Draft に留めて `agent:blocked`、理由コード `orphan-base`）にする。組めば（`stacked` のイベント）App が `kind=base-resolved` を残して戻す。
- 判定：層ごとに、その PR の base からの差分（`git diff origin/<PR の base>...<head>`）で行う。judge-input にスタックの節（base・位置・下の層と変更ファイル）が入る。
- Merge：Stacked PR は Human Merge。GitHub の auto-merge も従来の Merge API も使えないので、人が全部の層が Ready になってから GitHub の画面でスタックを Merge する（Draft の層があると Merge できない）。スタックの Merge の API（`merge-async`）は App も使わない。
- Merge の後：層が既定ブランチに Merge されたら、App が `stack-link` の記録の Issue を閉じ、Issue に `kind=stack-closed` を残す（層の `Refs` は GitHub が閉じないため）。
- 追従：`git merge` で行う（`main` を一番下の層に、下の層を上の層に、下から順に）。rebase と force push はしない。App が既定ブランチへの push のたびに Agent PR を base に追従させる（update-branch＝merge）のと食い違わない。
- 止める操作：見張りの hook（`.claude/hooks/guard.ts`）が `gh stack` の `merge`・`push`・`sync`・`rebase`・`submit`・`modify`・`alias`・`unstack`・`checkout` など、ブランチ名やフラグを渡す `gh stack link`、`gh api -X PUT …/merge-async` を止める（`gh extension exec stack`・`gh-stack` の直接の実行も）。通すのは link（PR 番号・URL だけ）・view・移動だけ。

## 同時に開ける PR の数

同じ領域（`area:*`）の PR が長く開いたまま重なると、1本 Merge されるたびに残りが衝突する。`harness.config.json` の `areaConcurrency`（既定は `{"harness": 3}`）で、領域ごとに同時に開いてよい PR の数を決める。数えるのは、同じリポジトリの Agent PR（`agentBranchPrefix` のブランチ）のうち Draft のもの（判定の前で、まだ push が続く PR）だけ。Ready になった PR（人の Merge 待ちも自動 Merge 待ちも）、人の PR、fork の PR は数えない。 このリポジトリ（gen-ai-development-kit）では 6 にしている（2026-10-13 の計測で、直近 30 件の Merge 済み PR のうち取り込みが要ったのは 1 件だけで、上限 3 では Draft PR 3 件で枠が埋まり新しい PR を出せなかった。取り込みの衝突が増えたら 3 に戻す）。App が「Draft＝判定前、Ready＝判定に合格して Merge 待ち」を保つので、PR の一覧の `draft` だけで判定の前かが分かる。ガードレールに触れる PR は人の Merge を待つ間 Ready のままたまるので、それを数えると上限を超えたままになり、止める役に立たない。

- 上限に達した領域に計画の触るファイルが入る Issue は、queue が implement を出さずに skip にする（理由はダッシュボードに出る）。
- 付き添いのセッションの `agent.ts claim <番号> --manual` も同じ条件で止まる。ただし claim の段階 `plan`・`plan-critique` の宣言は、PR を作らないので上限を見ない。急ぐときは `--force` を付ける。fleet が領域の上限を越えて宣言し直すときは `--fleet` を付ける（飛ばすのは領域の上限だけで、`--force` と同じ）。ほかのセッションの着手宣言があるときも止まり、こちらは `--force`・`--fleet` では越えない。引き継ぐのは人が決めたときだけで、`--takeover` を付ける。
- 修正の上限（`agent:blocked`、理由コード `fix-limit`）で止まった Agent PR は Draft のまま人を待つので、数え続ける。人が片付けるまで、同じ領域の新しい着手は止まる。
- 計画・判定・修正の段階は止めない。

## 上限の設定

運用の上限の数値は、すべて `harness.config.json` にある（Issue #272。省略できるキーは、書かなければ既定値で動く）。変えるときは `harness.config.json` を PR で変える（ガードレールなので人が Merge する）。リポジトリの変数・環境変数では上書きしない（[plan.md](../../docs/plan.md) の Q101）。

| キー | 今の値 | 意味 | 読む側 |
| --- | --- | --- | --- |
| `routine.maxItemsPerRun` | 5 | 1回の Routine で扱う項目の数 | Routine（[.claude/routine.md](../../.claude/routine.md)） |
| `routine.humanClaimStaleHours` | 6 | 人の着手宣言を期限切れとみなす時間 | ゲート・セッション（queue・`claim`・`fleet-status`） |
| `routine.routineClaimTakeoverMinutes` | 90 | Routine の着手宣言を引き継げるまでの時間 | ゲート・セッション（queue） |
| `routine.gateReplyTimeoutMinutes` | 30 | 判定コメントへの App の返答を待つ時間（過ぎたら判定し直す） | `prFacts` を通してゲートとセッション（queue・fleet）の両方 |
| `routine.stalledClaimMinutes` | 60 | judge・fix・sync の着手宣言の後に動きが無ければ、ダッシュボードの「止まっていそうな着手宣言」「担当のいない判定待ちの PR」に出すまでの時間 | ゲート（`stale`） |
| `areaConcurrency` | `{"harness": 3}` | 領域ごとに同時に開いてよい判定前の Agent PR の数（節「同時に開ける PR の数」） | ゲート（queue）・セッション（`claim`） |
| `fixLoop.normalLimit`・`criticalLimit` | 2・3 | 修正の上限（`criticalLimit` は `normalLimit` 以上） | ゲート・セッション（`agent.ts step`） |
| `syncLoop.limit` | 3 | sync ⇄ judge のループの上限 | セッション（`agent.ts step`） |
| `patrolAutoSupply.dailyLimit` | 1 | auto mode の間に patrol が直近 24 時間で自動で Issue にする下書きの数の上限（0 で自動にしない。#827） | セッションだけ（patrol） |
| `periodicCatchUpMinutes` | 90 | 定期実行（schedule）が来なくても、イベントで動いた gate が定期の仕事（label-apply・停滞検知とダッシュボード・queue の公開）を補うまでの、前回の定期の仕事からの分（#418。rerun-failed は補わない） | ゲート（`run.ts`） |
| `staleHours` | 24 | 停滞とみなす時間・ダッシュボードで見返す期間 | ゲート（`stale`） |
| `jev.maxDiffChars` | 80000 | Jev に渡す diff の文字数の上限 | ゲート |
| `jev.decisionMaxTargets`・`decisionMaxAnswerChars` | 20・20000 | 決定の記録を Jev に問う項目の数・答えの文字数の上限（超えれば問わない） | ゲート |
| `classification.issueTriageJevPerRun` | 5 | 1回の定期実行で Jev に分類を問う Issue の数（残りは次の実行） | ゲート（`label-apply`） |
| `harnessDrift.graceHours` | （書かない。既定 6） | origin で変わったハーネスのファイルを「読み込みが古い」とするまでの時間（規則・settings・判定の担当には置かない。0 で猶予なし。#812） | セッションだけ（`harness-drift`・`claim`・`fleet-status`・`step`） |
| `fleet.maxParallelShips` | 3 | fleet ごとに、`--max` が無いときに同時に動かす ship の数（全体の上限は `hq.maxParallelShips`） | セッションだけ |
| `fleet.watch.intervalMinutes`・`appStallMinutes` | （書かない。既定 3・20） | fleet の待つ間の読み直しの間隔と、App が止まったとみなす時間（分。#199）。書かなければ既定値。誤りは `fleet-status --watch` の実行時に止まる（`loadConfig` では検査しない） | セッションだけ（`fleet-status --watch`） |
| `observe.opsHealth.*`（`scheduleGapMinutes`・`rateLimitFailures`・`failedGateMinutes`・`gateRunsPerDay`・`ciJobMinutes`・`readyHours`・`prOpenHours`・`requeueCount`・`claimIdleMinutes`・`planReviewCount`・`unplannedIssueCount`・`epicDrift`・`linkMismatch`・`staleWorktrees`・`areaFullMinutes`・`reviewPanelFailures`・`maxGets`） | 90・1・60・600・10・2・24・2・60・5・10・1・1・1・60・1・200 | 保守の観測の運用の健康（節「保守の観測」）のしきい値。…Minutes・…Hours は分・時間、ほかは件数・回数で、`maxGets` は1回の観測で GitHub を読む数の上限。書かなければ `ops-health.ts` の既定（`OPS_HEALTH_DEFAULTS`）で動く。誤りは `observe` の実行時に運用の健康の節が読めない旨で出す（ほかの節は出る。`loadConfig` では検査しない） | セッションだけ（`observe`） |
| `delegateMerge.hours`・`minRemainingMinutes` | （無し） | 古いキー。読まないが、書いてあれば検査する | — |

- `routine.gateReplyTimeoutMinutes`・`routine.stalledClaimMinutes`・`jev.decisionMaxTargets`・`jev.decisionMaxAnswerChars`・`classification.issueTriageJevPerRun` は、コードに直書きだった上限をキーにしたもの。省略でき、無ければ今の値で動く。`areaConcurrency`・`fleet`・`syncLoop`・`patrolAutoSupply`・`delegateMerge` も省略できる。
- 読むときの検査：`loadConfig` が上限の数値のキーを型と範囲で検査する（`harness/lib/config.ts` の `limitErrors`）。回数・件数・文字数は正の整数、時間は正の数、`minRemainingMinutes` は 0 以上。必須のキー（`routine` の3つ、`fixLoop` の2つ、`staleHours`、`jev.maxDiffChars`）が無いのも誤り。誤りがあれば、キーと今の値を示して止まる（上限が効かないまま動かない）。上限のほかに `project`（検証コマンド・取り込みのコマンド）の書式も検査する（#640）。Jev のしきい値・ガードレールの一覧などはここでは検査しない。
- 誤りのある設定が main に入ると、ゲートと `agent.ts` のコマンドが全部止まる。guard の hook も設定を読めず、`git … push` を送り先に関わらず止めるので、セッションは直す PR を push できない。人が手元で `harness.config.json` を直す PR を出して Merge する。`npm run check` が実物の設定と雛形を検査する（`harness/test/config-limits.test.ts`）ので、PR の段階で落ちる。

## テストの改ざん検査

App は PR の差分（`base...head`）から、テストを弱める変更を必須チェック `agent/tests` で検出する。fork の PR も対象。テストファイルは `harness.config.json` の `testPatterns`（範囲照合と同じパターンの書式）で見分ける。

- 検出するもの：テストファイルの削除とテストファイルでないパスへのリネーム、テスト定義（`test(` / `it(` / `describe(`）の行の削除（同じファイルに同じ名前の定義が足されていれば移動とみなす）、テストの名前の変更（削除された定義の行が、追加の定義の行と名前の文字列だけ違い、本体も同じ。組はテスト定義の行どうしで作る（同じまとまりの中で、相殺後に残った名前の変わった削除の定義の行と追加の定義の行の k 番目どうし。間に足したコメントで組がずれない）。呼び出し・引数・行の残りが違えば組にせず定義の削除）、テストの中身の書き換え（名前が変わった組の本体が、空行・`//` だけの行・アサーションの行を除いて前後で違う。本体は定義の行から括弧が閉じる行まで。本体が hunk の外まで続くとき、後ろの hunk は境目より前の行だけを数える（境目は、字下げが定義以下の次のテスト定義の行。字下げ 0 の定義なら、見出しの関数の文脈が前後どちらの名前とも違うテスト定義の hunk 全体。境目が無ければ後ろの全部）。数える行に本体の書き換えになりうる行（空行・`//` だけの行・アサーション・テスト定義の行以外）があれば、全部を見られず同じと確かめられないので中身の書き換えにして、前後の本体は持たせない）、`skip` / `only` / `todo` の追加（`.skip(`、`{ skip: … }`、`xit(` など）、アサーション（`assert` / `expect(`）を含む行の削除・書き換え。
- `skip` / `only` / `todo` の追加は、文字列リテラル（`'…'`・`"…"`・テンプレート文字列）の中の一致を数えない（テストの固定値の diff の文字列などで止めないため。Issue #431）。`{ skip: … }` の形は、同じ行にテスト定義の呼び出し（`test(`・`it(`・`describe(` など）があるときだけ数える。新しく足したテストファイルでは `only` だけを数え、`skip`・`todo` は数えない（既存のテストファイルへの追加は今までどおり止める。Issue #607）。見逃しうる形は、引数を複数行に分けた呼び出しの設定だけの行（`{ skip: true },`）と、変数に入れて渡す設定（`const opts = { skip: true };`）。文字列の範囲は hunk の新しい側の行（文脈と追加）を順に読んで見分け、見分けが確かでない行は伏せずに今までどおり数える：文字列・テンプレート・ブロックコメントが行をまたぐ行（複数行のテンプレート文字列の中の一致は数える）と、テンプレートに `${` がある行・コードの部分にコメントの始まりでない `/`（正規表現リテラルや割り算）がある行（この2つは同じ hunk の残りの行も）。割り算などのある行では誤検出が残りうる。コメント（`//`・`/* */`）の中の一致は数える。hunk より前から続く複数行のテンプレートの途中に足した行は、diff だけでは見分けられない。
- 検出したら、自動 Merge の対象の PR は failure、Human Merge の PR は neutral で、ファイルと行を一覧にする。テストの追加だけ、テスト以外だけの差分は success。
- 自動 Merge の対象の PR の failure の概要の先頭には、技術者でなくても分かる説明を置く：何を見張っているか（テストを甘くして通すこと）、なぜ止まったか（テストの行が変わると中身に関わらず止める）、人が確かめること（期待する結果・メッセージ・確認の数が変わっていないか、テストが消えていないか）、通し方（理由を書いて `test:exempt` を付ける。付けたあとに push したら付け直す）。一覧は検出の種類ごとに分け、種類ごとに一言の説明を付ける。
- アサーションの書き換えは、同じ場所の削除と追加が対になるとき（hunk の中の連続する削除と、その直後に続く連続する追加で、移動として相殺した残りの k 番目どうし）、変更前と変更後の行を並べる。対は表示のためだけで、検出の件数や failure の条件は変えない。
- アサーションの行は、整形だけの変更（インデント以外の空白・改行位置・引用符の違いなど）でも検出する。同じ内容の行を同じファイルの中で動かしただけなら数えない。
- 人が Merge する PR（Human Merge）では止めずに neutral にし、人の Merge の判断にまとめる（`test:exempt` は要らない）。Human Merge とみなすのは Agent PR で、次のどちらかに当たるとき：
  - 変更ファイル（リネームは旧パスも）がガードレールか `humanMergePaths` に当たる（判定の前から分かる。どの判定でも自動 Merge しない）
  - 現在の差分（patch-id）に対する最新の受け付けの記録が、Reviewer 合格かつ自動 Merge の対象外（critical・Risk の答え・範囲外・Jev の enforce など。App が Human Merge の依頼を出す条件と同じ）
- 書き直すのは、PR の作成・push・`test:exempt` の付け外しと、判定の受け付け（新しい判定、push での引き継ぎ、hold を外したときの付け直し）のとき。受け付けでは Ready 化と auto-merge の設定より前に書くので、判定のやり直しで経路が自動 Merge に変わると、auto-merge を付ける前に failure に戻る。
- neutral の要約には「人の確認が要る変更あり」と Human Merge とみなした理由、平易な説明（何を見張っているか、なぜ止めていないか、人が確かめること）、検出の一覧を載せる。Human Merge の依頼のコメント（`kind=human-review`）にも、懸念点より前に見つけた行を目立つ形で載せる。
- 次のときは緩めず、今までどおり failure（`test:exempt` が要る）：`agent:hold` や自動 Merge モードの停止だけが理由のとき（外すと判定のやり直し無しに自動 Merge に戻るため）、人の PR・fork の PR、PR に auto-merge が付いているとき、Reviewer が不合格の判定だけのとき。
- 誤検出や、Issue 本文にテストを変える理由がある変更は、人が PR に `test:exempt` を付けて通す（付け外しを App が記録し、外すと検査し直す）。自動 Merge の対象の PR で使う（Human Merge の PR では要らない）。例外は付けた時点の差分にだけ効く（次節）。
- 結論の優先順は「検出0件 → success」「`test:exempt` が効く → success（Jev に問わない）」「Human Merge → neutral」「削除があれば、削除が `test-move-jev` で通り（`enforce`・問えた・通す）、削除以外の検出が0件か `jev.testTamper` の Jev が通す → success」「削除が無く、`jev.testTamper` が `enforce` で Jev が通す → success」「auto mode の経路で、自動 Merge モードが有効なときに Jev が妥当と答える → success（下記「auto mode の間（Jev が妥当か）」）」「それ以外 → failure」（`harness/gates/tests-check.ts` の `testsOutcome`）。

### Jev の判定（`jev.testTamper`）

検出があると、App はアサーションの書き換え・テストの名前の変更・テストの中身の書き換えが「テストを弱めていないか」を Jev に問い、確率を記録する（docs/plan.md の Q95。`harness/lib/test-tamper-jev.ts`・`harness/gates/tests-jev.ts`）。

- 問うのは、すべての検出が変更後の行と対になったアサーションの書き換えかテストの名前の変更のときだけ（対ごとに1問。アサーションは変更前の行が確かめていたことを変更後の行がすべて確かめているか、名前の変更は新しい名前が古い名前の確かめていたことを狭めていないか、中身の書き換えは変更後のテストが変更前のテストの確かめていたことをすべて確かめているか。中身の書き換えには定義の行と本体の前後を渡す）。削除系（テストファイルの削除・リネーム、組にならないテスト定義の削除、skip / only / todo の追加）と、対にならないアサーションの削除が1件でもあるとき、対（アサーションの書き換え・名前の変更・中身の書き換えを合わせて）が 40 を超えるときは問わない（Jev では通らない）。本体が後ろの hunk まで続いて前後の本体を持たない中身の書き換えがあるとき、本体が前後どちらかで 4000 文字（`MAX_TAMPER_BODY_CHARS`）を超えるときも、一部だけ問わずに問わない。
- 材料は App が diff から検出した行（ファイル名・変更前・変更後。アサーションと名前の変更は各行 500 文字まで、中身の書き換えは本体を切り詰めない）だけ。全部の組（アサーション・名前・中身）の変更前＋変更後の文字数の合計が `jev.maxDiffChars` を超えるときは問わない。PR 本文・コメント・判定などセッションが書いたものは渡さない。fork の PR と、`JEV_API_KEY` が無いときは問わない。
- 1つの差分（patch-id）に1回だけ問う。同じ patch-id の記録（`kind=test-tamper-jev`）があれば問い直さず、記録の確率と**今の設定**で通すかを決め直す。Jev がエラーを返したときは記録せず、次のイベントで問い直す。
- `jev.testTamper`（`jev.mode` とは独立。無ければ `shadow`）：
  - `shadow`：確率を要約と記録に残すだけで、`agent/tests` の結果は変えない（要約に「記録だけで、この結果は変えません」と出る）。
  - `enforce`：対ごとの確率の最小値が `jev.thresholds.testTamperProbability` 以上なら success にする（下限が無ければ通さない）。auto-merge が付いていて Human Merge として緩めない PR でも、Jev が通せば success。委任 Merge・bypass モードで自動経路に乗る PR も、Jev が通せば止めずに進む。
  - `off`：問わない（今までどおり）。
- Human Merge の PR にも問って記録する（一致率の材料を増やすため。結論は neutral のまま）。経路の判断（Human Merge か、委任・bypass か）は変えない。
- enforce への切り替えは、`node harness/scripts/report.ts` の「テストの改ざん：Jev と人の判断」の行（一致率と、Jev は通す・人は直させた件数）を見て人が決める（[security.md](security.md#テストの改ざん)）。
- このリポジトリは 2026-09-30 に `enforce` にした（持ち主の決定、#364。docs/plan.md の Q104）。上の一般の手順と違い、一致率は見ずに切り替えた（`report.ts` が5分で終わらず読めなかった）。auto mode の間に Jev で妥当かを確かめる仕組み（#349、Epic #339。下記「auto mode の間（Jev が妥当か）」）より先に、`test:exempt` を付ける手間を早く減らすため。`report.ts` は enforce で Jev が通した記録を一致率に数えないので、切り替えの後は一致率の材料が減る。導入先の雛形（`harness/templates/harness.config.json`）の既定は `shadow` のまま。

### テストファイルの削除（移し先の確かめ）

テストファイルを消した PR（`agent/tests` の検出に `deleted-file` がある）で、PR 本文に対応表があれば、App が「消したテストの確かめが、足したテストに残っているか」を Jev に問う（Epic #511、Issue #514。`harness/lib/test-move-jev.ts`・`harness/gates/tests-move.ts`）。通れば、その削除では `agent/tests` を止めない。

- かける条件：削除があり、同じリポジトリの PR で、`jev.testTamper` が off でなく、`JEV_API_KEY` がある。
- 対応表：本文に Markdown の表があり、消した各ファイルの名前（最初の `.` より前）が本文に出る。これは表があるかの印で、通すかは Jev の答えで決まる。本文は Jev に渡さない。
- 材料：消したファイルの削除の行（中身全部）と、移し先（この PR で足した・変えたテストファイル）の追加の行。diff だけから集める。
- 問い：消したファイルごとに1問（移し先で、同じかより厳しい条件で確かめられているか）。
- 通す条件：`jev.testTamper` が `enforce` で、確率の最小値が `jev.thresholds.testTamperProbability` 以上。削除以外の検出（アサーションの書き換えなど）があるときは、それらを削除を除いて今の `jev.testTamper` の Jev が通すことも要る。auto mode の経路の PR の扱いは変えない（削除があっても、auto mode の Jev が妥当と答えれば今までどおり通る）。
- 問わないとき（今までどおり止める。要約に理由が出る）：対応表が無い・消したファイルの名前が表に無い・移し先が無い・消したファイルの件数と diff から読めた件数が合わない（「消したファイルの中身を diff から読めません」）・消したファイルが 20 件を超える（`MAX_TEST_MOVE_FILES`）・材料が `jev.maxDiffChars` を超える・Jev のエラー。
- 記録：問えたら通したときも止めたときも、ファイルごとの確率の表を PR にコメントで残す（`kind=test-move-jev`）。同じ patch-id・同じ問いの版（`TEST_MOVE_JEV_QUESTION_SET`）の記録があれば問い直さず、今の設定で決め直す。Jev のエラーは記録せず、次のイベントで問い直す。
- Human Merge の依頼のコメントにも、問えたときはこの表を載せる。

### auto mode の間（Jev が妥当か）

auto mode（Epic #339）の間、auto mode の経路に乗る PR でテストを弱める変更が見つかったら、すぐ人に回さず、その変更が妥当か（Issue と計画が求める振る舞いの変更に合ったテストの正しい直しで、落ちるはずのテストを黙らせるためのものではないか）を Jev に問う（Issue #349。`harness/lib/auto-mode-tests.ts`・`harness/gates/auto-mode-tests.ts`）。危険の判定は Jev だけ（人の決定、#382）で、Claude の答えは問わない。

- かける PR：Agent PR で、現在の差分の受け付けがあり、auto mode で自動経路に乗る（`autoModeRoute` が ok：Reviewer 合格・自動 Merge の対象外・auto mode が有効・受け付けの `autoMode.eligible`）もので、自動 Merge モードが有効（リポジトリの Allow auto-merge が有効で、ダッシュボードに停止ラベルが無い）なとき。委任承認（計画＋Merge）で乗る PR・bypass だけで乗る PR・自動 Merge の対象の PR・Human Merge の PR・`agent:hold` の付いた PR にはかけない（今までの扱いのまま。hold を外すと受け付けを当て直すので、そのときに問う。bypass だけ・委任だけで乗る PR に問わないことは `harness/test/gates-auto-mode-tests-holes.test.ts` で確かめる）。自動 Merge モードが無効なら、auto mode の経路でも問わず、`agent/tests` は今までどおり failure（`test:exempt` が要る）。auto-merge が付かず人が Merge するので、人が確かめる前にテストを弱める変更が Jev の答えで「確かめ済み」に見えないようにするため（Issue #440）。auto mode の経路の PR は、Risk critical・ガードレール・`humanMergePaths` に触れても Human Merge の neutral にしない（neutral だと Jev を通らずに必須チェックを抜けるため）。
- かける検出：すべての種類（テストファイルの削除・リネーム、テスト定義の削除、skip / only / todo の追加、アサーションの削除・書き換え）。ただし `jev.testTamper` が `enforce` で Jev がアサーションの書き換えを通すなら、先に success にして auto mode の問いはかけない。
- 材料：PR が Closes する Issue（1つだけ）の番号・タイトル・本文（Goal・Requirements・AC を含む本文そのまま）、その Issue の計画コメントの本文（委任・bypass の範囲照合と同じ選び方：ゲートを通った計画・ゲートの停止で止まった計画・人が進めると決めた計画。ゲートの記録の本文の sha256 と今の本文が違えば使わない。sha256 の無い古い記録の計画は、ゲートの後に編集されたかを確かめられないので使わない（Issue #440））、検出ごとの種類・ファイル・行・変更前の行・変更後の行・前後の差分（その行を含む hunk。ファイル単位の検出はそのファイルの diff の先頭）。行は 500 文字、差分は 4000 文字で切る。PR 本文・コメント・判定などセッションが PR の上で書いたものは渡さない。
- 問い：検出ごとに Noul の1問（`finding_0`, `finding_1`, …。yes が妥当）。Issue と計画から理由が言えなければ no。妥当とみなさない例を問いの criteria に書く：Issue・計画に理由が無いのに期待値を緩める／落ちるテストを消す・skip する（確かめていた振る舞いがまだ要るのに）／確かめる数を減らすだけで置き換えが無い／実装の不具合に合わせて期待値を変える。問いを変えたら版（`AUTO_MODE_TESTS_QUESTION_SET`）を上げる。
- 通す条件：検出ごとの確率の最小値が `jev.thresholds.autoModeTestsProbability` 以上（このリポジトリと雛形は 0.9。無ければ通さない）。答えが欠けた検出があれば通さない。
- 問わない（failure のまま、理由を要約に出す）とき：検出が 20 件を超える、材料が `jev.maxDiffChars` を超える、Closes する Issue が1つでない、使える計画が無い、fork の PR、`JEV_API_KEY` が無い、Jev がエラーを返した。
- 1つの差分（patch-id）に1回だけ問う。問うたら、通したときも止めたときも、検出ごとの確率の表を PR にコメントし、記録（`kind=auto-mode-tests`）を残す。同じ patch-id・同じ問いの版の記録があれば問い直さず、記録の確率と**今の下限**で決め直す。記録は付けた時点の差分にだけ効く（`test:exempt` と同じく、push で差分が変わると前の記録は使わずに問い直す）。Jev のエラーは記録せず、次のイベント（判定のやり直し・push）で問い直す。
- 問うのは主に判定の受け付けのとき（PR の作成・push の直後は受け付けが無いので問わない）。auto-merge を付けた後の書き直しでも、通した差分は success のまま。
- 止めたとき：`agent/tests` の failure の要約と、Human Merge の依頼（`kind=human-review`）のテストの節に、検出ごとの確率と「妥当でない・答えが無い」の理由を載せる。人は確かめて `test:exempt` を付けるか、直させる。通したものも、人は後から `agent:hold` や変更要求で止められる（通した差分にだけ効くので、直した push には効かない）。
- 集計：`node harness/scripts/report.ts` の「テストの改ざん：auto mode で通した」と「auto mode で通した・人が後から直させた」の行（[security.md](security.md#テストの改ざん)）。

### 分かっている限界

行の形で見るので、次の変更は検出しない。これらは Reviewer と人のレビューで見る。

- 期待値を変数や定数に移してから変える（assert の行は変わらず、定義の行だけが変わる）。
- fixture・スナップショット・テストデータのファイルの変更（`testPatterns` に当たらない場所のファイルは見ない）。
- 弱い assert の追加（`assert.ok(true)` など。行の追加は検出しない）。
- JS 以外の書き方（`test(` / `it(` / `describe(` / `assert` / `expect(` 以外のテスト定義やアサーション）。

## 判定の⑨の Jev（`jev.overbuild`）

判定の受け付けで、⑨（`over-implementation`・`over-testing`・`over-engineering`）のブロッキング指摘ごとに、Jev に「Merge を止めるべきか」と「直近の修正で変わった行への指摘か」を問う（`harness/lib/overbuild-jev.ts`・`harness/gates/overbuild-jev.ts`。Epic #497、Issue #584）。

- 材料は PR の diff・⑨の指摘・recent_diff だけ。判定の facts・rationale・authorView・PR 本文は渡さない。⑨以外の指摘は問わない。
- `jev.overbuild`（`jev.mode` とは独立。無ければ `shadow`）：
  - `off`：問わない。
  - `shadow`（既定）：答えを受け付けの記録の `overbuildJev` と、受け付けの表の「⑨の Jev」の行に残すだけで、reviewPass・修正の依頼・修正の回数は変えない。
  - `enforce`：「Merge を止める」確率が `jev.thresholds.overbuildBlockProbability` 未満の⑨をブロッキングから外して提案に回し、reviewPass・修正の依頼・修正の回数をその結果で決める。下限が無い・問わなかった（skipped）・エラー・答えの欠けは外さない。判定コメントは書き換えない。
- 問わない場合：`JEV_API_KEY` が無い、⑨が5件を超える、diff と recent_diff の文字数が `jev.maxDiffChars` を超える（記録は `status: skipped` で残る）。⑨が0件のときは記録を作らない。
- 限界：recent_diff は前回の受け付けの head から今の head への compare なので、間に main の取り込みがあると main の変更も入る。recent（直近の修正で変わった行への指摘か）は記録だけで、合否には使わない。
- このリポジトリは `shadow` のまま。`enforce` にするかは、記録を見て人が決める。

## auto mode の保留の検討会

auto mode で Jev の危険の判定が計画か PR を保留にしたとき、fleet が3つの担当（安全・分け方・反対役）に調べさせ、結論を出して人に上げる（Issue #681）。手順は [fleet の skill](../../.claude/skills/fleet/SKILL.md#auto-mode-の保留の検討会) に書き、ここには写さない。保留は人の判断なしに解かない。検討会がするのは、人に上げるか、`files` が変わる計画に出し直して Jev に問い直させるかだけ。

### 結論の記録の書式

結論を決めたら、計画なら Issue、PR なら PR に、fleet のセッションが `gh issue comment` / `gh pr comment` で投稿する。本文は次の形にする。

````markdown
<!-- agent-harness:claude -->
## 保留の検討会の結論（保留は解いていない）

保留：<計画コメントの URL か PR #N（patch-id の先頭12文字）>・Jev の危険の確率 <yes>%（保留の線 <1−dangerSafe>%）
結論：誤検知らしい／本当に危険（／PR の変え方の案）— <一番強い根拠を1文>
見落とし：<反対役の見つけたこと、無ければ「無し」>。人がすること：進める／直させる／閉じる

```agent-hold-council
{
  "version": 1,
  "target": { "type": "plan", "issue": 681, "planCommentId": 123 },
  "jev": { "yes": 0.82, "status": "ok", "questionSet": "..." },
  "conclusion": "dangerous",
  "roles": {
    "safety": { "verdict": "weakens" },
    "split": { "verdict": "unsure", "proposal": { "kind": "none", "files": [] } },
    "devil": { "verdict": "weakens" }
  },
  "summary": ["保留：…", "結論：…", "見落とし：…"],
  "at": "2026-10-11T00:00:00Z"
}
```
````

| 欄 | 中身 |
| --- | --- |
| `version` | 1 |
| `target` | 計画なら `{ type: "plan", issue, planCommentId }`。PR なら `{ type: "pr", pr, issue, patchId, headSha }`（`patchId` は保留にした受け付けの記録の値） |
| `jev` | `{ yes, status, questionSet }`。記録の写し。確率が無い（`skipped`・`error`）なら `yes` は `null` |
| `conclusion` | `change-plan`（計画を変える）／`false-positive`（誤検知らしい）／`dangerous`（本当に危険） |
| `roles` | 担当（`safety`・`split`・`devil`）ごとの `verdict`（`weakens`・`not-weakens`・`unsure`）。`split` だけ `proposal`（`{ kind: "split" \| "narrow" \| "guard-test" \| "none", files }`）が付く |
| `summary` | 人に上げる3行 |
| `at` | ISO 8601 の時刻 |

- 本文に ```` ```agent-plan ````・```` ```agent-verdict ````・```` ```agent-decision ```` のブロックを含めない（ゲートが起きないようにするため。App はこの記録を読まない）。
- 書式は `harness/docs/formats.md` に載せておらず、`node harness/scripts/agent.ts check` も検査しない。

### その後の数え方

集計のコードは無い。記録ごとに GitHub の記録と照らして数える。

- 計画（`dangerous`・`false-positive`）：同じ `planCommentId` の App の `plan-proceed` があれば「進めた（そのまま）」。後に別の計画コメントの計画ゲートの記録があれば「直させた」。Issue が計画の無いまま閉じたら「閉じた」。どれも無ければ「未決」。
- 計画（`change-plan`）：出し直した計画の計画ゲートの記録の `autoMode.hold` が偽なら「Jev が通した」、真なら「また保留」。
- PR：Merge 済みで最後の受け付けの `patchId` が記録の `patchId` と同じなら「そのまま Merge」、違えば「直させた」。Merge されずに閉じたら「閉じた」。

限界：PR の「直させた」は、保留の後の関係の無い push でも patch-id が変わると数えるので、多めに出る（`report.ts` と同じ限界）。`report.ts` の「auto mode で保留した計画・PR のその後」は確率の帯ごとの数で、結論ごとの数ではない。

## 例外ラベルの効く範囲

`test:exempt`（`agent/tests`）と `review:exempt`（`agent/review`）は、人が付けた時点の PR の差分にだけ効く。人が見ていない後からの変更まで例外で通さないため（判定の引き継ぎと同じく、差分の `git patch-id --verbatim` で比べる）。`plan:exempt` は PR の差分ではなく紐付けの例外なので対象外。

- 付けたとき：App が付け外しの記録（`kind=test-exempt` / `kind=review-exempt`）に、付けた時点の head とその差分の patch-id を残す。ゲートが動くまでに push されていても、イベントに入っている「付けた時点の head」の差分で記録する。
- push したとき：現在の差分の patch-id が記録と同じなら例外は効き続ける。変わっていれば、ラベルが付いたままでも効かない。`agent/tests` は通常どおり検査し、`agent/review` は判定待ち（同じ差分に受け付け済みの判定があればその結果）になり、判定前の PR は Draft に戻る。App が「効いていない」ことをコメントで知らせる（`kind=exempt-stale`。同じ head には1回だけ）。
- 通すには：差分を確認して、ラベルを外して付け直す。その時点の差分で新しい記録ができ、効くようになる。
- 付け外しの記録のうち最新のものが「付けた」で、その patch-id が現在の差分と同じときだけ効く。App 以外が書いた記録は数えない。
- この仕組みの前に付けた例外ラベル（patch-id の記録が無いもの）は効かない。付いたままの PR は、差分を確認して付け直す。

## 人が Merge するパス（humanMergePaths）

導入先の製品で、Risk の判定に関わらず必ず人が Merge したい場所（認証・マイグレーション・課金など）を決めておく。

- 書き方：`harness.config.json` の `humanMergePaths` に範囲パターン（範囲照合と同じ書式）で並べる。`**/migrations/**` のように最初の階層から `**` も書ける。

  ```json
  "humanMergePaths": ["src/auth/**", "**/migrations/**", "src/billing/**"]
  ```

- 効き方：変更ファイル（リネームは旧パスも）が当たる PR は、Risk が low でも自動 Merge せず、Human Merge の依頼になる。受け付けのコメントに理由（「人が Merge するパスに触れます（humanMergePaths）」）と表の行（「人が Merge するパス」）が出る。計画ゲートには効かない（計画は止めない）。
- ガードレールとの違い：ガードレール（`guardrailPaths`）は Agent が自分を縛る仕組みで、計画ゲートでも止まり、一覧が無ければすべてのファイルが当たる。`humanMergePaths` は導入先の製品を守るためのもので、書かなければ何もしない。
- ゲートは既定ブランチの `harness.config.json` を読む。PR の中で `humanMergePaths` を変えても、その PR の判定には効かない。

## 必須チェック

既定ブランチの Ruleset（`node harness/scripts/setup.ts ruleset` が作る）の必須チェックは2種類ある。

- プロジェクトの CI が出すもの：`harness.config.json` の `projectChecks` に並べる（既定は GitHub Actions の `ci`）。プロジェクトが正しいか（lint・テスト・ビルドなど）は CI が判断し、ゲートは CI を動かさない。
- ハーネスが出すもの：`agent/review`・`merge-route`・`agent/plan-link`・`agent/title`・`agent/tests`（App）。Merge してよいかの判断で、コードに固定していて設定から外せない。

`projectChecks` の書式の誤りはゲートでは検出されず、`setup.ts ruleset` の実行時にエラーになる。変えたら `ruleset` を実行し直す（手順は [setup.md](../../docs/setup.md)）。

## 人が関わる場面

| 場面 | 操作 |
| --- | --- |
| PR を出すとき（付き添いのセッションの Agent PR も、人の PR も） | Issue を立てて計画を投稿し、PR 本文に `Closes #番号` を書く。計画のある Issue に紐付かない PR は必須チェック `agent/plan-link` で止まる |
| `agent:plan-review` の Issue | 人が付き添う Claude のセッションで、止めた理由が想定 Risk だけで `files` がガードレール・`delegateMergeExclude`・`harness.config.json` に触れない計画は、セッションが `plan-review-check` で確かめて決め（`post-judgment` で記録）、ガードレールに触れる計画などは人が進めてよいと言えば ship が続きを進める（`node harness/scripts/agent.ts claim <番号> --manual --stage implement` してから実装し、`claude/` ブランチで同じ書式の PR を出す。Agent PR として判定される）。やめるときは `release <番号>`。ゲートの停止（critical・ガードレールなど）なら、止めた理由を直した計画の出し直しで外れうる |
| ほかのセッションの着手宣言がある（`claim` が止まった） | 宣言の段階とセッションを見て、そのセッションが続けるか、こちらが引き継ぐかを人が決める。引き継ぐと決めたら `claim <番号> --manual --stage <段階> --takeover` |
| 同時に宣言して後の側になった（`claim` が自分の宣言を取り下げて止まった） | セッションはその Issue を進めず（fleet は飛ばして次へ）、一覧に「#番号 は session … が着手中」と書く。先の側がそのまま進む。引き継ぐかは人が決め、引き継ぐなら `--takeover` |
| Agent PR に直してほしい点がある | PR の Review を **Comment として Submit** する（同じ名義の PR には Request changes を付けられない）。最後の push 以降のレビューを fix が修正依頼として扱う |
| Human Merge の依頼 | App のコメント（`kind=human-review`）が付いた PR を、依頼のコメントにテストの変更（`agent/tests` が neutral のとき）があれば、その行も確かめて確認して Merge する |
| 人の PR（`claude/` 以外のブランチから人が自分で書いた PR） | 計画のある Issue に紐付いていれば judge の skill で判定する。判定が出るまで `agent/review` は通らない。ブロッキング指摘は App の変更要求レビューで返るので、人が直す。急ぐときは `review:exempt` |
| `agent:blocked` | 理由のコメントを読み、直してからラベルを外す |
| 委任承認を始める | 見ていられる間だけ、ダッシュボードに付ける。計画の承認だけを委ねるなら `agent:delegate-plan`、Merge の判断も委ねるなら `agent:delegate-merge`。期限は無いので、終えるときは外す。ガードレール・想定 Risk だけで止まる計画は App が通し（止まっている Issue も判定し直す）、`agent:delegate-merge` なら条件を満たす Agent PR は、ガードレール・Risk が理由でも自動 Merge される（[risk-policy.md](risk-policy.md#委任承認)） |
| 委任承認を見返す | ダッシュボードの委任承認の状態の行（計画のみ・計画＋Merge・無効と、付けた人）、「委任承認で Merge された PR」（直近 `staleHours` 時間）、PR の App の記録（`kind=delegated-merge`）、Issue の計画ゲートの記録（`kind=plan-gate` の `delegated`）を見る |
| bypass モードを始める | ダッシュボードに `agent:bypass-merge` を付ける（外すまで続く）。ブロッキング指摘の無い Agent PR は、ハーネス自身の変更も含めて自動 Merge される（[risk-policy.md](risk-policy.md#bypass-モード)） |
| bypass モードを見返す | ダッシュボードの「bypass で Merge された PR」（直近 `staleHours` 時間）と、PR の App の記録（`kind=bypass-merge`）を見る |
| auto mode を始める | ダッシュボードに `agent:auto-mode` を付ける（外すまで続く）。中核に触れる計画・PR も、Jev が危険と答えなければ App が通す。付けると、止まっている計画を判定し直し、条件を満たす Agent PR に auto-merge を付ける。有効になったか（ならなかった理由）はダッシュボードのコメントに出る |
| auto mode を見返す | ダッシュボードの auto mode の状態・通した計画と Merge した PR・保留にしたもの（ダッシュボードの節「auto mode で通した計画」「auto mode で保留にした計画」「auto mode で Merge した PR」「auto mode で保留にした PR」）と、計画・PR の保留の理由のコメント（Jev の確率）を見る |

## 止める仕組み

| 仕組み | 操作 | 効き方 |
| --- | --- | --- |
| 停止スイッチ | 「Agent ダッシュボード」Issue に `agent:auto-merge-stopped` を付ける | App が全 PR の auto-merge を外し、merge-route が自動経路を failure にする。Human Merge は通る |
| 委任承認を終える | ダッシュボードの `agent:delegate-plan`・`agent:delegate-merge` を外す（期限は無いので、外すまで続く）。停止スイッチでも止まる（停止スイッチの間は計画の委任も無効） | `agent:delegate-merge` を外すと、App が委任で付けた auto-merge を外し（記録 `delegated-merge-end`）、人にレビューを依頼する。自動 Merge の対象の PR（low など）はそのまま。`agent:delegate-plan` を外すと計画の委任が終わるだけ。どちらも委任で付けた `agent:plan-ok` は外さない |
| bypass モードを終える | ダッシュボードの `agent:bypass-merge` を外す。停止スイッチでも止まる | App が bypass で付けた auto-merge を外し（記録 `bypass-merge-end`）、人にレビューを依頼する。委任承認（計画＋Merge）で乗る PR は委任に引き継ぐ。自動 Merge の対象の PR（low など）はそのまま |
| auto mode を終える | ダッシュボードの `agent:auto-mode` を外す。停止スイッチでも止まる | App が auto mode で付けた auto-merge を外し、記録（`auto-mode-merge-end`）を残して人にレビューを依頼する（bypass と同じ。停止スイッチ以外では、委任・bypass で乗り続ける PR は引き継ぐ）。自動 Merge の対象の PR（low など）はそのまま |
| 最終手段 | Settings → General → Allow auto-merge を切る | auto-merge が一斉に効かなくなる |
| 個別停止 | Issue / PR に `agent:hold` を付ける | PR は merge-route が failure、Issue は Routine が処理しない。外されると App が記録する |
| revert で自動停止 | 自動 Merge された PR を revert する | App が停止スイッチを入れる。人が確認して外すまで再開しない |
| main の CI の失敗で自動停止 | Merge の後、既定ブランチの先頭の必須チェック（`projectChecks`）が失敗する | App が定期の実行で見つけ、停止スイッチを入れて理由をダッシュボードに書く（記録 `auto-merge-stopped`、`cause: "main-ci-failed"`。同じ commit は1回だけ）。先頭が App の自動 Merge した Agent PR（Stacked PR でない。Merge の方法は SQUASH か MERGE）の commit で、親の commit の必須チェックが成功していたときは、戻す commit のブランチ `agent-revert/pr-<N>` と Draft の PR も出す（Agent PR ではなく、Merge は人）。出さないとき：人が Merge した PR・Stacked PR・Merge の方法が REBASE・PR を特定できない・親の commit でも失敗している（ci.yml に push(main) を足す前の commit が親でチェックが無い場合を含む）・ブランチが既にある。毎時の実行の前に次の PR が Merge されると先頭が別の commit になり、停止だけになる（取りこぼし）。先頭にチェックがいつまでも付かないときは何もしない。revert の PR を人が Merge すると、revert の検知がもう一度ダッシュボードにコメントを残す。再開は、原因を確かめて停止ラベルを外す |
| Routine の停止 | Routine を無効化する | Claude が動かなくなる（ゲートは動く） |

暴走したときは、Routine を無効化 → 停止スイッチ → 開いている Agent PR に `agent:hold` か Close → 誤って入った変更を revert、の順に止める。再開は停止ラベルを外すだけ。

## 困ったとき

| 状態 | 見え方 | 対処 |
| --- | --- | --- |
| Issue 本文が読めない | `agent:blocked`＋App の `form-error` | 本文を Issue Form の見出しに直してラベルを外す |
| 修正回数の上限 | PR に `agent:blocked` | 指摘を確認して人が直すか Close |
| 判定が古い | App の `verdict-rejected` | 何もしない（次の実行で判定し直す） |
| コンフリクト・停滞 | ダッシュボードの各一覧。持ち主のいない衝突した Agent PR は「人の対応待ち」に「引き継ぐか決める」で出る。judge・fix・sync の宣言の後に動きの無い PR は「止まっていそうな着手宣言」に出る | 人が解消する。持ち主のいない衝突した PR は、引き継ぐならどのセッションにでも「#<PR番号> を引き継いで sync」と言う。止まっていそうな着手宣言は、引き継ぐかを人が決め、引き継ぐならどのセッションにでも「#<PR番号> を引き継いで <段階>」と言う（引き継がないなら何もしない）。宣言の無い判定待ちの PR は「担当のいない判定待ちの PR」に出るので、引き継ぐかを人が決め、引き継ぐならどのセッションにでも「#<PR番号> を引き継いで judge」と言う |
| ラベルの不足・違反 | ダッシュボードの「ラベルが足りない Issue・PR」、`agent.ts label-audit` | セッションは聞かない（Jev が下限未満で付けなかった `priority:*`・`area:*` はセッションが決めて付け、理由をコメントに残す）。それでも足りないものと違反は、人がダッシュボードを見て、足りないラベルを付け、違反を直す（Epic の `type:*` を外す、優先度を1つにする、タイトルか `type:*` を直す）。セッションが付けたラベルを直すのも人 |
| GitHub API の上限 | `RateLimitError`（HTTP 403・429。メッセージにリセットか次に送れる時刻） | 短時間の上限（secondary）と 502・503・504 の読み取りは自動で待ってやり直す。core の上限の間は、付き添いのセッションのコメントの投稿とラベルの付け外しだけ GraphQL で続く（標準エラーに1行出る）。書き込みの前に REST で読むコマンド（着手宣言の読み直し・判定の入力など）は、メッセージのリセットの時刻まで待ってからやり直す |
| ゲートの失敗 | Actions の失敗 | ログを確認。`gate` の手動実行でダッシュボードと queue を更新できる。計画・判定・決定の記録のコメントで起動して失敗した実行は、次の定期実行（1時間ごと）か手動の起動でジョブ `rerun-failed` が1回だけやり直す（直近6時間・1回目の実行・まだ処理されていないものだけ。やり直した実行と飛ばした理由はそのジョブのログにある）。2回目も失敗した実行と、「acceptance の後で失敗」で飛ばした実行（受け付けは書かれたが Ready・auto-merge などの続きが済んでいない。定期照合は auto-merge の付いた PR しか見ないので直らない）は、人が `gh run rerun` するか判定し直す。定期実行が来ないときにイベントの gate が定期の仕事を補う仕組み（`periodicCatchUpMinutes`）は、`rerun-failed` を行わない（`actions: write` を定期実行・手動の起動のジョブだけに持たせるため） |

判定の集計（Jev の切り替え判断用）は `node harness/scripts/report.ts <owner>/<repo> [日数]`。集計のしかたと切り替えの基準は [security.md](security.md#jev) を見る。同じ集計の最後に、合体版のレビューの記録と今の判定を比べる節（「合体版のレビュー（記録だけの期間の比較）」）が出る。その切り替えの基準は [plan.md](../../docs/plan.md) の決定ログの Q91。さらに「auto mode で保留した計画・PR のその後」の節が、保留した計画・PR を危険の確率の帯ごとに、そのまま Merge・直させた・閉じたで数える（PR の「直させた」は保留の後の関係の無い push でも patch-id が変わると数えるので、多めに出る）。

PR に残る実行メトリクスのトークン数と推定料金（`harness.config.json` の `pricing` で計算）はセッションの累計による目安で、実際の請求額ではない。手元では `node harness/scripts/agent.ts usage` で確認できる。

Actions の使用分（料金になる分）は `node harness/scripts/actions-usage.ts <owner>/<repo> [日数（既定 1。小数も可）]` で数える（Issue #624）。

- 出るもの：ワークフロー×ジョブごとのジョブ数と分、ワークフローの小計と合計、`pull_request` で動くワークフロー（ci）のきっかけごとの実行数・ジョブ数・分（App の main の取り込み・セッションの push・再実行・そのほか）。
- 数え方：ジョブごとに `completed_at − started_at` を分単位で切り上げる（private のリポジトリの課金と同じ）。skipped のジョブと未完了のジョブは数えない（未完了は件数だけ出す）。再実行の前の回のジョブも数える。きっかけは、ジョブの `run_attempt` が 2 以上なら再実行、実行の actor が App の名義なら App の main の取り込み、`claude/` のブランチで actor が Bot でなければセッションの push、ほかはそのほか。
- 限界：ジョブの時刻からの見積もりで、請求額ではない（料金は出さない。請求は GitHub の Billing を見る）。実行1件ごとにジョブの一覧を読むので、長い期間は API を多く使う。絞り込みが 1000 件を超える期間は半分に分けて読み直し、それでも読み切れなければ「打ち切り」と出す。
- gh の認証で読むだけで、GitHub にもリポジトリにも書かない。

## 問題の記録と振り分け

ship・fleet は、セッションで起きた問題を記録し、終わりに振り分けて、ハーネスの改善の候補を「人がすること」の「改善の候補」に示す（Issue #186）。

- **何を記録するか**：拒否された操作（`deny`）、人に返す条件に当たった（`return-to-human`）、App の拒否（ゲートの停止・受け付けの拒否。`app-reject`）、人の訂正（`human-correction`）、手順に無い回避策（`workaround`）。起きたその場で `node harness/scripts/agent.ts incident add --kind <種類> --what <起きたこと> [--target <#番号|PR #番号>] [--workaround <回避策>]` で残す。
- **置き場所**：リポジトリの外の、セッションごとの JSON Lines。ディレクトリは `AGENT_HARNESS_INCIDENT_DIR`、無ければホームの下の `.agent-harness/incidents/`（TMPDIR は使わない）。ファイルは `<セッションID>.jsonl`（ディレクトリ 0700・ファイル 0600）。セッション ID は `--session <id>`、無ければ `AGENT_HARNESS_SESSION`（英数字と `-` `_` だけ）。置き場所の決め方は `harness/lib/incident.ts` の `incidentFile` の1か所で、hook（#187）も同じものを使う。秘密に見える文字列（`ghp_`・`github_pat_`・`sk-ant-`・`Bearer`・`token=` の値など）は記録するときと下書きを出すときに `***` に置き換える。
- **`/clear` で記録が分かれたら**：セッション ID が変わると記録のファイルも変わる。`node harness/scripts/agent.ts incident sessions` で記録のあるセッション ID を新しい順に出し、`incident list --session <今の ID> --session <前の ID>` のように `--session` を重ねて前の記録も読む（`render-issue` も同じ）。
- **振り分けの3つ**：ハーネスの不具合・手順の抜けは Issue の候補（`gh issue list --state open --search` で開いた Issue を探し、同じものがあればコメントの案、無ければ `incident render-issue <id>... --title <題>` で Issue Form の形の下書き）。このパソコンの環境は docs の候補か何もしない。一度きりのミスは記録だけ。
- **Jev への振り分けの問い（shadow、#498）**：ship の手順9で1件ずつ `node harness/scripts/agent.ts incident triage <id> --as <harness|environment|once> [--session <id>]` を流す。セッションの振り分け（`harness`＝ハーネスの不具合・手順の抜け、`environment`＝環境、`once`＝一度きり）と、同じ記録を Jev に問うた答え（確率・一番の種類・一致）を、`<セッションID>.triage.jsonl`（同じディレクトリ、0600）に並べて残す。振り分けの結果は今までどおりセッションが決め、Jev の答えは使わない。Jev に渡す材料は記録の `kind`・`what`・`workaround` だけで、秘密に見える文字列は `***` に伏せ、`target` は渡さない。鍵（`JEV_API_KEY`）がセッションの環境に無い・`jev.mode` が `off`・材料が `jev.maxDiffChars` を超えるときは問わずに `skipped` と残す（[security.md](security.md#jev) に例外として書いてある）。`node harness/scripts/agent.ts incident triage-stats [--json]` で全セッションの記録を集計し（同じセッション・同じ id は最後の行だけ）、一致の割合と組み合わせを見る。Jev の答えで振り分けを決める enforce にするかは、人がそれを見て決める。
- **Issue の下書きの重なりの問い（shadow、#631）**：Issue の候補（ship の手順9・intel の手順3）を人に示す前に（intel の手順3では issue-creator のサブエージェントがこの問いを流す）、下書きの本文を scratchpad のファイルに書き、自分の判断（同じ件と見た開いた Issue の番号か none）を決めてから `node harness/scripts/agent.ts issue-overlap check --title <題> --body-file <ファイル> --session-duplicate <番号|none> [--session <id>]` を流す。Jev に渡す材料は下書きと候補（開いた Issue のうち語の重なる上位 `jev.issueOverlapMaxCandidates` 件）のタイトル・Goal だけで、秘密に見える文字列は `***` に伏せる。問いの文・下限は #499 のもの。候補ごとの答え・セッションの判断・一致を `<セッションID>.overlap.jsonl`（同じディレクトリ、0600）に残す。鍵（`JEV_API_KEY`）が無い・`jev.mode` か `jev.issueOverlap` が `off`・候補が無い・問いが大きすぎるときは問わずに `skipped` と残し、止まらない。出力の提案は、`enforce` で Jev の答えが下限以上ならその Issue へのコメントの案、それ以外（`shadow` を含む）はセッションの判断のまま（Jev が「無し」と答えても、セッションが同じ件と見たものは捨てない）。`node harness/scripts/agent.ts issue-overlap stats [--json]` で全セッションの記録を集計し、一致率を見る。`enforce` にするかは、人がそれを見て決める。
- **起票は人が選ぶ**：起票・コメントは人が選んだものだけで、自動で起票しない。起票した Issue のラベルは Jev に任せる（[ラベル](#ラベル)）。
- **付き添いのセッションは GitHub に自動で書かない**：記録はファイルに残るだけ。`incident render-comment`（`agent-incident` ブロックのコメント本文、[formats.md](formats.md#問題の記録agent-incident)）は Routine がダッシュボードに書くためのもの（#187）で、ship・fleet は使わない。

## 保守の観測

PR ごとの判定は1つの diff しか見ないので、リポジトリ全体に積み重なるずれは、人が指示したときに `node harness/scripts/observe.ts` で1回分だけ観測する。LLM を呼ばない決まる集計で、判断（直すか・Issue にするか）は人が行う。

```
node harness/scripts/observe.ts [--days <n>] [--top <n>] [--junit <path> | --run-tests] [--previous <前回の JSON>] [--offline]
```

| 節 | 出るもの（根拠） |
| --- | --- |
| docs の照合 | docs（`docs/upstream/` を除く）・skill・agent の定義・`.claude/routine.md`・CLAUDE.md・`harness/CLAUDE.harness.md`・README に書かれた、実在しない `agent.ts` のサブコマンド・リポジトリ内のパス・ラベル名・設定キー（「`harness.config.json` の `キー`」の形で書いたもの）と、リンク切れ・無い見出しへのリンク（ファイルと行、名前）。コードブロックの中、`<…>` を含む例、導入先のパス（リポジトリの最上位に無い名前で始まるもの）は見ない |
| ホットスポット | 直近 `--days` 日（既定 30）の変更回数 × 今の行数の大きい順（変更回数、追加・削除行数、行数）。消えたファイルと `classification.sizeExclude` に当たるものは除く |
| 遅いテスト | テストごと・ファイルごとの時間の上位。`--junit` に Node の junit の出力を渡すか、`--run-tests` でこのリポジトリのテストを動かす（導入先には `harness/test` が無いので `--junit` を渡す）。どちらも無ければ読めない旨を出す |
| 不安定なテスト | 同じ head で失敗の後に成功した CI の実行のテスト名ごとの回数と、失敗した実行の URL（qa-retro と同じ集め方） |
| 生き残ったミュータント | ci ワークフローの mutation ジョブのログの `survived` の行（ファイル・行・壊し方・PR・実行の URL）。同じ箇所は新しい実行だけ残し、今は無いファイルは除く。行番号はその PR のもので、今の main とずれることがある。ログが読めなかった実行は数と理由を出す |
| 運用の健康 | 直近 24 時間の 14 項目（項目は節「見直しを /loop で回す」の表）。項目ごとに値・しきい値・根拠を出し、超えた項目を先に並べる。GitHub を読む数は `observe.opsHealth.maxGets`（既定 200）までで、読んだ数を `gets/maxGets` で出す。読めない項目（上限に達した・worktree を読めないなど）は理由を出す |

- 標準出力に人が読む要約を出し、最後の行に JSON のパスを出す。JSON は OS の一時ディレクトリに書く。リポジトリにも GitHub にも書かない（GitHub は gh の認証で読むだけ）。
- 各節は `--top`（既定 20）件までで、切った数を出す。GitHub が読めない（`--offline`、認証が無い）ときは、不安定なテスト・生き残ったミュータント・運用の健康の節を読めない旨にして、ほかの節は出す。
- `--previous` に前回の JSON を渡すと、節ごとに「新しく出たもの」「消えたもの」（上位の中での比較）を足す。運用の健康は、超えた項目の増減と値が増えた項目を足す（前回に運用の健康が無い・読めないときは比べない）。前回の JSON をどこに置くかは呼び出す側が決める（JSON は OS の一時ディレクトリにあり、回をまたいで残る保証は無い）。arch-review の `/loop` の回は `--previous` を付けずに呼び、その回の JSON を arch-reviewer の材料に渡す（前回の位置は arch-review の記録で持つ）。集計のロジックは `harness/lib/observe.ts`・`observe-docs.ts`・`hotspot.ts`・`test-health.ts`・`observe-ops.ts`・`ops-health.ts`。

## 見直しを /loop で回す

見直し（Merge 済みの変更の arch-review・qa-retro と、テストの test-prune）は、人が付き添うセッションの `/loop` から続けて回せる。skill によらない規則をここに書き、1回分の処理（間隔の目安・見る範囲や期間・記録や状態の書式）は各 skill の「/loop で回すとき」の節に書く。

- 回すのは、付き添いのセッションの `/loop`（`/loop 6h /arch-review --loop` のように）か、クラウドの Routine の patrol（`--routine`。[patrol-routine.md](../../docs/patrol-routine.md)）。Actions は使わない。Routine で動かすのは patrol だけ。付き添いのセッションでは `gh` をそのまま使える。
- `/loop` から呼ぶときは skill に `--loop` を付け、skill は `--loop` のあるときだけループの回として動く。人が `--loop` なしで呼んだときは、今までどおりの手順。
- 1回分はその回の中で完結させ、人の答えを待たない（AskUserQuestion を呼ばない）。人の判断が要る状態に当たったら、その回を止めて理由を出す。
- 前回の位置は、その skill の記録・状態から読む（arch-review はダッシュボード Issue の記録の `headSha`）。見るものが無い回は記録を残さず、次の回を待つ。
- 1回に出す直す Issue の下書きは3件まで。超える分は直す価値の高い順に絞り、残りは要約にだけ書く。
- ループの回は Issue を作らず、ラベルも付けない。例外は patrol の auto mode の間の自動の供給だけ（上限は `patrolAutoSupply.dailyLimit`。詳細は patrol の skill）。patrol の Routine がまとめの Issue を初回に1回作るのも例外。Routine の回は自動の供給を行わない。Issue にするのは、人が「〜の下書きを選ぶ」（例：「arch-review の下書きを選ぶ」）と頼んだときに、人が選んだものだけ。
- 止め方：`/loop` を止める（セッションで止めるよう頼む・セッションを閉じる）。記録を残す前に止めた回は、次の回が同じ範囲を見直す。
- 結果は PR ごとの判定（reviewer・risk-agent・review-panel）の材料にしない。

### patrol が知らせる観測の項目

patrol の回の要約の先頭には、保守の観測の「運用の健康」のうち、しきい値を超えた項目と前回から増えた項目を出す（知らせるだけで、見直しの skill は動かさない。直すのは各 Issue で行う）。項目は Epic #417 の表の 1〜14 で、しきい値のキーは `harness.config.json` の `observe.opsHealth` にある（節「上限の設定」）。

| # | 見張るもの | 見分け方 | しきい値のキー | 個別の直しの Issue |
| --- | --- | --- | --- | --- |
| 1 | 定期実行の抜け | gate の schedule の実行の間隔（最後の実行からの時間・最大の間隔） | `scheduleGapMinutes` | #392 の候補「定期実行の抜けを補う」（未起票） |
| 2 | App の API の上限 | gate の失敗の実行のうち上限が原因のもの（ログか失敗の理由）。数・時刻 | `rateLimitFailures` | #379・#384（済み）、#248 |
| 3 | 失敗した gate が残る | 失敗の実行のうち、同じ対象の後の成功が無いもの | `failedGateMinutes` | #390 |
| 4 | gate の実行の多さ | ワークフローごと・イベントごとの実行の数と前回との差 | `gateRunsPerDay` | #366（済み） |
| 5 | CI の過剰な実行 | ワークフローごとの実行の数と時間、同じ PR の重なった実行、長いジョブ | `ciJobMinutes` | #360・#376（済み） |
| 6 | PR の滞留 | 開いた PR の出てからの時間、Ready（人の Merge 待ち）のままの時間 | `readyHours`・`prOpenHours` | #392 の候補（ダッシュボード） |
| 7 | main の取り込みで判定が外れる | PR ごとの Draft への戻り・判定のやり直しの回数 | `requeueCount` | #397 |
| 8 | 止まった宣言・担当のいない PR | 着手宣言の段階と経過時間、宣言の無い判定待ちの PR | `claimIdleMinutes` | #391・#407 |
| 9 | 計画ゲートの滞留 | `agent:plan-review` の件数と経過時間、計画の無い開いた Issue の件数 | `planReviewCount`・`unplannedIssueCount` | #407 |
| 10 | Epic の紐付けのずれ | 子が全部 Close の開いた Epic、fleet で進んだ Issue のうち Epic の子でないもの | `epicDrift` | #412・#407 |
| 11 | PR と Issue の紐付けの抜け | 本文の `Closes/Refs` と GitHub の紐付けの食い違い | `linkMismatch` | #398 |
| 12 | 片付いていない worktree | `git worktree list` のうち、Issue が Close・PR が Merge 済みのもの、変更が残っているもの | `staleWorktrees` | ship の Merge 後の片付け（#405 に関係） |
| 13 | 領域の上限の張り付き | 領域ごとの開いた PR の数と上限、上限で待っている Issue と待った時間 | `areaFullMinutes` | #399 |
| 14 | 合体版のレビューの失敗 | 判定コメントの無いまま終わった合体版の記録、担当の失敗の数 | `reviewPanelFailures` | #406 |

- GitHub を読む数は、1回の観測で `maxGets`（既定 200）までに限る。上限に達したら以後の読みを呼ばず、その読みに頼る項目を読めない旨にする（API の上限を観測で使いすぎない）。
- 個別の直しの Issue が Merge された後も、項目は残す（直った後にまた起きたら気づくため）。
- 新しく「また起きそうな問題」が見つかって観測に足したら、この表に1行足す（足す項目・見分け方・しきい値の案は intel・qa-retro の下書きに書く）。

## よくある質問

### Q. 急ぎの Issue を先に進めたいときはどうするか

Issue に `priority:high`（もっと急ぐなら `priority:highest`）を付ける。優先度は highest・high・medium・low・lowest の5段階で、付いていなければ medium、複数付いていれば最も高いものとして扱う。queue（`node harness/scripts/agent.ts queue`）は優先度 → `agent:ready` が付いた順に並ぶので、先に処理される。PR の段階は元の Issue の優先度を引き継ぐ。

### Q. 自動 Merge を一時的に止めたいときはどうするか

「Agent ダッシュボード」Issue に `agent:auto-merge-stopped` を付ける。App が全 PR の auto-merge を外し、merge-route が自動経路を failure にする（Human Merge は通る）。再開は同じラベルを外すだけ。

### Q. 特定の PR だけ自動 Merge を止めたいときはどうするか

その PR に `agent:hold` を付ける。merge-route が自動経路を failure にし、他の PR には影響しない。再開は同じラベルを外すだけ。
