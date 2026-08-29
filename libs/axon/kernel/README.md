# @arcforge/kernel

The kernel of the [Axon](https://axon.arclabs.it) agent runtime — ring 0.

An Axon agent runs as its own OS process, and everything it does happens inside that one
box. The kernel is the trusted core: it owns the machine-facing operations, enforces
policy, and is the only constructor of the unprivileged capsule that agent code runs in.

Policy is declared in two places — a profile sets the ceiling for a machine, an agent
narrows within it — and enforced by two layers: the kernel mediating every syscall, and
OS-level confinement (namespaces and cgroups) bounding the process itself.

```bash
npm install @arcforge/kernel
```

Most people never install this directly. It arrives as a dependency of the Axon
framework when you scaffold an agent with `axon init`.

## Documentation

Full documentation is at **[axon.arclabs.it/docs/v2](https://axon.arclabs.it/docs/v2)**.

- [Kernel & Policy](https://axon.arclabs.it/docs/v2/concepts/kernel-and-policy)
- [Policy](https://axon.arclabs.it/docs/v2/agent/policy)
- [The Agent's World](https://axon.arclabs.it/docs/v2/concepts/agents-world)
- [Escalations](https://axon.arclabs.it/docs/v2/tui/escalations)

## License

Proprietary. © ArcLabs
