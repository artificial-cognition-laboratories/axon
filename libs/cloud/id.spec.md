# Agent Identity — Spec

## What This Is

Every deployed agent gets a persistent identity: a stable email address and a keypair.
Identity is provisioned automatically at deploy time and survives redeployments. It is
retired (tombstoned) on undeploy — never deleted, never reused.

This is not a mailbox product. It is an identity primitive. The email address is the
anchor that lets agents act as first-class principals in external systems — signing up
for services, receiving verification mail, owning resources — without borrowing a
human's identity.

## Scope (v1)

**In scope:**
- Email address provisioned per agent at deploy time (`{agentName}.{username}@agents.arclabs.it`)
- Inbound mail received, parsed, stored per agent
- Inbox API: list, get, delete messages
- `waitFor` primitive: block until a matching message arrives (with timeout)
- Outbound sending: send mail as the agent's address
- AxonCloud client namespace: `client.identity.*`
- Agent-side injection: `AXON_AGENT_EMAIL` env var in Cloud Run
- Well-known JWKS endpoint (keypair generated, not yet user-facing)

**Out of scope (v1):**
- `@axon/email` module (agent inbox API as installable module — v2)
- Financial identity (virtual cards, Stripe Connect)
- Phone/SMS identity
- OAuth grant ownership
- Keypair signing exposed as a feature (generated but not surfaced)

---

## Data Model

### `agent_identities`

One row per agent. Created at first deploy. Never deleted.

```sql
agent_identities (
  id              uuid primary key default gen_random_uuid(),
  agent_id        uuid not null references agents(id),
  owner_id        uuid not null references users(id),
  email           text not null unique,
  public_key      text not null,          -- JWK format, published at well-known endpoint
  private_key_enc text not null,          -- AES-256-GCM encrypted, never returned to clients
  created_at      timestamptz not null default now(),
  retired_at      timestamptz             -- set on undeploy, null = active
)
```

Email format: `{agentName}.{username}@agents.arclabs.it`
- Globally unique (agent names unique per user, usernames unique globally)
- Derived deterministically — no allocation needed, no config per address
- Catch-all MX on `agents.arclabs.it` routes everything; routing is a DB lookup by email string

### `agent_inbox`

Parsed inbound mail. Lightweight — no attachments in v1.

```sql
agent_inbox (
  id           uuid primary key default gen_random_uuid(),
  agent_id     uuid not null references agents(id),
  message_id   text not null unique,     -- SMTP Message-ID header (deduplication)
  from_addr    text not null,
  subject      text,
  body_text    text,
  body_html    text,
  received_at  timestamptz not null default now(),
  read_at      timestamptz              -- set on first get, null = unread
)
```

---

## Inbound Mail Pipeline

```
Internet → MX (agents.arclabs.it) → AWS SES inbound (eu-west-1)
  → SNS topic
  → HTTPS subscription → POST /api/ingest/mail (backend)
  → parse To address, lookup agent_id in agent_identities
  → INSERT into agent_inbox (idempotent on message_id)
```

No Lambda. SNS delivers directly to the backend via HTTPS subscription. Backend verifies
the SNS signature on the request before processing. One SES receipt rule, catch-all.
No per-agent configuration — routing is a DB lookup by email string.

**SES production access must be requested before launch.**
Sandbox mode only receives from verified addresses — not useful for real verification flows.

---

## Backend Routes

### Identity

```
GET /api/agents/[id]/identity
```
Returns the agent's identity record. Owner-only. Never returns private key.

**Response:**
```typescript
{
  email: string           // my-agent.cody@agents.arclabs.it
  publicKey: string       // JWK format
  createdAt: string
  retiredAt: string | null
}
```

### Inbox

```
GET  /api/agents/[id]/inbox              -- list messages (paginated)
GET  /api/agents/[id]/inbox/[msgId]      -- get full message (marks read)
DELETE /api/agents/[id]/inbox/[msgId]    -- delete message
POST /api/agents/[id]/inbox/wait         -- waitFor (long-poll)
POST /api/agents/[id]/outbox            -- send message
```

**List params:** `?unread=true`, `?from=addr`, `?limit=20`, `?before=msgId`

**`POST /api/agents/[id]/inbox/wait` body:**
```typescript
{
  from?: string       // filter by sender address (exact or glob: *@github.com)
  subject?: string    // filter by subject substring
  timeout?: number    // ms, default 60000, max 300000
}
```
Long-polls until a matching message arrives or timeout. Returns 200 with message or
408 on timeout. Agent uses this for verification flows — trigger signup, call wait,
extract link, continue.

**`POST /api/agents/[id]/outbox` body:**
```typescript
{
  to: string | string[]
  subject: string
  body: string        // plain text
  html?: string       // optional HTML version
}
```
Backend calls SES outbound directly. DKIM signed. From address is the agent's identity
email. Rate limit: 100 messages/agent/day (enforced in backend, counted in Postgres).

### Well-Known

```
GET /.well-known/axon-agent/[email]/jwks
```
Unauthenticated. Returns the agent's public key in JWKS format. `[email]` is the full
agent email address (`my-agent.cody@agents.arclabs.it`). Email is the identity anchor —
third parties verifying a signature will have the email, not the username/name pair.
Enables verification without calling back to Axon auth.

---

## AxonCloud Client

New namespace on `AxonCloudClient`. Follows existing operation pattern exactly.

```typescript
client.identity.get(agentId): Promise<AgentIdentity>
client.identity.inbox.list(agentId, options?): Promise<InboxMessage[]>
client.identity.inbox.get(agentId, msgId): Promise<InboxMessage>
client.identity.inbox.delete(agentId, msgId): Promise<void>
client.identity.inbox.waitFor(agentId, filter, options?): Promise<InboxMessage>
client.identity.send(agentId, message): Promise<void>
```

**Types:**

```typescript
interface AgentIdentity {
  email: string
  publicKey: string
  createdAt: string
  retiredAt: string | null
}

interface InboxMessage {
  id: string
  fromAddr: string
  subject: string | null
  bodyText: string | null
  bodyHtml: string | null
  receivedAt: string
  readAt: string | null
}

interface InboxFilter {
  from?: string        // exact address or glob (*@github.com)
  subject?: string     // substring match
  timeout?: number     // ms, default 60000, max 300000
}

interface OutboundMessage {
  to: string | string[]
  subject: string
  body: string
  html?: string
}
```

---

## Agent-Side Integration

At deploy time, `AXON_AGENT_EMAIL` is injected into the Cloud Run environment via the
existing boot config mechanism (`GET /api/deployments/[id]/boot`). No new delivery path.

The agent reads its own email address from `process.env.AXON_AGENT_EMAIL`. To interact
with the inbox, it calls the backend API directly using `AXON_CONNECT_TOKEN` (already
injected). The `@axon/email` module (v2) will wrap this into a clean `inbox` interface —
for now, agents interact via raw HTTP or the cloud client.

---

## Deployment Integration

**At `axon deploy` → `deploymentProvisioning.ts`:**

```
provisionIdentity(agentId, ownerId, agentName, username)
  → derive email: `{agentName}.{username}@agents.arclabs.it`
  → check agent_identities for existing active row (idempotent)
  → if none: generate keypair, encrypt private key, insert row
  → inject email into Cloud Run env (AXON_AGENT_EMAIL)
```

Idempotent — redeployments reuse the existing identity. Same email survives version bumps.

**At `axon undeploy`:**

```
retireIdentity(agentId)
  → SET retired_at = now() on agent_identities row
  → address is tombstoned — catch-all will drop future mail to this address
  → inbox rows retained for 90 days then purged (audit trail)
```

---

## Invariants

- Private key never leaves the backend. Not in API responses, not in logs, not in events.
- Email address is immutable after creation. Rename of agent name does not change email.
- Retired addresses are never reused — even if the agent name is reclaimed by a new agent.
- `waitFor` is non-destructive — message remains in inbox after resolving. Caller must
  explicitly delete if consumed.
- One inbox per agent. Human and agent read from the same inbox. No sync state.
- Outbound rate limit: 100 messages/agent/day (v1). Exceeding returns 429.
- Inbound is unlimited — agent cannot be blamed for mail it receives.

---

## Abuse & Deliverability

**Outbound reputation is shared across all agents on agents.arclabs.it.**
One spamming agent can blacklist the domain for every agent. Mitigations:

- Rate limit outbound per agent (100/day v1)
- Require human-verified account to deploy (device flow already enforces this)
- Monitor bounce/complaint rates via SES feedback loop
- Takedown: `retired_at` + SES suppression list for abusive addresses

**Request SES production access before any external testing.**
Sandbox blocks inbound from unverified senders — useless for real verification flows.

---

## Decisions

1. **Email on agent name collision.** Reuse blocked entirely. If `my-agent.cody@agents.arclabs.it`
   has ever existed, it can never exist again. On conflict at provision time, raise an error —
   do not generate a suffix. Agent name retirement is a consequence of undeploy.

2. **Inbox retention.** 90 days post-retire then purged. GDPR deletion requests trigger
   immediate purge via existing user deletion path.

3. **`waitFor` implementation.** Long-poll. Server holds connection up to 55s (Cloud Run
   safe limit), returns 408 on timeout. AxonCloud client retries transparently — from
   caller's perspective it is a single await with the full requested timeout.

4. **Domain.** `agents.arclabs.it` for all agent email. Isolates deliverability risk from
   `agents.arclabs.it` platform mail (auth, billing, notifications).

5. **SES region.** eu-west-1.

6. **Outbound.** SES outbound. Same account as inbound, shared DKIM config.

7. **Keypair algorithm.** ES256 (ECDSA P-256 + SHA-256). Compact, fast, standard JWK support.

8. **Private key encryption.** GCP KMS (eu-west1). Private key encrypted before DB write,
   decrypted in memory only during sign operations (v2). Never in plaintext on disk or in logs.

9. **JWKS endpoint.** Included in v1. Costs one DB read. Establishes verifiability from day
   one. No signing API exposed in v1 — generate and publish only.

10. **Ingest boundary.** SNS delivers directly to `POST /api/ingest/mail` via HTTPS
    subscription (shared-secret auth). No Lambda. Backend is the only process that
    touches Postgres.

---

## Build Plan

Five subagents, all default model (not small). Three can run in parallel after the
schema subagent completes. The cloud client subagent is fully independent and runs
immediately in parallel with schema.

---

### Wave 1 — Parallel (start immediately)

#### Agent A: Schema + Queries
**Works in:** `apps/backend`

Write the migration and all DB query functions. Everything else depends on this.

**Deliver:**
- Migration file at `apps/backend/server/db/migrations/NNNN_agent_identity.sql`:
  ```sql
  CREATE TABLE agent_identities (
    id              uuid primary key default gen_random_uuid(),
    agent_id        uuid not null references agents(id),
    owner_id        uuid not null references users(id),
    email           text not null unique,
    public_key      text not null,
    private_key_enc text not null,
    created_at      timestamptz not null default now(),
    retired_at      timestamptz
  );
  CREATE INDEX ON agent_identities(agent_id);
  CREATE INDEX ON agent_identities(email);

  CREATE TABLE agent_inbox (
    id           uuid primary key default gen_random_uuid(),
    agent_id     uuid not null references agents(id),
    message_id   text not null unique,
    from_addr    text not null,
    subject      text,
    body_text    text,
    body_html    text,
    received_at  timestamptz not null default now(),
    read_at      timestamptz
  );
  CREATE INDEX ON agent_inbox(agent_id, received_at DESC);
  CREATE INDEX ON agent_inbox(message_id);
  ```

- Query functions at `apps/backend/server/db/queries/identity.ts`:
  - `getIdentityByAgentId(agentId, sql)` → row | null
  - `getIdentityByEmail(email, sql)` → row | null
  - `createIdentity({ agentId, ownerId, email, publicKey, privateKeyEnc }, sql)` → row
  - `retireIdentity(agentId, sql)` → void
  - `listInbox(agentId, opts: { limit, before, from, unread }, sql)` → rows
  - `getInboxMessage(agentId, msgId, sql)` → row | null (marks read_at)
  - `deleteInboxMessage(agentId, msgId, sql)` → void
  - `insertInboxMessage({ agentId, messageId, fromAddr, subject, bodyText, bodyHtml }, sql)` → row
  - `countOutboundToday(agentId, sql)` → number
  - `getOutboundRateLimit()` → 100 (constant)

**Testing:** No tests needed — queries are tested via the route tests in Agent B.

**Key constraints:**
- `createIdentity` must throw if email already exists (UNIQUE violation surfaces as identity name retirement)
- `getInboxMessage` sets `read_at = now()` in same query (UPDATE ... RETURNING)
- All functions take `sql` as last param, never import the global sql directly

---

#### Agent B: AxonCloud Client — `client.identity.*`
**Works in:** `libs/axon/cloud`
**Fully independent — runs in parallel with Agent A.**

Add `identity` namespace to `AxonCloudClient`. Follow the exact pattern of existing
operation files (e.g. `src/deployments.ts`). Use `AxonHttpClient` for all HTTP.

**Types to add** (in `src/types.ts` or equivalent):
```typescript
interface AgentIdentity {
  email: string
  publicKey: string
  createdAt: string
  retiredAt: string | null
}

interface InboxMessage {
  id: string
  fromAddr: string
  subject: string | null
  bodyText: string | null
  bodyHtml: string | null
  receivedAt: string
  readAt: string | null
}

interface InboxFilter {
  from?: string
  subject?: string
  timeout?: number   // ms, default 60000, max 300000
}

interface OutboundMessage {
  to: string | string[]
  subject: string
  body: string
  html?: string
}
```

**Operations:**
```typescript
client.identity.get(agentId): Promise<AgentIdentity>
client.identity.inbox.list(agentId, opts?: { unread?: boolean, from?: string, limit?: number }): Promise<InboxMessage[]>
client.identity.inbox.get(agentId, msgId): Promise<InboxMessage>
client.identity.inbox.delete(agentId, msgId): Promise<void>
client.identity.inbox.waitFor(agentId, filter: InboxFilter): Promise<InboxMessage>
client.identity.send(agentId, message: OutboundMessage): Promise<void>
```

**`waitFor` implementation:**
- POST to `/api/agents/{agentId}/inbox/wait` with filter + timeout
- Server long-polls up to 55s, returns 200 (message) or 408 (timeout)
- Client retries on 408 transparently until caller's timeout is exhausted
- Throws `AxonCloudError` only on non-408 errors or total timeout exceeded

**Testing** (`tests/integration/identity.test.ts`):
- Use `makeClient()` and `ensureUsers()` from `tests/setup/client.ts`
- `beforeEach`: `await ensureUsers()`
- Test: `get(agentId)` returns identity with email + publicKey
- Test: `inbox.list()` returns empty array for fresh agent
- Test: `send()` returns void without throwing
- Test: `inbox.waitFor()` times out and throws on 408 after exhausting retries
- Never test internals — only I/O through the public client

**Key constraints:**
- snake_case → camelCase coercion on all responses (follow existing pattern)
- `waitFor` must not swallow errors other than 408
- `send` must throw `AxonCloudError` on 429 (rate limit hit)

---

### Wave 2 — After Agent A completes (parallel with each other)

#### Agent C: Backend Routes
**Works in:** `apps/backend`
**Depends on:** Agent A (queries)

Implement all identity routes. Follow `defineTracedEventHandler` pattern throughout.
Emit trace events on every significant operation. Never swallow errors.

**Files to create:**
- `server/api/agents/[id]/identity.get.ts`
- `server/api/agents/[id]/inbox/index.get.ts`
- `server/api/agents/[id]/inbox/[msgId].get.ts`
- `server/api/agents/[id]/inbox/[msgId].delete.ts`
- `server/api/agents/[id]/inbox/wait.post.ts`
- `server/api/agents/[id]/outbox.post.ts`
- `server/api/ingest/mail.post.ts`
- `server/api/_well-known/axon-agent/[email]/jwks.get.ts`

**Auth pattern** (follow existing routes exactly):
- All agent routes: owner-only via `requireAuth(event)` + verify `agent.owner_id === user.id`
- Ingest mail route: shared secret via `x-ingest-secret` header (env var `INGEST_MAIL_SECRET`)
- JWKS route: unauthenticated

**`wait.post.ts` (long-poll):**
- Read filter from body (`from?`, `subject?`, `timeout?` capped at 55000ms)
- Poll `listInbox` with filter every 1000ms
- On match: return 200 with message
- On timeout: return 408 `{ error: "timeout" }`
- Set `setResponseStatus` before returning in both cases

**`outbox.post.ts` (send):**
- Check `countOutboundToday(agentId)` — if ≥ 100, throw 429
- Call SES `SendEmailCommand` via `@aws-sdk/client-sesv2`
- From address: agent's identity email from `getIdentityByAgentId`
- On SES error: throw 502 with message, emit `agent:identity:send:error` trace event
- On success: emit `agent:identity:send` trace event

**`ingest/mail.post.ts` (SNS inbound):**
- Verify `x-amz-sns-message-type` header
- If `SubscriptionConfirmation`: fetch `SubscribeURL` and confirm (GET request)
- If `Notification`: parse `Message` JSON as SES notification
  - Verify `notificationType === "Received"`
  - Extract To address from `receipt.recipients[0]`
  - Skip if spam or virus verdict is FAIL
  - Look up agent by email via `getIdentityByEmail`
  - Skip silently if no agent found (mail to retired/unknown address)
  - Insert into `agent_inbox` via `insertInboxMessage` (idempotent on `message_id`)
  - Emit `agent:identity:mail:received` trace event
- Always return 200 (SNS retries on non-2xx)

**SES client** (`server/infra/ses.ts`):
```typescript
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2"

const sesClient = new SESv2Client({ region: "eu-west-1" })

export async function sendEmail(opts: {
  from: string
  to: string | string[]
  subject: string
  body: string
  html?: string
}): Promise<void>
```
Throws on SES error — never swallows.

**Trace events to emit:**
- `agent:identity:get` — on identity fetch
- `agent:identity:mail:received` — on inbound mail inserted
- `agent:identity:send` — on outbound mail sent
- `agent:identity:send:error` — on SES failure (hasError: true)
- `agent:identity:wait:timeout` — on waitFor timeout
- `agent:identity:wait:resolved` — on waitFor match

**Testing** (`tests/identity/routes.test.ts`):
- `beforeEach`: `truncateAll()`, `seedTestUser()`, create test agent + identity row directly via `sql`
- Test GET identity returns correct shape, 404 for unknown agent, 403 for wrong user
- Test inbox list returns empty, then returns message after direct SQL insert
- Test inbox get marks read_at, 404 for unknown message
- Test inbox delete removes message
- Test wait returns 408 on timeout (use short timeout like 500ms in test)
- Test outbox returns 429 when count ≥ 100 (seed 100 rows in sent_today counter or mock)
- Test ingest/mail inserts message, idempotent on duplicate message_id
- Test JWKS returns valid JWK structure

---

#### Agent D: Deploy Lifecycle Integration
**Works in:** `apps/backend`
**Depends on:** Agent A (queries)

Hook identity provisioning and retirement into the existing deploy flow.
Read `server/services/deploymentProvisioning.ts` in full before writing anything.

**Add to `server/services/identity.ts` (new file):**
```typescript
export async function provisionIdentity(opts: {
  agentId: string
  ownerId: string
  agentName: string
  username: string
}, sql: Database): Promise<{ email: string }>
```

Implementation:
1. Derive email: `${agentName}.${username}@agents.arclabs.it`
2. Check for existing active identity (`getIdentityByAgentId`) — return early if exists (idempotent)
3. Check for retired identity with same email (`getIdentityByEmail`) — throw if found (name retired)
4. Generate ES256 keypair using Node `crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })`
5. Export public key as JWK: `publicKey.export({ format: 'jwk' })`
6. Encrypt private key with GCP KMS (`@google-cloud/kms`):
   - KMS key path from `process.env.GCP_KMS_KEY_NAME`
   - Encrypt PEM export of private key
   - Store base64-encoded ciphertext
7. Insert via `createIdentity()`
8. Emit `agent:identity:provisioned` trace event
9. Return `{ email }`

```typescript
export async function retireIdentity(agentId: string, sql: Database): Promise<void>
```

Implementation:
1. Call `retireIdentity(agentId, sql)` query
2. Emit `agent:identity:retired` trace event
3. If no row found, log warning but do not throw (undeploy must not fail due to missing identity)

**Hook into provisioning flow** (`deploymentProvisioning.ts`):
- After deployment status set to `provisioning`, call `provisionIdentity()`
- Inject `AXON_AGENT_EMAIL` into Cloud Run env vars alongside existing env
- On `provisionIdentity` failure: log error + emit trace event, but do not fail the deployment
  (identity is a feature, not a hard requirement for the agent to run)

**Hook into undeploy** (find the delete/undeploy route or service):
- Call `retireIdentity(agentId)` after Cloud Run service deletion

**Boot config** (`server/api/deployments/[id]/boot.get.ts`):
- Add `agentEmail` to the returned boot config object
- Fetch from `getIdentityByAgentId(deployment.agent_id)`
- If no identity yet, return `agentEmail: null` (graceful — identity may not be provisioned yet)

**Testing** (`tests/identity/provisioning.test.ts`):
- `beforeEach`: `truncateAll()`, `seedTestUser()`
- Test `provisionIdentity` creates row with correct email format
- Test `provisionIdentity` is idempotent (second call returns same email, no duplicate row)
- Test `provisionIdentity` throws on retired name reuse
- Test `retireIdentity` sets `retired_at`
- Test `retireIdentity` does not throw if no identity row exists
- Boot config test: `agentEmail` present in response after identity provisioned

---

#### Agent E: Infra Setup (manual + documented)
**Works in:** `apps/backend/infra/` + AWS console

This agent documents the one-time AWS/GCP infrastructure that must be configured before
the feature is live. Output is a runbook, not code.

**Document exactly:**

1. **SES domain verification** (`agents.arclabs.it`):
   - Add TXT record for SES domain verification
   - Add MX record pointing to SES inbound SMTP endpoint for eu-west-1:
     `10 inbound-smtp.eu-west-1.amazonaws.com`
   - Add DKIM CNAME records (3 records, generated by SES)
   - Add SPF TXT record: `v=spf1 include:amazonses.com ~all`
   - Add DMARC TXT record: `v=DMARC1; p=quarantine; rua=mailto:dmarc@arclabs.it`

2. **SES receipt rule set**:
   - Rule: catch-all on `agents.arclabs.it`
   - Action: SNS → topic ARN
   - Enable spam/virus scanning

3. **SNS topic**:
   - Topic name: `axon-agent-inbound-mail`
   - HTTPS subscription to: `https://api.arclabs.it/api/ingest/mail`
   - Subscription must be confirmed (backend handles `SubscriptionConfirmation` automatically)

4. **SES production access**:
   - Request via AWS console (Support → Service Limit Increase → SES Sending Limits)
   - Required before any external mail can be received in sandbox
   - Request both inbound and outbound production access

5. **GCP KMS key**:
   - Keyring: `axon-agent-identity` in `europe-west1`
   - Key: `private-key-encryption`, purpose: ENCRYPT_DECRYPT, algorithm: GOOGLE_SYMMETRIC_ENCRYPTION
   - Set `GCP_KMS_KEY_NAME` env var in Cloud Run:
     `projects/{project}/locations/europe-west1/keyRings/axon-agent-identity/cryptoKeys/private-key-encryption`
   - Grant Cloud Run service account `roles/cloudkms.cryptoKeyEncrypterDecrypter`

6. **Environment variables** to add to backend Cloud Run service:
   - `INGEST_MAIL_SECRET` — random 32-byte hex string, also configure in SNS subscription header
   - `GCP_KMS_KEY_NAME` — full KMS key resource name
   - `SES_REGION` — `eu-west-1`

7. **`@aws-sdk/client-sesv2` package**:
   - Add to `apps/backend/package.json`

---

### Execution Order

```
Wave 1 (parallel, start now):
  Agent A — Schema + Queries
  Agent B — AxonCloud Client

Wave 2 (after Agent A, parallel):
  Agent C — Backend Routes     (depends on A)
  Agent D — Deploy Lifecycle   (depends on A)
  Agent E — Infra Runbook      (independent, can run any time)
```

Wave 2 agents should be given the schema file path and query file path as source of
truth. They read, they build, they test. No ambiguity about interfaces.
