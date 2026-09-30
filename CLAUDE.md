# CLAUDE.md

GitHub Issues × Claude Code の自律開発ハーネス。概要は [README.md](README.md)。

ハーネスの規則（進め方・立場・やってはいけないこと）は次のファイルにある。

@harness/CLAUDE.harness.md

## 構成

| パス | 内容 |
| --- | --- |
| `harness/lib/` | ロジック（Issue Form、計画・判定の書式、範囲照合、merge-route、patch-id、queue、Jev） |
| `harness/gates/` | Actions で App として動くゲート（`gate.yml` → `node harness/gates/run.ts`） |
| `harness/scripts/agent.ts` | 書式検査と本文生成（`render-*`、API を呼ばない）と、付き添いのセッション用の操作（`gh` を使う） |
| `harness/scripts/setup.ts` | 導入先の設定（ラベル・Ruleset・Environment・App） |
| `harness/test/` | `node:test` のテスト |
| `harness/CLAUDE.harness.md` | ハーネスの規則（進め方・立場・やってはいけないこと）。この CLAUDE.md が読み込む。導入先にも配る |
| `harness/managed.json` | 導入先に配るファイルの一覧（kit が持つもの・初回だけ雛形から作るもの・`.claude/settings.json` のうちハーネスが持つキー） |
| `harness/templates/` | 導入先の設定の雛形（`harness.config.json`・`CLAUDE.template.md`・deny の一覧） |
| `.claude/skills/` | 付き添いのセッションの手順（ship / fleet / plan / implement / judge / fix / sync / arch-review / qa-retro / gh-stack） |
| `.claude/agents/` | reviewer / risk-agent / test-designer / arch-reviewer |
| `overview.html` | 全体の図解（流れ・役割・ディレクトリの地図・ラベル）。外部を読み込まない1ファイル |

## コードの書き方

- TypeScript をビルドせずに Node 24 で実行する。型注釈を剥がすだけで消えない構文（`enum` など）は使わない。
- 相対 import は拡張子 `.ts` まで書く。実行時の依存パッケージは追加しない。
- ゲートは PR の head を checkout・実行しない。イベントの中身は `GITHUB_EVENT_PATH` から読む。
- 新しいテストは既存ファイルの末尾に足さず、機能・ハンドラーごとのファイルに書く。共有の補助は `harness/test/support/` に置く（`*.test.ts` にしない）。
- README のあるディレクトリの直下にファイルを足したら、ファイルの先頭にコメントを書き、`node harness/scripts/readme.ts write` で表を作り直す（`harness/test` は手で1行足す。`.github/` は root の README.md の節）。ラベル・役割・流れを変えたら `overview.html` も直す。
- `npm run check`（型検査＋テスト）を通す。
