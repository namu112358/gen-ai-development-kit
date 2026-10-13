# fleet の参照用のファイル：auto mode の保留の検討会

fleet の skill（[SKILL.md](../SKILL.md)）の参照用のファイル。手順・節の番号は SKILL.md のもの。

## auto mode の保留の検討会

auto mode で Jev の危険の判定が計画か PR を保留にしたとき、fleet が3つの担当に調べさせて結論を出す。保留は検討会では解かない。人に上げるか、`files` が変わる計画に出し直して Jev に問い直させるだけ。結論の記録の書式と、その後の数え方は [harness/docs/operations.md](../../../../harness/docs/operations.md#auto-mode-の保留の検討会)。

- **見つけ方**：計画は、Issue の App の最新の計画ゲートの記録（`kind=plan-gate`）の `autoMode.hold` が真（停止のコメントに「auto mode（…）の危険の判定で保留にしました」）。PR は、受け付けの記録（`kind=acceptance`）に `autoMode.jev` があり、`autoMode.reasons` に Jev の危険の判定での保留がある（Human Merge の依頼 `kind=human-review` が付く）。
- **開くのは fleet**：サブエージェント（general-purpose）を3つ並行に呼ぶ。保留を見つけたら、開くかを人に聞かずに開く（付き添いなら AskUserQuestion で聞かない。hq の worker のときも hq に `ask` しない）。人に上げるのは結論の3行だけ。新しいワークスペース・Orca の worker は開かない。入れ子の方式で保留を見つけた ship は検討会を開かず fleet に返す（入れ子の方式の手順1の「渡すもの」）。交互の方式では fleet が自分で見つけて開く。
- **3つの担当**：
  - 安全の担当：その計画・差分が、守り（ゲート・必須チェック・hook・deny・ラベルの権限・Secret）を本当に弱める・外すか、データを戻せない形で壊すか、auto mode が保留にするものを減らすかを調べる。
  - 分け方の担当：守りに触れる部分を別の Issue に分けられるか、範囲を小さくできるか、守りを確かめるテストを足して守りを強められるかを調べる。案は `files` の集合で示す。
  - 反対役：Jev が正しいと仮定して、ほかの2つが見落とした弱め方を探す。
- **渡す材料**：Jev に渡ったのと同じもの（計画は計画コメントの本文から `authorView` を除いたものと `files`。PR は `git fetch origin` の後の `git diff origin/<PR の base>...<headSha>` の差分と `git diff --name-only origin/<PR の base>...<headSha>` の変更ファイル。base と head は `node harness/scripts/agent.ts rest pr-view <PR番号>` の `baseRefName`・`headRefOid`）、Issue の本文と AC、App の停止・受け付けの記録（Jev の確率と保留の線）、読み先のリポジトリのパス。作業した側の見解（計画の `authorView`、判定の Risk Agent の `facts`・Reviewer の要約、PR の説明、ship の引き継ぎの所見）は渡さず、結論の根拠にしない。
- **担当の答え**：各担当は scratchpad の `council-<Issue番号か PR番号>-<担当>.json` に `{ role, verdict: "weakens" | "not-weakens" | "unsure", evidence: [ファイル・行か AC], proposal? }` を書く。`proposal` は分け方の担当だけで、`{ kind: "split" | "narrow" | "guard-test" | "none", files: [...] }`。リポジトリのファイルは書かない・commit しない。
- **3つの結論（決め方）**：
  - (1) 計画を変える：安全の担当か反対役が `weakens` と答え、分け方の担当の案が `files` の集合を変え、その案で弱める部分が消えると安全の担当の答えから言える計画の保留。ship を段階 `plan` で呼び直し、案を渡して計画を出し直す（plan の skill の出し直しの扱い。批評・投稿・計画ゲートを通し、App が新しい計画を Jev に問い直す）。案の `kind` が `split` なら、出し直す計画は `agent-plan` の `split`（子課題に分け、守りに触れる部分を別の子課題にする。子課題はそれぞれの計画でゲートと Jev がもう一度見る）にする。案の `files` が保留した計画の `files` と集合として同じなら（保留を引き継ぐので）出し直さず、(3) として人に上げる。1つの Issue で「計画を変える」は1回まで。その Issue に `conclusion` が `change-plan` の `agent-hold-council` のコメントが既にあれば (3) にする（セッションの記憶に頼らず GitHub の記録で見分ける）。PR の保留はこの結論にしない。変え方の案を3行の3行目に添えて人に上げる（PR の差分を人の判断なしに書き換えて保留の対象を変えないため）。人が「直す」と言えば ship を段階 `fix`、範囲の外が要るなら `plan` で呼び直す。
  - (2) 誤検知らしい：どの担当も `weakens` と答えず、安全の担当と反対役が `not-weakens`。保留のまま、3行で人に上げる。
  - (3) 本当に危険：それ以外（`unsure` を含む）。保留のまま、3行で人に上げる。
- **人に上げる3行の形**：
  1. 保留：<計画コメントの URL か PR #N（patch-id の先頭12文字）>・Jev の危険の確率 <yes>%（保留の線 <1−dangerSafe>%）。Jev が `skipped`・`error`・確率なしで保留にしたときは「Jev：確率なし（<status>）」と書く。
  2. 結論：誤検知らしい／本当に危険（／PR の変え方の案）— <一番強い根拠を1文。ファイル・行か AC>
  3. 見落とし：<反対役の見つけたこと。無ければ「無し」>。人がすること：進める／直させる／閉じる
  - 人に上げる経路は手順2の人の判断待ちと同じ（付き添いなら AskUserQuestion、hq の worker なら hq に `ask`）。
- **記録**：結論を決めたら、人に上げる前・出し直す前に、[harness/docs/operations.md](../../../../harness/docs/operations.md#auto-mode-の保留の検討会) の書式で、計画なら Issue、PR なら PR にコメントを残す（`gh api repos/{owner}/{repo}/issues/<Issue番号か PR番号>/comments -F body=@<ファイル>`。Issue と PR のどちらにも同じ形で付く）。
- **しないこと**：保留を解かない。`agent:plan-review` を外さない。`plan-review-check` の `riskOnly` が真でも、聞かずに「進める」と決めない。`post-judgment` の `risk-only` を出さない。人の答えの無い `proceed` の記録を出さない。Jev の問い・保留の線・ラベルは変えない。
