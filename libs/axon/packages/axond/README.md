# @arcforge/axond

The machine-wide daemon for the [Axon](https://axon.arclabs.it) agent runtime.

One process per user, per machine, owning everything no single agent can own. Not an
inference server — inference is its first tenant, not its purpose. Four domains:

- **machine** — the GPU. Two agents deciding independently that 6GB is free is how both
  take it, so one process arbitrates.
- **agents** — every agent running here, in a registry that outlives the terminal that
  started one.
- **models** — one resident copy of a weight, however many agents hold it.
- **schedule** — boot-time agents and cron-style wakeups.

`Axond()` is the server; `AxonDaemon()` is the client handle, and both expose the same
four domains. The client is the SDK: `daemon.agents.at(id)` returns an instance handle
you can talk to, not a record you look things up in.

```bash
npm install @arcforge/axond
```

Most people never install this directly. It arrives with the Axon CLI, which keeps the
daemon running for you — `axon daemon status` to see it.

```ts
import { AxonDaemon } from "@arcforge/axond"

const daemon = AxonDaemon()

await daemon.machine.state()   // hardware, budget, what is held
await daemon.agents.list()     // every agent on this machine
await daemon.models.resident() // what is loaded right now
```

## Documentation

Full documentation is at **[axon.arclabs.it/docs/v2](https://axon.arclabs.it/docs/v2)**.

- [What is Axon?](https://axon.arclabs.it/docs/v2)
- [The CLI](https://axon.arclabs.it/docs/v2/cli)

## License

Proprietary. © ArcLabs
