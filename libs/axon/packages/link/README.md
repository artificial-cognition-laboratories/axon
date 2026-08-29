# @arcforge/link

The supervisor ↔ agent transport for the [Axon](https://axon.arclabs.it) agent runtime.

An Axon agent runs inside an OS-level box — its own process, with its own namespaces
and filesystem view. `link` is the length-prefixed protocol over unix sockets that the
supervisor and the confined agent speak across that boundary.

Two channels, so an interrupt never queues behind the inference it exists to stop. The
provider credential stays supervisor-side and never enters the box: the agent names a
role and never sees a model, a provider, or a key.

```bash
npm install @arcforge/link
```

Most people never install this directly. It arrives as a dependency of the Axon
framework when you scaffold an agent with `axon init`.

## Documentation

Full documentation is at **[axon.arclabs.it/docs/v2](https://axon.arclabs.it/docs/v2)**.

- [Kernel & Policy](https://axon.arclabs.it/docs/v2/concepts/kernel-and-policy)
- [Policy](https://axon.arclabs.it/docs/v2/agent/policy)

## License

Proprietary. © ArcLabs
