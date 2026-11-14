# @arcforge/cognet

The cognet authoring surface for the [Axon](https://axon.arclabs.it) agent runtime.

A cognet is an agent's brain — the loop that decides what happens on every wake. It is
compiled, versioned and swappable: change the cognet and the agent thinks differently
without a line of its own code changing.

A cognet is a world and the systems that change it: components declared in `.proto`
schemas, systems in TypeScript or Rust that each declare what they read and write, and the
`kernel` syscall table as its one door to anything outside. It names engines by **role**
rather than by model; which model fills a role is decided at boot against whatever providers
the user declared.

```bash
npm install @arcforge/cognet
```

Most people never install this directly. It arrives as a dependency of the Axon
framework when you scaffold an agent with `axon init`.

## Documentation

Full documentation is at **[axon.arclabs.it/docs/v2](https://axon.arclabs.it/docs/v2)**.

- [Systems](https://axon.arclabs.it/docs/v2/cognets/engine/systems)
- [defineSystem](https://axon.arclabs.it/docs/v2/cognets/api/define-system)
- [ecs](https://axon.arclabs.it/docs/v2/cognets/api/ecs)
- [kernel](https://axon.arclabs.it/docs/v2/cognets/api/kernel)
- [kernel.engine](https://axon.arclabs.it/docs/v2/cognets/api/engine)
- [kernel.store](https://axon.arclabs.it/docs/v2/cognets/api/store)

## License

Proprietary. © ArcLabs
