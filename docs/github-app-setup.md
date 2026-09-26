# GitHub App と リポジトリ設定の手順

信頼できる印（段階ゲート、判定の確定、merge-route、auto-merge）を付けるための専用 GitHub App を作り、リポジトリを設定する。
**人が手元で**、リポジトリ管理者の `gh` 認証で行う。

## 1. App を作る（マニフェストフロー）

```bash
node harness/scripts/setup.ts app-manifest namu112358/gen-ai-development-kit namu112358-agent-gate
```

1. 出力された `app-manifest.html` をブラウザで開き、「GitHub App を作成」を押す。
2. GitHub の確認画面で作成する。
3. リダイレクト先 URL の `?code=...` の値をコピーする（このページに戻ってくる。1時間以内に次へ）。
4. code を App に確定し、鍵を Environment Secret に保存する（鍵は画面に表示されない）：

```bash
node harness/scripts/setup.ts environment namu112358/gen-ai-development-kit
node harness/scripts/setup.ts app-convert namu112358/gen-ai-development-kit <code>
```

`app-convert` は次を行う：

- `AGENT_APP_PRIVATE_KEY` を Environment `gate` の Secret に保存
- `AGENT_APP_CLIENT_ID` を Environment `gate` の変数に保存
- `harness.config.json` の `appSlug` を App の slug に書き換え（コミットが必要）

5. 出力された URL から、App を**このリポジトリだけ**にインストールする。

### App の権限

| 権限 | レベル | 用途 |
| --- | --- | --- |
| Checks | write | `agent/review`・`agent/risk`・`agent/scope`・`merge-route` |
| Contents | write | auto-merge による Merge、update-branch |
| Issues | write | ラベル（`agent:plan-ok` など）、コメント、親 Issue の Close、ダッシュボード |
| Pull requests | write | Ready 化・Draft 化、auto-merge、変更要求レビュー |
| Metadata | read | 必須 |
| Workflows | **なし** | `.github/workflows/**` を変える PR は App では Merge できない（GitHub が拒否） |

Webhook は使わない（ゲートは Actions から App のトークンで動く）。

手動で作る場合は、上の権限で App を作り、Private key を生成して次で保存する：

```bash
gh secret set AGENT_APP_PRIVATE_KEY --env gate --repo namu112358/gen-ai-development-kit < private-key.pem
gh variable set AGENT_APP_CLIENT_ID --env gate --repo namu112358/gen-ai-development-kit --body <Client ID>
```

## 2. Jev の鍵

```bash
gh secret set JEV_API_KEY --env gate --repo namu112358/gen-ai-development-kit
```

（プロンプトに貼り付ける。未設定なら Jev のシャドー判定は `skipped` になる）

## 3. ラベル・リポジトリ設定・Ruleset

```bash
node harness/scripts/setup.ts all namu112358/gen-ai-development-kit <App ID>
```

| 対象 | 設定 |
| --- | --- |
| ラベル | `agent:*`、`risk:*`、`agent:auto-merge-stopped` |
| マージ方式 | squash のみ、auto-merge 許可、Merge 後にブランチ削除、Update branch ボタン |
| Actions | `GITHUB_TOKEN` の既定権限は read、PR の承認不可 |
| Environment `gate` | 既定ブランチ（main）からの実行だけが Secret を読める |
| Ruleset `agent-harness-main` | main の削除・force push 禁止、PR 必須（承認 0）、必須チェック `ci`（GitHub Actions）・`agent/review`（App）・`merge-route`（App）、main への追従必須、**bypass なし** |

必須チェックの出どころ（`integration_id`）を App に固定しているため、ユーザー名義や `github-actions[bot]` が同名のチェックを書いても通らない。

## 4. 自動 Merge を有効にする（Phase 4）

ゲートが最初に動くと、App が「Agent ダッシュボード」Issue を**停止ラベル付き**で作る（自動 Merge モード停止）。
止める仕組みの動作確認が終わったら、ダッシュボードの `agent:auto-merge-stopped` ラベルを外すと有効になる（[runbook.md](runbook.md)）。
