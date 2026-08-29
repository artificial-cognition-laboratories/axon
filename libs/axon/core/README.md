# @arcforge/core

The agent runtime for [Axon](https://axon.arclabs.it).

`Axon()` composes a blueprint, a kernel, a cognet, modules and a server into one running
agent. It is the thing the TUI runs, the CLI spawns, the Fleet extension attaches to, and
a deployed container boots — all through the same entry point or the HTTP surface it
builds.

`Axon()` is wiring only. It normalises the blueprint at one seam and hands the strict
shape down, so nothing below has to re-derive what the agent is. What you get back is a
handle you talk to, not a config you look things up in.

```bash
npm install @arcforge/core
```

Most people never install this directly. It arrives as a dependency of the Axon
framework when you scaffold an agent with `axon init`.

## Documentation

Full documentation is at **[axon.arclabs.it/docs/v2](https://axon.arclabs.it/docs/v2)**.

- [What is Axon?](https://axon.arclabs.it/docs/v2)
- [The runtime loop](https://axon.arclabs.it/docs/v2/concepts/runtime-loop)
- [Managed runtime](https://axon.arclabs.it/docs/v2/concepts/managed-runtime)

## License

Proprietary. © ArcLabs
