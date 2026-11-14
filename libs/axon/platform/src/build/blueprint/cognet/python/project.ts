import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import { err } from "@arcforge/err"
import type { PythonSystem } from "@arcforge/cognet"
import { fsx } from "../../../../utils/fs"
import { writeIfChanged } from "../../../project/typegen/write"

const SKIP = ["node_modules", ".git", ".agent", ".cognet", ".venv", "__pycache__", ".pytest_cache", "target"]

/** PythonProject — discover systems, stage their source, and sync their environment. */
export function PythonProject(opts: { sourceDir: string; agentRoot: string; out: string; owned: boolean }) {
    return {
        async sources(): Promise<string[]> {
            const files = await fsx.walk(opts.sourceDir, { skipDirs: SKIP })
            return files.filter(file => file.relPath.endsWith(".system.py")).map(file => file.relPath).sort()
        },

        /** Prepared systems and the interpreter relative to the agent's generated frame. */
        async prepare(sources: readonly string[]): Promise<{ systems: PythonSystem[]; executable: string }> {
            if (sources.length === 0) throw err("COGNET_PYTHON_FAILED", { detail: "PythonProject.prepare needs Python systems" })
            const sdk = Bun.resolveSync("@arcforge/cognet/python/declare.py", opts.agentRoot)
            let declared: ReturnType<typeof Bun.spawnSync>
            try {
                declared = Bun.spawnSync(["python3", sdk, opts.sourceDir, ...sources], { stdout: "pipe", stderr: "pipe" })
            } catch (cause) {
                throw err("COGNET_PYTHON_FAILED", { detail: "Python systems need python3 on PATH to read their declarations", cause: cause })
            }
            if (declared.exitCode !== 0) {
                throw err("COGNET_PYTHON_FAILED", { detail: `Python declaration failed:\n${new TextDecoder().decode(declared.stderr).trim()}` })
            }
            let systems: unknown
            try {
                systems = JSON.parse(new TextDecoder().decode(declared.stdout))
            } catch (cause) {
                throw err("COGNET_PYTHON_FAILED", { detail: "Python declaration returned invalid JSON", cause: cause })
            }
            if (!Array.isArray(systems) || systems.length !== sources.length || !systems.every(validSystem)) {
                throw err("COGNET_PYTHON_FAILED", { detail: "Python declaration returned invalid system metadata" })
            }

            const stage = join(opts.out, "source")
            rmSync(stage, { recursive: true, force: true })
            const files = await fsx.walk(opts.sourceDir, { skipDirs: SKIP })
            for (const file of files) {
                const target = join(stage, file.relPath)
                mkdirSync(dirname(target), { recursive: true })
                copyFileSync(file.absPath, target)
            }

            const project = join(opts.sourceDir, "pyproject.toml")
            let executable = "python3"
            if (existsSync(project)) {
                const lock = join(opts.sourceDir, "uv.lock")
                if (!existsSync(lock)) {
                    if (!opts.owned) throw err("COGNET_PYTHON_FAILED", { detail: `${project} has no uv.lock; published Python cognets need a committed lockfile` })
                    await command(["uv", "lock", "--project", opts.sourceDir], opts.sourceDir)
                }
                const environment = join(opts.out, ".venv")
                await command(["uv", "sync", "--project", opts.sourceDir, "--locked", "--no-install-project"], opts.sourceDir, { UV_PROJECT_ENVIRONMENT: environment })
                executable = process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python"
                if (!existsSync(join(opts.out, executable))) throw err("COGNET_PYTHON_FAILED", { detail: `uv sync succeeded but left no interpreter at ${join(opts.out, executable)}` })
            }

            if (opts.owned) {
                const settingsRoot = new Set([opts.sourceDir, opts.agentRoot])
                for (const root of settingsRoot) {
                    const settings = join(root, ".vscode", "settings.json")
                    const current = existsSync(settings) ? Bun.JSONC.parse(readFileSync(settings, "utf8")) as unknown : {}
                    if (typeof current !== "object" || current === null || Array.isArray(current)) {
                        throw err("COGNET_PYTHON_FAILED", { detail: `${settings} must be a JSON object to configure Python` })
                    }
                    const configured = current as Record<string, unknown>
                    const path = executable === "python3" ? "python3" : relative(root, join(opts.out, executable)).split(sep).join("/")
                    const extra = configured["python.analysis.extraPaths"]
                    if (extra !== undefined && (!Array.isArray(extra) || !extra.every(entry => typeof entry === "string"))) {
                        throw err("COGNET_PYTHON_FAILED", { detail: `${settings}: python.analysis.extraPaths must be a list of paths` })
                    }
                    const paths: string[] = Array.isArray(extra) ? extra : []
                    const generated = relative(root, join(opts.out, "generated")).split(sep).join("/")
                    const sdkPath = relative(root, dirname(dirname(sdk))).split(sep).join("/")
                    const added = [generated, sdkPath].filter(value => !paths.includes(value))
                    if (configured["python.defaultInterpreterPath"] === path && added.length === 0) continue
                    mkdirSync(dirname(settings), { recursive: true })
                    writeIfChanged(settings, `${JSON.stringify({ ...configured, "python.defaultInterpreterPath": path, "python.analysis.extraPaths": [...paths, ...added] }, null, 4)}\n`)
                }
            }
            return { systems: systems, executable: executable }
        },

        clear(): void {
            rmSync(opts.out, { recursive: true, force: true })
        },
    }
}

function validSystem(value: unknown): value is PythonSystem {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false
    if (!("name" in value) || typeof value.name !== "string" || !("file" in value) || typeof value.file !== "string"
        || !("function" in value) || typeof value.function !== "string" || !("declaration" in value)) return false
    const spec = value.declaration
    if (typeof spec !== "object" || spec === null || Array.isArray(spec)) return false
    const fields = spec as Record<string, unknown>
    const names = (name: string): boolean => Array.isArray(fields[name]) && fields[name].every((entry: unknown) => typeof entry === "string")
    return names("reads") && names("recalls") && names("streams") && names("writes")
        && (fields.on === undefined || names("on")) && (fields.uses === undefined || names("uses")) && typeof fields.once === "boolean"
        && (fields.lag === undefined || (typeof fields.lag === "number" && Number.isSafeInteger(fields.lag) && fields.lag >= 0))
}

async function command(args: string[], cwd: string, env: Record<string, string> = {}): Promise<void> {
    let child: ReturnType<typeof Bun.spawn>
    try {
        child = Bun.spawn(args, { cwd: cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
    } catch (cause) {
        throw err("COGNET_PYTHON_FAILED", { detail: `Python systems with pyproject.toml require uv; could not run ${args[0]}`, cause: cause })
    }
    if (!(child.stderr instanceof ReadableStream)) throw err("COGNET_PYTHON_FAILED", { detail: `${args[0]} did not provide a stderr stream` })
    const [stderr, exit] = await Promise.all([new Response(child.stderr).text(), child.exited])
    if (exit !== 0) throw err("COGNET_PYTHON_FAILED", { detail: `${args.join(" ")} failed: ${stderr.trim()}` })
}
