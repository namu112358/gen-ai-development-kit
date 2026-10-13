# review-api

PR レビューの試作の Worker（Cloudflare Workers・Workflows・KV）。設計と手順は [docs/review-api.md](../docs/review-api.md)。

## 構成

詳しい表は docs/review-api.md の節3。

- `src/`：Worker（`worker.ts`）・Workflow（`workflow.ts`）と、Node でも動く純粋なロジック
- `scripts/`：手元の確かめ用（`send-webhook.ts`）
- `review.config.json`：モデル・レビューの条件・上限・単価
- `wrangler.jsonc`：Worker・Workflow・KV の束ね方（値は KV の id だけ。秘密・識別子は Cloudflare の Secret に入れる）
- `.dev.vars.example`：`wrangler dev` 用の秘密と識別子の値の雛形（`.dev.vars` にコピーして使う。commit しない）

## コマンド

```bash
npm install
npm run check                 # 型検査（tsc --noEmit）
npm run dev                   # wrangler dev（http://localhost:8787）
node scripts/send-webhook.ts <action> <owner/repo> <PR 番号> <head>   # 別の端末で署名つきの Webhook を送る（--closes <Issue 番号> などは scripts/send-webhook.ts の先頭を参照）
```

Claude を呼ばずに流れだけ見るときは、`.dev.vars` に `DRY_RUN=1` を書く。

## デプロイ・Secret・Workers Builds

docs/review-api.md の節8（セットアップ）と節10（デプロイ）を見る。
