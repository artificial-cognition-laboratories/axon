# @arcforge/arcline

Unified CLI rendering for the [Axon](https://axon.arclabs.it) agent runtime.

Three layers: escape sequences, width arithmetic and a theme-bound palette at the core;
a composable vocabulary of components — header, rows, tree, table, status, error report —
above it; and whole Axon surfaces composed from those.

Purity is the load-bearing property. A view returns a string rather than printing, so it
can be snapshot-tested, composed into a larger frame, or repainted by a live surface.
Interactive surfaces — spinners, progress, prompts — are the one exception and are a
different kind: they own the cursor and have a lifecycle, so they are handles rather
than functions.

```bash
npm install @arcforge/arcline
```

Most people never install this directly. It arrives as a dependency of the Axon
framework when you scaffold an agent with `axon init`.

## Documentation

Full documentation is at **[axon.arclabs.it/docs/v2](https://axon.arclabs.it/docs/v2)**.

- [The CLI](https://axon.arclabs.it/docs/v2/cli)
- [The TUI](https://axon.arclabs.it/docs/v2/tui)

## License

Proprietary. © ArcLabs
