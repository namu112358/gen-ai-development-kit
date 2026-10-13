# fleet の参照用のファイル：Orca の worker として動くとき

fleet の skill（[SKILL.md](../SKILL.md)）の参照用のファイル。手順・節の番号は SKILL.md のもの。

## Orca の worker として動くとき

hq（テーマごとの fleet をまとめる付き添いのセッション）が Orca の orchestration で起こした fleet の手順。人に聞く窓口は hq にまとめる（ship → fleet → hq → 人）。ここに書いていないことは、上の節（入力・選び方・手順・入れ子の方式）のとおりに進める。

Orca のコマンドは、`node harness/scripts/agent.ts orca-cli` が出す JSON の `command` を実行ファイルとして使う（下では `ORCA` と書く。そのまま打たずに置き換える。決め方は orchestration の skill（[.claude/skills/orchestration/SKILL.md](../../orchestration/SKILL.md)）の「Resolve the CLI for this session」と同じ順で、`harness/lib/worktree.ts` の `orcaCliCommand`。`env`・`printenv` で環境変数を読まない。この点は orchestration・orca-cli の skill の案内より優先する）。細部は `ORCA skills get orchestration` の、版に合った案内に従う。

1. **当てはまるとき**：プロンプトに orchestration の注入の前置き（Task ID・Dispatch ID・worker の handle・capability）があるとき。前置きが無ければこの節は使わず、AskUserQuestion で人に聞く。前置きのコマンド（実行ファイル・handle・capability・ID）は写して使い、組み立て直さない。
2. **ship の動かし方を読む**：最初に `node harness/scripts/agent.ts fleet-config` を読む。
   - `worker`：節「Orca の worker で ship を動かすとき」で、ship を Orca の worker として起こす（ship の worker は fleet の Run に入れ、質問は ship → fleet → hq の順に `ask` で上げる）。その節の 1 で Orca が動かなければ、または起動に失敗したら、その節の 7 のとおり入れ子の方式に戻る。`worker-start` が入れ子の深さで拒まれたときは、その節の 7 の素の端末の方式で起こす（その ship の質問はタブで人に直接聞き、hq には中継されない）。
   - `subagent`（既定）：入れ子の方式で進める。
   - 終了コード 1（設定の誤りなど）：着手宣言をせず、何もしないで止める。標準エラーの理由を hq に `escalation` で送り、`worker_done` を `--outcome failed` で送る。
   - 表の「進め方」が交互（flat）のとき、または ship が「入れ子不可」を返したときも、同じく理由を hq に送って止める。交互の方式では fleet が worktree で自分でファイルを書き換えることになり、下の 4 に反するため。止めるときに着手宣言が残っていれば `release <番号>` で解除する。
3. **ペインを作る**：並びは、左に fleet の Claude（縦いっぱい）、右に上から 進み具合 → あなたがすること → PR と費用（hq のペインと同じ「左に Claude・右に縦に3つ」）。

   ```
   ┌──────────────┬──────────────────┐
   │              │ 進み具合         │
   │  fleet の    ├──────────────────┤
   │  Claude      │ あなたがすること │
   │              ├──────────────────┤
   │              │ PR と費用        │
   └──────────────┴──────────────────┘
   ```

   - 作り方：fleet の Claude のターミナル（前置きの handle。無ければ `ORCA terminal list --worktree current --json` で自分のもの）を `ORCA terminal split --terminal <fleet の handle> --direction vertical --json` で左右に分ける（右が進み具合）。右にできたペイン（進み具合）を `ORCA terminal split --terminal <進み具合 の handle> --direction horizontal --json` で上下に分け（下があなたがすること）、あなたがすること のペインをもう一度 `--direction horizontal` で分ける（下が PR と費用）。左の fleet の Claude のペインは分け直さない（縦いっぱいのまま）。
   - 向き：最初は Orca 1.4.216 の実際の動き（`orca-cli` の案内（「`--direction horizontal` splits left/right」）とは逆で、`--direction vertical` で左右、`--direction horizontal` で上下）で分ける。最初から案内に合わせて `vertical` と `horizontal` を入れ替えない。向きは決め打ちにしない：1回分けるたびに、下の「分けた後の確かめ」で並びを見る。左右に分けたいのに上下になった（上下に分けたいのに左右になった）ら、そのとき分けたペインだけを閉じて逆の向きの `--direction` で分け直す。逆の向きで正しく分かれたら、残りの分け方も左右と上下の `--direction` を入れ替えて使う（Orca が案内どおりの向きに直っても崩れないように）。
   - 分けた後の確かめ：1回分けるたびに `ORCA terminal list --worktree current --include-visual-layouts --json` のペインの木（`visualLayouts` の `panes`）で、新しい分け目の `direction`（`vertical` が左右、`horizontal` が上下）が狙いどおりかを見る（ペインの木の `direction` は分かれた結果の向きで、`--direction` の指定とは別に読む）。全部分けた後に、fleet の Claude の handle が `direction` が `vertical` の分け目の `first`（左）で、その `second`（右）が `horizontal` の分け目で上（`first`）から 進み具合 → あなたがすること → PR と費用 の handle の順になっているかを確かめる。違えば、そのとき分けたペインだけを `ORCA terminal close --terminal <handle>` で閉じ（閉じる前の確かめは手順7と同じ。閉じる handle が控えた表示のペインの handle で、fleet 自身の Claude の端末の handle と違うこと）、逆の向きで作り方から分け直す。分け直しは1つのタブで合わせて2回まで。2回分け直しても違えば、作った表示のペインを閉じて表示のペイン無しで進め、hq に `status` で知らせる（fleet の仕事を止めない）。
   - 分けたペインで動かすコマンドは、`--command` に空白を含めて渡さない。`ORCA terminal send --terminal <新しい handle> --text "<コマンド>" --enter` で後から送る。
   - あなたがすること：`node harness/scripts/panes.ts todo --session <fleet のセッション ID>`
   - 進み具合：`node harness/scripts/panes.ts collect --session <fleet のセッション ID> --label "<テーマ>" [--cwd <fleet の作業ディレクトリ>] <Issue 番号>...`。GitHub を読むのはこのペインだけで、間隔は `panes.collectIntervalSeconds`
   - PR と費用：`node harness/scripts/panes.ts prs --session <fleet のセッション ID>`
   - セッション ID は fleet 自身のもの（`AGENT_HARNESS_SESSION`）。表示用のペインは Claude のセッションではないので、渡さないと fleet の宣言が「ほかのセッション」と表示される。テーマは hq の指示の名前（`fleet: #<Epic番号> <日本語の短い言葉>` の日本語の短い言葉）。名前は表示のためだけで、宣言・usage・`fleet-status` はセッション ID で見分ける。Issue 番号は `fleet-status` に渡す番号の集合と同じにする。
   - 作ったペインの handle を、どれがどのペインか（進み具合・あなたがすること・PR と費用）と一緒に控える（片付けで使う）。fleet 自身の Claude の端末の handle も「閉じないもの」として控える。比べる自分の handle は `ORCA terminal list --worktree current --json` から控えた自分のターミナルの handle にする（前置きの worker の handle は、`terminal list` の handle と同じ種類と確かめられたときだけ使う。種類が違うと比べても一致しないため）。
   - 対象の Issue が変わったら、進み具合のペインは閉じずに、`ORCA terminal send --terminal <進み具合 の handle> --interrupt` で collect を止め、新しい Issue 番号の collect のコマンドを `ORCA terminal send --terminal <進み具合 の handle> --text "<コマンド>" --enter` で送り直す（一番上の位置を保つ。分け直すと下にしかできないため）。止まらない・ペインが無いときは、表示のペイン3つを閉じて（閉じる前の確かめは手順7と同じ）、上の作り方と分けた後の確かめからやり直す。
4. **fleet は指揮と読むことだけ**：fleet はリポジトリのファイル（ワークスペースの checkout と Issue の worktree）を書き換えない。コードや docs の書き換え・commit・push は、ship が Issue の worktree の中でだけ行う。fleet がするのは、`fleet-status`・`panes.ts`・`usage`・`gh` で読むこと、ship を呼ぶこと、着手宣言（`claim`・`release`）、hq とのやり取り、intel への送信（下の 9）、ship を worker で動かすとき（節「Orca の worker で ship を動かすとき」）の `node harness/scripts/agent.ts worktree`（リポジトリの外に Issue の worktree を作るだけ）と、ship の worker の `terminal create`・`terminal send`・`worker-start`・`worker-release`、素の端末の ship（その節の 7）の `terminal create`・`terminal send`・`terminal close`、hq がいない間の質問の控え（`node harness/scripts/hq-state.ts pending`・`pending-add`・`pending-answer`・`pending-remove`。git の共通ディレクトリの下に書くだけで、作業ツリーの外。下の 5 の「hq がいないとき」）だけ。一時ファイルは scratchpad にだけ書く。
5. **人に聞く（ask）**：ship と fleet の手順が AskUserQuestion で聞くところでは、AskUserQuestion を使わず、前置きの `ask` のコマンドで hq に聞く。手順1の引き継ぎ、手順2と入れ子の方式の手順2の投稿の前の質問、`agent:plan-review` で進めてよいか、「進める／直す／やめる」、手順9の人の判断待ちなどがこれに当たる。前置きに無ければ、形は `ORCA orchestration ask --from <handle> --dispatch-capability <capability> --question "<質問>" --options "<おすすめ>,<ほかの選択肢>" --timeout-ms <ミリ秒>`。
   - 1回の `ask` に1問。質問には、Issue 番号・段階・なぜ人が要るかを入れる。選択肢はおすすめを先頭に置く。聞き方の決まりは [harness/CLAUDE.harness.md](../../../../harness/CLAUDE.harness.md) の進め方と同じで、書式や既定の規則で決まることは聞かない。
   - 待つ間に時間切れや切断になっても、新しく聞き直さない。同じ質問の ID を `--resume <message_id>` に渡して待ち直す（同じ質問を二重にしない）。
   - hq が `reply` で返した本文を、人の答え（人の言葉のまま）として扱い、各 skill の手順どおりに続ける。投稿の前の質問なら、答えと書きかけの計画のパスを渡して ship を呼び直す。`agent:plan-review` で進めてよいかなら、答えのとおりに進めるか止める。
   - hq が「答え無し」（人が拒んだ・答えなかった）と返したら、各 skill の「人が答えなかった」ときの扱い（申告を残して投稿する、人の判断待ちのまま一覧に書く など）にする。同じ質問を繰り返さない。
   - `ask` を待つ間も、ほかの Issue の ship は進めてよい（止めるのは、聞いた Issue だけ）。
   - Orca のコマンドが動かないときは、そのエラーをそのまま示して止める。AskUserQuestion にも、別の実行ファイルにも切り替えない。人の判断待ちで止めるときと同じく、宣言は `release <番号>` で解除する。ただし Orca 自体は動いていて hq だけがいないと確かめられたとき（下の「hq がいないとき」の見なす条件）は、止めずに退行に進む。
   - **hq がいないとき**（hq が落ちた・閉じられた）：
     - 見なす条件（両方を満たしたときだけ。一度の時間切れでは決めない）：きっかけは、hq への `ask` が時間切れになった（`--resume` で待ち直しても同じ）か、前置きの `check`・heartbeat が Orca のエラーで失敗したこと。確かめは、hq の Claude の端末（控えの `hqHandle`。`node harness/scripts/hq-state.ts ledger` で読む。控えが無ければ `ORCA orchestration run-show --id <hq の Run ID> --json` の `coordinator_handle`）を `ORCA terminal show --terminal <handle> --json` で読み、無い（エラー・live でない）ことを、5分以上あけた2回の読みで続けて確かめたこと。数えるのは `ORCA status --json` が成功している（Orca 自体は動いている）うえで `terminal show` がその handle が無い・live でないと返したときだけ。`ORCA status` も失敗するときは hq がいない証拠にせず、上の「Orca のコマンドが動かないとき」のとおり止める。端末があるなら hq はいる（人が答えていないだけ）ので、`--resume` で待ち直す。
     - 退行（案A）：人の判断が要る Issue は `release <番号>` で宣言を解除して「人の判断待ち」として止め、ほかの Issue は進める。質問は `node harness/scripts/hq-state.ts pending-add --session <fleet のセッション ID> --issue <番号> --stage <段階> --question "<質問>" --option "<おすすめ>" --option "<ほか>" [--message-id <ask の message_id>]` で控え、`panes.ts todo`（あなたがすること）のペインの先頭に「hq がいない間の質問（fleet のタブで答える）」として出す。AskUserQuestion には切り替えない（fleet のタブに人がいるか分からないまま fleet 全体を止めないため）。
     - 二重に出さない：hq がいない間に出た新しい質問は `ask` せずに、同じく `pending-add` で控えに足す。
     - 人が fleet のタブ（fleet の Claude）で答えたら、それを人の答え（人の言葉のまま）として扱い、`node harness/scripts/hq-state.ts pending-answer --session <ID> --issue <番号> --answer "<人の答え>"` で答え済みにしてから、各 skill の手順どおりに続ける（宣言し直して ship を呼び直すなど）。続きを進めたら `pending-remove` で控えから外す。
     - hq が戻ったとき（前置きの `check` に新しい hq の `send`（件名 `hq-back`）が届いた、または控えの `hqHandle` が変わり、その端末が live）：答えの無い控えのうち `messageId` のあるものは `ask --resume <message_id>` で待ち直し（新しい hq が前の Run を引き継いで同じ質問を受け取るので、新しく聞き直さない）、`messageId` の無いものは新しく `ask` する。hq に上げた控えは `node harness/scripts/hq-state.ts pending-remove --session <ID> --issue <番号>` でペインから外す（人と hq に二重に出さない）。答え済みの控えは待ち直さない（新しい hq が控えを読み、その質問に本文 `fleet のタブで人が答え済み` で `reply` する）。
6. **hq からの追加の指示**：段階の切れ目（ship が返ったとき、`fleet-status` を読み直すとき）と `worker_done` の直前に、前置きの `check` のコマンドで hq の追加の指示を読む。前置きが求める間隔で heartbeat を送る（`ask`・`check --wait` の間は送らない）。
   - hq の「Issue の追加」は、受け持つ Epic の外の Issue（ほかの Epic の子・単発の Issue）でも、`fleet-status` に渡す集合に足して進める。進み具合のペインの Issue 番号も足す（手順3の「対象の Issue が変わったら」）。
   - heartbeat の間隔：前置きの間隔より短い間隔で送らない。この節の 8 で `status` を送った直後の区切りでは、heartbeat を重ねて送らない（束を増やして hq の question を遅らせないため）。
   - heartbeat の本文に今の状況を一言入れる：前置きの heartbeat のコマンドを写し、一言を本文（`--body`）に入れる。入れるものは Issue 番号・段階・次にすること・待っているもの（例：「#388 実装中、次は判定」「#386 area:harness の上限の空き待ち」）。受け持つ Issue が複数なら、動いているもの・待っているものを、hq が一目で状況を掴める短さで並べる。前置きの heartbeat の形が本文を持てないときは、一言を入れずに送る（一言のために `status` を増やさない）。
   - 一言は知らせるだけで、heartbeat に質問を載せない。人の判断が要ることは 5 の `ask`、報告・連絡は 8 の `status` で送る。一言のために heartbeat の間隔を変えない。hq は一言を読んで人がすることの一覧（hq の手順7・12）に使う。
7. **終わるとき**：途中の知らせは、この節の 8 で続けて送る（8 は終わるまでずっと続ける手順で、時間の順では 7 の前でもある）。`worker_done` を送るのは、受け持つ Epic が Close し、かつ hq が足した Epic の外の Issue が全部 Merge 済み（見届け済み）か人の判断待ちになったときか、人の判断待ちだけが残ったとき（節「待つ間の読み直し」の 7）。Epic が Close しても、足された Epic の外の Issue が残る間は `worker_done` を送らない（hq の片付けの条件と同じ）。それまでは手順9の一覧を scratchpad に書き直し、`check` で hq の指示を読みながら読み直しを続ける。手順9の人がすることの一覧は人に出さない。scratchpad のファイルに書き、`worker_done` を前置きのコマンドで1回だけ送る（本文は hq が一目で状況を掴める要約。`--report-path` にそのファイルを渡し、`--outcome succeeded` にする。止まったときは `failed`）。
   - `worker_done` を送った後に、手順3で作った表示のペイン（進み具合・あなたがすること・PR と費用）を `ORCA terminal close --terminal <handle>` で閉じる（閉じる操作で fleet 自身の端末まで閉じることがあるため、知らせが届いたあとに閉じる）。`ORCA terminal close` を送る前に毎回、閉じる handle が手順3で控えた表示のペインの handle で、fleet 自身の Claude の端末の handle と違うことを確かめる。同じなら閉じない（fleet 自身の端末を閉じないため）。
   - 残った空のシェルのペインは閉じない。hq の片付け（Epic の Close のときのワークスペースの削除）に任せる（2回目の `ORCA terminal close` で fleet 自身の端末まで閉じると、`worker_done` を送れない）。
   - ワークスペース（Orca の worktree）そのものは消さない（片付けるのは hq）。`worker_done` の後は、表示のペインを閉じるほかに新しい作業を始めない。
   - hq に `ask` で聞いて答えを待っている Issue があるうちは、`worker_done` を送らない（読み直しと `ask --resume <message_id>` の待ちを続ける）。交代・Orca のエラーなどで答えを待たずに終えるしかないときは、その Issue を `release <番号>` で解除し、レポートに「hq に聞いた質問（message_id・質問）の答えを受け取っていない」と書いてから送る。
8. **hq に知らせる（send）**：途中の報告・連絡を、その都度 hq に `status` で送る。形は前置きの `--from`・`--dispatch-capability`・`--task-id`・`--dispatch-id` を写した `ORCA orchestration send ... --type status --subject "<件名>" --body "<要点>"`（`--to` は付けない。worker が `--to` を省くと、自分の Dispatch の Run の mailbox（hq）に届く）。本文は hq が一目で状況を掴める短さにする。
   - 送る時機：ship が返ったとき・`fleet-status` を読み直したとき・節「待つ間の読み直し」で気づいたとき。
   - 報告（件名）：
     - `ready-<PR>`：PR が人の Merge 待ち（`human-merge`・`auto-merge`）になった。本文の1行目を `Human Merge` か `自動 Merge` で始める（ship の手順6の App の印で決め、推測で書かない）
     - `merged-<PR>`：Merge された
     - `verdict-<PR>`：判定に合格／不合格。本文に合否とブロッキングの件数
     - `wait-<Issue>`：fleet が Issue を待ちにした。本文に理由（重なり・PR 同士の衝突・`--max`・領域の上限・読み込みが古い）
   - 連絡（件名 `notice`）：着手宣言の引き継ぎ・宣言で負けた・衝突・main の取り込みで判定が外れた・ほかのセッションと重なった。本文の1行目を `#<Issue／PR 番号> 人の判断が要る` か `#<Issue／PR 番号> 人の判断は要らない` にする（hq が語で見分け、要るものだけすぐ人に伝え、要らないものは intel に回す。迷ったら `人の判断が要る`）。
   - 相談：今の `ask`（この節の 5）のまま。人の判断が要るものは `status` で送らない。
   - 二重に送らない：送った件名と状態を scratchpad の `fleet-hq-sent.json` に控え、読み直しで同じ状態なら送らない（状態が変わったら送り直す）。
   - `status` は知らせるだけで、判断の正は GitHub（`fleet-status`）とラベル。
9. **範囲の外の気づき**：ship・fleet が進める中で見つけた、今の Issue の範囲の外の気づき（仕組みの問題・改善案・Issue の種。今すぐの判断が要らないもの）は、hq を通さずに `SendMessage` の `to: intel` で intel（[intel](../../intel/SKILL.md)。本体のタブで待つ）に送る。本文は出どころ（テーマ・Issue 番号）・要点・根拠。返事は待たない。
   - 人の判断が要るもの（今の進め方を決めるもの）は、5 の `ask` で hq に上げる（hq に聞けない障害なら `escalation`）。1つの気づきに両方が混ざるときは分け、判断の要る部分は hq に上げ、残りを intel に送る。迷ったら intel ではなく hq に上げる側にする（判断の要るものを intel に流して止めないため。hq の skill の「相談・アイデアを intel に回す」と同じ考え方）。
   - intel がいない（`ListAgents` に無い・`SendMessage` が失敗した）ときは送らずに、手順9の一覧（`worker_done` のレポート）に「intel に回せなかった気づき」として書く。
10. **縮められた後**：hq から `/compact` で縮められた後は、`node harness/scripts/hq-state.ts ledger` の自分の Dispatch の要素の `issues` と `fleet-status <その集合>` を読み直し、前置きの ID はそのまま使って続ける。
