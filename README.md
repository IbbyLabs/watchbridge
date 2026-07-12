# Watchbridge

Sync watch history and playback progress between [Trakt](https://trakt.tv),
[Simkl](https://simkl.com), [PublicMetaDB](https://publicmetadb.com) and
[MDBList](https://mdblist.com) — on a schedule or on demand. Connect your accounts, pick what to
sync and in which direction, and Watchbridge keeps them in step.

Built to be correct first: it matches titles by ID (never by name), never re-adds a play it has
already synced, and never marks something watched unless the source actually says so.

> Status: early. History + progress are the first data types; ratings, watchlist and lists follow
> on the same engine.

## Run it

Docker (Postgres + Redis + local mail capture):

```bash
cp .env.sample .env         # then fill APP_ENCRYPTION_KEY and SESSION_SECRET
docker compose up --build
```

- App: http://localhost:8080
- Captured emails (dev): http://localhost:8025

Generate the two required secrets:

```bash
openssl rand -base64 32     # APP_ENCRYPTION_KEY
openssl rand -base64 48     # SESSION_SECRET
```

## Develop

Node ≥22 and pnpm ≥11.

```bash
pnpm install
pnpm dev        # server (8080) + web (5173) in watch mode
pnpm test       # unit + integration
pnpm build      # build all packages
```

By default the server uses embedded PGlite under `./data` — no external database needed. Set
`DATABASE_URL=postgres://…` to use a real Postgres.

## Configuration

All configuration is via environment variables — see [`.env.sample`](.env.sample) for the full
list. Notable ones:

| Variable               | Purpose                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `APP_ENCRYPTION_KEY`   | 32-byte key that encrypts stored provider tokens (AES-256-GCM)                      |
| `SESSION_SECRET`       | Session/cookie secret                                                               |
| `DATABASE_URL`         | `pglite://…` (embedded) or `postgres://…`                                           |
| `TRUSTED_PROXIES`      | `cloudflare`, `loopback`, `private`, or explicit CIDRs — controls real-IP detection |
| `REGISTRATION_ENABLED` | Toggle public sign-ups                                                              |
| `SMTP_*` / `MAIL_FROM` | Outgoing mail for email verification                                                |
| `TRAKT_*` / `SIMKL_*`  | Operator-registered OAuth app credentials                                           |

Behind Cloudflare, set `TRUSTED_PROXIES=cloudflare` so per-IP rate limits use the real visitor IP
from `CF-Connecting-IP`, not the Cloudflare edge.

## Layout

- `packages/core` — config, crypto, real-IP resolution, and (soon) the sync engine and providers
- `packages/server` — Fastify API, auth, email, scheduling
- `packages/web` — React SPA served by the server in production

## Images

Published to `ghcr.io/ibbylabs/watchbridge` as native `linux/amd64` and `linux/arm64` (no
emulation).
