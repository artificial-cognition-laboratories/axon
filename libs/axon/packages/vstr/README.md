# @arcforge/vstr

Vue SFC as a prompt template language, for the [Axon](https://axon.arclabs.it) agent runtime.

Prompts are components. A `.vue` or `.prompt` file is parsed, its script setup executed,
its template server-rendered, and the result converted to the target format — so a prompt
can fetch its own data, branch on it, and compose other prompts by importing them.

Context arrives by injection rather than props: the host puts globals like `axon` into
the script setup scope, which is what lets a prompt read the agent it belongs to without
being handed a bag of arguments. Relative imports resolve recursively, and the render
cache is keyed by absolute path.

```bash
npm install @arcforge/vstr
```

Most people never install this directly. It arrives as a dependency of the Axon
framework when you scaffold an agent with `axon init`.

## Documentation

Full documentation is at **[axon.arclabs.it/docs/v2](https://axon.arclabs.it/docs/v2)**.

- [Vuedown](https://axon.arclabs.it/docs/v2/concepts/vuedown)
- [The AIR format](https://axon.arclabs.it/docs/v2/concepts/air-format)

## License

Proprietary. © ArcLabs
