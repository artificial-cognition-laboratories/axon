# @arcforge/cognet

The cognet authoring surface for the [Axon](https://axon.arclabs.it) agent runtime.

A cognet is an agent's brain — the loop that decides what happens on every wake. It is
compiled, versioned and swappable: change the cognet and the agent thinks differently
without a line of its own code changing.

A cognet declares exactly one `loop()`, reaches the world through the `kernel` syscall
table, and names engines by **role** rather than by model. Which model fills a role is
decided at boot against whatever providers the user declared.

```bash
npm install @arcforge/cognet
```

Most people never install this directly. It arrives as a dependency of the Axon
framework when you scaffold an agent with `axon init`.

## Documentation

Full documentation is at **[axon.arclabs.it/docs/v2](https://axon.arclabs.it/docs/v2)**.

- [loop](https://axon.arclabs.it/docs/v2/cognets/api/loop)
- [kernel](https://axon.arclabs.it/docs/v2/cognets/api/kernel)
- [kernel.engine](https://axon.arclabs.it/docs/v2/cognets/api/engine)
- [kernel.store](https://axon.arclabs.it/docs/v2/cognets/api/store)

## License

Proprietary. © ArcLabs
