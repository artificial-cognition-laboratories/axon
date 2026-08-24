---
title: Signing
---

# Signing

The root of every agent's identity is a keypair. The email address is its human-readable
alias. The keypair is what the identity actually is — a mathematical object that can
produce unforgeable proofs and be verified by anyone without a central authority.

## The DID

Every Axon agent is a `did:web` identity — the W3C standard for decentralised
identifiers:

```bash
did:web:agents.arclabs.it:alice:barry
```

This resolves to a DID Document containing the agent's public key and service endpoints.
Any DID-aware system — identity platforms, credential verifiers, cross-platform
federation tools — can resolve it using standard protocols. No Axon-specific tooling.
No API call to Axon. The identity is the keypair, and the keypair is public.

## The public key

The public key is published at a well-known URL, unauthenticated, in standard JWKS
format:

```bash
https://agents.arclabs.it/.well-known/agents/alice/barry/jwks
```

```json
{
  "keys": [{
    "kty": "EC",
    "crv": "P-256",
    "alg": "ES256",
    "use": "sig",
    "kid": "barry.alice@agents.arclabs.it#key-1",
    "x": "...",
    "y": "..."
  }]
}
```

No authentication. No API key. Standard JWKS — the same format browsers, identity
providers, and OAuth servers already know how to consume.

The private key never leaves Axon's infrastructure. It is encrypted at rest and used
server-side only. You never see it. You never manage it.

## What a signature proves

An API key proves that whoever holds the key made the request. But API keys can be
copied, leaked, or shared. A signature proves that whoever holds the *private key*
produced that specific artifact — and the private key never moved.

This commit was made by this agent. This request came from this agent. This document
was produced by this agent. Verifiable by anyone, without calling back to Axon, without
any shared secret.

## What agents can sign

**Git commits** — using the SSH signing format GitHub and GitLab already support. Every
commit in the agent's history is verifiably from that agent, not from a shared CI key
or a service account no one remembers creating.

**HTTP requests** — JWS signatures over the request body. Services that want to verify
an Axon agent is making a request can fetch the public key and verify the signature
with standard tooling.

**Documents** — reports, audit logs, release notes — carry provenance. Anyone reading
the document can confirm which agent produced it and verify that it hasn't been modified.

## Verification is local

Once the public key is fetched and cached, verification requires no network call. The
key is public. The algorithm is standard. The math runs locally. A service can cache the
key for a day or a year — verification stays fast and offline.

This matters for the same reason TLS matters: trust does not require a live connection
to a central authority. The proof is in the math, not in a callback.

---

**[Identity](/docs/v2/agent/identity)** — the full picture: what the identity consists
of, why every agent has one, and how the email alias and the keypair fit together.
