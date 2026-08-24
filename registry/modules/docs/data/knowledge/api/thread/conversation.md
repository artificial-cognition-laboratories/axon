---
title: Conversation entries
---

# Conversation entries

The message exchange between the user and the agent.

## user:message

```ts
type MessageUser = ThreadEntry<"user:message", {
    content: string
    attachments?: Array<{
        kind: "image" | "file" | "url"
        name?: string
        url?: string
        data?: string       // base64-encoded content for inline attachments
        mimeType?: string
        size?: number       // bytes
    }>
}>
```

## axon:agent:message

Final accumulated agent response. Replaces the stream of `axon:agent:message:delta` entries
when the model finishes. Shares the same `id` as its deltas.

```ts
type MessageAgent = ThreadEntry<"axon:agent:message", {
    content: string
    attachments?: Array<{
        kind: "image" | "file" | "url"
        name?: string
        url?: string
        mimeType?: string
    }>
}>
```

## axon:agent:message:delta

Streaming chunk of an agent message. Arrives in real time as the model generates.
Same `id` as the final `axon:agent:message` — accumulate deltas in place, replace on completion.

```ts
type MessageAgentDelta = ThreadEntry<"axon:agent:message:delta", {
    content: string  // partial chunk — not a full message
}>
```

## axon:agent:thinking

Final accumulated reasoning text. Only emitted by models with extended thinking support.
Shares the same `id` as its deltas.

```ts
type AgentThinking = ThreadEntry<"axon:agent:thinking", {
    content: string
}>
```

## axon:agent:thinking:delta

Streaming chunk of agent reasoning. Same accumulate-and-replace pattern as message deltas.

```ts
type AgentThinkingDelta = ThreadEntry<"axon:agent:thinking:delta", {
    content: string
}>
```
