import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { err } from "@arcforge/err"
import { fsx } from "../../../../utils/fs"
import { writeIfChanged } from "../../../project/typegen/write"
import { rust } from "../schema"
import { cargo } from "./cargo"
import { library } from "./library"
import { manifest } from "./manifest"

export type CrateOpts = {
    /** The cognet's source directory. */
    sourceDir: string
    /** The agent compiling it: whose installed `@arcforge/cognet` the Rust runtime comes from. */
    agentRoot: string
    /** The agent frame's `cognet/native/`: the generated crate, its build, and the module it makes. */
    out: string
    /** Whether the cognet's source is its own — an installed cognet's `Cargo.lock` is read, never written back. */
    owned: boolean
}

/** One `.rs` file of the cognet: where it is, the module path it is mounted at, and — for a `*.system.rs` — the name it runs as. */
export type RustSource = { absPath: string; module: string[]; system: string | null }

/** Directories no source lives under: installed code and build output. */
const SKIP_DIRS = ["node_modules", ".git", ".cognet", ".agent", "target"]

/** Where, beside the bundle, the module sits — named for its content, which the generated entry loads relative to itself. */
export const NATIVE_DIR = "native"

/**
 * Crate — a cognet's Rust compiled into one native module.
 *
 * A cognet's Rust is written beside its TypeScript. The author's Cargo package
 * points at a generated library in the agent's frame, which mounts
 * every `.rs` file at the path it sits at, as the TypeScript is imported —
 * `lib/align/align.rs` is `crate::lib::align::align`, a sibling is `super::x`
 * — with the schemas' Rust (`schema.rs`, written by `Schema`) at
 * `crate::schema`, and the `[dependencies]` in the cognet's own `Cargo.toml`
 * lists. `cargo` builds it into a `.node` the generated entry loads — on the
 * main thread and in every worker — and `Discovered` makes each
 * `*.system.rs` an ordinary system. A cognet that lists crates keeps its
 * `Cargo.lock` beside its `Cargo.toml`, as `bun.lock` is.
 */
export function Crate(opts: CrateOpts) {
    const project = opts.out
    const workspace = join(project, "Cargo.toml")
    return {
        /** Every `.rs` file of the cognet, mounted by its path. None when it has none. */
        async sources(): Promise<RustSource[]> {
            const walked = await fsx.walk(opts.sourceDir, { skipDirs: SKIP_DIRS })
            const named = naming(opts.sourceDir)
            // A `*.components.rs` is a schema the build reads, never Rust it compiles: its types are generated at `crate::schema`.
            return walked.filter(file => file.relPath.endsWith(".rs") && !file.relPath.endsWith(".components.rs")).map(file => {
                const path = named(file.relPath).slice(0, -".rs".length)
                const module = path.split("/").map(rust.segment)
                if (module[0] === "schema") throw err("COGNET_NATIVE_FAILED", { detail: `${file.relPath}: nothing at a cognet's top level can be called schema — that is where its schemas' Rust is mounted` })
                return { absPath: file.absPath, module: module, system: path.endsWith(".system") ? path.slice(0, -".system".length) : null }
            })
        },

        /**
         * The module built from `sources`, named for its content
         * (`<hash>.node`) — so a process that loads a rebuilt one gets the new
         * code, where the same path would hand back the library already
         * loaded — and every other module beside it removed. The schemas'
         * Rust already at `src/schema.rs`. Throws `cargo`'s own words when it
         * cannot be built, and names `cargo` when it is not installed.
         */
        async build(sources: readonly RustSource[]): Promise<string> {
            const own = join(opts.sourceDir, "Cargo.toml")
            const runtime = join(dirname(Bun.resolveSync("@arcforge/cognet/rust/Cargo.toml", opts.agentRoot)), "cognet")
            if (opts.owned && !existsSync(own)) writeIfChanged(own, manifest.source(opts.sourceDir, opts.agentRoot, opts.out))
            if (opts.owned) {
                const config = join(opts.sourceDir, ".cargo", "config.toml")
                if (!existsSync(config)) {
                    mkdirSync(dirname(config), { recursive: true })
                    writeIfChanged(config, manifest.config(opts.sourceDir, opts.out))
                }
            }
            mkdirSync(join(project, "systems", "src"), { recursive: true })
            mkdirSync(join(project, "module", "src"), { recursive: true })
            for (const source of sources) mkdirSync(join(project, "systems", "src", ...source.module.slice(0, -1)), { recursive: true })
            const dependencies = manifest.dependencies(own, runtime, opts.owned)
            writeIfChanged(workspace, manifest.workspace(opts.owned))
            if (!opts.owned) writeIfChanged(join(project, "systems", "Cargo.toml"), manifest.systems(dependencies.text))
            writeIfChanged(join(project, "systems", "src", "lib.rs"), library.systems(sources, join(project, "systems", "src")))
            writeIfChanged(join(project, "module", "Cargo.toml"), manifest.module(dependencies.runtime, opts.owned ? opts.sourceDir : null))
            writeIfChanged(join(project, "module", "build.rs"), "fn main() {\n    napi_build::setup();\n}\n")
            writeIfChanged(join(project, "module", "src", "lib.rs"), library.module())
            const lock = join(opts.sourceDir, "Cargo.lock")
            if (!opts.owned && existsSync(lock)) copyFileSync(lock, join(project, "Cargo.lock"))

            const target = join(opts.out, "target")
            await cargo.build(workspace, target, sources)

            const built = join(target, "release", process.platform === "darwin" ? "libcognet_native.dylib" : "libcognet_native.so")
            if (!existsSync(built)) throw err("COGNET_NATIVE_FAILED", { detail: `cargo succeeded but left no ${built}` })
            const name = `${createHash("sha256").update(readFileSync(built)).digest("hex").slice(0, 16)}.node`
            mkdirSync(opts.out, { recursive: true })
            const module = join(opts.out, name)
            if (!existsSync(module)) copyFileSync(built, module)
            for (const old of readdirSync(opts.out).filter(entry => entry.endsWith(".node") && entry !== name)) rmSync(join(opts.out, old))
            return module
        },

        /** Where the schemas' Rust goes: the systems crate's `schema` module. */
        schema(): string {
            return join(project, "systems", "src", "schema.rs")
        },

        /** The crate and its module gone: a cognet with no Rust systems carries neither. */
        clear(): void {
            rmSync(opts.out, { recursive: true, force: true })
        },
    }
}

export type CrateT = ReturnType<typeof Crate>

/** The path a file is named by: under `src/` when the cognet keeps its code there, as components and systems are named. */
function naming(sourceDir: string): (relPath: string) => string {
    const nested = existsSync(join(sourceDir, "src"))
    return relPath => (nested && relPath.startsWith("src/") ? relPath.slice("src/".length) : relPath)
}
