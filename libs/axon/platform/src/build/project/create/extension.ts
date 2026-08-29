import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { err } from "@arcforge/err"
import { fsx } from "../../../utils/fs"
import { bareName, type ScaffoldOpts } from "../kinds"

const PACKAGE_TEMPLATE = (name: string, version: string): string => `${JSON.stringify(
    {
        name,
        version: "0.1.0",
        private: false,
        type: "module",
        dependencies: {
            "@arcforge/types": version,
            "@types/bun": "^1.2.0",
        },
    },
    null,
    4,
)}\n`

/**
 * Empty, and that is the whole file.
 *
 * It marks the directory as an extension — a kind is identified by its config
 * file, and `main.ts` cannot be that marker since a profile has one too.
 * Behaviour lives in main.ts, identity in package.json.
 */
const CONFIG_TEMPLATE = `export default defineExtension({})\n`

const MAIN_TEMPLATE = (name: string): string => `// Everything here is typed — try \`commands.\` or \`palette.\`.
//
// This is the same file a user writes in their own profile: an extension is a
// main.ts, packaged. Split it up with an import whenever you like, and put
// lifecycle hooks (boot, shutdown, agent:ready) in plugins/.

commands.register("${bareName(name)}", {
    async run() {
        tui.info("hello from ${bareName(name)}")
    },
    description: "An example command",
})
`

/**
 * Scaffold an extension — a published, installable unit of TUI behaviour.
 *
 * The same layout as a profile: a main.ts that registers, and a plugins/ folder
 * that hooks. That is not a coincidence to be tidied away — it is the design.
 */
export async function scaffoldExtension(input: ScaffoldOpts): Promise<string> {
    const root = join(input.dir, bareName(input.name))
    if (fsx.exists(root)) throw err("PROJECT_EXISTS", { context: { path: root } })

    await mkdir(join(root, "plugins"), { recursive: true })
    await Promise.all([
        writeFile(join(root, "package.json"), PACKAGE_TEMPLATE(input.name, input.frameworkVersion)),
        writeFile(join(root, "extension.config.ts"), CONFIG_TEMPLATE),
        writeFile(join(root, "main.ts"), MAIN_TEMPLATE(input.name)),
    ])

    return root
}
