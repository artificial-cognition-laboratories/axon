---
title: Identity
---

# Identity

Every deployed agent is a cryptographic entity on the internet. Not a process running
on a server. Not a service account tied to a human's login. An entity — with a stable
identity, a verifiable presence, and the ability to act in the world as itself.

The identity is provisioned automatically at deploy time. No configuration. No module
to install. It arrives the same way a URL and an API key arrive.

## What the identity is

At its root, the identity is a keypair: a private key that never leaves Axon's
infrastructure, and a public key published where anyone can find it.

```bash
did:web:agents.arclabs.it:alice:barry  # the identity — a standard W3C DID
```

The DID is the canonical form. It resolves to the agent's public key and service
endpoints. Any DID-aware system can verify an agent's identity without calling back
to Axon, without a shared secret, without any prior arrangement.

The email address is the human-readable alias for that identity:

```bash
barry.alice@agents.arclabs.it  # the same identity, legible to human-built systems
```

Same agent. Two representations. The DID is how machines see it. The email is how
services built for humans see it. Both point to the same keypair.

## Why this matters

Agents have operated by borrowing until now. They borrow a human's OAuth token to call
GitHub. They borrow a team's API key to call Linear. The human rotates their token, or
leaves the company, and the agent breaks. The audit trail shows actions taken by a person
who didn't take them.

An agent with its own identity can own these things instead of borrowing them. It can
initiate an OAuth flow as itself — using its email address to create the account,
completing the verification flow through its own inbox, holding the resulting token
against its own keypair. The agent is the authorised party. Not a proxy for one.

That distinction is the difference between an agent that is genuinely autonomous and one
that falls apart when the wrong person leaves.

## The web parallel

The web solved this problem for servers fifteen years ago. A domain has a TLS certificate
proving you control it. Services publish capabilities at `.well-known/` paths — a standard
location any caller can check without prior arrangement. Trust is decentralised: the
certificate is signed by a known authority, the verification is local.

Axon applies the same pattern to agents. The keypair is the TLS certificate — proof of
control, no central authority required for verification. The email address is the domain
name — the human-legible identifier that anchors the agent in existing systems. The
`.well-known/` endpoint is where you go to find the public key.

| Component | Web equivalent | Role |
|---|---|---|
| ES256 keypair | TLS certificate | Root of identity — verifiable proof |
| Email address | Domain name | Human-legible alias — works with existing services |
| `.well-known/` endpoint | DNS + service discovery | Public key lookup, no auth required |

No new infrastructure. No proprietary protocol. The same pattern that made the web
trustworthy — applied to agents.

## Credentials

An agent with its own identity can hold credentials as itself rather than borrowing them
from a human. OAuth grants, API keys, service tokens — attached to the agent's identity,
scoped to this agent only, persisting across redeployments and personnel changes. Agent
credential ownership is in active development.

---

**[Email](/docs/v2/agent/identity/email)** — the email alias: the inbox, the `waitFor`
primitive, how an agent participates in services built for humans.

**[Signing](/docs/v2/agent/identity/signing)** — the keypair: what it proves, how
verification works, the DID standard it implements.
