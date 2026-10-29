# poidh

A lean frontend for [poidh](https://poidh.xyz) (pics or it didn't happen), live at https://poidh.borodutch.com. It uses the same contracts and the same bounties, and reads its data from poidh.xyz's API.

- No build step and no npm dependencies: plain ES modules in `public/` and one Bun server, `server.ts`.
- `server.ts` serves the static files (brotli/gzip compressed once at startup) and proxies `/api/*` to poidh.xyz, which sends no CORS headers. Public queries are cached for 15 s and served stale while they refresh. Bounty pages get per-bounty OG and Farcaster embed tags for link previews.
- `/resolve` turns a claim's URI (metadata JSON, an image or a video) into its media. Results are kept in `DATA_DIR/media.jsonl`.
- `/thumb` makes small webp thumbnails with libvips and caches them in `DATA_DIR/thumbs`.
- `/upload` stores claim photos and videos by content hash in `DATA_DIR/uploads`; they are served from `/u/<sha256>.<ext>`.
- Wallets are found through EIP-6963. Inside a Farcaster client the app is a mini app (`public/miniapp.js`, which talks the host protocol without the SDK) and uses the client's wallet. The manifest is at `/.well-known/farcaster.json`.

Run locally:

```sh
bun server.ts   # http://localhost:3000
```

Environment variables:

- `PORT` (default 3000)
- `DATA_DIR` (default `./data`)
- `PUBLIC_URL`: the public origin when the app runs behind a TLS proxy
- `UPSTREAM` (default https://poidh.xyz)
- `FARCASTER_ACCOUNT_ASSOCIATION`: the signed `{header, payload, signature}` JSON for the mini app manifest

MIT, like the original [poidh-app](https://github.com/picsoritdidnthappen/poidh-app).
