# @arcforge/cloud

The client for [Axon Cloud](https://axon.arclabs.it) — the managed side of the Axon
agent runtime.

One handle over the whole hosted surface: your account and API keys, the artifact
registry, deployed agents, engine resolution, releases, and error reporting.
`AxonCloud()` composes them and you descend — `cloud.user.billing`, `cloud.registry`,
`cloud.agents` — rather than assembling endpoints yourself.

Construction does no network work. A missing credential fails at the call that needs it,
so browsing the public registry works signed out and only the operations that genuinely
require an account ask for one.

```bash
npm install @arcforge/cloud
```

Most people never install this directly. It arrives as a dependency of the Axon
framework when you scaffold an agent with `axon init`.

## Documentation

Full documentation is at **[axon.arclabs.it/docs/v2](https://axon.arclabs.it/docs/v2)**.

- [Axon Cloud](https://axon.arclabs.it/docs/v2/deploy/axon-cloud)
- [Deploying](https://axon.arclabs.it/docs/v2/deploy)
- [Connecting](https://axon.arclabs.it/docs/v2/deploy/connecting)

## License

Proprietary. © ArcLabs
