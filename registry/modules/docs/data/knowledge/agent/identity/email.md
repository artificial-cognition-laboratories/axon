---
title: Email
---

# Email

Every agent has a cryptographic identity. The email address is how that identity
participates in services built for humans — account creation, verification flows,
correspondence, anything that expects an address in a form field.

```bash
barry.alice@agents.arclabs.it
```

The format is `{agentName}.{username}@agents.arclabs.it`. It's stable across
redeployments, persists across version updates, and is tied to the agent's keypair —
the same identity expressed in a form that human-built services understand.

## In the environment

The address is available as `AXON_AGENT_EMAIL`. Tools and scripts read it directly:

```ts
const agentEmail = process.env.AXON_AGENT_EMAIL
// → "barry.alice@agents.arclabs.it"
```

No import, no configuration object. If you're writing a tool that needs to register an
account somewhere, this is the address to use.

## The inbox

Mail sent to the agent's address arrives in an inbox. The `@axon/email` module exposes it:

```ts
import { email } from "@axon/email"

email.address  // → "barry.alice@agents.arclabs.it"

const message = await email.inbox.waitFor({
    from: "noreply@github.com",
    subject: /please verify/i,
    timeout: 60_000,
})
```

`waitFor` blocks until a matching message arrives or the timeout expires. It returns the
full parsed message — text, HTML, headers — so the agent can extract links or read the
content directly.

## Verification flows

The pattern that makes the email address useful: trigger a flow, wait for the
confirmation, extract the link, continue. It appears constantly — any service that
confirms accounts by email.

```ts
// src/scripts/create-github-account.ts
import { email } from "@axon/email"
import { browser } from "@axon/browser"

const page = await browser.open("https://github.com/signup")
await page.fill('[name="user[email]"]', email.address)
await page.fill('[name="user[login]"]', "barry-arclabs")
await page.fill('[name="user[password]"]', process.env.GITHUB_INITIAL_PASSWORD)
await page.click('[type="submit"]')

const message = await email.inbox.waitFor({
    from: "noreply@github.com",
    subject: /verify your email address/i,
    timeout: 120_000,
})

const match = message.text.match(/https:\/\/github\.com\/users\/activate\?[^\s]+/)
if (!match) throw new Error("No activation link in confirmation email")
await browser.open(match[0])
```

After this completes, the agent has a verified GitHub account it owns. The OAuth token
that comes out of that account is the agent's — not borrowed from a human, not tied to
anyone's employment.

## Sending

Agents send mail as themselves:

```ts
await email.send({
    to: "alice@example.com",
    subject: "Deploy complete",
    text: "The v2.3.1 deploy finished without errors. 14 tests passed.",
})
```

Outbound limit: 100 messages per day.

## Oversight

The inbox is shared — the agent and the human read the same messages. From outside the
agent, via the AxonCloud client:

```ts
const messages = await client.identity.inbox.list(agentId)
```

Every message the agent receives is visible. Every verification flow it's in the middle
of is inspectable. Nothing happens in the background you can't see.

---

**[Signing](/docs/v2/agent/identity/signing)** — the keypair that the email address
is an alias for. What it proves and how verification works.
