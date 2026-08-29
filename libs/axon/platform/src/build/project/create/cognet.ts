import { join } from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { err } from "@arcforge/err"
import { fsx } from "../../../utils/fs"
import { INLINE_COGNET_DIR } from "../../blueprint/cognet"
import { bareName, type ScaffoldOpts } from "../kinds"

const CONFIG_TEMPLATE = (name: string) => `// ${name} — what this brain declares.
//
// Identity comes from package.json and behavior from src/main.ts; the compile
// step composes the three. The kernel ABI is stamped in at compile time, so
// there is nothing to pin unless you want this brain to REFUSE a kernel it
// has not been validated against.
export default defineCognet({
    mode: { kind: "invocation" },
})
`

const MAIN_TEMPLATE = (name: string) => `// ${name} — a raw script: this file IS the brain.
//
// Runs once at load(), with the ambient globals live (kernel, loop, phase,
// system, blueprint — typed by the generated frame, run \`axon prepare\`).
// Module scope is resident RAM: alive across wakes, rebuildable from the
// log, gone without loss on kill -9 — never authoritative.

loop(async ({ stimuli, signal, stop }) => {
    await phase("sense", async () => {
        // one deterministic fold: new entries → your own resident model.
        // kernel.store.session.get({ after: seq }) is the same door for
        // cold-boot hydration and steady-state diffs — the equivalence
        // that makes kill -9 free.
    })

    await phase("think", async () => {
        // strategy. yours. the kernel has no opinion past this comment.
        // const messages = ...render from your model...
        // for await (const event of kernel.stream({ messages, signal })) { ... }
    })

    await phase("act", async () => {
        // effects leave ONLY through the two verbs:
        //   kernel.output(type, data)  — unmediated emission (chunk: {of, final} to stream)
        //   kernel.run(code)           — mediated capsule execution, committed for you
    })

    // quiescent? nothing pending → this wake is over. the brain stays warm.
    stop()
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

    await mkdir(join(root, "src"), { recursive: true })

    const files: Promise<unknown>[] = [
        writeFile(join(root, "cognet.config.ts"), CONFIG_TEMPLATE(opts.name)),
        writeFile(join(root, "src", "main.ts"), MAIN_TEMPLATE(opts.name)),
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
