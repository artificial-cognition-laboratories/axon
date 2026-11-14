# @arcforge/engines

Provider connections for the [Axon](https://axon.arclabs.it) agent runtime.

An engine is a source of inference and nothing more. Axon's loop, context assembly,
tool dispatch and policy enforcement are identical regardless of which provider
answers — changing providers changes how an agent thinks, never how it works.

Supports Anthropic, OpenAI, Google, Groq, Cerebras, DeepSeek, Mistral, Moonshot,
OpenRouter, Perplexity, xAI, Z.AI, Ollama for local models, and Axon's own managed
inference.

```bash
npm install @arcforge/engines
```

Most people never install this directly. It arrives as a dependency of the Axon
framework when you scaffold an agent with `axon init`.

## Account credentials

Axon stores provider credentials in the account vault. API-key providers use the
AI SDK for inference; Codex retains its subscription OAuth flow. Provider SDKs
ship with the runtime, so connecting a provider requires no package installation.

```ts
await cloud.user.vault.connections.get("anthropic").connect({ key: apiKey })
await cloud.user.vault.connections.list() // metadata only
```

A fresh host discovers active account connections when its profile has no
`providers` declaration. Explicit profiles, including `providers: []`, retain
that restriction. The runtime discovers availability when it resolves its pool;
new connections require pool resolution again. Existing drivers pick up changed
credentials within the 30-second cache bound, or immediately after a metadata
refresh. Disconnecting a connection does not revoke keys already issued by the
provider.

Explicit keys and environment credentials override the account vault. A custom
endpoint requires an explicit credential; account keys are never sent to an
endpoint override. `openai-api` identifies an OpenAI API credential; `codex`
identifies the subscription grant. The legacy vault `openai` alias remains Codex.

## Documentation

Full documentation is at **[axon.arclabs.it/docs/v2](https://axon.arclabs.it/docs/v2)**.

- [Providers](https://axon.arclabs.it/docs/v2/providers)
- [How a role becomes a model](https://axon.arclabs.it/docs/v2/providers/behaviour)
- [Engines](https://axon.arclabs.it/docs/v2/agent/runtime/engines)

## License

Proprietary. © ArcLabs
