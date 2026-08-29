#!/usr/bin/env bun
import { Axond } from "../src/axond"
import { Cli } from "../src/control/index"
import packageJson from "../package.json" with { type: "json" }

/**
 * `axond` — what the OS execs.
 *
 * Deliberately thin: parse one verb, call the CLI, print, exit. Everything it
 * does is `Cli()`'s, which is also what `axon daemon <verb>` calls — so the
 * two entry points cannot drift into two behaviours.
 *
 * This file is the ENTRYPOINT a detached start re-execs, which is why it is
 * handed to `Axond()` rather than derived there: a module resolving its own
 * path finds itself, not the binary.
 */
const axond = Axond({
    version: packageJson.version,
    entrypoint: import.meta.path,
})

const cli = Cli({ axond: axond })
const verb = process.argv[2]

try {
    switch (verb) {
        case "up":
            console.log(await cli.up(process.argv.includes("--json")))
            break
        case "down":
            console.log(cli.down())
            break
        case "status":
            console.log(cli.status())
            break
        case "machine":
            console.log(cli.machine())
            break
        case "agents":
            console.log(cli.agents())
            break
        case "disable":
            console.log(cli.disable())
            break
        case "serve":
            // Does not return: the process IS the daemon from here.
            await cli.serve()
            break
        default:
            console.log(cli.help())
            // An unknown verb is a usage error, not a success — a script that
            // typos one must not read the help text as everything being fine.
            if (verb !== undefined) process.exit(1)
    }
} catch (cause) {
    console.error(cli.failure(cause))
    process.exit(1)
}
