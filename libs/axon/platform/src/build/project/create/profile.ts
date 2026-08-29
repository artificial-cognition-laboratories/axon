import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fsx } from "../../../utils/fs"
import type { ScaffoldOpts } from "../kinds"

/**
 * A profile's manifest.
 *
 * `@arcforge/types` is a real dependency, pinned to the running CLI's version
 * and resolved from the REGISTRY — a profile lives under ~/.axon, outside any
 * workspace, so `workspace:*` cannot resolve there. It exists to make
 * `tsconfig.base.json` (which the type frame extends) resolvable.
 *
 * `@types/bun` is declared OUTRIGHT rather than inherited through it: the base
 * config sets `"types": ["bun"]`, an explicit `types` field disables automatic
 * @types discovery, and a `file:`-linked dependency does not bring its own
 * dependencies with it. Without this line a user's plugin loses `Bun`,
 * `process` and `fetch`, and every symbol degrades to any. prepare() declares
 * the same pair (see FrameworkSet) — this is only what a first boot starts
 * from.
 */
const PACKAGE_TEMPLATE = (version: string): string => `${JSON.stringify(
    {
        name: "axon-profile",
        private: true,
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
 * The user's config entry point.
 *
 * Deliberately near-empty. This is the first file a person opens, and a wall of
 * commented-out examples is a worse introduction than three lines and working
 * autocomplete — every global is typed, so `commands.` in an editor is a better
 * tour than anything written here.
 */
const MAIN_TEMPLATE = `// Your Axon config. Everything here is typed — try \`commands.\` or \`palette.\`.
//
// Split it up whenever you like; an import is all it takes:
//
//     import "./keybindings"
//
// Lifecycle hooks (boot, shutdown, agent:ready) go in plugins/ — every file
// in that folder loads automatically.

commands.register("hello", {
    async run() {
        tui.info("hello from main.ts")
    },
    description: "An example command",
})
`

const CONFIG_TEMPLATE = `export default defineProfile({
    // Extensions load in this order. A registry name ("@axon/vim") is fetched
    // and installed; a path ("./extensions/mine") is used where it sits.
    extensions: [],
})
`

/**
 * Scaffold a profile — the user's own Axon directory.
 *
 * Unlike every other kind this is never run by a person: it fires on boot for
 * whoever logs in, so it must be safe to call against a directory that already
 * half-exists. Each file is written only if absent, and nothing is ever
 * overwritten — a user's main.ts is theirs, and a profile that gained
 * plugins/ in a later release should acquire the missing folder without
 * touching what was already there.
 */
export async function scaffoldProfile(input: ScaffoldOpts): Promise<string> {
    const root = input.dir

    // `extensions/` is deliberately NOT created. An install makes it when there
    // is something to put in it, and a user who writes their own extends
    // main.ts or drops a file in plugins/. Scaffolding it empty on every boot
    // advertised a directory most profiles never use, and an empty folder that
    // reappears after you delete it reads as the tool not listening.
    await mkdir(join(root, "plugins"), { recursive: true })
    await mkdir(join(root, "store"), { recursive: true })

    await Promise.all([
        write(join(root, "package.json"), PACKAGE_TEMPLATE(input.frameworkVersion)),
        write(join(root, "main.ts"), MAIN_TEMPLATE),
        write(join(root, "profile.config.ts"), CONFIG_TEMPLATE),
    ])

    return root
}

/** Write only when absent. Never clobbers a file the user may have edited. */
async function write(path: string, contents: string): Promise<void> {
    if (fsx.exists(path)) return
    await writeFile(path, contents)
}
