# hq の参照用のファイル：相談・アイデアを intel に回す

hq の skill（[SKILL.md](../SKILL.md)）の参照用のファイル。手順・節の番号は SKILL.md のもの。

## 相談・アイデアを intel に回す

hq に流れてきた相談・アイデア（fleet からも人からも）を、hq が自分で抱えずに intel（[intel](../../intel/SKILL.md)。Orca の本体のタブで待つ）に回す（#396）。

- **分け方**（担当（hq-judge）の `split` の結果に従う。人が hq のタブに直接言った相談・アイデアは、スクリプトを通らないので、毎回 `split` の場面で担当を呼ぶ。基準は次のとおり）：
  - 人に上げる（ship → fleet → hq → 人）：今の進め方を決めるもの。fleet の `question`（`ask`）、`agent:plan-review` で進めてよいか、着手宣言の引き継ぎ（hq の控えにある、同じテーマの fleet の宣言（前のセッションは控えに入れてから `staleHours` 以内のもの）は除く。手順9・10）、`escalation`など。
  - intel に回す：今すぐの判断が要らないもの（判断の要らない `notice`（手順7）を含む）。今の Issue の範囲の外の仕組みの問題・運用で見つけたずれ・止まり方・改善案・Issue の種。
  - 1つの相談に両方が混ざるときは分け、判断の要る部分は hq が人に聞き、残りを intel に回す。迷ったら人に上げる側にする（判断の要るものを intel に流して止めないため）。
- **回し方**：`SendMessage` の `to: intel` で送る。本文は出どころ（人・fleet のテーマ・Issue 番号）・要点・根拠（Issue・PR・コメントの番号、ファイル）を短く。返事を待たない（intel は「受け取った」と返すだけ）。hq は回したものを自分で抱えない（Issue にしない・下書きにしない）。
- **人への案内**：人が hq に相談・アイデアを言い、それが intel に回すものなら、intel に回したうえで「intel に回しました。次からは intel のタブに直接送ってください」と1行で返す。人の判断が要る部分があれば、その部分は hq が AskUserQuestion で扱う。
- **intel のタブの起こし方**：手順1で本体を確かめた後に、`ListAgents` で `intel` の名前のセッションを探す。
  - 既にいる（ほかの hq やこれまでの起動で残っている）ときは起こさずにそれを使い、タブを二重に作らない。
  - 無ければ、`.claude/skills/intel/SKILL.md` が本体にあるときだけ、本体（main の checkout）で起こす。置き場所は手順6のペインの右（真ん中の列を `ORCA terminal split --direction vertical` で分けた handle。#402）で、分けられないときだけ `ORCA terminal create --worktree path:<本体の絶対パス> --title intel --json` でタブを作る。その handle に `ORCA terminal send --terminal <新しい handle> --text "claude --permission-mode auto --name intel /intel" --enter`（`--command` に空白を含めて渡さない。fleet の skill の手順3と同じ）。起こしたペインの handle は、控えのキー `intelHandle` に書いて `hq-state.ts ledger-save` で置く（手順8の長く出力の無いタブが intel を除くのに使う。控えのほかのキーはそのまま残す）。intel は何にも触らない役なので、本体で動かしてよい。
  - 起こした後は、画面が auto mode であることを確かめる。bypass なら `ORCA terminal close --terminal <intel の handle>` で閉じ（閉じる handle が hq 自身の端末でないことを確かめる。手順6の「自分の端末を閉じない」）、「intel がいない」の扱いにする（intel は本体で動き、印 `.agent-harness-workspace` が無いので hook で書き換えを止められないため）。
  - intel の skill が無い、起こせない（Orca のコマンドが失敗した）ときは、起こし直さずに「intel がいない」の扱いにする。
- **intel がいないとき**：`ListAgents` に intel が無い、または `SendMessage` が失敗したら、送らずに手順12の一覧に「intel に回せなかった気づき」として書く。
