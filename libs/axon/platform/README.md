# @arcforge/platform

The headless developer platform for [Axon](https://axon.arclabs.it).

Everything the CLI, the TUI and the Fleet extension do to projects and agents on this
machine — project discovery, blueprint scanning, typegen, agent lifecycle, registry,
benches and tests — with no terminal, no reactivity and no prompts of its own.

`Platform()` is the composition root: one object holding every tool a runtime needs.
Consumers get it and descend into it; they never construct its internals. That is what
lets one implementation serve a terminal, an editor extension and a CI run without any
of them knowing about the others.

```bash
npm install @arcforge/platform
```

Most people never install this directly. It arrives as a dependency of the Axon
framework when you scaffold an agent with `axon init`.

## Documentation

Full documentation is at **[axon.arclabs.it/docs/v2](https://axon.arclabs.it/docs/v2)**.

- [What is Axon?](https://axon.arclabs.it/docs/v2)
- [The CLI](https://axon.arclabs.it/docs/v2/cli)
- [The agent folder](https://axon.arclabs.it/docs/v2/agent/folder)

## License

Proprietary. © ArcLabs
