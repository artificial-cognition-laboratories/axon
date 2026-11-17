import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { createFileRegistry, fromBinary, type FileRegistry } from "@bufbuild/protobuf"
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt"
import { err } from "@arcforge/err"

/** One schema of the cognet's: where it is, and the path it is imported and named by. */
export type Source = { absPath: string; named: string; content?: string }

/** The runtime's own schema, as every cognet schema imports it. */
const RUNTIME = "cognet/cognet.proto"

/**
 * Compile — a cognet's schemas into one image: every file, its types, its
 * options and its comments. Plain functions over the filesystem and `buf`.
 *
 * The schemas are staged first, each at the path it is NAMED by (its path
 * under `src/`, as components are named), beside the runtime's own
 * `cognet/cognet.proto` from the `@arcforge/cognet` the agent runs — so a
 * schema imports another as `import "control/control.proto"` and the
 * runtime's as `import "cognet/cognet.proto"`, wherever either lives on disk.
 */
export const compile = {
    /** `stage` emptied and refilled: the cognet's schemas, and the runtime's, from `agentRoot`'s installed `@arcforge/cognet`. */
    stage(stage: string, sources: readonly Source[], agentRoot: string): void {
        rmSync(stage, { recursive: true, force: true })
        mkdirSync(stage, { recursive: true })
        const runtime = runtimeSchema(agentRoot)
        const runtimeAt = join(stage, RUNTIME)
        mkdirSync(dirname(runtimeAt), { recursive: true })
        copyFileSync(runtime, runtimeAt)
        for (const source of sources) {
            const at = join(stage, source.named)
            mkdirSync(dirname(at), { recursive: true })
            if (source.content !== undefined) writeFileSync(at, source.content)
            else copyFileSync(source.absPath, at)
        }
        // `cognet` names a runtime, not an API with versions: its compatibility is the cognet ABI's.
        writeFileSync(join(stage, "buf.yaml"), "version: v2\nlint:\n  use: [STANDARD]\n  except: [PACKAGE_VERSION_SUFFIX, PACKAGE_DIRECTORY_MATCH]\n")
    },

    /** Every staged schema compiled, with source info: what each says, and the comments that say why. Throws with `buf`'s own words. */
    image(stage: string): FileRegistry {
        const out = join(stage, "image.binpb")
        const run = Bun.spawnSync([buf(), "build", stage, "-o", out], { stderr: "pipe", stdout: "pipe" })
        if (run.exitCode !== 0) {
            throw err("COGNET_SCHEMA_INVALID", { detail: `${new TextDecoder().decode(run.stderr).trim()}`, context: { stage: stage } })
        }
        return createFileRegistry(fromBinary(FileDescriptorSetSchema, readFileSync(out)))
    },
}

/**
 * The runtime's `cognet.proto`, from the `@arcforge/cognet` installed for `agentRoot`.
 *
 * Found on disk rather than through `Bun.resolveSync`, because Bun's resolver
 * caches directory lookups for the life of the process: a process that
 * resolved from `agentRoot` before its install (the TUI, Fleet, the test
 * runner — anything that scaffolds and then compiles) is told the package
 * does not exist after it does.
 */
function runtimeSchema(agentRoot: string): string {
    for (let dir = resolve(agentRoot); ; dir = dirname(dir)) {
        const pkg = join(dir, "node_modules", "@arcforge", "cognet")
        if (existsSync(join(pkg, "package.json"))) {
            const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf-8")) as { exports?: Record<string, string> }
            const entry = manifest.exports?.["./proto/cognet.proto"]
            if (!entry) throw err("COGNET_RUNTIME_UNAVAILABLE", { detail: `${pkg} does not export ./proto/cognet.proto — it predates cognet schemas` })
            return join(pkg, entry)
        }
        if (dirname(dir) === dir) throw err("COGNET_RUNTIME_UNAVAILABLE", { detail: `@arcforge/cognet is not installed for ${agentRoot}` })
    }
}

/** The `buf` this platform was installed with. */
function buf(): string {
    return Bun.resolveSync("@bufbuild/buf/bin/buf", import.meta.dir)
}
