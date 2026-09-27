# harness/test/support/

テストが共有する補助。ファイル名を `*.test.ts` にしないので、それ自体はテストとして動かない。

| 名前 | 内容 |
| --- | --- |
| `gate-fixtures.ts` | ゲートのテスト用の偽の GitHub（呼び出しを記録し、決めた応答を返す）と、ゲートの実行コンテキスト・PR・判定・イベントの見本 |
| `stack-fixtures.ts` | Stacked PR・orphan-base のテスト用の見本（stack 付きの PR、orphan-base／base-resolved の App の記録、agent:blocked の events）と、`acceptanceFake` にルートを足した偽の GitHub |
