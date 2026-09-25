import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { err } from "@arcforge/err"
import type { ModelRuntime } from "./types"

type RuntimeId = Exclude<ModelRuntime, "ollama">

type RuntimeSpec = {
    id: RuntimeId
    package: string
    version: string
    module: string
}

type RuntimeManifest = RuntimeSpec & {
    installedAt: string
    platform: string
    arch: string
}

const SPECS: Record<RuntimeId, RuntimeSpec> = {
    onnx: { id: "onnx", package: "onnxruntime-node", version: "1.29.0", module: "onnxruntime-node" },
    "llama.cpp": { id: "llama.cpp", package: "node-llama-cpp", version: "3.20.0", module: "node-llama-cpp" },
    transformers: { id: "transformers", package: "@huggingface/transformers", version: "4.2.0", module: "@huggingface/transformers" },
}

export type RuntimeState = {
    id: RuntimeId
    package: string
    version: string
    installed: boolean
    path: string
}

export type RuntimesOpts = {
    root?: string
    run?: (command: string[], cwd: string) => Promise<{ ok: boolean; output: string }>
}

/**
 * Runtimes — optional native/local inference packages, owned by Axon rather
 * than the package manager that installed the CLI. Every environment is
 * versioned and lives below ~/.axon/runtimes; interrupted installs remain in
 * staging and never read as usable.
 */
export function Runtimes(opts: RuntimesOpts = {}) {
    const root = opts.root ?? process.env.AXON_RUNTIMES_DIR ?? join(homedir(), ".axon", "runtimes")
    const staging = join(root, ".staging")
    const installing = new Map<RuntimeId, Promise<RuntimeState>>()

    function spec(id: RuntimeId): RuntimeSpec {
        return SPECS[id]
    }

    function directory(id: RuntimeId): string {
        const entry = spec(id)
        return join(root, id.replace(".", "-"), entry.version)
    }

    function modulePath(id: RuntimeId, module: string): string {
        return join(directory(id), "node_modules", ...module.split("/"))
    }

    function installed(id: RuntimeId): RuntimeState {
        const entry = spec(id)
        return { id, package: entry.package, version: entry.version, installed: existsSync(modulePath(id, entry.module)), path: directory(id) }
    }

    async function execute(command: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
        if (opts.run) return await opts.run(command, cwd)
        const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" })
        const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
        return { ok: code === 0, output: `${stdout}${stderr}` }
    }

    async function install(id: RuntimeId): Promise<RuntimeState> {
        const ready = installed(id)
        if (ready.installed) return ready
        const inFlight = installing.get(id)
        if (inFlight) return await inFlight

        const work = (async (): Promise<RuntimeState> => {
            const entry = spec(id)
            await mkdir(staging, { recursive: true })
            const pending = await mkdtemp(join(staging, `${id.replace(".", "-")}-`))
            try {
                await writeFile(join(pending, "package.json"), JSON.stringify({
                    private: true,
                    name: `axon-runtime-${id.replace(".", "-")}`,
                    dependencies: { [entry.package]: entry.version },
                }, null, 2) + "\n")
                const result = await execute([process.execPath, "install", "--production"], pending)
                if (!result.ok) {
                    throw err("MODEL_RUNTIME_INSTALL_FAILED", {
                        detail: `could not install ${entry.package}@${entry.version}: ${result.output.trim() || "bun install failed"}`,
                        context: { runtime: id, package: entry.package },
                    })
                }
                await writeFile(join(pending, "manifest.json"), JSON.stringify({
                    ...entry, installedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
                } satisfies RuntimeManifest, null, 2) + "\n")
                const target = directory(id)
                await mkdir(join(root, id.replace(".", "-")), { recursive: true })
                await rm(target, { recursive: true, force: true })
                await rename(pending, target)
                const state = installed(id)
                if (!state.installed) {
                    throw err("MODEL_RUNTIME_INSTALL_FAILED", {
                        detail: `${entry.package} installed but its module was not found in ${target}`,
                        context: { runtime: id, package: entry.package, target },
                    })
                }
                return state
            } finally {
                await rm(pending, { recursive: true, force: true })
            }
        })()
        installing.set(id, work)
        try { return await work } finally { installing.delete(id) }
    }

    return {
        get root() { return root },
        state(): RuntimeState[] { return (Object.keys(SPECS) as RuntimeId[]).map(installed) },
        install,
        async remove(id: RuntimeId): Promise<boolean> {
            if (!installed(id).installed) return false
            await rm(directory(id), { recursive: true, force: true })
            return true
        },
        async import(id: RuntimeId): Promise<unknown | null> {
            const entry = spec(id)
            if (!installed(id).installed) return null
            try {
                // Resolve from the Axon-owned runtime project, never from the
                // mise/npm tree that installed the main CLI.
                const entrypoint = Bun.resolveSync(entry.module, directory(id))
                return await import(pathToFileURL(entrypoint).href)
            } catch {
                return null
            }
        },
    }
}

export type RuntimesT = ReturnType<typeof Runtimes>
