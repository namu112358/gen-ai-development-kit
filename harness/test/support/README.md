# harness/test/support/

テストが共有する補助。ファイル名を `*.test.ts` にしないので、それ自体はテストとして動かない。

| 名前 | 内容 |
| --- | --- |
| `dashboard-fixtures.ts` | ダッシュボードの読み直しのテスト用の見本（1つの見本を、REST の応答と、まとめた GraphQL の問い合わせの応答の両方で返す偽の GitHub）と、内側に流れた呼び出しの短い形 |
| `gate-fixtures.ts` | ゲートのテスト用の偽の GitHub（呼び出しを記録し、決めた応答を返す）と、ゲートの実行コンテキスト・PR・判定・イベントの見本 |
| `git-sandbox.ts` | worktree のテスト用の git の砂場（一時ディレクトリに bare の origin と、その clone（本体）を作る） |
| `output-file-rules.ts` | サブエージェントの定義に同じ言い回しで置く「渡された出力のパスに自分で書く」決まりの文（判定の担当と plan-critic のテストが共有する） |
| `stack-fixtures.ts` | Stacked PR・orphan-base のテスト用の見本（stack 付きの PR、orphan-base／base-resolved の App の記録、agent:blocked の events）と、`acceptanceFake` にルートを足した偽の GitHub |
