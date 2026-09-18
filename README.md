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

Docker (Postgres + Redis):

```bash
cp .env.sample .env         # then fill APP_ENCRYPTION_KEY and SESSION_SECRET
docker compose up --build
```

- App: http://localhost:8080

Generate the two required secrets:

```bash
openssl rand -base64 32     # APP_ENCRYPTION_KEY
openssl rand -base64 48     # SESSION_SECRET
```

### For a private instance (no mail provider)

Email is optional. With `RESEND_API_KEY` unset, Watchbridge logs every message instead of
sending it and runs normally — you just won't receive the links. For a single-user instance:

1. Set `APP_URL` to the address you actually reach. It is baked into the verification and
   password-reset links and the OAuth redirect URLs, so leaving it at `http://localhost:8080`
   on a remote box breaks both.
2. `docker compose up --build`, then register your account.
3. **Signing in requires a verified email**, so open the verification link from the logs once:

   ```bash
   docker compose logs app | grep 'Verification email'
   ```

   The log line carries the full `…/api/auth/verify?token=…` URL; open it to activate the
   account. If you lose it, the login page's "resend" logs a fresh one.
4. Set `REGISTRATION_ENABLED=false` and restart, so nobody else can sign up.

Password resets and sync-failure alerts are emailed, so without a key they only land in the logs:
change a password while signed in, and read sync problems from the syncs page rather than an
inbox. To get real mail, set `RESEND_API_KEY` and a `MAIL_FROM` on a domain you've verified with
Resend (an unverified domain fails silently).

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
| `APP_URL`              | Public origin you reach — used for OAuth redirects and email links                  |
| `DATABASE_URL`         | `pglite://…` (embedded) or `postgres://…`                                           |
| `TRUSTED_PROXIES`      | `cloudflare`, `loopback`, `private`, or explicit CIDRs — controls real-IP detection |
| `REGISTRATION_ENABLED` | Toggle public sign-ups; turn off once your own account exists                       |
| `RESEND_API_KEY` / `MAIL_FROM` | Optional mail (verification, password resets, alerts) via Resend              |
| `TRAKT_*` / `SIMKL_*`  | Operator-registered OAuth app credentials; `SIMKL_AUTH_VERSION` + `SIMKL_V2_*` switch new Simkl connections to AUTH V2 |

Behind Cloudflare, set `TRUSTED_PROXIES=cloudflare` so per-IP rate limits use the real visitor IP
from `CF-Connecting-IP`, not the Cloudflare edge.

## Layout

- `packages/core` — config, crypto, real-IP resolution, and (soon) the sync engine and providers
- `packages/server` — Fastify API, auth, email, scheduling
- `packages/web` — React SPA served by the server in production

## Images

Published to `ghcr.io/ibbylabs/watchbridge` as native `linux/amd64` and `linux/arm64` (no
emulation).

## Privacy

Data handling for the hosted instance is described in [PRIVACY.md](PRIVACY.md).

## License

[GNU AGPL-3.0](LICENSE). If you run a modified version as a network service, you
must offer its source to your users.
