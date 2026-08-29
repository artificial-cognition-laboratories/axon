# @arcforge/air

AIR — the Agent Intermediate Representation used by the [Axon](https://axon.arclabs.it)
agent runtime.

AIR is the format Axon uses to construct the context window sent to a model on every
loop tick. One grammar, rendered for a model and parsed back from its reply. It is an
open standard, independent of any model provider, and used by every Axon agent
regardless of which engine answers.

```bash
npm install @arcforge/air
```

Most people never install this directly. It arrives as a dependency of the Axon
framework when you scaffold an agent with `axon init`.

## Documentation

Full documentation is at **[axon.arclabs.it/docs/v2](https://axon.arclabs.it/docs/v2)**.

- [AIR Format](https://axon.arclabs.it/docs/v2/concepts/air-format)
- [Agent Output](https://axon.arclabs.it/docs/v2/concepts/agent-output)
- [The Runtime Loop](https://axon.arclabs.it/docs/v2/concepts/runtime-loop)

## License

Proprietary. © ArcLabs
