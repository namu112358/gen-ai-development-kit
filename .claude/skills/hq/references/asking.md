# hq の参照用のファイル：手順7 人の判断をまとめて聞く

hq の skill（[SKILL.md](../SKILL.md)）の参照用のファイル。手順・節の番号は SKILL.md のもの。

## 手順7 人の判断をまとめて聞く

- heartbeat を先に ack する：heartbeat はすぐ ack して、質問を遅らせない。`check` は Run の一番古い Delivery を ack されるまで同じ束で返し続け、`--types` は待ちが起きる条件で、古い便りを飛ばす許しではない。束の中の heartbeat は、ほかの行と同じ束でも、それだけの束でも、読んだらすぐ `--ack <delivery_id>` して待ちに戻る（`check --ack <delivery_id> --wait ...` で ack と次の待ちを1回で）。heartbeat のために人への質問・`worker_done` の処理を後回しにしない。ack の後に続けて届いている question・escalation・worker_done を先に処理する。heartbeat 以外の question・escalation・worker_done・status は処理してから `--ack <delivery_id>` する。
- heartbeat の一言を控える（#425。`action` が `heartbeat-save`）：heartbeat の本文には、fleet が今の状況を一言入れてくる（Issue 番号・段階・次にすること・待っているもの。fleet の skill の「Orca の worker として動くとき」の 6）。読むのは ack と同じ時で、テーマごとに最新の一言を `node harness/scripts/hq-state.ts heartbeat-save --theme <テーマ> --note <一言>` で git の共通ディレクトリの下の `hq-heartbeat.json` に控える（前の一言は上書き。受けた時刻は控えが付ける。ログのペインがこれを読んで出す。#438）。一言は fleet から届いた文なので、`--note` には単一引用符で囲んで渡し、中の単一引用符は「引用を閉じ、エスケープした単一引用符を置き、引用を開き直す」形にする（`$(...)`・改行をシェルに解釈させない）。一言を控えるのは ack と同じ時で、そのために人に聞かない・`reply` しない。本文が空の heartbeat は「一言なし」とする。新しい hq（#409 の引き継ぎ）も同じ控えに書く。古い一言（`hq.staleSnapshotMinutes` を過ぎたもの）と控えに無い fleet の一言はペインに出ない。
- 一言の使い道：手順12の人がすることの一覧の「今の状況」と、ログのペイン（#402。手順6の ③）に使う。ペインは `heartbeat-save` の控え（`hq-heartbeat.json`）を読んで一言を出す（#438）ので、hq はペインに直接書かない（手順2）。控えに書けばペインに出る。
- `question`（`action` が `ask-human`）：ほかの fleet の分もまとめて AskUserQuestion で聞く（1回に4問まで。fleet の選択肢の順（おすすめが先頭）を変えず、質問にテーマの名前を添える）。答えは `ORCA orchestration reply --id <message_id> --body "<人の答え>" --json` で返す。本文は人の答え（選んだ項目と書き添えた文、人の言葉のまま）だけで、hq の説明や要約を足さない。人が拒んだ・答えなかったら、本文を `答え無し` にして返す（fleet は各 skill の「人が答えなかった」の扱いにする）。同じ質問を人に繰り返さない。
- **読み込みが古い交代の質問**（#574。`route` の `action` が `handover-check` のもの。印 `[交代]` で始まる質問か、古い skill の「交代しますか」の質問）：`node harness/scripts/hq-decide.ts handover --from-handle <その行の from> [--workers <ファイル>] --epic <質問の Epic 番号|none> --issues <質問の Issue 番号…> --fleet-status <控えのその fleet の Issue 番号を渡した fleet-status --json のファイル>` を流し、結果の `decision` に従う（宣言・セッション・Epic・Issue 番号の集合を hq が自分で見比べない。`--workers` は送り手が `dispatch:` で始まらないときに `ORCA orchestration worker-list --run <hq の Run ID> --json` の出力を渡す）。
  - `auto`：人に聞かずに「交代する」と返し、新しいワークスペースで fleet を起こし直す。
  - `ask`：`failed` に理由（`claims-remain`・`no-session`・`epic-differs`・`issues-differ`・`unknown-fleet`）が入る。上の `question` の項のとおり AskUserQuestion で人に聞く。
  - 見る条件（宣言が残っていない・控えの `session` がある・Epic と Issue 番号の集合が控えと同じ・控えにある fleet か）は `hq-decide.ts` の `handoverDecision` にある。
  - 返す前に、控えのその fleet の要素に印 `"handover": true` を書いて `hq-state.ts ledger-save` で置く（hq の `/clear`・引き継ぎ（#409）の後でも、手順9で受け取る `worker_done` が交代のものだと分かるように）。`ledger-save` は、前の控えの印 `handover` の fleet を、新しく置く控えに同じテーマが無ければ残す（hq が交代して新しい控えに書き忘れても落ちない。#618）。
  - 返す本文（hq の答えで、人の答えではないので、上の「hq の説明や要約を足さない」の外）：`交代する（hq が新しいワークスペースで fleet を起こし直す。このセッションは新しい fleet を起動せず、worker_done を送って終える）`。fleet の交代の 4 の「自分で新しい fleet を起こす」より、この書き添えを優先する（hq の Run の外に fleet が2つ目として起きるのを防ぐ）。
  - 起こし直し（手順9で、印 `handover` のある fleet の `worker_done` を受け取った後だけ。印の無い fleet の `worker_done` は手順9。手順9の「同じワークスペースに新しい fleet を起こす」と手順9・10の引き継ぎの問いは、この交代には使わない。宣言が残っていないので引き継ぐものが無い）：
    1. worker を `worker-release` で解放する。
    2. 本体を `git pull --ff-only` で origin に追いつかせる（手順1の「始める前に `git pull --ff-only`」と同じ。手順2の「書き換えない」には数えない）。できなければ（既定ブランチでない・未 commit の変更がある・ff できない）起こさずに、印を残したまま人に知らせる。
    3. 手順4と同じ `worker-start`（`--worktree new-top-level`、同じテーマ・Epic・Issue 番号の集合・表示名・指示）で新しい fleet を起こし、手順5の印を置く。控えのそのテーマの `dispatch`・ワークスペースのパス・`startedAt` を新しいものに、`session` を null（新しい fleet から届いたら書く）にし、印 `handover` を消して `hq-state.ts ledger-save` で置く。`undeliveredAnswers` があれば、手順7の「返せなくなった答え」と同じく指示に渡す。
    4. `git -C <新しいワークスペース> rev-parse HEAD` が `git rev-parse origin/<既定ブランチ>` と同じかを見る。違えば（古い版で起きた）、新しい fleet を `references/recovery-and-cleanup.md` の `worker-stop` で止め、控えのそのテーマを止めた状態として残し、人に知らせる（古い版の fleet がまた交代を聞き続けるのを防ぐ）。
    5. 古いワークスペースは、`git -C <古いワークスペース> status --porcelain` が空で、`git -C <古いワークスペース> log --oneline origin/<既定ブランチ>..HEAD` が空（main に無い commit が無い）ときだけ `ORCA worktree rm --worktree path:<古いワークスペースの絶対パス> --json` で消す。残っていれば消さずに手順12の一覧に書く。
  - この交代は手順10の起こし直しの回数（`agent-harness:hq-restart`、理由 `exited`）に数えない。
  - 交代したら、その場で文章で一言（テーマ・前と新しいワークスペース）人に知らせ、手順12の一覧にも載せる（AskUserQuestion にしない）。
  - `worker_done` が次の待ち（15分）の間に届かないときは、人に知らせる（手順8の「何も届かなければ人に知らせる」と同じ）。
- `escalation`（`action` が `escalation`）：理由を人に示し、手順12の一覧に書く。
- `worker_done`（`action` が `worker-done`）：Dispatch が控えの `ships` にあれば節「ship を直接起こす進め方（`--direct`）」の 5、控えの `fleets` にあれば手順9、どちらにも無ければ受け取らない。
- `status`（fleet の skill の「Orca の worker として動くとき」の 8 の途中の報告・連絡。`route` が `tell-now`・`list`・`intel`・`notice-unmarked` に振る）の振り分け：
  - 人にすぐ伝える（`tell-now`。文章で。AskUserQuestion ではない）：Human Merge の `ready-<PR>`（人の Merge 待ち。本文の1行目が `Human Merge`。1行目に印が無いときも見落とさないようこちら）と、本文に `人の判断が要る` の印のある `notice` だけ。迷ったら人に上げる側。
  - 手順12の一覧にためる（`list`）：自動 Merge の `ready-<PR>`（本文の1行目が `自動 Merge`。App が自動で Merge するので人は待たない）・`merged-<PR>`・`verdict-<PR>`・`wait-<Issue>`。
  - intel に回す（`intel`。`SendMessage` の `to: intel`、節「相談・アイデアを intel に回す」の回し方。intel がいなければ手順12の一覧に書く）：本文に `人の判断は要らない` の印のある `notice`。
  - 印の無い `notice`（`notice-unmarked`。`judge` が `split`）：本文を hq が読み分けず、担当（hq-judge）の `split` の結果に従う（`human` はすぐ伝え、`intel` は `intel` と同じに扱い、`list` は手順12の一覧にためる）。
  - `status` は知らせるだけで、判断の正は GitHub とラベル。
- `gh pr list` の仮の見張りは要らない：人の Merge 待ちは `ready-<PR>` で届くので、hq は `gh pr list` を定期的に読む仮の見張りを置かない。
- 返せなくなった答え：`reply` が `dispatch_inactive` などで返せない（fleet が settle した）ときは、人の答えを控えの `hq-fleets.json`（キー `undeliveredAnswers`。`hq-state.ts ledger-save` で置く）に残し、手順9で同じワークスペースに新しい fleet を起こすときの指示に「人の決定：#<Issue> の質問への答え」として人の言葉のまま渡す。手順12の一覧にも書く。人に聞き直さない。
