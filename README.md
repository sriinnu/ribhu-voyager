# Ribhu Voyager

**A durable coding agent that goes the distance.**

Ribhu Voyager is a phone-first coding agent built on **its own durable engine** — SQLite WAL,
a checkpointed run/tool journal, exactly-once submissions, and native Anthropic/OpenAI-compatible
streaming clients. There are **no `@earendil-works/*` packages** and no external agent framework.

The agent runs on your computer; the phone is the remote control. Kill the gateway mid-answer, lose
Wi-Fi, reload the app, or retry a message — the run resumes, and side effects are never silently
duplicated.

![Ribhu Voyager](docs/ribhu-empty.png)

---

## Start here

```bash
cd ~/Sriinnu/Personal/ribhu-voyager
npm start
```

Open <http://127.0.0.1:8787>.

`npm start` runs two processes — the **API** and the **worker** — sharing one SQLite journal.

That runs the built-in **scripted demo model**: no API key, but the real engine, tools, journal, and
streaming path. It is the fastest way to verify everything works.

If dependencies or the PWA build are ever missing:

```bash
npm install
npm run build
```

For development:

```bash
npm run dev     # API + worker + Vite :5173
```

Node **22.13+** is required (built-in `node:sqlite`); 24+ recommended. Normal startup needs no
`sudo`.

---

## Use it on your phone

The phone and computer must be on the **same Wi-Fi** (guest networks often isolate clients).

### 1. Find the computer's LAN address

```bash
ipconfig getifaddr en0      # Wi-Fi; may be en1 on some Macs
```

### 2. Start with a token

```bash
cd ~/Sriinnu/Personal/ribhu-voyager
RIBBHU_TOKEN="$(openssl rand -hex 16)" HOST=0.0.0.0 npm start
```

The terminal prints:

```text
gateway   http://127.0.0.1:8787?token=…
phone     http://192.168.1.42:8787?token=…
```

### 3. Open the phone URL

Open the **`phone`** URL **including `?token=…`**. The token is stored in `localStorage` and removed
from the address bar; later visits can use the plain URL on that phone.

The header should say **Live**. If macOS asks whether to allow `node` incoming connections, allow it.

### 4. Add it to the home screen

- **iPhone (Safari):** Share → **Add to Home Screen**.
- **Android (Chrome):** ⋮ → **Add to Home screen / Install app**.

If you rotate `RIBBHU_TOKEN`, open the new `?token=…` URL once, or clear the site data.

> **HTTPS matters for the full PWA experience.** Service workers and install prompts need HTTPS or
> `localhost`. Over plain HTTP on the LAN the agent works and the local replica is still saved, but
> the offline app shell does not register. For install/offline away from home, use an HTTPS tunnel.

### Away from home

```bash
tailscale serve --bg 8787
# or
cloudflared tunnel --url http://127.0.0.1:8787
```

Open the HTTPS origin on the phone; the service worker and install prompt then work.

### Phone troubleshooting

| Symptom | Fix |
| --- | --- |
| Page never loads | Same Wi-Fi? Correct IP? `HOST=0.0.0.0`? macOS firewall allowed `node`? |
| Stuck on **Reconnecting** | Missing/stale token. Open the printed `?token=…` URL once. |
| Worked yesterday, not today | DHCP changed the Mac's IP. Use the new printed address. |
| No install option | Serve over HTTPS, or use “Add to Home Screen” as a shortcut. |
| iOS sleeps and misses updates | Reopening reconnects and fetches a fresh snapshot. |

---

## Pick a model

| You want | Command |
| --- | --- |
| Demo, no key | `npm start` |
| Claude subscription | `RIBBHU_PROVIDER=anthropic RIBBHU_MODEL=claude-sonnet-4-5 npm start` |
| Anthropic API credits | `ANTHROPIC_API_KEY=sk-ant-… RIBBHU_ANTHROPIC_AUTH=api-key RIBBHU_PROVIDER=anthropic RIBBHU_MODEL=claude-sonnet-4-5 npm start` |
| DeepSeek API key | `DEEPSEEK_API_KEY=sk-… RIBBHU_PROVIDER=deepseek RIBBHU_MODEL=deepseek-flash npm start` |
| Local Ollama | `RIBBHU_PROVIDER=ollama RIBBHU_MODEL=llama3.2:3b npm start` |
| OpenAI key | `OPENAI_API_KEY=sk-… RIBBHU_PROVIDER=openai RIBBHU_MODEL=gpt-6-luna npm start` |

Supported providers: `anthropic`, `openai`, `deepseek`, `openrouter`, `xai`, `groq`, `mistral`,
`ollama` (plus `demo`).

### Claude: subscription or API credits

Both are supported, and you can switch **while the gateway runs**:
**⋯ → Anthropic auth → Subscription / API credits**.

![Anthropic auth selector](docs/ribhu-auth.png)

| Mode | Uses | Select with |
| --- | --- | --- |
| Subscription | Your Claude plan quota | `RIBBHU_ANTHROPIC_AUTH=subscription` (or `auto`) |
| API credits | Anthropic API key, including promotional credits | `RIBBHU_ANTHROPIC_AUTH=api-key` |

**Claude Code login.** If the `claude` CLI is logged in, Ribhu Voyager reads that OAuth credential
from the macOS Keychain (`Claude Code-credentials`). Refreshed tokens are cached in
`~/.ribhu/agent/claude-code.json`; `RIBBHU_KEYCHAIN_WRITE=1` also writes them back to the Keychain.

```bash
RIBBHU_PROVIDER=anthropic RIBBHU_MODEL=claude-sonnet-4-5 npm start
```

**Pi login (optional).** The engine can also read Pi's `~/.pi/agent/auth.json` file — no Pi packages
involved, it is just a JSON credential file. Use `RIBBHU_AUTH_SOURCE=pi` or `auto`.

`RIBBHU_AUTH_SOURCE=claude-code|pi` picks explicitly. `auto` prefers the credential that stays valid
longest. `RIBBHU_AUTH_FILE=/path/to/auth.json` overrides the Pi file; `none` disables it.

**API credits.**

```bash
ANTHROPIC_API_KEY=sk-ant-... \
RIBBHU_ANTHROPIC_AUTH=api-key \
RIBBHU_PROVIDER=anthropic RIBBHU_MODEL=claude-sonnet-4-5 \
npm start
```

The key is used directly by the native Anthropic client; requests never fall back to the
subscription. `RIBBHU_ANTHROPIC_API_KEY` works as an alternative name. If no key is present at
startup, **API credits** is disabled in the menu.

---

## Use it as a coding agent

The model gets four native tools — `read`, `write`, `edit`, `bash` — rooted at `RIBBHU_WORKSPACE`
(default `.ribhu-workspace/`). Point it at a repository and steer from the phone:

```bash
RIBBHU_WORKSPACE=~/code/my-repo \
RIBBHU_PROVIDER=anthropic RIBBHU_MODEL=claude-sonnet-4-5 \
RIBBHU_TOKEN="$(openssl rand -hex 16)" HOST=0.0.0.0 \
npm start
```

Ask something concrete:

> The test in `check.py` fails. Read the relevant files, fix the bug, run the test, and tell me what
> you changed.

Every model request, tool intent, tool result, and answer is journaled. If the gateway dies mid-edit,
restart it and the run resumes from the journal.

![A real coding run](docs/ribhu-coding.png)

*Native engine + native Anthropic client + Claude Code Max: read both files, edited `math.py`,
ran `python3 check.py`, saw `ok`, and reported the change.*

**The demo model is not an autonomous coder.** It answers canned text or runs commands prefixed
with `run:`. Use a real provider for real edits.

---

## How it works

```text
phone (PWA)
  ├── replica: view + cursor         → IndexedDB
  ├── outbox: {requestId, text}      → IndexedDB + synchronous localStorage mirror
  ├── reconnect: backoff + heartbeat → snapshot on every reconnect
  └── service worker: offline shell  (HTTPS/localhost only)

                 WebSocket /ws (JSON, protocol v2)
                 hello → welcome + snapshot
                 ← view {cursor, full view}
                 submit {requestId} → ack

API (Node)                     worker (Node)
  ├── admission + auth info      ├── durable queue consumer
  ├── view polling (120 ms)      ├── Engine: run/tool tasks
  └── static PWA                 └── SQLite WAL journal
  ├── native providers: Anthropic · OpenAI-compatible · Ollama · demo
  ├── tools: read · write · edit · bash
  └── HTTP: the built PWA + /api/health
```

### Durability invariants

- **Journal before show.** Entries, submissions, and tool tasks are committed to SQLite before the
  UI sees the change.
- **Exactly-once input.** `requestId` is unique in `submissions`; a retry returns the original
  submission and appends no second user entry.
- **Assistant is committed on completion.** A cut-off model stream is discarded and retried after a
  restart; no half-answer is appended.
- **Tool intent is committed first.** A tool task row records the call and its replay policy before
  execution.
- **Replay policy.** `read` is safe to rerun; `bash`, `write`, and `edit` are not. An interrupted
  unsafe tool is reported to the model as interrupted, never blindly repeated.
- **Resume.** On startup the engine finishes running tool tasks (safe rerun or interrupted result),
  then restarts every conversation with open submissions.
- **Snapshots, not deltas.** Protocol v2 sends the full bounded view on each revision; the phone
  never has to reconcile a partial op stream.

### One submission

```text
phone                    gateway/engine                 SQLite
  submit {requestId} ───▶ unique submission + pi.user ──▶ COMMIT
                          run starts
                          model stream ─────────────────▶ live view (ephemeral)
                          assistant + tool intent ──────▶ COMMIT
                          tool executes
                          tool result ──────────────────▶ COMMIT
                          next model turn …
                          final answer ─────────────────▶ COMMIT (submission done)
  ◀──────────────── ack + view snapshots
```

### What each failure does

| Failure | Behaviour |
| --- | --- |
| Gateway killed mid-answer | Reopen SQLite; retry the model request; the cut-off partial is discarded. |
| Gateway killed mid-tool | The running tool task is found on startup: safe tools rerun, unsafe tools report interruption. |
| Wi-Fi drops | **Offline**; inputs queue locally with `requestId`s and flush once on reconnect. |
| App reload / phone reboot | View, cursor, and outbox restore from IndexedDB, then a snapshot reconciles. |
| Duplicate submit after a lost ack | Unique `requestId` returns the original submission. |
| Two phones | Both attach and receive snapshots; either can send or abort. |

---

## Working with the app

![A tool call](docs/ribhu-tool.png)

- **Send:** Enter, or the ↑ button. Shift+Enter adds a line.
- **Steer vs Queue:** while busy, **Steer** joins the running turn at its next model step; **Queue** waits
  for the next run. Stop aborts.
- **Offline:** messages show as queued and flush on reconnect; “Retry now” resets a stuck socket.
- **Menu (⋯):** force a resync, install, copy diagnostics, switch Anthropic auth, or clear the local
  replica (the gateway keeps the journal).

Demo commands:

| You send | What happens |
| --- | --- |
| `What is durable about this?` | Streams the engine explainer |
| `run: uname -a` | Runs a real `bash` tool task |
| A fenced ` ```sh ` block | Runs the block body |
| `Write a haiku about durable systems` | Streams a haiku |

### Health

`/api/health` reports `worker.alive`, `worker.heartbeatAgeMs`, `worker.job`, and `queue`
(`pending`/`running`), so you can tell the API is up while the worker is down or busy. Inputs are
still admitted while the worker is down; the next worker claims the queued job.

### Conversations and context

![Conversations, forks, and compaction](docs/ribhu-conversations.png)

Open **⋯** to switch conversations, start a new one, fork the current one, rename it, or compact
its context. A fork copies the journal up to the fork point and keeps its own future turns.
Compaction writes a durable `pi.compaction` summary and keeps the full transcript; the active
context resumes from the summary boundary.

Search is SQLite **FTS5**-backed with highlighted snippets. Archived conversations disappear from
the list and search, and can be restored from the Archived section.

![Search across conversations](docs/ribhu-search.png)

![Archived conversations](docs/ribhu-archived.png)

### Web Push

Generate VAPID keys and start the gateway with them:

```bash
npx web-push generate-vapid-keys
RIBBHU_VAPID_PUBLIC_KEY=... RIBBHU_VAPID_PRIVATE_KEY=... npm start
```

The PWA's Session sheet shows **Enable server push**. Push requires HTTPS (or localhost) and browser
notification permission. Approvals are sent to every subscribed browser for the tenant. This is
Web Push only; APNs/FCM for the native app is not configured.

### Approvals

`RIBBHU_APPROVALS=ask` pauses `bash`, `write`, and `edit` for a phone approval; the pending request
and decision are durable journal entries, so a worker restart does not lose the wait. "Always allow"
remembers that exact tool + arguments for the conversation. `deny-bash` removes `bash`, and
`read-only` exposes only `read`. See
[docs/APPROVALS.md](docs/APPROVALS.md) and [docs/NATIVE-SHELL.md](docs/NATIVE-SHELL.md). For Postgres, tenant-scoped API tokens are enforced at the WebSocket boundary and the shared
`RIBBHU_TOKEN` is not accepted; one tenant per deployment is the current routing model.

### Sandboxed execution

`read`, `write`, and `edit` are contained to `RIBBHU_WORKSPACE`. With `RIBBHU_SANDBOX=docker`,
`bash` and the file tools all execute inside the hardened container (workspace-only mount, no
network, read-only root, no host env):

```bash
RIBBHU_SANDBOX=docker RIBBHU_SANDBOX_IMAGE=node:24-bookworm RIBBHU_WORKSPACE=~/code/my-repo npm start
```

The container gets only the workspace mount, a read-only root, a small `noexec` `/tmp`, no network,
dropped capabilities, and CPU/memory/PID limits. `local` remains the default for trusted machines.

### Data and reset

| Path | Contents |
| --- | --- |
| `.ribhu-data/ribhu.sqlite` | Entries, submissions, tool tasks, docs, usage |
| `.ribhu-workspace/` | Default working directory for tools |
| `~/.ribhu/agent/claude-code.json` | Cached refreshed Claude Code token |

Start fresh:

```bash
rm -rf .ribhu-data .ribhu-workspace
```

---

## Hosted storage

`packages/storage-postgres` is the async StorageV2 adapter: conversations, journal entries/docs,
exactly-once admission, queue leases with **fence tokens**, archive, settings, cancellation, and tool
tasks. It is exercised by a Dockerized Postgres suite.

```bash
npm run migrate:postgres -- .ribhu-data/ribhu.sqlite postgres://user:pass@host/ribhu
```

The migration is **non-destructive by default** and transactional. `--force` truncates every tenant
table; only use it for a verified empty target.

For a complete hosted setup, use the [single-tenant beta guide](docs/HOSTED-SINGLE-TENANT.md):
provision a least-privilege role, migrate, issue a token, enable strict RLS, and put TLS in front.

The engine now runs on **either** adapter: SQLite locally or Postgres for a hosted deployment.

```bash
RIBBHU_STORAGE=postgres \
RIBBHU_POSTGRES_URL=postgres://app_user:pass@host/ribhu \
RIBBHU_TENANT=default \
npm start
```

The Postgres role must be **NOSUPERUSER / NOBYPASSRLS**; a superuser bypasses RLS. Provision one with
`npm run provision:postgres -- --url "$ADMIN_URL" --role ribhu_app`. Issue, list, and revoke tenant
tokens with `npm run tokens:postgres -- issue|list|revoke`. The shared `RIBBHU_TOKEN` is for the local
SQLite gateway; it is ignored when a Postgres token checker is active.

The API and worker both select the adapter from config; the Docker suite proves API + gateway +
worker + engine + journal on Postgres, including two workers competing for one job and a hard worker
crash with lease resume. Postgres schema changes are versioned (`schema_migrations`), and search uses
Postgres full-text (`tsvector`/`ts_headline`) rather than `LIKE`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Gateway HTTP + WebSocket port |
| `HOST` | `127.0.0.1` | Bind address; `0.0.0.0` for the phone |
| `RIBBHU_DATA_DIR` | `.ribhu-data` | SQLite directory |
| `RIBBHU_WORKSPACE` | `.ribhu-workspace` | Default `cwd` for tools |
| `RIBBHU_PROVIDER` | `demo` | `demo` or a provider id |
| `RIBBHU_MODEL` | `ribhu-demo` | Model id |
| `RIBBHU_ANTHROPIC_AUTH` | `auto` | `auto`, `subscription`, or `api-key` |
| `RIBBHU_AUTH_SOURCE` | `auto` | `auto`, `claude-code`, or `pi` |
| `RIBBHU_AUTH_FILE` | `~/.pi/agent/auth.json` | Pi credential file; `none` disables |
| `RIBBHU_ANTHROPIC_API_KEY` | falls back to `ANTHROPIC_API_KEY` | Credits-mode key |
| `RIBBHU_KEYCHAIN_WRITE` | unset | `1` writes refreshed Claude Code tokens back to Keychain |
| `RIBBHU_TOKEN` | empty | Shared secret for the WebSocket upgrade |
| `RIBBHU_SANDBOX` | `local` | `local` or `docker` for tool execution |
| `RIBBHU_SANDBOX_IMAGE` | `node:24-bookworm` | Image used when `RIBBHU_SANDBOX=docker` |
| `RIBBHU_APPROVALS` | `allow` | `allow`, `ask`, `deny-bash`, or `read-only` |
| `RIBBHU_TENANT` | `default` | Postgres tenant for this deployment |
| `RIBBHU_STRICT_RLS` | unset | `1` fails startup if the Postgres role bypasses RLS |
| `RIBBHU_VAPID_PUBLIC_KEY` | unset | Web Push VAPID public key |
| `RIBBHU_VAPID_PRIVATE_KEY` | unset | Web Push VAPID private key |
| `RIBBHU_VAPID_SUBJECT` | `mailto:hello@srinivas.dev` | VAPID subject |
| `RIBBHU_ADMIN_TOKEN` | unset | Bearer token for `/admin` and `/api/admin/*`; unset disables them |
| `RIBBHU_COST_MICROS_PER_1K_TOKENS` | `0` | Usage pricing for quota/dashboard cost reporting |
| `RIBBHU_STORAGE` | `sqlite` | `sqlite` or `postgres` |
| `RIBBHU_POSTGRES_URL` | unset | Postgres URL when storage is `postgres` |
| `RIBBHU_DEMO` | unset | `1` forces the scripted provider |
| `RIBBHU_WINDOW_ENTRIES` | `100` | Max transcript entries in a view |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434/v1` | Local Ollama endpoint |
| `RIBBHU_GATEWAY` | `http://127.0.0.1:8787` | Vite dev proxy target |

---

## Tests and development

```bash
npm test          # 85 tests
npm run typecheck
npm run build
npm run dev
```

Coverage: exactly-once submissions, demo answer, real bash tool, hard-crash resume, gateway
snapshot/broadcast, credentials, auth-mode selection, Anthropic/OpenAI SSE parsers, and the new
queue/admission/lease/cancel primitives.

The crash test spawns a child, starts a slow stream, kills it with `SIGKILL`, reopens the same
SQLite file, and asserts the resumed run finishes with one user entry.

### Layout

```text
ribhu-voyager/
├── packages/
│   ├── engine/                  pure durable core, no Node/HTTP/SQLite
│   │   ├── src/engine.ts        run loop, resume, views, cancellation
│   │   ├── src/ports.ts         Storage, ToolRunner ports
│   │   ├── src/types.ts         entries, messages, providers
│   │   └── src/tool-specs.ts    read / write / edit / bash schemas
│   ├── storage-sqlite/          Storage adapter: journal, submissions, tasks
│   ├── storage-postgres/        async hosted StorageV2 adapter (Docker-tested)
│   ├── providers/               Anthropic, OpenAI-compatible, demo clients
│   └── protocol/                wire types (v2)
├── apps/
│   ├── server/                  API + worker entrypoints + auth + tools
│   │   ├── src/index.ts         API: static, WebSocket, admission, polling
│   │   ├── src/worker-main.ts   worker: queue consumer
│   │   ├── src/worker.ts        claims jobs and runs the engine
│   │   ├── src/health.ts        worker liveness · job · queue depth
│   │   ├── src/sandbox.ts       Docker-isolated bash runner
│   │   ├── src/tools-runtime.ts implements ToolRunner (local fs/bash)
│   │   ├── src/auth.ts          subscription vs credits, OAuth refresh
│   │   ├── src/gateway.ts       WebSocket snapshots
│   │   └── test/
│   └── mobile/                  React PWA
│       ├── src/session.ts       replica, outbox, reconnect
│       ├── src/format.ts        view → timeline
│       └── public/sw.js
```

The engine is a package boundary, and the API and worker are separate processes sharing only the
SQLite journal and queue. `packages/storage-postgres` is the async hosted adapter (admission, queue,
fences, conversations, archive) with a Dockerized conformance test; wiring the engine to it is the
next step. See [docs/ARCHITECTURE-UPGRADE.md](docs/ARCHITECTURE-UPGRADE.md) and the
[real-app target](docs/REAL-APP-ARCHITECTURE.md) for the hosted, sandboxed, multi-tenant direction.

### Extending

- **Tools:** add a spec in `packages/engine/src/tool-specs.ts` and an implementation in
  `apps/server/src/tools-runtime.ts`; set `replaySafe` correctly.
- **Providers:** add a native client in `packages/providers` and a case in its registry.
- **Engine features:** forks, compaction, subagents, and a task graph are deliberately not
  implemented yet; the journal is the place to grow them.

---

## Troubleshooting

- **`npm install` EPERM on `~/.npm`.** The repo's `.npmrc` uses a project-local cache; or
  `npm install --cache ./.npm-cache`, or fix the global cache with
  `sudo chown -R "$(id -u):$(id -g)" ~/.npm`.
- **Port in use.** `PORT=8788 npm start`, then use 8788.
- **Phone cannot connect.** `HOST=0.0.0.0`, correct LAN IP, firewall allows `node`.
- **Reconnecting forever after rotating the token.** Open the new `?token=…` URL once.
- **`Claude OAuth refresh failed`.** Run `pi` → `/login`, log in with `claude`, or use an API key.
- **`API credits` disabled.** No key was present at startup; set one and restart.
- **`401 invalid x-api-key`.** Wrong/revoked key.
- **Install option missing / no offline shell.** Plain HTTP is not a secure context; use HTTPS.
- **Blank page after update.** Hard-reload; bump `CACHE` in `public/sw.js` if needed.

---

## Limits

- **Sandboxing is opt-in.** `RIBBHU_SANDBOX=local` is the default; local `bash` runs as your user
  (with a secret-scrubbed environment). Use `RIBBHU_SANDBOX=docker` for isolation.
- **Multi-tenant API, one worker per tenant.** One API process routes tenant tokens to isolated
  runtimes; workers still bind to `RIBBHU_TENANT`, and there is no worker autoscaler or shared worker
  pool. See [docs/MULTI-TENANT.md](docs/MULTI-TENANT.md).
- **RLS requires the right role.** A superuser or `BYPASSRLS` role silently bypasses row security.
  Provision a dedicated `NOSUPERUSER NOBYPASSRLS` app role.
- **Approvals are single-user and non-cryptographic.** `ask` pauses risky tools, survives restart, and
  can remember an exact call. Web Push can notify the PWA, but there is no approver role,
  rule-management UI, signed audit trail, or native APNs/FCM push.
- **Native is real but not store-ready.** Generated iOS/Android projects build (iOS simulator and
  Android debug APK verified), with configurable gateway, deep-link parsing, local notifications, and
  a token-storage seam. No signing, OAuth exchange, secure native storage, or APNs/FCM push yet.
- **Single SQLite writer.** One gateway/worker pair per data directory. Postgres supports multiple
  workers with leases and fences.
- **Usage, quotas, and audit are minimal.** Usage events and audit rows are recorded and can be
  capped/inspected from an optional admin token + dashboard; there is no billing, invoicing, or
  per-user roles. See [docs/SAAS-CONTROL-PLANE.md](docs/SAAS-CONTROL-PLANE.md).
- **HTTP is cleartext.** The token gates the agent, not the traffic. Use TLS beyond your own LAN.
