# @arcforge/types

Shared type definitions for the [Axon](https://axon.arclabs.it) agent runtime.

This is the leaf of the Axon dependency graph — every other package depends on it,
and it depends on nothing. It holds the contracts that cross package boundaries:
the agent handle, engine connections, policy shapes, and the session event vocabulary.

```bash
npm install @arcforge/types
```

Most people never install this directly. It arrives as a dependency of the Axon
framework when you scaffold an agent with `axon init`.

## Documentation

Full documentation is at **[axon.arclabs.it/docs/v2](https://axon.arclabs.it/docs/v2)**.

- [What is Axon?](https://axon.arclabs.it/docs/v2)
- [The axon API](https://axon.arclabs.it/docs/v2/api)
- [Policy](https://axon.arclabs.it/docs/v2/agent/policy)

## License

Proprietary. © ArcLabs
