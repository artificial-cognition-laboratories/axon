# @arcforge/capsule

The execution sandbox for the [Axon](https://axon.arclabs.it) agent runtime.

The bounded place an agent's own code runs: model-emitted TypeScript, the tools it calls,
the processes it spawns. Everything that happens inside is gated by policy and lands on
the event stream, so there is no path from a model's output to your machine that is not
both permitted and observable.

`Capsule()` is the single entry point, and its shape is the contract —
`run` / `exec` / `interrupt` / `process` / `scope` / `on` / `boot` / `shutdown`.

```bash
npm install @arcforge/capsule
```

Most people never install this directly. It arrives as a dependency of the Axon
framework when you scaffold an agent with `axon init`.

## Documentation

Full documentation is at **[axon.arclabs.it/docs/v2](https://axon.arclabs.it/docs/v2)**.

- [Kernel & Policy](https://axon.arclabs.it/docs/v2/concepts/kernel-and-policy)
- [Capabilities](https://axon.arclabs.it/docs/v2/concepts/capabilities)

## License

Proprietary. © ArcLabs
