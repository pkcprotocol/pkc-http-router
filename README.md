# pkc-http-router

An IPFS [delegated routing v1](https://specs.ipfs.tech/routing/http-routing-v1/) HTTP server. It acts like a torrent tracker for IPFS: IPFS/kubo nodes announce that they provide a CID, and other nodes query it to find peers that have that CID. This lets nodes discover each other without relying on the IPFS DHT.

#### how it works

The server exposes the `/routing/v1/providers/` HTTP API and keeps a SQLite store of which peers provide which CIDs.

- **`PUT /routing/v1/providers/`** — a peer announces that it provides one or more CIDs (`routes/providers.ts`). The server validates and cleans the peer's announced multiaddrs against the request IP (`cleanAddrs` in `lib/utils.ts`, which fixes kubo's `0.0.0.0` self-reporting and drops mismatched ip4/ip6 addrs), then stores the providers keyed by CID (`lib/database.ts`). CIDs are normalized to a single version/codec/encoding (`normalizeCid`) so the same content always maps to one key.
- **`GET /routing/v1/providers/:cid`** — returns up to 100 providers for a CID, randomized like a BitTorrent tracker response so peers spread their connections. Returns `404` with a short `max-age` when there are no providers, and sets `Cache-Control`/`Last-Modified` headers (with `stale-if-error` so cached results survive a 24h outage).

Storage details (`lib/database.ts`):
- Providers are stored in SQLite via the built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) module (no native dependencies). Values are JSON serialized and keyed by normalized CID in `data/database.sqlite` (created on first write).
- Each provider entry has a `lastModified` timestamp and expires after 24h (`ttl`). Expired entries are pruned lazily on read and write, so the DB is self-cleaning.
- Writes to the same CID are serialized with a per-CID pending lock to avoid losing concurrent announces.

Other endpoints:
- **`GET /`** — health/welcome message (`routes/index.ts`).
- **`GET /metrics/prometheus`** (and the same path under `/routing/v1/providers/`) — Prometheus metrics (`routes/prometheus.ts`, `lib/prometheus.ts`).

The app is a standard Express app written in TypeScript: `bin/www.ts` starts the HTTP server (`PORT` env var, default `3000`), and `app.ts` wires up the middleware and routes. It runs behind a proxy (`trust proxy` is enabled), so the client IP comes from `x-forwarded-for`.

#### configuration

All configuration is via environment variables and one CLI flag. There is no config file.

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port the server listens on (`bin/www.ts`). |
| `DEBUG` | _unset_ | Debug namespace filter. Set to `pkc-http-router:*` to enable debug logs and morgan HTTP request logging (stdout). Sub-namespaces: `pkc-http-router:server`, `pkc-http-router:routes:providers`. |
| `NO_IP_VALIDATE` | _unset_ | When set, skips multiaddr/IP validation in `cleanAddrs` (`lib/utils.ts`). Intended for testing only. |

CLI flags (passed after `npm start --`, e.g. `npm start -- --log-key mylog`):

| Flag | Description |
| --- | --- |
| `--log-key <name>` | Enables per-request provider logging to the file `log/<name>`, and serves the `log/` folder at `GET /log`. Off when omitted. |

The `scripts/start-ipfs.ts` helper (for running a local kubo node pointed at this router) also reads `HTTP_ROUTER_URLS`; that is not used by the server itself.

#### logging

Logging is **off by default**.

- HTTP request logging (morgan) only turns on when the `DEBUG` env var enables the `pkc-http-router:*` namespace, and it goes to stdout.
- Per-request provider logging to a file is opt-in via the `--log-key <name>` CLI flag. When set, requests are appended to `log/<name>` and the `log/` folder is served at `GET /log`. Without the flag, nothing is written to disk.

#### getting started

Docker compose is the recommended way to run this, both locally and in production.

```
sudo apt install docker.io docker-compose-v2
git clone https://github.com/pkcprotocol/pkc-http-router.git && cd pkc-http-router
cp .env.example .env
docker compose up -d
```

The router is now on port 80 (`HTTP_PORT` in `.env` moves it). `docker compose logs -f` follows the logs, `docker compose down` stops it. The SQLite database lives in `data/` on the host, so it survives a rebuild.

To deploy an update, pull and rebuild — without `--build` compose keeps running the old image:

```
git pull && docker compose up -d --build
```

The `.env` file takes the same settings as the environment variables above, plus:

| Variable | Default | Description |
| --- | --- | --- |
| `HTTP_PORT` | `80` | Host port mapped to the router (inside the container it always listens on 3000). |
| `HTTP_BIND_IP` | `0.0.0.0` | Host interface that port binds to. Set to `127.0.0.1` when a reverse proxy or tunnel terminates TLS in front of it. |
| `LOG_KEY` | _unset_ | When set, passed as `--log-key`, so per-request logs go to `log/<LOG_KEY>` on the host. |

##### https

The `https` profile adds nginx on 443 in front of the router, with a Let's Encrypt certificate issued and renewed over the Cloudflare DNS-01 challenge. DNS-01 means the domain never has to be reachable on port 80 to issue the cert, but it does mean the domain has to be on a Cloudflare zone.

Set `DOMAIN`, `CERT_EMAIL` and `CLOUDFLARE_API_TOKEN` (a token with `Zone:DNS:Edit` on that zone) in `.env`, then:

```
docker compose --profile https up -d
```

The certbot container issues the cert on first start and re-checks for renewal once a day; nginx waits for the certificate to exist before starting, and reloads itself when it is renewed. Certificates are kept in `letsencrypt/` on the host, so recreating the containers does not re-issue them.

Without the profile flag only the router starts, so `docker compose up -d` stays the plain-HTTP path even with those variables set.

##### deploying to a server over ssh

`scripts/deploy.sh` clones or pulls the repo on a remote host, copies the local `.env` over and runs `docker compose up -d --build`. It reads `DEPLOY_HOST`, `DEPLOY_USER` and `DEPLOY_PASSWORD` (and optionally `DEPLOY_PROFILE=https`) from a `.deploy-env` file, and needs `sshpass` locally. `scripts/logs.sh` tails the remote logs with the same credentials.

#### running without docker

The project is written in TypeScript and requires **Node.js 24 or newer** (it uses the built-in `node:sqlite` module, which is stable as of Node 24). `npm start` compiles the TypeScript to `dist/` (via the `prestart` build step) and then runs the compiled server.

```
git clone https://github.com/pkcprotocol/pkc-http-router.git && cd pkc-http-router
npm install
DEBUG=pkc-http-router:* PORT=80 npm start
```

For local development with auto-reload (runs the TypeScript directly via `tsx`):

```
npm run dev
```

`scripts/start-docker.sh` is a third option: a single `docker run` off the stock `node:24` image with the repo bind mounted, no image build.

#### test

Tests run with [Vitest](https://vitest.dev).

```
npm test
```

or

```
npm run test:watch
```

#### type checking

```
npm run typecheck
```
