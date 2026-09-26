# private リポジトリへの移行（Phase 5）

個人のパブリックリポジトリ `namu112358/gen-ai-development-kit` から、GitHub Team 組織の private リポジトリ（以下 `<org>/<repo>`）へハーネスを移す手順。
GitHub の設定は**人が手元の端末で**、組織オーナー（またはリポジトリ管理者）の `gh` 認証で行う。`gh secret`・`gh variable`・Ruleset の変更は `.claude/settings.json` の deny に当たるため、Claude のセッションからは実行しない。

## 1. 移行前に決めること

決まるまで手順（[8章](#8-手順)）の 5 以降に進まない。結論は移行用の Issue に記録する。

| # | 決めること | 判断者 | 不可・未定のとき |
| --- | --- | --- | --- |
| D1 | 社内のコード（diff）を外部 API の Jev（TypeSafe AI）に送ってよいか。送る場合の経路（直接／AI Gateway 経由） | 情報セキュリティ担当（必要なら法務） | `JEV_API_KEY` を置かず、`harness.config.json` の `jev.mode` を `off` にする。Jev への切り替えは行わない（Risk 判定は Claude のまま） |
| D2 | Claude Team の規約上、Routine の毎時実行を含む自律実行が「通常利用」に収まるか（[plan.md](plan.md) 規約・費用の確認事項） | Claude Team の契約管理者。不明なら Anthropic に問い合わせ | 移行しない（または Routine を作らず人のセッションだけで運用） |
| D3 | 社内ルール：社内のコードを Claude（Anthropic のクラウド）に扱わせること、社員の GitHub アカウント名義で Agent が書き込むこと、会社のシートで使うこと | 情報システム部門・所属長 | 移行しない |
| D4 | 費用：Jev の従量課金、Actions の無料枠超過分（[5章](#5-github-側の設定)） | 予算の承認者 | Jev は D1 と同じ扱い。Actions は使用上限 0 円で運用 |
| D5 | 移行方式：リポジトリの Transfer か新規作成か（[2章](#2-移行方式の比較)） | ハーネス管理者＋組織オーナー | — |
| D6 | App：既存 App の組織への移管か、組織で新規作成か（[3章](#3-github-app)） | 組織オーナー | — |
| D7 | ラベルを Issue Fields に置き換えるか（[plan.md](plan.md) Issue 契約） | ハーネス管理者 | 置き換えない（推奨。[5章](#5-github-側の設定)） |

## 2. 移行方式の比較

| 観点 | A. Transfer（組織へ移管 → private 化） | B. 新規作成（空の private リポジトリに main を push） |
| --- | --- | --- |
| Issue・PR・コメント | 番号ごと引き継がれる | 引き継げない。Issue の転送は同じ持ち主のリポジトリ間だけなので、個人 → 組織では手で作り直す |
| Jev 評価の履歴（`report.ts`） | App の slug が変わらなければ、受け付けコメントをそのまま数えられる | 受け付けコメントは旧リポジトリに残る。旧リポジトリで集計して保存し、新リポジトリの集計と手で合算する |
| 旧 URL | 新しい場所へリダイレクトされる（旧名で新しいリポジトリを作ると切れる） | 旧リポジトリはそのまま残る（アーカイブする） |
| ラベル・Environment・Secret・Ruleset | 引き継がれる想定。移行後に確認し、`setup.ts` で掛け直す | すべて設定し直す |
| App のインストール | 組織に入れ直す | 組織に入れる |
| パブリック期間の内容 | 過去に公開されていた事実は消えない（clone・fork 済みのもの）。ハーネスのコードだけなので実害は小さい | 旧リポジトリは公開のまま（アーカイブ）。社内のコードは新リポジトリにだけ入る |
| 戻しやすさ | 組織から個人へ Transfer し直せるが、社内のコードが入った後は公開リポジトリに戻せない | 旧リポジトリをアーカイブ解除して Routine を戻せばよい |
| 作業量 | 少ない | 多い（Issue の作り直し、集計の合算） |

推奨は **A（Transfer）＋既存 App の移管**。履歴・受け付け記録・ダッシュボードが1か所に残り、`appSlug` も Ruleset の `integration_id` も変わらない。

## 3. GitHub App

| 観点 | 既存 App を組織へ移管 | 組織で新規作成 |
| --- | --- | --- |
| 操作 | App の設定 → Advanced → Transfer ownership | 組織の Settings → Developer settings → GitHub Apps で作る |
| App ID・slug | 変わらない（名前を変えると slug が変わるので変えない） | 変わる。`harness.config.json` の `appSlug`、リポジトリ変数 `AGENT_APP_SLUG`、Ruleset の `integration_id` を掛け直す |
| 過去の App の記録 | 認識される（計画の写し、受け付け記録、ダッシュボード） | 認識されない。ダッシュボードは新しい App が停止ラベル付きで作り直す。仕掛かりの計画ゲート・受け付けは無効になる |
| 鍵 | そのまま使える | `AGENT_APP_PRIVATE_KEY` を作り直す |

どちらでも次は変えない。

- 権限は [github-app-setup.md](github-app-setup.md) の表のまま（Checks・Contents・Issues・Pull requests が write、Metadata が read、**Workflows なし**、Webhook なし）。
- インストールは Only select repositories で `<org>/<repo>` **だけ**。
- private の App のまま（組織の外にインストールさせない）。

`setup.ts app-manifest` は個人の App 作成画面（`/settings/apps/new`）に送るため、組織で新規作成するときは使わない。上の権限で手で作り、[github-app-setup.md](github-app-setup.md) の「手動で作る場合」の手順で鍵と Client ID を保存する。

## 4. 受け入れているリスクの変化

| リスク | 移行後 |
| --- | --- |
| Q58 パブリック期間のコメント | **なくなる**。コメントできるのはリポジトリにアクセスできる人だけになる |
| Q60 コメントの作成者チェック | **残す**（`author_association` が OWNER / MEMBER / COLLABORATOR）。組織では MEMBER が組織メンバー全員を指すため、Read 権限を持つメンバーは計画・判定コメントを置ける。リポジトリの権限は信頼できる人に絞る（組織の Base permissions は No permission） |
| fork からの PR | 組織とリポジトリの設定で private の fork を禁止できる。ただし PR の head を checkout しない・実行しない前提は緩めない |
| Q44・Q47・Q50・Q51・Q57・Q59 | 変わらない |
| [security.md](security.md) の残りのリスク | 変わらない |
| 外部送信（新規） | D1 で許可した場合、diff が Jev に送られる。`jev.maxDiffChars` を超える diff は送らない |

## 5. GitHub 側の設定

| 対象 | 設定 | 備考 |
| --- | --- | --- |
| 組織：Member privileges | Base permissions を No permission、private リポジトリの fork を禁止 | Q60 の MEMBER を実質的にリポジトリの権限者に絞る |
| 組織：Actions | 使う action（`actions/checkout`・`actions/setup-node`・`actions/create-github-app-token`、SHA 固定）を許可。Workflow permissions は read、Actions による PR の承認は不可 | 組織の設定がリポジトリの設定より優先される |
| 組織：課金 | Actions の使用上限（予算）を設定し、通知を受ける | 見積もりは [phase0.md](phase0.md) #14：1 Issue 約 11 分＋停滞検知 月 240 分。月 100 Issue で約 1,350 分（Team の無料枠 月 3,000 分）。`ci.yml` は人の PR でも動く |
| リポジトリ | private、fork 禁止 | Transfer の場合は移管後に private に変える |
| App | [3章](#3-github-app) | — |
| Environment `gate` | main からの実行だけに限定（`setup.ts environment`） | private での Environment は Team プランで使える |
| Environment `gate` の Secret | `AGENT_APP_PRIVATE_KEY`、`JEV_API_KEY`（D1 で許可した場合だけ） | D1 が不可なら `JEV_API_KEY` を削除し、`jev.mode` を `off` にする |
| Environment `gate` の変数 | `AGENT_APP_CLIENT_ID` | — |
| リポジトリ変数 | `AGENT_APP_SLUG`（`setup.ts environment` が `harness.config.json` の `appSlug` から設定） | `gate.yml` の `if:` が App 自身の操作を除くのに使う |
| ラベル・マージ方式・Ruleset | `node harness/scripts/setup.ts all <org>/<repo> <App ID>` | Ruleset の `agent/review`・`merge-route` の `integration_id` がその App ID になる |
| `gate.yml` の権限 | `permissions: contents: read`（設定済み） | private では checkout に必要。変えない |
| Issue Fields（D7） | 移行時はラベルのまま | 状態は `harness/lib/state.ts`・`gate.yml` の `if:`・Timeline での「App が付けた」確認がラベル前提。Fields は App の操作と区別して読めるかを確かめてから、別の Issue で検討する |
| 参照の書き換え | `.github/CODEOWNERS`、`docs/github-app-setup.md`・`docs/routine-setup.md` の `namu112358/...` | 移行後に人の PR で直す（手順 10） |

## 6. Claude 側の設定

| 対象 | 設定 |
| --- | --- |
| Claude Team の管理者設定 | Routines と Claude Code on the web を有効にする（[phase0.md](phase0.md) #1） |
| Claude の GitHub App | 組織にインストールし、対象は `<org>/<repo>` だけ（組織オーナーの承認が必要） |
| Routine | 旧 Routine を無効化してから削除し、新しく作る。Repositories は `<org>/<repo>` の**1つだけ**。その他は [routine-setup.md](routine-setup.md) と同じ（毎時、Network は Trusted、Connectors は GitHub だけ、同じ Prompt と Setup script） |
| `.claude/settings.json` | deny はそのまま（リポジトリと一緒に移る）。新しい Routine で `gh pr merge` が止まることを確かめる（[phase0.md](phase0.md) #9） |
| 人の手元 | `git remote set-url origin` で新しい URL に向ける |

## 7. 引き継ぐデータ

| データ | A. Transfer | B. 新規作成 |
| --- | --- | --- |
| 開いている Issue | そのまま | 手で作り直す（Issue Form の本文をコピー）。旧 Issue は移行先へのリンクを書いて Close |
| 開いている Agent PR | 移行前に Merge か Close して 0 件にする | 同左（PR は移せない） |
| 仕掛かりの Issue（`agent:working`・計画ゲート通過後） | 移行前に終わらせるか、`agent:hold` を付けておく | 新しい Issue で最初からやり直す |
| ダッシュボード Issue | App を移管すればそのまま。新規 App なら旧ダッシュボードを Close（新しい App が停止ラベル付きで作る） | 新しい App が停止ラベル付きで作る |
| Jev 評価の履歴 | そのまま `report.ts <org>/<repo>` で数えられる（App の slug が同じ場合） | 移行前に `node harness/scripts/report.ts namu112358/gen-ai-development-kit 365` を実行し、結果を新リポジトリの移行 Issue に貼る。切り替え条件（否定側 20 件など）は両方を合算して判断する |
| `claude/` ブランチ | そのまま（不要なものは削除） | 持っていかない |

## 8. 手順

A（Transfer＋App 移管）を基本とし、B・新規 App で違う点は括弧内に書く。各手順の確認が取れてから次へ進む。

| # | 手順 | 確認 |
| --- | --- | --- |
| 1 | 移行用の Issue を作り、D1〜D7 の結論と判断者を記録する | すべて埋まっている |
| 2 | 旧 Routine を無効化する。ダッシュボードに `agent:auto-merge-stopped` を付ける | Routine が無効。App がダッシュボードに停止を記録。auto-merge が付いた PR が 0 件 |
| 3 | 開いている Agent PR を Merge か Close する。仕掛かりの Issue には `agent:hold` | `gh pr list --search "head:claude/"` が 0 件。`agent:working` の Issue が 0 件 |
| 4 | `report.ts` で集計を取り、移行 Issue に貼る | 件数が直近の運用と合っている |
| 5 | 組織の設定（[5章](#5-github-側の設定) の組織の行）と、Claude Team の管理者設定・Claude の GitHub App のインストール承認 | 各設定画面で確認。Base permissions が No permission |
| 6 | リポジトリを組織へ Transfer し、private・fork 禁止にする（B：空の private リポジトリを作り、main だけを push。旧リポジトリはまだ残す） | 旧 URL がリダイレクトされる。Issue・PR の件数が一致する。Visibility が Private（B：main の先頭コミットが一致） |
| 7 | App を組織へ移管し、`<org>/<repo>` だけにインストールする（新規 App：[3章](#3-github-app) の権限で作ってインストール） | 組織の Installed GitHub Apps で Repository access が1件だけ。権限に Workflows がない |
| 8 | Environment `gate` の Secret・変数を確認し、なければ入れ直す。D1 が不可なら `JEV_API_KEY` を削除（新規 App：鍵と Client ID を保存し、手元の `harness.config.json` の `appSlug` を書き換える） | `gh secret list --env gate --repo <org>/<repo>` と `gh variable list --env gate --repo <org>/<repo>` |
| 9 | `node harness/scripts/setup.ts all <org>/<repo> <App ID>` | `gh api repos/<org>/<repo>/rulesets` の `agent-harness-main` で、`agent/review`・`merge-route` の `integration_id` が App ID、bypass が空。`gh variable list --repo <org>/<repo>` の `AGENT_APP_SLUG` が `appSlug` と一致 |
| 10 | 参照の書き換え（CODEOWNERS・docs。新規 App なら `harness.config.json` も）を人の PR にして Merge する。これがゲートの疎通確認を兼ねる | PR で `ci` が成功し、`agent/review`・`merge-route` が App 名義で付く。Merge 後の main の push で gate が成功 |
| 11 | `workflow_dispatch` で gate を動かす | ダッシュボードが（新規 App なら新しく停止ラベル付きで）ある。Actions のログに Secret が出ていない |
| 12 | 新しい Routine を作り、Run now で1回動かす。旧 Routine を削除する | セッションで `gh` によるラベル・コメント・Draft PR が動く。`gh pr merge` が deny で止まる（[phase0.md](phase0.md) #4・#9） |
| 13 | docs だけの小さな Issue に `agent:ready` を付け、Human Merge まで通す（停止ラベルは付けたまま） | [phase0.md](phase0.md) の通し確認の各段階が同じ結果になる。D1 が可なら受け付けコメントに Jev のシャドー記録がある |
| 14 | 仕掛かりの Issue の `agent:hold` を外す（B：Issue を作り直す） | 次の Routine が拾う |
| 15 | [runbook.md](runbook.md) の手順でダッシュボードの停止ラベルを外し、自動 Merge を再開する | App が再開を記録。low の PR が自動 Merge される |
| 16 | 1週間後に Actions の使用量を確認する（B：旧リポジトリをアーカイブ） | 組織の Billing で見積もり（1 Issue 約 11 分）から外れていない |

## 戻し方

| 時点 | 戻し方 |
| --- | --- |
| 手順 5 まで | 何も移っていない。ダッシュボードの停止ラベルを外し、旧 Routine を有効化する |
| 手順 6 以降・社内のコードを入れる前 | A：組織から個人へ Transfer し直して public に戻し、App も移管し直す。`setup.ts all` を掛け直して Routine を作り直す。B：新リポジトリは停止したまま、旧リポジトリで再開する |
| 社内のコードを入れた後 | 公開リポジトリには戻さない。[runbook.md](runbook.md) の「暴走時の手順」で止め、private のまま人の運用（Routine なし、Human Merge）に落とす |

どの時点でも、まず Routine の無効化とダッシュボードの停止ラベルで止めてから判断する。
