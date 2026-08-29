# @arcforge/theme

The shared palette and syntax theme for the [Axon](https://axon.arclabs.it) agent runtime.

One source of truth for Arcnight — the Shiki-compatible TextMate theme — and the Axon UI
colour palette. Consumed by the terminal's highlighter, the Fleet extension's webviews,
and every other surface that has to look like Axon.

A theme is data, not a stylesheet: it ships as plain objects, so a consumer can hand it
to Shiki, read individual tokens for its own chrome, or render the same colours in a
terminal that has never heard of CSS.

```bash
npm install @arcforge/theme
```

Most people never install this directly. It arrives as a dependency of the Axon
framework when you scaffold an agent with `axon init`.

## Documentation

Full documentation is at **[axon.arclabs.it/docs/v2](https://axon.arclabs.it/docs/v2)**.

- [What is Axon?](https://axon.arclabs.it/docs/v2)
- [The TUI](https://axon.arclabs.it/docs/v2/tui)

## License

Proprietary. © ArcLabs
