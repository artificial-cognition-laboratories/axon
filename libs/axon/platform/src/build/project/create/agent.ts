import { join } from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { err } from "@arcforge/err"
import { resolveDefaultBaseUrl } from "@arcforge/cloud"
import { fsx } from "../../../utils/fs"
import {
    AGENT_CONFIG_TEMPLATE,
    BOOT_VUE,
    BUNFIG_TEMPLATE,
    GITIGNORE_TEMPLATE,
    PACKAGE_JSON_TEMPLATE,
} from "./templates"
import { bareName, type ScaffoldOpts } from "../kinds"

/**
 * Scaffold a new agent at <dir>/<name>/. Refuses to overwrite an existing
 * directory. Returns the agent root.
 *
 * Source only — the .agent/ frame and the tsconfigs pointing at it are
 * prepare()'s, written after dependencies are installed.
 *
 * DELIBERATELY MINIMAL: an agent is its config plus its boot, and nothing
 * else is written until the author asks for it. Every surface an agent CAN
 * have (src/tools, src/scripts, server/api, modules, data/knowledge, tests)
 * is discovered by scanning a directory that may not exist — fsx.list()
 * returns [] on ENOENT — so an empty folder and an absent one mean the same
 * thing to the runtime. Scaffolding them anyway bought nothing and made a
 * new agent read like a framework the author had to grow into. `data/` is
 * absent for the same reason: the session writer mkdirs its own parent.
 *
 * `apiBase` becomes the agent's registry URL in bunfig.toml, defaulting to
 * whatever backend this process talks to — so an agent scaffolded against
 * local staging installs from local staging.
 */
export async function scaffoldAgent(opts: ScaffoldOpts): Promise<string> {
    const root = join(opts.dir, bareName(opts.name))
    if (fsx.exists(root)) {
        throw err("PROJECT_EXISTS", { detail: `${root} already exists`, context: { root } })
    }

    await mkdir(join(root, "src"), { recursive: true })

    await Promise.all([
        writeFile(join(root, "axon.config.ts"), AGENT_CONFIG_TEMPLATE()),
        writeFile(join(root, "src", "boot.vue"), BOOT_VUE),
        writeFile(join(root, ".gitignore"), GITIGNORE_TEMPLATE),
        writeFile(join(root, "package.json"), PACKAGE_JSON_TEMPLATE(opts.name, opts.frameworkVersion)),
        writeFile(join(root, "bunfig.toml"), BUNFIG_TEMPLATE(opts.apiBase ?? resolveDefaultBaseUrl())),
    ])

    return root
}
