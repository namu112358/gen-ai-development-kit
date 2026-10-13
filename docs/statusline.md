# ステータスライン

Claude Code のステータスラインに、位置・モデル・文脈と、Orca につないだアカウントごとの使用量を出すプロンプト。

新しいセッションに、下の「プロンプト」の枠の中をそのまま貼る。`/statusline` の自動の変換は PS1 を写すだけで使用量が出ないので、このプロンプトを使う。作るのは各自の `~/.claude/` の下のファイルで、リポジトリのファイルは変えない。

## プロンプト

````text
Claude Code のステータスラインを作ってください。`~/.claude/settings.json` は `statusLine` のキーだけを変え、ほかのキーは触らないでください。

## 表示
1行目: `user@host:cwd (branch)`。PS1 と同じ色にする。cwd は `workspace.current_dir`（HOME は `~` に縮める）。git のブランチが無ければ `(branch)` は出さない。
2行目: モデル名と文脈の使用率。例 `Opus 5.5 | ctx 7%`。
3行目から: Orca につないだアカウントごとに1行。
- 組織名（メールアドレスの入った組織名は「個人」と出す）。使用中のアカウントの行頭に `▶`、それ以外は空白2つ。
- 5h と 7d の使用率とリセットの時刻（5h は `→HH:MM`、7d は `→M/D HH:MM`）。リセット済みの枠は「リセット済」と出す。
- 末尾に、Orca が値を取った時刻 `updated HH:MM`。
- 使用率は 50% 未満が緑、80% 未満が黄、それ以上が赤。3桁で右揃えにする。
- 列は全角を2桁と数えて揃える。値の無い欄は空白で埋めて、後ろの列がずれないようにする。

## データの取り元
- statusLine の stdin の JSON: `workspace.current_dir`、`model.display_name`、`context_window.used_percentage`、`rate_limits.five_hour` と `rate_limits.seven_day` の `used_percentage`・`resets_at`（秒）。
- Orca の CLI の `account list --json`:
  - `result.claude.accounts[]` の `id`・`organizationName`
  - `result.claude.activeAccountId`
  - `result.rateLimits.claude`（使用中のアカウント）と `result.rateLimits.inactiveClaudeAccounts[]`（`accountId` と `rateLimits`）の `status`、`session`（5h）と `weekly`（7d）の `usedPercent`・`resetsAt`（ミリ秒）、`updatedAt`

## Orca を待たない作り
- Orca の一覧は、組織名と使用量だけを控えのファイル `~/.cache/claude-statusline/orca-accounts.json` に書く。
- 控えが1分より古ければ、裏で取り直す。取りに行く前に控えの時刻を更新して、同時に何度も取らない。書くときは一時ファイルに書いてから置き換える。
- 表示は控えだけを読む。Orca の CLI を表示の流れの中で呼ばない。
- Orca の statusline の hook（`~/.orca/agent-hooks/claude-statusline.sh`、Windows は `claude-statusline.cmd`）があり、`CLAUDE_CONFIG_DIR` が付いていないセッションなら、同じ stdin を裏で渡す。出力は待たない。`CLAUDE_CONFIG_DIR` が付いたセッションは渡さない（Orca はそれを今の使用中のアカウントの値として控え、別のアカウントの値になるため）。

## 使用量の控え
アカウントの振り分け（`harness/scripts/accounts/pick.ts`）が読む控え `~/.config/agent-harness/usage/<組織の ID>.json` を書く。組織の ID は、そのセッションの設定ディレクトリの `.claude.json` の `oauthAccount.organizationUuid`。
- 書くのは `CLAUDE_CONFIG_DIR` が付いたセッションだけ。`~/.claude` で動くセッションは書かない（Orca がアカウントを切り替えると `.claude.json` の組織が変わり、前のアカウントで動き続けるセッションの値が別の組織の控えに入るため）。
- 書く項目は `at`（ミリ秒）・`source`（`"statusline"`）・`configDir`（`CLAUDE_CONFIG_DIR` を `pwd -P` で実パスにしたもの）・`session`（5h の `usedPercent`・`resetsAt`（ミリ秒））・`weekly`（7d の同じ項目）。`configDir` が無い・対応表と違う控えは振り分けに使われない。
- そのセッションの値が前回から変わったときだけ書く。
- 同じ枠（`session.resetsAt` の差が 120 秒以内）の中では高い方を残す。古い枠の値で新しい枠の控えを上書きしない。
- 書くときは一時ファイルに書いてから置き換える。
- stdin から読んだ項目を区切るときは、空白（タブを含む）を区切りに使わない（`\037` など）。タブは空の項目をまとめてしまい、文脈の使用率などが空のときに後ろの値がずれて控えに書かれる。

## Orca が無いとき
Orca の CLI が無い、または控えがまだ無いときは、stdin の `rate_limits` だけで、ログイン中のアカウント（`~/.claude.json` の `oauthAccount.emailAddress`。「個人」の判定にだけ使う）の使用量を1行で出す。

## 環境ごとの違い
- WSL・Linux: sh と jq。`~/.claude/statusline-command.sh` を作り、`statusLine.command` は `sh "$HOME/.claude/statusline-command.sh"`。Orca の CLI は、環境変数 `ORCA_CLI_COMMAND` があればその名前、無ければ `orca-ide`（素の `orca` は GNOME の読み上げソフトと同じ名前なので使わない）。
- Windows: node。`statusline-command.mjs` を作り、`statusLine.command` は `node` で呼ぶ。Orca の CLI は `orca.exe`。応答に数秒かかるので、必ず裏で取る。

## 守ること
- 控えには組織名と使用量だけを書く。トークンやメールアドレスは書かない。
- `settings.json` は `statusLine` のキーだけを変える。
- 作った後に、手元で stdin の例の JSON を渡して、出力と列の揃いを確かめる。Orca がある環境では、控えを消した場合と、控えがある場合の両方を確かめる。
````

## 表示の例

組織名とホスト名は架空のもの。

```text
user@host:~/orca/gen-ai-development-kit (main)
Opus 5.5 | ctx 7%
  個人         5h   0% →06:49  7d   7% →10/18 20:59  updated 02:15
  Org-A        5h   0%          7d  31% →10/18 08:00  updated 02:15
▶ Org-B        5h   3% →06:50                         updated 02:23
```

使用中の行頭に `▶` が付く。値の無い欄（Org-B の 7d）は空白で埋める。
