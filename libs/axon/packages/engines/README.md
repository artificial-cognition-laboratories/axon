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

## Documentation

Full documentation is at **[axon.arclabs.it/docs/v2](https://axon.arclabs.it/docs/v2)**.

- [Providers](https://axon.arclabs.it/docs/v2/providers)
- [How a role becomes a model](https://axon.arclabs.it/docs/v2/providers/behaviour)
- [Engines](https://axon.arclabs.it/docs/v2/agent/runtime/engines)

## License

Proprietary. © ArcLabs
