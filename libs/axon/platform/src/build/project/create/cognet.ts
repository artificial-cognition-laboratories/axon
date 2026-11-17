import { join } from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { err } from "@arcforge/err"
import { fsx } from "../../../utils/fs"
import { INLINE_COGNET_DIR } from "../../blueprint/cognet"
import { bareName, type ScaffoldOpts } from "../kinds"

const CONFIG_TEMPLATE = (name: string) => `// ${name} — what this brain declares.
//
// Identity comes from package.json; behaviour from its systems — every
// *.system.ts under src/. The kernel ABI is stamped in at compile time, so
// there is nothing to pin unless you want this brain to REFUSE a kernel it
// has not been validated against.
export default defineCognet({
    // Wakes when a stimulus arrives. A mind that must keep acting whether or
    // not the world spoke declares { kind: "continuous", hz } instead.
    mode: { kind: "invocation" },
})
`

const SCHEMA_TEMPLATE = (name: string) => `// What ${name} believes about the room. Components are declared here, in no
// language: \`axon prepare\` generates the TypeScript (and Rust) types and
// handles, imported as #schema/sense/sense.
syntax = "proto3";

package ${protoPackage(name)}.sense;

import "cognet/cognet.proto";

// A temperature, and when it was felt.
message Reading {
  double celsius = 1;
  double at = 2;
}

message Components {
  option (cognet.components) = true;

  // The newest temperature the room reported. act/ reads it.
  Reading temperature = 1;
}
`

const FEEL_TEMPLATE = `import { temperature } from "#schema/sense/sense"

/**
 * Feel — the newest temperature the body reported, as a belief.
 *
 * Reads stimuli: every one since this system last ran, so nothing that
 * arrived is missed. Writes the belief only; deciding what to do about it is
 * another system's.
 */
export default defineSystem({
    reads: [stimuli],
    writes: [temperature],

    run({ stimuli }) {
        for (const stimulus of stimuli) {
            if (stimulus.type !== "cognet:stimulus:vector" || stimulus.data.channel !== "/temperature") continue
            ecs.set({
                id: "room",
                components: { temperature: { celsius: stimulus.data.values[0]!, at: stimulus.time.ms } },
            })
        }
    },
})
`

const HEAT_TEMPLATE = `import { temperature } from "#schema/sense/sense"

const SETTINGS = { target: 21 }

/**
 * Heat — turn the heater on below the target, off above it.
 *
 * Runs after feel, and only when the temperature changed: it reads what feel
 * writes, and the schedule derives both from that alone.
 */
export default defineSystem({
    reads: [temperature],

    async run() {
        const [room] = ecs.query({ components: ["temperature"] })
        if (!room) return
        await kernel.output("cognet:output:vector", {
            channel: "/heater",
            values: [room.temperature.celsius < SETTINGS.target ? 1 : 0],
        })
    },
})
`

/**
 * Scaffold a new cognet. Returns its root.
 *
 * Standalone at <dir>/<name>/, or INLINE at <agent>/cognet/ when run from an
 * agent root — where the folder itself is the declaration and the agent needs
 * no `cognet:` line. See INLINE_COGNET_DIR.
 *
 * Source only. The generated frame (the authoring globals + tsconfig) is
 * prepare()'s to write, and can only be written once dependencies are on disk
 * — writing it here is what made `axon cognet init` fail its own
 * FRAMEWORK_NOT_INSTALLED assert on a directory created moments earlier.
 */
export async function scaffoldCognet(opts: ScaffoldOpts): Promise<string> {
    // Inside an agent, the brain lands at <agent>/cognet/ and IS that agent's
    // — the folder is the declaration, so nothing is written into
    // axon.config.ts. Standalone, it lands at <dir>/<name>/ like every other
    // kind. Mirrors scaffoldModule(), which reads the same way.
    const insideAgent = fsx.exists(join(opts.dir, "axon.config.ts"))
    const root = insideAgent
        ? join(opts.dir, INLINE_COGNET_DIR)
        : join(opts.dir, bareName(opts.name))
    if (fsx.exists(root)) {
        throw err("PROJECT_EXISTS", { detail: `${root} already exists`, context: { root } })
    }

    await mkdir(join(root, "src", "sense"), { recursive: true })
    await mkdir(join(root, "src", "act"), { recursive: true })

    const files: Promise<unknown>[] = [
        writeFile(join(root, "cognet.config.ts"), CONFIG_TEMPLATE(opts.name)),
        writeFile(join(root, "src", "sense", "sense.proto"), SCHEMA_TEMPLATE(opts.name)),
        writeFile(join(root, "src", "sense", "feel.system.ts"), FEEL_TEMPLATE),
        writeFile(join(root, "src", "act", "heat.system.ts"), HEAT_TEMPLATE),
    ]

    // A standalone cognet is a package: it has an identity to publish, its own
    // dependencies, and its own generated frame to ignore. An inline one is
    // none of those — it is part of the agent, compiled from the agent's
    // node_modules and shipped inside the agent's bundle. Giving it a
    // package.json would declare a second publishable package in one project.
    if (!insideAgent) {
        files.push(
            writeFile(join(root, "package.json"), JSON.stringify(
                { name: opts.name, version: "0.1.0", description: "", type: "module", private: false },
                null,
                2,
            ) + "\n"),
            writeFile(join(root, ".gitignore"), "node_modules/\n.cognet/\n"),
        )
    }

    await Promise.all(files)

    return root
}

/** A cognet name as a proto package segment: lowercase letters, digits and underscores, starting with a letter. */
function protoPackage(name: string): string {
    const bare = bareName(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
    return /^[a-z]/.test(bare) ? bare : `cognet_${bare}`
}
