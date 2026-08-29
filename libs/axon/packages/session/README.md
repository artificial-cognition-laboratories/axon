# @arcforge/session

The durable session log for the [Axon](https://axon.arclabs.it) agent runtime.

Every layer of the Axon stack reads and writes through one append-only event log. A
session is the record of what an agent did — every tick, every tool call, every engine
exchange — durable on disk and replayable afterward.

Because the log is the source of truth rather than a side effect, the terminal, the
Fleet debugger and an attached cloud deployment all render the same run from the same
events.

```bash
npm install @arcforge/session
```

Most people never install this directly. It arrives as a dependency of the Axon
framework when you scaffold an agent with `axon init`.

## Documentation

Full documentation is at **[axon.arclabs.it/docs/v2](https://axon.arclabs.it/docs/v2)**.

- [State & Memory](https://axon.arclabs.it/docs/v2/concepts/state-model)
- [Events](https://axon.arclabs.it/docs/v2/api/events)
- [The event log](https://axon.arclabs.it/docs/v2/fleet/debugging/events)

## License

Proprietary. © ArcLabs
