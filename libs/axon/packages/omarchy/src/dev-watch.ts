/**
 * The watch stream, straight from source.
 *
 * A development entry point only: the published CLI is what a user runs, and
 * this exists so the plugin can be exercised against a source checkout before
 * a build carrying `axon daemon watch` exists. Point the service at it with
 *
 *   AXON_OMARCHY_WATCH="exec bun <this file>"
 *
 * It emits exactly what `axon daemon watch --json` emits, because it is the
 * same call.
 */
import { Axond } from "../../axond/src/axond"
import { Cli } from "../../axond/src/control/cli"

const axond = Axond({})
const cli = Cli({ axond })

const stop = await cli.watch(line => { console.log(line) })
const end = () => { stop(); process.exit(0) }
process.on("SIGINT", end)
process.on("SIGTERM", end)
await new Promise(() => {})
