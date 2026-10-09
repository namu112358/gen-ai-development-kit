# GitHub Issues SSoT × Claude Code 自律開発 計画（改訂版）

計画と決定ログ（なぜこの形にしたか）。

Sep 26, 2026

## 目的と前提

GitHub Issues を開発状態の SSoT とし、Claude Code が Issue を起点に計画・実装・レビューを自律的に進め、Risk が low の変更は人手なしで Merge まで完走させる。

| 項目 | 前提 |
| --- | --- |
| 構築場所 | 個人アカウントのパブリックリポジトリでハーネスを構築 |
| 移行先 | ある程度完成したら GitHub Team 組織の private リポジトリへ移す |
| Claude の課金 | Claude Team プランのサブスクリプションのみ（API キー不使用） |
| GitHub Actions | private では課金対象になるため、Claude の処理には使わない。数秒で終わる決定論的ジョブと既存 CI のみ |
| Claude の起動経路 | 人が立てたセッション、または定期実行の Routines の2つだけ。GitHub イベントで Claude を直接起動しない |
| GitHub 名義 | Claude はユーザー自身の GitHub アカウントとして動く |
| Risk 判定 | 当面は Claude、将来は TypeSafe AI の Jev に移行 |

最終原則は元計画を引き継ぐ。GitHub を開発 OS とし、自動化は Risk に応じて開放し、Agent の自己申告を唯一の根拠にしない。

## 元計画からの主な変更点

実行基盤・状態管理・Risk 判定・承認の4点が大きく変わった。いずれも「Team サブスクのみ」「private での Actions 課金回避」「個人アカウントで開始」という前提から導かれている。

| 観点 | 元計画 | 改訂版 | 理由 |
| --- | --- | --- | --- |
| Orchestrator | GitHub Agentic Workflows（gh-aw） | Claude Code Routines（定期実行）＋付き添いのセッション＋軽い Actions | gh-aw はサブスク OAuth 非対応。private での Actions 課金回避 |
| 状態管理 | Issue Fields | ラベル（`agent:*`、`risk:*`） | 個人アカウントでは Issue Fields が使えない。移行後に再検討可 |
| Risk 段階 | R0〜R4 | low / medium / high / critical（Agent のみが付与） | low = R0+R1 |
| Risk 判定 | Changed Paths から機械判定 | Claude が8問の型付き質問に答え、将来 Jev に移行 | 意味的な判定が必要。確率付き判定へ段階移行 |
| 自動 Merge | Phase 4 で R0/R1 から検討 | low は Phase 4 で即有効化 | 運用方針 |
| 計画承認 | 初期は全件 | 人間の判断が必要な場合のみ。承認＝人が付き添いのセッションで進めると決める | 名義が同一のため、ラベル承認は偽装を防げない |
| 書き込み | Safe Outputs | Routine は `claude/` ブランチ・PR・コメントまで。信頼が必要なラベル、Check Run、merge-route、auto-merge は専用 GitHub App のみ（既定ブランチの YAML から） | 本人名義と区別でき、PR 側から偽装できないのは App だけ。`GITHUB_TOKEN` は後続 workflow を起動せず、`github-actions[bot]` は PR 側から名乗れる |
| Protected Files | パス保護 | ガードレール（`guardrailPaths`）に触れる PR は App がパスで自動 Merge から外す（Q82） | 保護するのは Agent が自分を縛る仕組みと、判定の連鎖（入力の作り方・組み立て・手順）と、導入先の下限（Q85） |

## アーキテクチャ

Claude が動く処理はすべて Routines か付き添いのセッションに置き、GitHub Actions には Claude を動かさない数秒のジョブだけを残す。Actions の費用はほぼ Claude の実行時間なので、これで private 移行後も GitHub Team の無料枠に収める。

| 構成要素 | 担当 | 動く場所 | GitHub 上の名義 |
| --- | --- | --- | --- |
| 定期実行 Routine（1本、毎時） | 進められる Issue・PR を1段階ずつ進める（計画・実装・Reviewer・Risk・修正） | Anthropic のクラウド | ユーザー本人 |
| 付き添いのセッション | 承認が必要な Issue と急ぎの Issue の実装、手動の介入（PR は `claude/` ブランチの Agent PR） | 手元またはクラウドの Claude Code | ユーザー本人 |
| 軽い Actions（決定論的ジョブ） | 段階間のゲート、範囲照合、Check Run 作成、merge-route、auto-merge 制御、依存解消、親 Issue の Close、停滞検知、Jev 呼び出し | GitHub Actions（既定ブランチの YAML のみ） | 専用 GitHub App |
| 既存 CI | Build・Lint・Typecheck・Test・Security | GitHub Actions | `github-actions[bot]` |
| GitHub 標準機能 | Ruleset、Required Checks、auto-merge、Sub-issues、Dependencies | GitHub | — |
| Jev | Risk 判定（シャドー運用 → 本番） | TypeSafe AI の API（Actions から呼ぶ） | — |

```mermaid
flowchart LR
  H[人] -->|agent:ready| I[Issue]
  R[定期 Routine] -->|claim・計画コメント| I
  I -->|issue_comment| G[Actions ゲート App]
  G -->|agent:plan-ok| I
  R -->|実装 push・Draft PR| P[PR]
  R -->|判定コメント SHA付き| P
  P -->|issue_comment / pull_request_target| A[Actions App]
  A -->|範囲照合・Check Run・merge-route・auto-merge| P
  C[既存 CI] --> P
  P -->|Required Checks 通過| M[Merge]
  M -->|Closes| I
```

**名義と信頼**：信頼できる印は専用 GitHub App が付けたものだけと定義する。Routine と付き添いのセッションはどちらもユーザー本人として記録されるため、偽装されては困る印（段階ゲート、判定結果の確定、merge-route、auto-merge）は必ず App が付ける。`github-actions[bot]` は信頼の根にしない。`pull_request` で起動する workflow は PR 側の YAML で動き、同じ名義で書き込めてしまうためである。

**ゲートの起動**：ゲートの workflow は既定ブランチの YAML だけが動くトリガーで起動する。コメントが起点のもの（計画ゲート、判定の受け付け）は `issue_comment`、PR が起点のもの（push 検知で auto-merge を解除する処理など）は `pull_request_target` とし、PR の head を checkout せず、PR の中身は API で読むだけにする。パブリックリポジトリでは fork を無効にできないため、PR のコードを実行しないことが秘密（App の鍵、Jev の鍵）を守る前提になる。

**App を使う理由**：`GITHUB_TOKEN` で行った Merge・Close・Ready 化は後続の workflow（main の CI、依存解消、`ready_for_review` のジョブ）を起動しない。App のトークンならこれが起動する。Ruleset の必須チェックの出どころもこの App に固定し、ユーザーの名義で同名のチェックを置いても通らないようにする。

## Issue 契約・ラベルと状態モデル

状態はラベルで持ち、ラベルには人間の判断点と Agent の進捗だけを載せる。PR や Checks から分かる状態（レビュー中・CI 中）と DONE（Issue が Closed）はラベルにしない。

| ラベル | 付ける者 | 意味 |
| --- | --- | --- |
| `agent:ready` | 人 | 着手してよい。Routine が次の実行で拾う |
| `agent:working` | Routine / 付き添いのセッション | 着手宣言（claim）。着手者（Routine の実行 URL か「手動」）をコメントに残す。Routine はこのラベルの Issue をスキップする。着手者が Routine の実行で、その実行がすでに終わっている場合に限り、次の Routine が引き継ぐ。付き添いのセッションの着手は奪わず、6 時間（目安）進展がなければ停滞として表示する |
| `agent:plan-review` | Routine | 計画済み、人間の判断が必要。Routine は以後この Issue の実装をしない |
| `agent:plan-ok` | App のみ | 計画が停止基準に該当しないことを確認済み。Routine はこのラベルが App によって付けられた Issue だけを実装する |
| `agent:in-pr` | Routine | Draft PR 作成済み |
| `agent:waiting` | Routine / App | 依存待ち。blocker が閉じると App が外す |
| `agent:blocked` | Routine / App / 人 | 仕様確認、修正上限超過、Issue が読めない（書式不一致）など、人の対応が必要 |
| `agent:hold` | 人 | 個別停止。PR なら merge-route が failure を返し、Issue なら Routine が処理しない。Routine も同じ名義で外せてしまうため、外されたら App が記録してコメントで知らせる |
| `risk:low` / `medium` / `high` / `critical` | Routine | 計画時の想定 Risk（表示用。Merge 可否は実 diff の判定で決まる） |

Issue Forms の項目は元計画の6章（Goal、Background、Requirements、Non-goals、Acceptance Criteria、Dependencies、Validation Requirements）を引き継ぐ。Risk と Priority はフォームに入れない（Risk は Agent が付与するため）。

Issue Forms は `###` 見出しで出力される。フォームの定義とゲートの読み取り処理は同じ PR でテストし、読めない Issue は静かに止めず `agent:blocked` にして見える状態にする。

構造は元計画どおり、大きな機能は Epic と Sub-issues、順序は Issue Dependencies で表す。Agent は未解決の blocker を持つ Issue に着手せず、`agent:waiting` を付けて待つ。

移行先が GitHub Team の組織リポジトリになると Issue Fields が使えるようになる。ラベルから切り替えるかは移行時に判断する。

## 開発フロー

毎時1本の Routine が、その時点で進められる Issue・PR をまとめて1段階ずつ進める。段階の間には Actions のゲートを挟むため、1 Issue は数時間かけて進む前提とする。

急ぎの Issue は定期実行を待たず、付き添いのセッションで進める。

1. **起動**：人が Issue に `agent:ready` を付ける。
2. **着手宣言**：Routine（または付き添いのセッション）は作業の前に `agent:working` を付け、着手者をコメントに残す。各段階は開始時に GitHub の状態（ブランチ、PR、計画コメント、ラベル）を読み直し、途中まで済んだ作業は続きから進める（冪等に動く）。
3. **計画（Routine）**：Issue 本文と、コラボレーターのコメントだけを読み、計画を Issue コメントとして投稿する。コメントには構造化出力（想定 Risk、人間の判断が必要かのフラグ、Open Questions、**触るファイル一覧**）を含める。触るファイル一覧は必須とする。要件や AC の変更が必要なら提案だけをコメントし、Issue 本文は書き換えない。
4. **ゲート（App、`issue_comment` 起動）**：計画の構造化出力を読み、次のどれにも該当しなければ `agent:plan-ok` を付ける。該当すれば Routine が付けた `agent:plan-review` のまま停止する。
   - 人間の判断が必要（仕様の曖昧さ、AC 変更の提案、Issue 範囲を超える設計判断）
   - 想定 Risk が high 以上
   - 触るファイル一覧が欠けている
5. **承認経路**：`agent:plan-review` の Issue は、付き添いのセッションで実装する。Routine は手を出さない。
6. **実装（Routine）**：App が `agent:plan-ok` を付けた Issue だけを対象に、投稿済みの計画コメントを入力として実装する（承認後に Issue 本文が書き換えられても影響しない）。Test Designer は実装内のサブエージェント。`claude/` ブランチに push し、Draft PR を作成する。PR 本文に `Closes #番号` と実行セッションの URL を入れる。
7. **範囲照合（App）**：実際の diff が計画の触るファイル一覧に収まるかを機械的に検査する。はみ出していれば自動 Merge の対象外とし（Human Merge は可）、Reviewer への入力にも含める。
8. **判定（Routine、次の実行）**：Reviewer と Risk Agent を別のサブエージェントとして実行し、結果を head SHA 付きの構造化コメントとして PR に投稿する。
9. **確定（App、`issue_comment` 起動）**：判定コメントを受け付け、`agent/review` と `agent/risk` の Check Run を書く。受け付けるのは、判定時の head と現在の head で「PR が main に対して加えた変更」（`git patch-id`）が同一の場合。main 追従で差分が変わらなければ判定し直さない。Jev のシャドー判定もここで呼ぶ。
10. **Merge**：
    - low かつ Reviewer 合格かつ範囲照合 OK → Draft を外し auto-merge を設定。Required Checks（既存 CI＋`agent/review`＋merge-route）通過で GitHub が Merge
    - medium 以上かつ Reviewer 合格 → Draft を外し、人にレビューを依頼（Human Merge）
    - Reviewer のブロッキング指摘 → Draft のまま、変更要求として投稿し修正へ
11. **修正（Routine）**：変更要求（Reviewer または人）を受けて修正し push。push のたびに App が auto-merge を即解除し、差分が変わっていれば判定をやり直す。
12. **Close**：Merge で `Closes` により子 Issue が閉じる。Sub-issues がすべて閉じた親 Issue は App が閉じる。Stacked PR の層（本文は `Refs #N`、一番上は `Closes #N`）の Issue は、既定ブランチへの push を見て App が閉じる（`stack-link` の記録）。

**merge-route**：App が書く必須チェック。auto-merge が付いていない PR には success を返し（人が Merge する経路は通す）、auto-merge が付いた PR には、判定が現在の差分に対して有効で、low かつ Reviewer 合格かつ範囲照合 OK かつ `agent:hold` なし、のときだけ success を返す。これで medium の PR に auto-merge が付いても Merge されず、`agent/risk` を Required にしなくても Human Merge は通る。

**直接マージの防止**：auto-merge を使わずに API で直接マージする経路は merge-route では止められず、Routine と人は同じ名義なので GitHub 側では区別できない。リポジトリの `.claude/settings.json` で `gh pr merge` と merge API の呼び出しを deny にし、Ruleset の bypass には誰も入れない。Routine は既定ブランチから clone して始まるため、PR で設定を書き換えても次の実行には効かない。ただしコマンドパターンによる防止なので完全ではない。

**順序制御**：App は push を検知したら最初に auto-merge を解除し、判定の受け付け時は auto-merge の設定を先に済ませてから `agent/review` を書く。`agent/review` は Required なので、それが書かれるまで Merge されない。main とコンフリクトしている PR では `pull_request` の CI が起動しないため、停滞検知で拾う。

## Risk ポリシーと自動 Merge 条件

自動 Merge は Risk Agent の判定のみで決める。Risk Agent は Issue 本文・PR 説明・コメント・Planner のラベルといった自然言語の主張を読まず、diff・リポジトリ全体・このポリシーだけを入力にする。

判断軸は「壊れたときの影響範囲」と「revert で完全に元に戻るか」とし、観点を8問の型付き質問に分けて聞く。

| # | 質問 | 型 | 自動 Merge を止める答え |
| --- | --- | --- | --- |
| 1 | Risk レベルはどれか | Choice（low / medium / high / critical） | low 以外 |
| 2 | revert すれば完全に元に戻るか | Noul | いいえ・迷う |
| 3 | 公開インターフェース（API・スキーマ・イベント形式・設定形式）を変えるか | Noul | はい・迷う |
| 4 | 挙動を変える変更は、既存または追加されたテストで検証されているか（挙動を変えない変更だけなら yes。Q71） | Noul | いいえ・迷う |
| 5 | 永続データの書き込み・削除・移行を伴うか | Noul | はい・迷う |
| 6 | 認証・認可・課金・秘密情報に関わるか | Noul | はい・迷う |
| 7 | 依存関係（パッケージ・lockfile）を追加・更新するか | Noul | はい・迷う |
| 8 | ガードレール（`harness.config.json` の `guardrailPaths`）に触れるか（Q82） | Noul | はい・迷う |

レベルの目安は次のとおり。

- **low**（R0+R1）：壊れても利用者のデータ・認証・課金・外部連携に影響せず、revert で完全に戻る。docs、typo、独立した UI、挙動を変えない小さなリファクタ
- **medium**：業務ロジックや API の挙動が変わり得るが、revert で戻る
- **high**：revert しても戻らない影響があり得る、または影響が広い。マイグレーション、データの書き込み・削除、認証、課金、インフラ
- **critical**：ガードレール、権限、秘密情報、依存関係

**Claude 判定期間**：Noul は「はい／いいえ／迷う」の3択で答える。1つでも止める答えがあれば自動 Merge しない。Claude には確率も出させるが、較正の保証がないため判定には使わず記録のみとする。

**自動 Merge の条件**（すべて現在の差分に対して有効な判定で）：既存 CI 成功、`agent/review` 合格（ブロッキング指摘なし）、`agent/risk` が low かつ全 Noul が安全側、範囲照合 OK、`agent:hold` なし、自動 Merge モードが有効。merge-route がこれをまとめて検査する。PR の大きさには上限を置かず、Risk Agent の判断に任せる。

**Reviewer のブロッキング指摘**：直さない限り Merge させない指摘。次を常にブロッキングとし、スタイルや改善提案は非ブロッキングのコメントにとどめる。

- AC 未達
- Issue 範囲外の変更
- 型チェック・テストの失敗
- データ破壊
- 秘密の漏えい
- AC の外で既存の挙動が変わる退行

`agent/risk` は Required にしない。常に成功とし、判定結果はサマリーに書く。medium 以上を自動経路から外す役割は merge-route が担う。

**ガードレール**：Agent が自分を縛る仕組み（App が機械的に強制している部分）を `harness.config.json` の `guardrailPaths` に並べ、App がパスで判定する。触れる PR は Risk Agent の答えに関わらず自動 Merge から外し（Human Merge）、触れる計画は想定 Risk に関わらず計画ゲートで止める（Epic に分ける計画は子課題の files を見ず、子課題の計画で止める。Q83）。判定の連鎖（`harness/scripts/agent.ts`、judge・plan・sync・fix・ship の skill、`.claude/routine.md`、`CLAUDE.md`、plan-critic・test-designer の定義、Jev の切り替えの集計 `harness/scripts/report.ts`）も一覧に入る（Q85・Q86）。それ以外のハーネスの変更（implement・fleet の skill・テスト・docs など）は通常の判定で進める（Q82。Q4・Q50 を改める）。

## Jev への段階移行

Risk 判定は最終的に TypeSafe AI の Jev に任せる。Jev はテキストを生成せず、状態と型付きの質問を受けて確率付きの判定を返すモデルで、上の8問をそのまま1回の呼び出しで答えられる。

**役割分担**：Jev に渡す状態は App が API と設定から集めたものだけとし、セッションが書いたもの（Risk Agent の `facts`、Claude の判定）は含めない（含めるとセッションが Jev を誘導でき、一致率が独立性の証拠にならない）。Jev はリポジトリを読めないため、diff に見えない影響は分からないものとして安全側に倒す。

- 生の diff（Jev のコンテキスト 32K トークンに収まる範囲。収まらなければ自動 Merge の対象外）
- 変更ファイルの一覧（リネームの旧パスも）と、ガードレールの一覧（`guardrailPaths`・`guardrailExclude`）

**呼び出し場所**：Jev は Actions の決定論的ジョブから呼ぶ。Claude（ユーザー名義）から偽装できない位置に Risk 判定を置くためで、シャドー期間も同じ場所から呼ぶ。

**移行手順**

1. シャドー運用：Claude が判定し、Jev は同じ8問に答えて記録だけする（Phase 3 から）
2. 評価：比べる相手は Claude ではなく結果とする。Jev が「可」と判定した PR のうち、7 日以内に revert されたもの、同じファイルを直す fix の PR が出たものを「実は不可だった」と数える。Claude との一致率は PR の大半が low だと自然に高くなるため、切り替えの基準に使わない
3. 切り替え条件：結果で見た Jev の low の外れ、「Jev だけが可と判定した」ケース、否定側（medium 以上）の件数で決める。基準の値と集計のしかたは [security.md](security.md#jev) に置く
4. 切り替え後：Jev の確率と閾値（例：P(low) ≥ 0.9 かつ各 Noul が安全側で閾値以上）で判定。閾値は運用で調整する

評価に使う revert と fix PR の検知、判定コメントの書式検査、集計のスクリプトは Phase 3 で作る。書式が崩れた報告や追えない PR が集計から漏れないよう、書式は投稿時に検査する。

Jev は TypeSafe の API（または Cloudflare・Vercel の AI Gateway 経由）の従量課金で、Claude のサブスクとは別になる。2026年9月15日に公開されたばかりで、較正の精度はベンダーの公表値のため、自分のリポジトリで確かめてから任せる。

private リポジトリへの移行時は、社内のコードを外部 API（Jev）に送ってよいかを判断してから継続する。

## 安全設計

Claude がユーザー本人の名義で動く以上、GitHub 上の印で「人がやった」と証明することはできない。そのため信頼の置き場所を「起動経路」と「専用 App の操作（既定ブランチの YAML からのみ）」の2つに絞る。

| 観点 | 設計 |
| --- | --- |
| 起動 | Claude の起動は付き添いのセッションと定期実行だけ。Issue や PR の中身が起動のきっかけにならない |
| 信頼の根 | 専用 App が付けた印だけを信頼する。App のトークンを使う workflow は `issue_comment` / `pull_request_target` など既定ブランチの YAML だけが動くトリガーで起動し、PR の head を checkout しない。`github-actions[bot]` は PR 側の YAML からも名乗れるため信頼の根にしない |
| 必須チェック | Ruleset の必須チェック（`agent/review`、merge-route）の出どころを App に固定する。Ruleset の bypass には誰も入れない |
| 承認 | 承認＝人が付き添いのセッションで進めると決めること。Routine は `agent:plan-review` の Issue を実装しない |
| 段階ゲート | 計画 → 実装の通過は App が付ける `agent:plan-ok` のみ |
| 範囲 | 計画の触るファイル一覧と実際の diff を App が照合する |
| マージ経路 | 自動経路は merge-route で GitHub 側で強制。直接マージは `.claude/settings.json` の deny で Claude 側で防ぐ（完全ではない） |
| 判定結果 | Routine のコメントを App が検証してから Check Run にする。実装段階と判定段階はどちらも本人名義のため、名義では区別できない。守りは段階を別の実行・別のプロンプトに分けることで、将来は Jev を Actions から呼ぶことで Risk 判定を偽装できない位置に置く |
| 外部入力 | Agent が読むコメントはコラボレーター（本人）のものだけ。Claude が書いたコメントには目印を付けて人のコメントと区別する |
| 隔離 | Routine の環境を Trusted（既定の許可リスト）＋必要なドメインのみに。Connectors は GitHub 以外を外す |
| 書き込み範囲 | Routine が push できるのは `claude/` ブランチ。main へは PR 経由のみ（Ruleset で直接 push 禁止） |
| 秘密 | App の鍵と Jev の鍵はリポジトリ Secret ではなく Environment（例：`gate`）の Secret に置き、その Environment の実行を既定ブランチに限定する。PR の中で足された workflow（PR のブランチ上で動く）からは読めない。鍵を使うジョブは PR のコードを実行しない。Actions がコメントやログを書くときは秘密を伏せ字にする |
| 二重着手 | `agent:working` による着手宣言（事故防止であり安全の境界ではない） |

**要確認**：`.github/workflows/**` には App を使うゲートの定義が入る。既定ブランチの YAML しか App のトークンを使えない形にしたので、PR で書き換えても Merge されるまで効かない。`.github/**` はガードレールなので、書き換える PR は App が自動 Merge から外す（Q82）。Phase 0 で Routine が workflow ファイルを push できるかも確認しておく。

**受け入れるリスク**：次は把握したうえで、対策を入れないと決めたもの。

| リスク | 内容 | 残る守り | 決定 |
| --- | --- | --- | --- |
| 既存 CI の緑の偽装 | 既存 CI は `pull_request` で PR 側の YAML が動くため、`ci.yml` を書き換えた PR は自分の CI を緑にできる | `.github/**` はガードレールで、App が自動 Merge から外す（人が Merge する） | Q57・Q82 |
| ガードレールの外のハーネス | implement・fleet の skill・テストなど、ガードレールに入れないハーネスの変更は low なら自動 Merge され得る | Risk Agent の判定、テストの改ざんの検査（`agent/tests`）、一覧は人が PR で決める | Q82 |
| low にリファクタを含む | 挙動を変えないと称したリファクタや独立した UI も low になり得る | Risk Agent の質問2・4、Reviewer の退行の指摘 | Q51 |
| パブリック期間のコメント | パブリック期間はだれのコメントでもゲートが起動し、偽の計画・判定コメントを置かれる余地がある。受け付け条件、編集への対応、`${{ }}` の埋め込み対策は入れない | private 移行後はメンバーのみがコメント可能 | Q58（実装では作成者チェックを追加。Q60） |
| 直接マージ | 本人名義の API 直接マージは GitHub 側では止められない | `.claude/settings.json` の deny（コマンドパターンのため完全ではない） | Q47 |
| 判定段階の名義 | 実装段階と判定段階はどちらも本人名義で、名義では区別できない | 段階を別の実行・別のプロンプトに分けること。将来は Jev を Actions から呼ぶ | Q44 |
| hold の解除 | Routine も `agent:hold` を外せる | App による記録と通知 | Q59 |

## 運用

| 項目 | ルール |
| --- | --- |
| 修正ループ | Reviewer 由来の修正は通常2回まで、3回目はブロッキング指摘のうち critical なもの（テスト失敗、データ破壊、秘密の漏えい）があるときだけ。超えたら Draft のまま `agent:blocked`。回数はコメントの目印ではなく PR の Timeline（変更要求レビューの数）から数える。人のレビューによる修正は回数に数えない |
| 修正の起点 | Reviewer の指摘も人の指摘も、変更要求のレビューとして PR に残し、同じ経路で修正する |
| 処理順と量 | Routine は1回の実行で進める件数に上限を置き、`agent:ready` が付いた順（先着順）に処理する |
| 二重着手 | `agent:working` で着手宣言。各段階は GitHub の状態を読み直して冪等に動く |
| 依存待ち | 未解決の blocker があれば `agent:waiting`。blocker が閉じたら App が外し、次の実行で再開 |
| 利用上限 | サブスクの利用上限や Routines の1日の実行上限に当たった実行は失敗し、次の定期実行で再試行される。途中で落ちた状態からは冪等性で続きから進める。失敗は修正回数に数えない |
| 停滞検知 | 定期の Actions が、24 時間動きがない PR・Issue（Actions の失敗、期限切れの claim、main とのコンフリクトで CI が動かない PR など）を一覧化し、見える場所に出す |
| Draft | Draft＝Agent が作業中。判定が確定した時点で App が Ready 化する |
| Close | 子 Issue は `Closes` で Merge 時に自動 Close。Sub-issues がすべて閉じた親は App が Close。Stacked PR の層は、既定ブランチへの push を見て App が閉じる |

**止める仕組み**

| 仕組み | 内容 |
| --- | --- |
| 停止スイッチ | リポジトリ設定の Allow auto-merge を切ると、auto-merge が一斉に効かなくなる |
| hold ラベル | `agent:hold` で個別の PR・Issue を止める |
| revert で自動停止 | 自動 Merge された PR が1件でも revert されたら、App が自動 Merge モードを切る（merge-route が自動経路をすべて failure にする）。人が原因を確認して戻すまで再開しない |
| 暴走時の手順 | Routine を無効化し、フェーズを戻す手順を runbook に書く |

**Observability**：実行ごとのメトリクス（段階、モデル、所要時間、トークン使用量）は PR のフッターに追記する。トークン使用量は、請求額ではなくサブスクの利用上限の消費ペースを見るための指標として使う。「後で PR から数えられる」は楽観的なので（検索件数の上限、書式の崩れた報告、追えない PR）、判定コメントの書式検査と集計のスクリプトを Phase 3 で作る。開発状態を独自 DB に複製しない原則は元計画どおり。

## Phase 計画

動かしてみないと分からない前提を Phase 0 で先に確かめ、崩れたら設計に戻る。自動 Merge は Phase 4 で即有効化する。

| Phase | 内容 | 完了条件 |
| --- | --- | --- |
| 0 | 現状分析（元計画31章）＋技術検証 | 下記の検証項目が使い捨てリポジトリで確認できる。崩れた項目があれば設計に戻る |
| 1 | Issue 契約：ラベル、Issue Forms とパーサのテスト、Risk ポリシー8問、触るファイル一覧の書式、AC の書き方 | GitHub だけで開発状態を再構成できる |
| 2 | 着手宣言 → 計画 → App ゲート → 実装 → Draft PR → 範囲照合 | `agent:ready` から Draft PR まで通る |
| 3 | 判定（Reviewer・Risk）、Check Run 化、merge-route、修正ループ、Jev シャドー開始、書式検査と集計のスクリプト、停滞検知 | Agent PR が Ready 化まで自動で進む |
| 4 | 止める仕組み（停止スイッチ、hold、revert で自動停止、runbook）を先に入れてから、low の自動 Merge を有効化。依存解消と親 Close | low が Merge まで完走し、止める仕組みが動作確認済み |
| 5 | 運用最適化、Jev 切り替え判断、private リポジトリへの移行（Jev へのコード送信の可否判断を含む） | 切り替え条件で判断、移行完了 |

**Phase 0 の検証項目**

- [ ] Team 組織で Routines と Claude Code on the web が管理者設定で有効になっているか
- [ ] Routines の1日の実行上限の実数と、毎時実行で1日に処理できる Issue 数の見積もり
- [ ] 1 Issue あたりのサブスク利用量（計画・実装・判定・修正の合計）
- [ ] Routine がラベル操作・コメント・Draft PR 作成をどの経路で行えるか（GitHub 接続の権限）
- [ ] Routine が `.github/workflows/**` を push できるか
- [ ] PR の中で書き換えた・足した workflow が `github-actions[bot]` としてラベルや Check Run を書けてしまうか（書ける前提で、信頼の根にしていないことを確認）
- [ ] PR の中で足した workflow から、Environment に置いた App・Jev の鍵を読めないこと
- [ ] Ruleset の必須チェックの出どころを App に固定できるか、bypass に誰も入っていないか
- [ ] Routine（本人名義）が medium の PR を API で直接マージできてしまうか、`.claude/settings.json` の deny で止まるか
- [ ] App のトークンで行った auto-merge・Close・Ready 化の後に、後続の workflow（main の CI、依存解消、`ready_for_review`）が起動するか
- [ ] merge-route と、auto-merge の解除 → 設定 → `agent/review` 書き込みの順序で、古い判定のまま Merge されないか
- [ ] `git patch-id` による差分の同一判定が、main 追従後に期待どおり動くか
- [ ] Actions から Jev の API に到達でき、8問を1回で呼べるか
- [ ] 軽い Actions の月間実行時間の見積もり（GitHub Team の無料枠との比較）

## 段階の制御をコードに移す

段階のつなぎ（次に何をするか、いつ止まるか、段階に合わない操作）を、skill の文章に書いた AI の判断ではなく、コードで決める計画（#169）。考え方は、段階をノード・エッジ・共有する状態からなるグラフとして明示して設計する「グラフエンジニアリング」と、モデルの周りの仕組み（契約・状態・検証・権限・復旧）で信頼性を作る「ハーネスエンジニアリング」による。ここは計画で、各項目の実装は子課題で行う。

### 今の制御

| 制御 | 決め手 | 強制 |
| --- | --- | --- |
| 計画ゲート、判定の受け付け、Merge の経路、修正の回数（`fixLoop`） | App（Actions） | コード |
| main への push、force push、Merge、保護ラベル | Ruleset、`permissions.deny`、`.claude/hooks/guard.ts` | コード |
| 次の段階の候補 | 段階のグラフのデータ `harness/lib/flow.ts`（ノード・エッジ・ループの上限・止まる先の理由。#201）から、`harness/lib/queue.ts`・`harness/lib/fleet.ts` が次にやることを引く（計算はコード） | 使うかは AI 次第 |
| どの段階を今やるか | ship・fleet の skill の文章 | AI |
| 着手宣言の出し入れと段階 | 各 skill の文章 | AI（忘れても止まらない） |
| plan-critic・test-designer を呼ぶ、批評の止める条件 | plan・implement の skill の文章 | AI |
| 同じ指摘が続いたら止める、人に返す | fix・ship の skill の文章 | AI |
| 担当（誰の Issue か）の確かめ | 無い | 無し |
| 計画の `files` の外を変えない | App の範囲照合（PR を出した後） | コード（気づくのが遅い） |
| 同時の着手 | `claimOf` は最初の宣言を持ち主にし、`claim` は「読む → 書く → 待って読み直す」で後の側が取り下げて止まる。読み直しで気づかなくても、`critic-input`・`post-plan`・`worktree`・`ensure-claim`（PR を作る前）が同じ決め方で止める（#171） | コード |

### 目標と人の決定

目標は、次の一手・止まる判断・段階に合わない操作をコードで決め、AI は返されたノード（計画を書く、実装する、判定する など）の中身だけを行うこと。

人の決定（2026-09-28、付き添いのセッションで）：

- コードに移すのは、hook で段階に合わない操作を止めるところまで（下の構成の4項目）。ノードごとに `claude -p` を呼んで副作用を実行役が行う形は作らない。
- 付き添いのセッションは段階を選ばない窓口にする。段階は `step` が決め、セッションはそのノードを行い、止まった理由を人に伝えて相談する。
- 担当は Issue の Assignee を正にする。アサインは人か、人に頼まれた付き添いのセッションが決める。エージェントは自分の判断ではアサインしない（アサインは追加する操作で、「空なら自分を入れる」を1回でできないため）。人に頼まれたときだけ、付き添いのセッションが頼まれた人をアサインしてよい。

### 構成

1. **段階のグラフのデータ**
   - ノード（段階）、エッジ（行き先と条件）、ループ（計画 ↔ 批評、fix ↔ judge、sync ↔ judge）の上限、止まる先の理由コードを1か所（`harness/lib/flow.ts` の案）に置く。
   - `queue.ts`・`fleet.ts` はここから次の段階を引く。今は ship の skill の文章、`queue.ts`、`fleet.ts`、`overview.html`、`docs/operations.md` に同じ流れが別々に書かれている。
   - テストで、行き止まり（次のエッジも理由コードも無い状態）、届かないノード、`queue.ts` と `fleet.ts` の判断の食い違いを検査する。
2. **担当と着手宣言**（#171・#172）
   - 同じ人のセッションどうし（#171）：有効な宣言を「最初の宣言が持ち主」に変える。コメントを古い順に見て、持ち主がいないときの宣言で持ち主が決まり、同じセッションの宣言は段階の更新、ほかのセッションの宣言は `--takeover`（引き継ぎであることを宣言に書き込む）のときだけ持ち主を移し、それ以外は無視する。持ち主の解除・計画・判定のコメントで持ち主がなくなる（今と同じ）。
   - `claim` は宣言を投稿した後、少し待って読み直し、持ち主が自分でなければ取り下げのコメントを書いて、先に宣言したセッションを示して 0 以外で終わる。`ensureOwnClaim` も同じ決め方を使い、確かめる場所に plan-critique の前と PR を作る前を足す（読み直しで気づかなくても、次の確認で止まる）。
   - セッションの ID が得られなければ手動の宣言を止める。定期 Routine かどうかを `CLAUDE_CODE_REMOTE_SESSION_ID` の有無で決めず、クラウドの付き添いのセッションでも宣言を確かめる（今は Routine とみなされて確かめない）。
   - 人どうし（#172）：`harness.config.json` の設定が有効なとき、Issue の Assignee がちょうど1人で、今の GitHub のユーザーであるときだけ宣言する。空・他人・2人以上なら理由を示して止まる。`ensureOwnClaim` も確かめ、途中でアサインが変われば次の段階で止まる。PR の段階は、PR が Close する Issue の Assignee で確かめる。fleet は Assignee が自分1人の Issue だけを候補にし、外した理由を示す。設定が無効なら今と同じ動き。
   - 場所：判定は `harness/lib/assignee.ts`（純粋関数と `checkAssignee`）、宣言の前と後の確かめは `harness/lib/claim.ts` の `postClaim`（`before`）・`ensureOwnClaim`、呼び出しは `harness/scripts/agent.ts` の `claim`・`ensureOwnClaim`・`fleet-status`、fleet の除外は `harness/lib/fleet.ts` の `selectFleet`、設定は `harness/lib/config.ts` と `harness.config.json` の `requireAssignee`。Routine の選び方（`queue.ts`・`facts.ts`）は変えない。
3. **`agent.ts step <番号>`**
   - GitHub の事実とグラフのデータから、今やってよいノードを1つだけ返す（ノード、前提、許す操作、入力、出力の書式）。
   - 前提の確かめ（担当・宣言）、着手宣言、ループの上限、同じ指摘の繰り返しの数えを中で行い、当たれば理由コード付きの stop を返す。
   - 今の段階（Issue・段階・ブランチ・計画の `files`）をセッションごとのファイルに書く。
   - 場所：`harness/scripts/agent.ts`。段階を文章でつないでいる `.claude/skills/ship/SKILL.md`・`.claude/skills/fleet/SKILL.md`・ほかの段階の skill と `CLAUDE.md` を、`step` を呼ぶ形に変える。
4. **hook と段階の結びつけ**
   - `guard.ts` が段階のファイルを読み、段階に合わない GitHub への書き込みを止める（例：`gh pr create` は implement で Draft のときだけ、`post-plan` は plan だけ、`post-verdict` は judge だけ、`git push` はその段階のブランチだけ）。
   - push の前に、変更が計画の `files` に収まるかを確かめる（App の範囲照合を前に持ってくる）。
   - 段階のファイルが無ければ、GitHub への書き込みを止める。
   - Stop の hook で、宣言を持ったまま終わるセッションの宣言を扱う（解除するか、人に返す印を残す）。
   - 場所：`.claude/hooks/guard.ts`、Stop の hook を足す `.claude/settings.json`（今は PreToolUse と SessionStart だけ）。hook には抜け道があるので、最後の砦は今までどおり Ruleset と App。

### やらないこと

- ノードごとに `claude -p` を呼び、副作用を実行役が行う形（人の決定）。
- Cloudflare（Durable Objects・Workflows）、LangGraph への移行。状態の正が GitHub の外にもできる、実行時の依存とビルドを足さない決まりに合わない、今の取り合いは GitHub のままで直せる、のため。構成の2の後も取り合いが残るとき、または無人の Routine を常に動かすときに見直す。

### 子課題の順序

担当と着手宣言（#171 → #172。同じファイルを触るので #171 を先に）→ グラフのデータ → `step` → hook と段階の結びつけ。担当と着手宣言は取り合いを今すぐ減らすので先に行う。グラフのデータ以降の3件は、この計画が Merge された後に Issue にする。どれもガードレール（`harness/lib/**`、`harness/scripts/agent.ts`、`.claude/hooks/**`、`.claude/settings.json`、skill、`CLAUDE.md`）に触れるので、計画ゲートで止まり、付き添いのセッションで実装して人が Merge する。

### 未決の点

- 窓口のセッションが、`step` の返したノードを自分で行う形で「段階を選ばない」を満たすか（満たさなければ、ノードの実行を分ける形を見直す）。
- Routine（人の名義が無い）の担当をどう表すか。
- クラウドのセッションで、段階のファイルをどこに置くか（セッションをまたいで残らない）。
- 読み直しの待ち時間（GitHub の一覧の反映の遅れをどれだけ見込むか）。
- 「人に頼まれた」アサインかどうかをコードで確かめられないこと（付き添いのセッションのアサインは人の名義で行われ、頼まれたかは会話の中にしか無い）。
- ダッシュボード（`harness/gates/publish-queue.ts`）に「担当者待ち」「担当者が複数」を出すか（#172 は fleet の表示までで、ダッシュボードは含まない）。

## 将来の移行先：GitHub Actions 版

Actions の費用が問題にならなくなった場合の移行先として、Claude を GitHub Actions 上で動かす設計を記録しておく。起動がイベント駆動になり1 Issue の所要時間が大幅に短くなる一方、Actions の実行時間を消費する。

**実行基盤**：Anthropic 公式の Claude Code GitHub Action を、Team サブスクの OAuth トークン（`claude setup-token` で生成した `CLAUDE_CODE_OAUTH_TOKEN`）で動かす。gh-aw はサブスク OAuth に対応していないため使わない。トークンは生成した人のシートに紐付くので、複数人で使う段階では各自のトークンか API キーに切り替える。

**名義と書き込み**：Claude 専用の GitHub App を作り、App トークンで PR 作成・push を行う（PR の作成者が bot になり、人が承認できる。`GITHUB_TOKEN` で作った PR では CI が起動しない問題も避けられる）。App には `workflows` 権限を与えず、`.github/workflows/**` の書き換えを GitHub 側で拒否させる。帰属は Timeline、Co-authored-by トレーラー、PR フッターの3層で残し、起動者はワークフローが機械的に埋め込む。

**2ジョブ構成**（gh-aw の safe-outputs 相当）：Agent ジョブは読み取り権限だけで動き、patch と操作要求の JSON を出力する。後続の決定論的ジョブが App トークンで、ラベルの許可リスト照合（`agent:plan-review`・`agent:in-pr`・`agent:blocked`・`risk:*` のみ）、帰属情報の付与、push・PR 作成・コメントを行う。

**隔離**：Claude の許可ツールを絞り（Web 取得・検索を無効、Bash は必要なコマンドのみ）、ランナーの外向き通信を許可リスト化する（例：StepSecurity harden-runner）。

| ワークフロー | 起動 | 中身 |
| --- | --- | --- |
| develop | `agent:ready` / `agent:approved`、resume | 前処理（権限・依存・並列数）→ 計画ジョブ → 反映（high 以上や要判断はコードで停止）→ 実装ジョブ → 反映（push・Draft PR） |
| verify | Agent PR の作成・更新 | auto-merge 解除 → Reviewer・Risk・Jev シャドーを並列 → 反映（auto-merge 設定後に Check Run 記録、ブロッキングは変更要求レビュー） |
| fix | App かコラボレーターの変更要求レビュー | Agent 由来は3回まで → 修正 → 反映 |
| resume | Issue Close、develop / fix 完了、1時間ごと | 依存待ち・並列上限・利用上限の `agent:waiting` を先着順に再開、親 Issue の Close |

同時実行は Issue 単位で排他、全体2並列とし、前処理で実行中の develop / fix を数えて超えたら `agent:waiting` にする（Actions の concurrency 設定だけでは待機があふれた実行が取り消されるため）。承認は `agent:approved` ラベル（App と人の名義が区別できるため有効）。Merge 前に main への追従を必須にする。

## 規約・費用の確認事項

| 項目 | 現状の理解 | 確認すること |
| --- | --- | --- |
| Claude Team の規約 | Team は Commercial Terms。OAuth 認証はサブスク購入者の通常利用のためのもの（[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)） | 自律実行を継続的に回す利用量が「通常利用」に収まるか。不明なら Anthropic に問い合わせ |
| Routines | Pro・Max・Team・Enterprise で利用可、研究プレビュー。サブスク利用量に加え1日の実行上限あり。GitHub トリガーは PR とリリースのみ（[Routines](https://code.claude.com/docs/en/routines)） | 組織の管理者設定、1日の上限の実数 |
| Team プランの持ち主 | — | 会社契約のシートなら、個人のパブリックリポジトリでの利用が社内ルール上許されるか |
| GitHub Actions | パブリックリポジトリの標準ランナーは無料。private は無料枠を超えると課金（[GitHub の料金改定](https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/)） | 移行後の軽い Actions の月間実行時間 |
| gh-aw | Claude エンジンは API キーか WIF のみ。サブスク OAuth は非対応（[gh-aw Authentication](https://github.github.com/gh-aw/reference/auth/)） | — |
| 公式 Claude Code Action | OAuth トークンは Pro・Max・Team・Enterprise で利用可（[GitHub Actions](https://code.claude.com/docs/en/github-actions)） | Actions 版へ移行する場合のみ |
| Jev | TypeSafe AI の API、従量課金（[TypeSafe AI](https://docs.typesafe.ai/introduction)） | Claude のサブスクとは別の支出になることの了承 |

本計画は法的助言ではない。規約の最終判断は各社の規約本文と窓口で確認する。

## 決定ログ

レビューでの質疑（Q1〜Q44）の結論。「Actions 版」は将来の移行先の章にのみ適用され、現行の Routines 構成では置き換わっている。

| # | 論点 | 決定 | 現行構成での扱い |
| --- | --- | --- | --- |
| 前提 | リポジトリ | 個人アカウント・パブリックで構築、後に GitHub Team の private へ | 有効 |
| 前提 | AC 変更 | Agent はコメントで提案のみ | 有効 |
| Q1 | Risk 段階 | low=R0+R1 / medium / high / critical、付与は Agent のみ | 有効 |
| Q2 | low の範囲 | low はすべて自動 Merge | 有効 |
| Q3 | low 判定の方式 | Risk 判定専用の Agent を置く | 有効 |
| Q4 | 決定論的チェック | 併置せず Risk Agent の判定のみ | ガードレールのパスだけ App が判定する（Q82） |
| Q5 | Risk Agent の入力 | diff＋リポジトリ＋ポリシー（自然言語の主張は見せない） | 有効 |
| Q6 | Merge への接続 | head SHA 紐付け＋決定論的ジョブ | 有効（Actions が SHA 検証） |
| Q7・Q8 | 計画承認 | 要判断または high 以上のみ停止 | 有効（ゲートは Actions） |
| Q9 | 帰属 | App＋Timeline・Co-authored-by・PR フッター | Actions 版。現行は実行セッション URL を記録 |
| Q10 | Reviewer | 自動 Merge の必須条件、ブロッキングは AC 未達・範囲外のみ | 有効 |
| Q11 | 修正ループ | 3回まで | 有効 |
| Q12 | 同時実行 | Issue 単位排他・2並列・main 追従必須 | 並列は Actions 版。main 追従は有効 |
| Q13 | 外部入力 | コラボレーターのコメントのみ | 有効（Claude のコメントは目印で区別） |
| Q14 | ラベル権限 | Agent は plan-review / in-pr / blocked / risk:\* のみ | Actions 版。現行は信頼ラベルを Actions のみが付与 |
| Q15 | 依存待ち | `agent:waiting`＋自動再開 | 有効 |
| Q16 | Draft | Draft＝Agent 作業中 | 有効 |
| Q17'・Q18 | 実行基盤・書き込み | 公式 Action＋2ジョブ構成 | Actions 版 |
| Q19 | 保護対象 | App 権限＋Risk ポリシー | Actions 版。現行は Risk ポリシー＋Phase 0 で確認 |
| Q20 | 隔離 | 許可ツール＋通信許可リスト | 現行は Routine の環境設定で実現 |
| Q21 | 利用上限 | `agent:waiting` で自動再開 | 現行は次の定期実行で再試行 |
| Q22 | Close | 子も親も自動 | 有効 |
| Q23 | 計測 | 成果物＋PR フッター | 有効（PR フッター） |
| Q24〜Q30 | Risk ポリシー・Jev | 影響範囲＋revert 可否、8問、事実のみの状態、Claude は3択、一致率で切り替え | 有効 |
| Q31 | 結果の記録 | Check Run、`agent/review` のみ Required | 有効 |
| Q32 | 待ち合わせ | 標準 auto-merge に任せる | 有効 |
| Q33 | fix の起動 | 変更要求レビューに統一 | 有効 |
| Q34 | 計画と実装 | 別ジョブ（停止をコードで強制） | 有効（段階分割＋Actions ゲート） |
| Q35・Q36 | 並列・resume | 前処理で数えて待機、理由別起動 | Actions 版 |
| Q37・Q38 | Phase | Phase 0 で先に検証、Phase 4 で即有効化 | 有効 |
| Q39・Q40 | Actions の範囲 | Claude は人のセッションか定期 Routines、決定論的処理は軽い Actions | 有効 |
| Q41 | GitHub 名義 | 本人のアカウントのまま | 有効 |
| Q42 | 承認 | 要承認は人のセッションで実装 | 有効 |
| Q43 | Routine 構成 | 毎時1本、段階ごと＋Actions ゲート | 有効 |
| Q44 | 判定の受け渡し | SHA 付きコメント → Actions が Check Run 化、Jev は Actions から | 有効 |

**外部レビュー（Keishin の事故記録・ADR との突き合わせ）の反映**。上の表のうち Q10・Q11・Q27 と、`github-actions[bot]` を信頼の根にしていた箇所は、以下で置き換わる。

| # | 指摘 | 決定 |
| --- | --- | --- |
| Q45 | 1. `github-actions[bot]` は PR 側から名乗れる | ゲートは `issue_comment`＋`pull_request_target`（head を checkout しない）。必須チェックの出どころを App に固定 |
| Q46 | 8. `GITHUB_TOKEN` 起点のイベントは後続を起動しない | Actions の書き込みは専用 GitHub App のトークン |
| Q47 | 2. medium を Routine がマージできる | merge-route を必須チェックに＋`.claude/settings.json` で直接マージを deny、bypass なし |
| Q48 | 9. SHA 紐付けと main 追従の衝突 | `git patch-id` が同じなら過去の判定を有効 |
| Q49 | 11. 人と Routine の二重着手 | `agent:working` の着手宣言＋期限、各段階は冪等 |
| Q50 | 3. 決定論的な下限 | 置かない（Q4 のまま）。Q82 でガードレールだけ置く |
| Q51 | 4. low の定義 | 今の定義のまま |
| Q52 | 5. BLOCKING の範囲 | 型・テスト失敗、データ破壊、秘密の漏えい、AC 外の退行も常にブロッキング。敵対的レビューは入れない |
| Q53 | 6. 計画ゲートの入力が自己申告 | 計画に触るファイル一覧を必須化し、実装後の diff を App が照合 |
| Q54 | 7. Jev の切り替え基準 | 結果ベース（revert・fix PR）＋否定側の最低件数、「Jev だけが可」ゼロは維持 |
| Q55 | 10. 止める仕組み | 停止スイッチ、`agent:hold`、revert 1件で自動停止、暴走時の runbook のすべて |
| Q56 | （反映中に判明）PR 内の workflow から鍵を読める | App・Jev の鍵は Environment に置き、既定ブランチからの実行に限定 |
| 小 | 修正回数 | 通常2回、3回目は critical のみ。数え方は PR の Timeline |
| 小 | PR の大きさ | 上限なし |
| 小 | 停滞検知 | 24 時間動きがないものを一覧化 |
| 小 | 追加項目 | 書式とパーサのテスト、書式検査・集計スクリプト（Phase 3）、秘密の伏せ字、private 移行時の Jev の判断 |

**再レビューの反映**

| # | 指摘 | 決定 |
| --- | --- | --- |
| Q57 | B. 既存 CI は PR 側の YAML で動き、緑を偽れる | merge-route にパスの下限は入れない（Q50 のまま）。受け入れるリスクとして明記。Q82 で `.github/**` はガードレールになった |
| Q58 | C. `issue_comment` はだれのコメントでも起動する | private 移行を前提に、受け付け条件・編集対応・埋め込み対策は入れない。受け入れるリスクとして明記 |
| Q59 | E. hold と working の弱点 | `agent:hold` が外されたら App が通知。終了済みの Routine の `agent:working` は次の Routine が引き継ぐ |
| — | D. 時刻による比較 | 対応不要（判定の受け付けは patch-id による比較で、時刻を使っていない） |

**上の表で、その後の決定により変わった行**

- Q6：head SHA 紐付けは Q48 により「PR 自身の差分（patch-id）が同じなら有効」に拡張
- Q31：必須チェックは `agent/review` に加えて merge-route（Q47）。出どころは App に固定（Q45）
- Q41：本人名義のままは変わらないが、信頼できる印は専用 App が付ける（Q46）

**実装開始時の追加決定（2026-09-26）**

| # | 論点 | 決定 |
| --- | --- | --- |
| Q60 | Q58 の作成者チェック | ゲートは `author_association` が OWNER / MEMBER / COLLABORATOR のコメントのみ受け付ける（1行で済むため追加）。`${{ }}` 埋め込みはイベント JSON をファイルから読む実装で発生しない |
| Q61 | 実装言語 | TypeScript（ビルドなし、Node 24 の type stripping、実行時依存ゼロ、`tsc --noEmit`＋`node:test`） |
| Q62 | 質問8の対象 | `harness/**`・`harness.config.json` を追加（Q82 でガードレールに置き換え） |
| Q63 | コードの置き場所 | ハーネスは `harness/` に置き、導入先の製品コードと分ける |
| Q64 | 自動 Merge モード | ダッシュボード Issue の `agent:auto-merge-stopped` ラベルで持つ（App の権限で変数を書けないため）。ダッシュボードが無ければ停止 |
| Q65 | Agent PR | 同じリポジトリの `claude/` ブランチからの PR。それ以外は `agent/review` を判定対象外で通し、自動経路に乗せない |
| Q66 | 人の修正依頼 | PR の Review（Comment）で行う（同じ名義の PR には Request changes を付けられない）。Reviewer の変更要求は App が付ける |
| Q67 | claim の引き継ぎ | 別の Routine の実行の claim は 90 分で引き継ぐ |
| Q68 | deny | Phase 2（Routine 作成）で有効化 |
| Q69 | 変更要求の解除 | 合格した判定を受け付けたら App の過去の変更要求を解除する（修正回数は解除済みも数える） |
| Q70 | patch-id | `--verbatim` を使う（`--stable` は空白を無視する） |
| Q71 | 質問4 の範囲 | 「挙動を変える変更がテストで検証されているか（挙動を変えない変更だけなら yes）」に言い換え |
| Q72 | Routine の GitHub 操作 | GitHub MCP ツールのみ（Routine の環境に `gh` と API 用トークンがない）。queue は App が計算してダッシュボードに公開し、Routine はそれに従う。メトリクスは PR コメントに残す |
| Q79 | タイトルの形式 | Issue と PR のタイトルを Conventional Commits にそろえる。Issue は agent:ready で検査、PR は必須チェック `agent/title`。Routine は PR とコミットに Issue のタイトルを使う |
| Q80 | 作業場所と処理量 | 作業は常に worktree（リポジトリの外）で行う。1回の実行で進める件数は 5 |
| Q81 | Merge 衝突 | main が進むたびにすべての Agent PR を追従させ、衝突したものは Routine が main を取り込んで解消する（触るファイルの重なりは許す） |
| Q82 | ガードレール | critical を「Agent が自分を縛る仕組み（ガードレール）を変える変更」に絞る。一覧は `harness.config.json` の `guardrailPaths`（除外 `guardrailExclude`、一覧自身は外せない、一覧が無ければすべて）。触れる PR は App がパスで自動 Merge から外し、触れる計画は計画ゲートで止める。質問8は「ガードレールに触れるか」に言い換える（キー名は互換のため残す）。Q4・Q50・Q57・Q62 の「パスによる下限は置かない／質問8に任せる」を改める |
| Q83 | Epic とガードレール | Epic に分ける計画（`split`）では、子課題の files がガードレールに触れても計画ゲートで止めない。分ける段階では子 Issue を作るだけで、子課題はそれぞれの計画でゲートがガードレールを判定する（Q82 の「触れる計画は止める」を、split の子課題については子課題の計画で行う） |
| Q84 | ラベルの規則 | 必須ラベルは、Issue が `type:*`・`area:*`・`priority:*`、PR が `type:*`・`area:*`・`size:*`。子を持つ Issue は `epic` が必須で `type:*` を付けない。`type:*` はタイトルの type と同じ一覧。人が付けたラベルは上書きしない。`classification.issueTriage` に `label`（足りないラベルを Jev が付ける。確率の下限は `jev.thresholds.labelProbability`）を足す（Q75 のシャドーのみを改める。付与は #99、検査は #98 で入る） |
| Q85 | 判定の連鎖とガードレール | 判定の入力の作り方・組み立て・手順を変える変更も人が Merge する。`guardrailPaths` に `harness/scripts/agent.ts`、judge・plan の skill、`.claude/routine.md`、plan-critic・test-designer の定義を足し、`guardrailExclude` から `harness/lib/facts.ts`（queue が judge・fix を決める材料として、判定の受け付け・人のレビューなどの事実を集める）を外す。残りの除外（usage・classify・worktree・issue-triage・queue・concurrency）は判定の材料を作らないので残す。`harness/lib/session-inputs.ts` は `harness/lib/**` で既に入っていて扱いを変えない。導入先で人が Merge するパスを足す仕組みは `humanMergePaths` を採る（#105）。Jev の切り替えの基準は docs/security.md に置く（#104）。Q82 の「保護するのは Agent が自分を縛る仕組みだけ」を、判定の連鎖と導入先の下限に広げる |
| Q86 | 判定の連鎖の残り | `guardrailPaths` に sync・fix・ship の skill、`CLAUDE.md`、`harness/scripts/report.ts` を足す（判定の引き継ぎ、再レビューの範囲とテストの改ざん検査、段階のつなぎ、有人セッションで計画の批評の止める条件を上書きする規則、Jev の切り替えの集計を緩められるため）。`harness/lib/queue.ts` は `guardrailExclude` に残す：queue は次にやること（いつ judge・fix するか）を決めるだけで、Merge の条件は App が確かめる（判定は `agent/review` の必須チェックと patch-id に結び付き、範囲照合は計画ゲートを通った計画だけを使い、修正回数は App の `fix-request` で数える）。緩めても判定・修正をしない／余計にするだけで、判定なしの Merge にはならない。事実を集める `harness/lib/facts.ts` はガードレールに入っている（Q85）。implement・fleet の skill はこの決定の対象外 |
| Q87 | テストの改ざん検査と Human Merge | 人が Merge する PR では `agent/tests` を止めず（neutral）、Human Merge の依頼に見つけた行を載せて Merge の判断にまとめる（施策 A、2026-09-27 の人の決定）。Human Merge とみなすのは Agent PR で、変更ファイルがガードレール・`humanMergePaths` に当たるか、現在の差分に対する最新の受け付けが合格かつ自動 Merge の対象外のとき。hold・自動 Merge モードの停止だけが理由のもの、人の PR・fork、auto-merge が付いた PR は対象外（今までどおり `test:exempt`）。経路が自動 Merge に変わると auto-merge を付ける前に failure に戻す |
| Q88 | Jev の問いとしきい値 | これまでの受け付けの記録 64 件（jev-1.13.0）は Jev の `allows` がすべて false で、Claude が low とした 11 件もすべて q2 で落ちた（q2 の yes は 0.77〜0.89。ガードレールに触れる critical の PR でも 0.91 で区別に役立たない）。Jev は問いを文字どおりに読むので、条件を直接書き、境界の例を `criteria` に置く形に書き直した（文は `harness/lib/jev.ts` の `JEV_NOUL_QUESTIONS`）。q2 は instructions を「Would running git revert on this change restore the state from before the change?」にし、criteria の true は「Every change in diff is an edit to files in this repository (documentation, tests, source code, or configuration), and the changed code does not write stored data, call an external service, send messages, or publish or deploy anything when it runs. Changes that only edit documentation or tests are yes.」、false は「diff adds or changes code that, when it runs, writes, deletes, or migrates stored data, calls an external service that changes remote state, sends messages, or publishes, deploys, or releases something. Reverting the files does not undo those effects. This includes changes to CI or deployment workflow files that publish, deploy, or release something when they run.」とした。実行されると外部の状態を変えるコード（このリポジトリでは GitHub API を呼ぶ `harness/gates` など）の変更が q2 で no 側に倒れるのは意図どおり（revert してもラベルやコメントは残る。こうした変更はガードレールで人が Merge する）。q5 は instructions を「Does diff add or change code that writes, deletes, or migrates persistent data?」にし、criteria の true は「diff adds or changes code that, when it runs, writes to, deletes from, or changes the schema of a database, files that the program keeps between runs, or external storage.」、false は「diff changes only documentation, tests, or code that does not write stored data. The edits to repository files shown in diff are not themselves persistent data writes.」とした。q3・q6 は instructions を変えずに criteria を足した（q3：criteria の true は「diff changes the name, parameters, or return value of an exported function, type, or class, or changes the fields, keys, or allowed values of a configuration file, schema, API, command-line option, or event or comment format.」、false は「diff changes only explanatory documentation, tests, code comments, or code that is not exported, and changes no configuration, schema, API, command-line option, or event or comment format.」。q6：criteria の true は「diff changes code or configuration that checks identity or permissions, handles tokens, keys, or passwords, stores or reads secrets, or charges money.」、false は「diff changes no such code or configuration. Documentation that only mentions these topics without changing how they work is no.」）。q1・q4・q7・q8 は変えない。問いの版（`JEV_QUESTION_SET`、今は 2、それまでを 1）を受け付けの記録の `jev.questionSet` に残し、`report.ts` の集計で版ごとに問いごとの確率の分布としきい値で落とした件数を出す。切り替えの基準（否定側・Jev の low の外れ・Jev だけが可）は今の版の記録だけで数える（版 1 は全件が不可なので、混ぜると今の問いを見ないまま「Jev だけが可 0 件」を満たすため）。しきい値は一律の `noulSafe` 0.9 のまま据え置き、問いごとのしきい値は入れない：今の記録で q2 だけを 0.75 に下げると Claude が不可とした PR（#10）も通り「Jev だけが可」が出る。書き直した問いは確率の出方が変わるので今の記録から問いごとの値を決められない。Jev のドキュメント（Confidence）もしきい値は保守的に始めて自分のデータで調整するとしている。決め直すのは版 2 の受け付けの記録が 20 件以上になったとき：`report.ts` の「問いごとの確率」を見て人が決め、問いごとの値を入れるのはその値でも記録の上で「Jev だけが可」が 0 件のままのときに限る。入れるときは別の Issue で `harness.config.json` と `jevAllows` を変える（ガードレールなので人が Merge する）。`jev.mode` は shadow のまま、切り替えの判断は security.md の「Jev」の基準で人が行う |
| Q89 | README の説明の生成 | README の表の「説明」は各ファイル・ディレクトリの先頭のコメントの1文目から生成する（新しいスクリプト `harness/scripts/readme.ts`。ガードレールの外に置き、`agent.ts` には足さない）。表が生成結果と食い違う、表の名前が実在しない、`overview.html` のラベルと設定が食い違う、をそれぞれテストで検査する（#132） |
| Q90 | Jev の材料の大きさ | Jev の上限は state と最も長い問いの合計で 32k トークンで、`jev.maxDiffChars`（80000）は文字数で数えている。日本語は1文字あたりのトークンが多いので、受け付けの記録の `jev.size` と `label-triage` の記録の `size` に、応答の `usage.input_tokens` と、送った材料（state と問いを JSON にしたもの）の文字数・日本語の割合を残し、`harness/scripts/report.ts` の集計に日本語の割合の区分ごとの「文字数 / トークン数」を出す。`jaRatio` は要求全体での割合（英語の問いの文とガードレールの一覧を含むので、diff だけの割合より薄まる）で、diff の文字数は `diffChars` に残す。上限をトークンで見積もる方式（文字の種類ごとの係数など）に切り替えるかは、区分ごとに実測が貯まってから決める。人の決定（2026-09-27）：それまで `maxDiffChars` は 80000 のまま据え置く（下げると shadow の記録が減る。shadow では上限を超えても Jev の結果は記録だけで経路に影響しない。上限を超えたときの Jev の挙動はドキュメントに無いので、enforce に切り替える前にこの比で見直す）。Jev のトークナイザーは再現しない。`label-triage` の記録は集計に入れない（Issue ごとのコメントを読む必要があり API の呼び出しが増えるため。必要になったら別の Issue で足す）（#129） |
| Q91 | 合体版のレビューに切り替える基準 | 記録だけ（shadow）の期間の合体版の記録と、App が受け付けた今の reviewer の判定を head ごとに組にして、`node harness/scripts/report.ts` の最後の節「合体版のレビュー（記録だけの期間の比較）」で比べる。切り替えの基準（`REVIEW_PANEL_SWITCH_CRITERIA`、人が計画で決めた値）は5つ：(1) 組になった PR が 20 件以上、(2) 今の reviewer だけが出して裏付けのあるブロッキング（合体版の見落とし）が 0 件、(3) 合体版だけのブロッキングのうち誤検知の疑いが半分以下（合体版だけが 0 件なら満たす）、(4) 合体版の仮の往復（組のうち合体版が不合格の数）の合計が実際の往復（組になった PR の App の変更要求の合計）の 1.5 倍以下（実際が 0 で仮が 1 以上なら満たさない）、(5) 1判定あたりの推定料金の中央値が今の reviewer の 3 倍以下（どちらかの値が1つも無ければ満たさない）。実際の往復は PR の全部の head、仮は組になった head だけを数えるので範囲がずれる。仮は参考の「今の reviewer が不合格の組」と並べて見る（記録の抜けた head があると仮が少なく出る）。合体版の記録はセッションが書くので偽れる。そのため数えるのは、コラボレーターが書き、Claude の目印があり、ブロックが読め、編集されておらず、head が App の受け付けの `verdictHeadSha` と同じで、判定コメントより前に作られた shadow の記録だけにする（同じ head に複数あれば判定コメントの直前の1つ。外したものは理由ごとの件数を出す）。今の reviewer の指摘は App の変更要求（fix-request）の本文から読み、無ければ未編集の判定コメントから読む。指摘は同じファイル（ファイルが無ければ同じ種類）で1対1に対応させる。片方だけの指摘は、後の head の App の変更要求・判定コメントより後の人のレビューコメント・Merge 後 7 日以内の fix の PR の同じファイル・revert のどれかがあれば「裏付けあり」、無ければ「未確認」。今の reviewer だけの指摘で、そのファイルを後の最初の合格の head までの PR 自身のコミット（main の取り込みを除く）が変えたものは「後の head で直された」として裏付けとは別に数える（指摘を受けたセッションは誤りでも直すので強い証拠ではない。人の決定で基準 (2) には数えず、基準の判定の文に件数を添える。#268）。合体版だけの指摘で、Merge され裏付けが無いものを「誤検知の疑い」とする。表は「App・GitHub の事実」の列と「セッションの申告」の列に分ける。基準を満たしても自動では切り替えない。人が「合体版だけ」の指摘と誤検知の疑いの全件を PR の diff と照らして確かめてから決め、切り替えるなら人が `reviewPanel.mode` を `enforce` にする Issue を立てる（`agent:ready` は 20 件に達して人が決めてから付ける。変更は `harness.config.json` の1行で、ガードレールなので人が Merge）（#150） |
| Q92 | 段階の制御をコードに移す | 段階のつなぎを skill の文章（AI の判断）からコードに移す。段階のグラフを1か所のデータにし、`agent.ts step` が次のノードを1つだけ返し、hook（`guard.ts`）が段階に合わない GitHub への書き込みを止めるところまで（ノードごとに `claude -p` を呼ぶ実行役は作らない）。付き添いのセッションは段階を選ばない窓口にする。担当は Issue の Assignee を正にし、設定が有効なときはちょうど1人で自分のときだけ取る。アサインは人か、人に頼まれた付き添いのセッションが決め、エージェントは自分の判断ではアサインしない（#172）。着手宣言は最初の宣言を持ち主にし、ほかのセッションの宣言は `--takeover` のときだけ持ち主を移す（#171）。Q49・Q67・Q76 の着手宣言による判断に、Assignee の確認を先に足し、持ち主を「最新」から「最初」に改める。Cloudflare・LangGraph へは移さない。人の決定（2026-09-28）。中身は「段階の制御をコードに移す」の節（#169） |
| Q93 | 人の決定の記録で Planner の申告を外す | 付き添いのセッションが、Planner の申告（`needsHuman`・`openQuestions`）への人の答えを ```` ```agent-decision ```` のコメントで記録し（`agent.ts post-decision`）、App が Jev に「すべての理由・質問に答えているか」を問う。材料は App の計画ゲートの記録にある計画の写しと答えだけ。`jev.decisionRelease` は `shadow` から始め（記録だけでラベルは変えない）、`enforce` でしきい値（`jev.thresholds.decisionProbability`）以上なら答え済みとして計画を判定し直す（通れば App が `agent:plan-review` を外す）。App のゲートの停止・人が付けた印（ラベルの時刻で見分ける）・`acChangeProposed` はこの経路で外さない。Routine は `.claude/routine.md` で記録を禁止するだけ（hook では Routine を見分けられない）。切り替えは `report.ts` の一致率を見て人が決める。人の決定（2026-09-27）（#151） |
| Q94 | ラベルを付ける確率の下限の見直し | Jev が `priority:medium` と答えても確率が `labelProbability`（0.8）に届かず、priority の無い Issue が残り続けた（#216 79%・#218 66%・#219 65%・#229 66%）。下限をラベルごとに分けられるようにし（`jev.thresholds.labelProbabilityByLabel`）、`priority:medium` だけ 0.5 に下げる。ラベルの無い Issue は queue で medium として並ぶので、medium を誤って付けても並び順は変わらない。0.5 は過半（medium がほかの選択肢の合計より確からしい）。`priority:high`・`low` などは並び順を、`area:*` は `areaConcurrency` の数え方を変えるので 0.8 のまま。既存の Issue は、最新の `label-triage` の記録の確率で App が1回だけ付け直す（`label-reapply`。Jev に問い直さない）。Jev の材料を足して確信度を上げる案は別の Issue にする（人の決定。#229） |
| Q95 | テストの改ざんの検査が止めた変更を Jev に問う | `agent/tests` が見つけたアサーションの書き換えと、同じ位置で名前だけ変えたテスト定義の組（テストの名前の変更、#421）を、App が Jev に「弱めていないか」を対ごとに問い、確率を `test-tamper-jev` の記録に残す（`jev.testTamper`。`jev.mode` と独立）。材料は App が diff から検出した行（ファイル名・変更前・変更後）だけで、セッションが書いたものは渡さない。削除系（テストファイルの削除・リネーム、組にならないテスト定義の削除、skip / only / todo の追加）と対にならない削除は問わずに止める。fork の PR は問わない。1つの差分（patch-id）に1回だけ問い、使い回すときは今の設定で通すかを決め直す。既定は `shadow`（記録だけで結果は変えない）。`enforce` では確率の最小値が `jev.thresholds.testTamperProbability` 以上なら success（優先順は `test:exempt` → Human Merge の neutral → Jev の enforce → failure。委任・bypass で自動経路に乗る PR も進む）。`enforce` への切り替えは、`report.ts` の人の判断（`test:exempt` か同じ差分で Merge ＝通した、違う差分で Merge ＝直させた）との一致率と「Jev は通す・人は直させた」件数を見て人が決める（基準は決めない）（#126） |
| Q96 | Jev に渡す材料を英訳するか | 英訳しない（人の決定、2026-09-30）。`harness/scripts/jev-language.ts` で、Merge 済みの PR 30 件（diff の長さで短・中・長の3層に各10件、`skipped` なし）と Issue Form の Issue 24 件を、日本語版と英訳版（セッションが下書きし人が確かめた）で各2回、本番と同じ問いで Jev（jev-1.13.0）に投げた（216 回、見積もり約 168 万トークン・約 $0.07）。PR の正解（Risk の8問）は埋めない決定のため、Brier score・一致率は判断に使わず、対の差・回ごとのぶれ・input_tokens の比で見た。PR の問いは、対の差（日本語 − 英訳、2回の平均どうし）の平均が q2〜q8 で ±0.011 以内、|差|平均が 0.0015〜0.037 で、回ごとのぶれ（0.002〜0.042）と同程度。q1_risk（正解が無いので総変動距離）は 0.042 で、ぶれ（日本語 0.036・英訳 0.042）と同じ。確率最大の選択肢が入れ替わったのは medium と critical が拮抗した3件だけ。input_tokens の比（日本語 ÷ 英訳）は合計 1.120・項目ごとの中央値 1.144。言語による差がぶれと同程度で、トークンも1割ほどしか変わらず、英訳には #104 の守り（Jev に渡すのは App が API と設定から集めたものだけ）を保つ仕組みとゲートの変更が要るため、見合わないと判断した。注意として、Issue の問いには偏りが残る：priority の |差|平均 0.071（ぶれ約 0.018）、requirements_clear は英訳のほうが高い（平均 −0.035、英訳が上回り 18 件・日本語 6 件）、ac_verifiable は日本語のほうが高い（平均 +0.022、17 件・6 件）。ラベルの付く・付かないが変わったのは priority の2件。長さの3層では短い層ほど差が大きい（|差|平均の平均 0.044・0.031・0.024。短い層は Issue が多い）。Issue のラベルや計画ゲートの判断でこの偏りが問題になれば、別の Issue で問いの言い回しかしきい値を見直す（#137、Epic #130） |
| Q97 | Jev にラベルを問う材料 | Q94 で見たとおり Jev の priority の答えは medium の 65〜79% に集まり、high・low の確信度が低かった。材料に、本文の Dependencies 節、Issue に付いている `type:*`・`risk:*`・`area:*`・`epic`、子の数を足し、priority の基準を `classification.priorityCriteria` で導入先ごとに書き換えられるようにした（このリポジトリ向けの基準を入れた）。どれも App が API と設定から集めたもの（#104 の守り）。較正の例（few-shot）は例ごとに events を読む費用がかかるため、計画の後の問い直しは「一度だけ問う」規則と計画（セッションが書いたもの）を材料にすることになるため、見送った。材料の言語は英訳しない（Q96）。`dependencies` が増えたので、`jev-language.ts` の実験を走らせ直すと Issue の要求はこの版から変わる（Q96 の結果とは同じ材料で比べられない）。材料を足す前と後で #216・#218・#219・#229 を各2回問うた（前・基準だけ・全部の3列、24 回、入力 約3.6万トークン。表は #295 の本文）。priority の最も高い選択肢の確率は、medium のままの3件で 79→81%・68→87%・68→81%（基準だけでも 75〜87%）に上がり、#218（`risk:critical`・`type:fix`）は全部を足すと high 60% に変わった。high・low が 0.8 に届いた Issue は無く、area は前後とも harness 100%。`priority:high`・`low`・`area:*` の下限（0.8）は変えない：下げると、1件だけ・2回とも 57〜63% の high で並び順を変えることになり、根拠が足りない（Issue #259） |
| Q98 | 合体版のレビューのしきい値 | 確信度のしきい値（`harness/lib/review-panel.ts` の `SCORE_THRESHOLD`）を 80 から 75 にする。人の決定（2026-09-30）。80 は公式の code-review の段階6の値だが、公式は人向けのコメントで確実なものだけを出す用途で、採点の刻み（0/25/50/75/100）では実質 100 だけが通る。shadow の記録 80 件（2026-09-27〜09-30）では合体版の不合格が 0 件で、担当が出した指摘 15 件の採点は 75 前後が 8 件・80 以上は 0 件だった。記録から模擬すると 75 なら組になった 74 head のうち 7 件が不合格になり、今の reviewer のブロッキング 2 件のうち #295（AC の未達）と一致した（#231 の退行は 75 でも見落とす）。合体版だけの 6 件のうち、#288 の2件（`harness/test/README.md` に新しいテストの行が無い）と #173（記録の目印の確認が必ず通る）は main に残っている本物だった。採点の基準の文（公式の写し）は変えない。続けて、今の reviewer にあって合体版に無いものを足し（#318）、`reviewPanel.mode` を `enforce` に切り替える（#319）（#317） |
| Q99 | 合体版のレビューに今の reviewer の中身をそろえる | `enforce` に切り替えても判定の強さと中身が落ちないよう、今の reviewer にあって合体版に無いものを足す（人の決定、2026-09-30）。⑦（review-safety）を opus にする（#231 の退行を合体版が見落とした）。⑦の採点にも Issue 本文と計画を渡す。⑥⑦の指摘の採点（review-scorer）は Agent の model を opus にして呼ぶ（人の決定：見つける担当が opus なのに haiku の採点が覆せる作りで、置き換える reviewer は opus で自分で判断している。⑥⑦の指摘は 80 記録で3件と少なく料金はほぼ増えない。haiku が⑥⑦を誤って落とした明らかな例は無く、実績ではなく作りの筋からの判断）。担当が Merge を止めない提案（`suggestions`）を返し、組み立てが採点せず `nonBlocking` に入れる（80 記録で `nonBlocking` が一度も入っていなかった）。⑥⑦に「ハーネス自体・公開インターフェース・データに触れる変更、テストで確かめきれない変更では humanNotes を必ず書く」を足す。料金の見込み：セッションの記録の 57 組では合体版の中央値 $0.757（reviewer $0.272 の 2.78 倍）、うち⑦は $0.102。⑦を opus にすると 3.16 倍（⑦が 1.5 倍なら約 2.97 倍）の見込みで、Q91 の基準 (5)（3 倍以下）の境目にある。基準 (5) の扱いは、切り替え（#319）のときに Merge 後の実際の値を見て人が決める（#318） |
| Q100 | 合体版のレビューで過剰さを見る | 合体版に観点⑨の担当 review-overbuild（sonnet）を足し、計画・AC が求めていない過剰な実装・過剰なテスト・オーバーエンジニアリングを見る。人の決定（2026-09-30）：提案だけで止めない、`enforce` への切り替え（#319）の前に入れる。PR の段階でこれを見るところが無かった（plan-critic は計画の文章だけ、reviewer のブロッキングは6種類だけ、①〜⑤は公式どおり nitpick を避け、⑥は範囲外のファイルだけ）。①〜⑤・⑥に混ぜると公式の文言と今の基準が崩れるので担当を分けた。指摘は1判定5件まで、haiku で採点して点を記録に残すが、確信度・再レビューに関わらず `nonBlocking`（計画の方針ごと過剰なら `humanNotes.checkPoints` にも）。公式の基準の 75 は「機能に直接響く問題」なので過剰さは本物でも 50 前後に出る見込みで、点は「25 以下＝採点の担当が本物と確かめられなかった、50 以上＝本物と確かめた」と当たり具合の材料として読む。出力が無ければ組み立てを止めず、`humanNotes.concerns` に「⑨の記録なし」を残す。料金は +$0.10 前後の見込みで、#318 の後の見込み（reviewer の約 3.16 倍）と合わせて約 3.5〜3.7 倍。基準 (5) の扱いは #319 で人が決める。記録が 20 件ほどたまったら、人が当たり具合を見て止めるようにするか・採点をやめるかを決める（#325） |
| Q101 | 上限の数値の置き場所と検査 | 運用の上限はすべて `harness.config.json` で変える（ガードレールなので人が Merge する）。リポジトリの変数・環境変数では上書きしない（人の決定、2026-09-29。#272）。コードに直書きだった4つ（Jev に分類を問う Issue の数・判定コメントへの App の返答を待つ時間・決定の記録を Jev に問う項目数と文字数）を省略できるキーにし（既定は今の値）、`loadConfig` が上限の数値のキーを型と範囲で検査して、誤りがあればキーと値を示して止まる（上限が効かないまま動かない）。上限でない設定の検査は広げない |
| Q102 | 合体版のレビューへの切り替え | 付き添いのセッションの judge を合体版の組み立ての出力で判定する（`reviewPanel.mode` を `enforce` に）。人の決定（2026-09-30）：今すぐ切り替え、料金の基準 (5) を超えるのを受け入れる。Q91 の集計（組になった PR 52）は「満たす」だったが、しきい値 80 では合体版の不合格が 80 記録で0件だったので、先にしきい値を 75 にし（Q98、#317）、今の reviewer との差を埋め（Q99、#318）、⑨ 過剰さの提案を足した（Q100、#325）。Merge 後の記録の料金は、#321 が合体版 $0.565 / reviewer $0.218（2.60 倍）、#334 が $0.711 / $0.383（1.86 倍）、#335（⑦ opus、⑨なし）が $1.035 / $0.366（2.83 倍）で、⑨の分を足すと約 3.1 倍の見込み。新しい構成（しきい値 75・⑦ opus・⑨）での shadow の記録は1〜2件しかないまま切り替えた。Routine（`.claude/routine.md`）と導入先の雛形（`harness/templates/harness.config.json` の `shadow`）は変えない。`enforce` では合体版が失敗すると判定しないので、⑨の出力の形の誤りでも判定が止まる。起きたら⑨の誤りを組み立てを止めない扱いにする Issue を立てる（#319） |
| Q103 | 合体版のレビューの⑨の扱い（見直し） | 確信度 75 以上の⑨（review-overbuild）の指摘をブロッキングにし、75 未満は今のまま提案（`nonBlocking`）にする。人の決定（2026-09-30。#352）。#386 で入れた：種類は⑨の3つ（`over-implementation`・`over-testing`・`over-engineering`）を判定の `BLOCKING_KINDS` に足した（`out-of-scope` などに寄せると⑥と見分けられず、report の比較と誤検知の数え上げが判定コメントから読めなくなるため。`CRITICAL_BLOCKING` は変えず、修正の上限は通常）。再レビューは①〜⑤と同じく変わった行に当たるものだけをブロッキングにし、ほかは `nonBlocking`。`planLevel` は扱いに関わらず `humanNotes.checkPoints` にも入れる。材料は enforce の記録（2026-09-30T05:25Z 以降、15 PR）の⑨の指摘 52 件、同じ PR・ファイル・内容の重複を除いて 40 件（全件の表は #352 のコメント）。見立ては当たり 13・一部当たり 22・外れ 5。点の帯ごとに、75 以上 2 件（当たり 2）・50〜74 が 33 件（当たり 11）・25〜49 が 5 件（当たり 0）。種類は over-testing 28・over-implementation 10・over-engineering 2。一部当たりの多くは、事実は正しいが計画のテスト方針が明記していたもので、外れ 5 件は事実の誤り 3・AC が求めていたもの 2。Merge 済みの PR の指摘 16 件は main で1件も直されていない。⑨の出力の形の誤りで合体版が失敗した判定は 0 件。表の見立ては付き添いのセッションの担当が各 head のコードと Issue の AC・計画を照らしたもので、人は全件を確かめず、その表を材料として受け入れて扱いを決めた（#352 の AC の「人の見立て」はこの形で満たした）。75 以上は件数が少なく確かではないので、切り替えた後の 20 件ほどで人が誤検知を見る。拾われていない提案（Merge 済みの 16 件）は今は何もしない（残った過剰なテストは、人が test-prune を呼んだときに拾う） |
| Q104 | テストの改ざんの Jev を enforce にする | このリポジトリの `jev.testTamper` を `shadow` から `enforce` にする（人の決定、2026-09-30、#364）。`report.ts` の一致率は読めなかったが、Jev と Claude で妥当かを確かめる仕組み（#349、Epic #339）より先に、`test:exempt` を付ける手間を早く減らす。下限（`jev.thresholds.testTamperProbability` 0.9）・問い・削除系の扱いは変えない。導入先の雛形の既定は `shadow` のまま | 有効 |
| Q105 | 実装のモデルを Jev で振り分ける | `jev.modelRouting`（既定 `shadow`。`off` / `shadow` / `enforce`）。計画ゲートで、App が集めた材料（Issue のタイトルと本文、計画の `files` とその件数・種類、ガードレールに触れるか。計画の本文は渡さない）だけを Jev に問い、実装に勧めるモデル（`opus` / `sonnet`）と確率を `plan-gate` の記録の `modelRouting` に残す（ゲートの結果は変えない）。止まった計画（`agent:plan-review`）も記録する（人の決定、2026-10-01：shadow の材料を多くする）。`enforce` で勧めに従うのはゲートを通った計画だけで、`shadow`・`off`・記録なし・止まった計画は `fleet.implementModel`（今は `sonnet`）のまま。使ったモデルは PR 本文の `実装のモデル:` の行の申告で、`report.ts` の節「実装のモデルの勧めと結果」で人が見るだけ（ゲート・Merge の経路は読まない）。切り替えは人が決め、`harness.config.json` を PR で変える。目安（数えるのはゲートを通過した計画の `modelRouting` が `ok` で、受け付け記録のある Agent PR）：shadow → enforce は、(1) 使ったモデルが `sonnet` の PR が 20 件以上で、勧めが `opus` のものと `sonnet` のものがそれぞれ 5 件以上、かつ (2) 勧めが `opus` で `sonnet` を使った PR の1回で合格の割合が、勧めが `sonnet` で `sonnet` を使った PR より 20 ポイント以上低い、または修正の往復の平均が 0.5 以上多い（Jev が難しい作業を見分けている）。enforce → shadow に戻す目安は、enforce の後の勧め `opus`（opus で実装）の PR の1回で合格の割合が、shadow のときの勧め `opus` × 使った `sonnet` の割合を上回らないとき（人が戻すかを決める）。mutation の survived は PR 側のコードが決める情報なので表に出すだけで基準に使わない。止まった計画の PR も表に出すが基準には数えない（#139） | 有効 |
| Q78 | 人の PR の判定 | 計画のある Issue に紐付いた人の PR も Routine が判定し、判定が出るまで `agent/review` を通さない（自動 Merge はしない、修正は人）。例外は人が付ける `review:exempt` |
| Q77 | 計画の紐付け | すべての PR に計画のある Issue への `Closes` を必須チェック `agent/plan-link` で求める（人のセッションの PR も）。例外は人が付ける `plan:exempt`。Stacked PR の層は本文の `Refs #N`／`Closes #N`（1つだけ）で紐付ける |
| Q76 | 状態ラベルの整理 | `agent:working`・`agent:in-pr` を廃止し、着手宣言コメントと開いた PR から判断する。止めるときは理由コード必須。ラベル定義はコードで一元管理し、文書との一致をテストで検査、定義に無いラベルは `setup.ts` が消す |
| Q75 | 分類ラベル | PR の `size:*`・`area:*` は App が差分から付ける（area は足すだけ）。Issue の種類・領域・優先度・書き方は Jev が提案コメントだけ出す（シャドー） |
| Q74 | 優先度 | `priority:*` の5段階（highest・high・medium・low・lowest）のラベルで queue を並べ替える（優先度 → 先着順）。付いていなければ medium、複数付いていれば最も高いもの。フォームには入れない（Q84 で `priority:high` / `priority:low` の2つから5段階に改めた） |
| Q73 | 汎用化 | 固有名は `harness.config.json` と `setup.ts` の引数に寄せ、別のリポジトリに導入できるようにする |
