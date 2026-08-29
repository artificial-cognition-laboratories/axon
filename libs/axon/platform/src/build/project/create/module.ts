import { join } from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { err } from "@arcforge/err"
import { fsx } from "../../../utils/fs"
import { MODULE_CONFIG_TEMPLATE } from "./templates"
import { bareName, type ScaffoldOpts } from "../kinds"

/**
 * Scaffold a new module. Inside an agent (dir has axon.config.ts) it lands
 * at <dir>/modules/<name>/; standalone at <dir>/<name>/. Returns the
 * module root.
 *
 * Source only — the .module/ frame (axon.d.ts + tsconfig) is prepare()'s.
 */
export async function scaffoldModule(opts: ScaffoldOpts): Promise<string> {
    const insideAgent = fsx.exists(join(opts.dir, "axon.config.ts"))
    const root = insideAgent
        ? join(opts.dir, "modules", bareName(opts.name))
        : join(opts.dir, bareName(opts.name))
    if (fsx.exists(root)) {
        throw err("PROJECT_EXISTS", { detail: `${root} already exists`, context: { root } })
    }

    await Promise.all([
        mkdir(join(root, "src", "tools"), { recursive: true }),
        mkdir(join(root, "src", "prompts"), { recursive: true }),
        mkdir(join(root, "server", "api"), { recursive: true }),
    ])

    const pkg = JSON.stringify(
        { name: opts.name, version: "0.1.0", description: "", type: "module", private: false },
        null,
        2
    ) + "\n"

    await Promise.all([
        writeFile(join(root, "module.config.ts"), MODULE_CONFIG_TEMPLATE()),
        writeFile(join(root, "package.json"), pkg),
        writeFile(join(root, ".gitignore"), "node_modules/\n.module/\n"),
    ])

    return root
}
