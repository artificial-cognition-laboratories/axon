import { createHash } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { rename, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { AxonTool } from "@arcforge/types"
import { err } from "@arcforge/err"
import { fsx } from "../../../utils/fs"
import { Frame } from "../../frame"
import type { Scanned } from "../types"
import type { DeclaredFile } from "./declare"
import { publishedTools } from "./published"

/**
 * The subprocess entry that actually runs declareTools() — see its own doc
 * comment for why this isn't inline.
 *
 * The published CLI is a single bundled app.js, so `import.meta.dir` is the
 * package root there, not this source directory. Like the capsule process
 * and the update helper, the worker is bundled beside it and preferred when
 * present; the .ts source is the workspace/development path.
 *
 * Getting this wrong is silent in development and total in production —
 * every tool declaration in every installed agent fails, which is exactly
 * what happened before the worker was added to packageFiles.
 */
const packagedWorker = resolve(import.meta.dir, "declare-worker.js")
const DECLARE_WORKER_PATH = existsSync(packagedWorker)
    ? packagedWorker
    : resolve(import.meta.dir, "declare-worker.ts")

// Same packaged-vs-source resolution as the declare worker: in the published
// single-file CLI the worker is bundled beside app.js; in the workspace it is
// the .ts source. Getting this wrong is silent in dev and total in production.
const packagedToolBundleWorker = resolve(import.meta.dir, "tool-bundle-worker.js")
const TOOL_BUNDLE_WORKER_PATH = existsSync(packagedToolBundleWorker)
    ? packagedToolBundleWorker
    : resolve(import.meta.dir, "tool-bundle-worker.ts")

type DeclareWorkerResult =
    | { ok: true; files: [string, DeclaredFile][] }
    | { ok: false; message: string }

type ToolBundleResult =
    | { ok: true; tools: Record<string, string> }
    | { ok: false; message: string }

/**
 * Runs declare-worker.ts as a subprocess and reads its one JSON stdout
 * line. ts.createProgram() is native, single-threaded compiler work with
 * no cooperative yield points — inline, it freezes VTerm's render/input
 * loop for the whole call. A subprocess moves that freeze off the
 * process that owns the terminal. Only reached on a cache miss (see
 * cachedDeclarations() below) — the common case (unchanged tool source
 * across a reboot) never pays this cost at all.
 */
async function runDeclareWorker(fileNames: string[]): Promise<DeclareWorkerResult> {
    return declareServer.request(JSON.stringify(fileNames))
}

/**
 * The long-lived declare worker.
 *
 * One process, reused for every scan in this process's lifetime, because the
 * worker's cost is dominated by parsing TypeScript's standard library to build
 * a program — a fixed ~1.0s that a fresh process pays every time and a warm one
 * pays once (see declare-worker.ts's serve mode). A run that scans an agent
 * plus its modules, or a test suite that scans fifteen roots, is the difference
 * between fifteen seconds and one.
 *
 * Requests are serialized rather than pipelined: the worker is one synchronous
 * compiler and answers one line at a time, so overlapping writes would
 * interleave two requests into one stream. The queue is what makes concurrent
 * callers safe without them knowing this exists.
 *
 * A worker that dies takes only the request in flight with it — `spawn()` runs
 * again on the next call, and the caller sees a normal failure result rather
 * than a hang.
 */
const declareServer = DeclareServer()

function DeclareServer() {
    let proc: ReturnType<typeof Bun.spawn> | null = null
    let lines: AsyncIterableIterator<string> | null = null
    let queue: Promise<unknown> = Promise.resolve()
    /** Whether the exit hooks are installed — once per process, not per spawn. */
    let reaperArmed = false

    /**
     * Kill the worker whenever this process ends, however it ends.
     *
     * ── Why an exit hook rather than a shutdown() call ──────────────────────
     *
     * A child is NOT killed when its parent exits — it is reparented to init
     * and keeps running. So the worker has to be killed explicitly, and the
     * only place that catches every exit is here: a graceful shutdown, a
     * `process.exit()` from the third ctrl+c, an uncaught throw, and a SIGINT
     * or SIGTERM from the terminal all end the process without necessarily
     * passing through any shutdown path we control.
     *
     * Hanging this off the teardown chain instead would have covered exactly
     * the one case that was already working, and missed every case where the
     * user is force-quitting — which is when a leaked 280MB compiler process
     * matters most.
     *
     * ── Only `exit`, and that is enough ────────────────────────────────────
     *
     * SIGINT and SIGTERM are deliberately NOT handled here. VTerm's terminal
     * driver already handles both — it restores the terminal and calls
     * `process.exit(0)`, which fires `exit` and reaches this. Adding our own
     * handlers would mean two listeners racing to tear down the same process,
     * and a `process.kill(self, signal)` to re-raise would fight the driver's
     * own exit rather than cooperate with it.
     *
     * Synchronous, deliberately: `exit` handlers cannot await, and
     * `proc.kill()` is a synchronous signal send, which is exactly what fits.
     */
    function armReaper(): void {
        if (reaperArmed) return
        reaperArmed = true
        process.once("exit", stop)
    }

    function spawn(): void {
        proc = Bun.spawn(["bun", "run", DECLARE_WORKER_PATH, "--serve"], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            // NOT a kill-on-parent-exit switch — `killSignal` only names the
            // signal `.kill()` sends when something calls it. Nothing did, so
            // this worker outlived every process that spawned one: a ~280MB
            // TypeScript compiler, reparented to init, one per session,
            // forever. Verified in the wild at 1h47m old with its parent long
            // gone. `reap()` below is what actually makes the comment true.
            killSignal: "SIGKILL",
        })

        // A spawned child with piped stdio KEEPS THE EVENT LOOP ALIVE, and
        // this worker is deliberately long-lived — it stays resident between
        // requests so the next one skips a cold TypeScript start. Together
        // those meant a CLI command that had finished all its work simply
        // never exited: `axon prepare` printed its summary and hung, on
        // exactly the projects that have tools to declare (the others never
        // spawn a worker, which is what made it look intermittent).
        //
        // unref() drops it from the loop's reference count without killing
        // it: the worker still answers requests for as long as the process
        // genuinely has work, and stops being a reason for the process to
        // stay alive once it does not. `reap()` below still kills it on exit.
        proc.unref()

        lines = readLines(proc.stdout as ReadableStream<Uint8Array>)
        armReaper()
    }

    function stop(): void {
        proc?.kill()
        proc = null
        lines = null
    }

    async function send(payload: string): Promise<DeclareWorkerResult> {
        if (!proc || proc.killed) spawn()

        const writer = (proc!.stdin as { write(chunk: string): void; flush?(): void })
        writer.write(`${payload}\n`)
        writer.flush?.()

        const next = await lines!.next()
        if (next.done) {
            // The worker exited rather than answering. Drop the handle so the
            // next call starts a fresh one instead of writing into a dead pipe.
            const stderr = await new Response(proc!.stderr as ReadableStream<Uint8Array>).text().catch(() => "")
            stop()
            return { ok: false, message: `declare-worker exited without answering${stderr ? `\n${stderr}` : ""}` }
        }

        return JSON.parse(next.value) as DeclareWorkerResult
    }

    return {
        /** Queue a request behind any in flight, so two callers never share a line. */
        request(payload: string): Promise<DeclareWorkerResult> {
            const result = queue.then(() => send(payload))
            // The chain must survive a rejection, or one failure wedges every
            // later request behind it forever.
            queue = result.catch(() => { })
            return result
        },
    }
}

/** Split a byte stream into trimmed, non-empty lines. */
async function* readLines(stream: ReadableStream<Uint8Array>): AsyncIterableIterator<string> {
    const decoder = new TextDecoder()
    let buffer = ""

    for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true })
        let index = buffer.indexOf("\n")
        while (index !== -1) {
            const line = buffer.slice(0, index).trim()
            buffer = buffer.slice(index + 1)
            if (line) yield line
            index = buffer.indexOf("\n")
        }
    }
}

/**
 * Bundles a batch of tool files to self-contained ESM source via a subprocess
 * (same off-thread reason as the declare worker — Bun.build() would freeze the
 * terminal loop inline). Tools load by import() inside the sandbox; bundling
 * collapses each to one module the box materializes from source, so no tool
 * file — and none of the project around it — is ever mounted into the box.
 */
async function runToolBundleWorker(entryPaths: string[]): Promise<ToolBundleResult> {
    const proc = Bun.spawn(["bun", "run", TOOL_BUNDLE_WORKER_PATH, JSON.stringify(entryPaths)], {
        stdout: "pipe",
        stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ])

    const line = stdout.trim().split("\n").at(-1)
    if (!line) {
        return { ok: false, message: `tool-bundle-worker produced no output (exit ${exitCode})${stderr ? `\n${stderr}` : ""}` }
    }
    return JSON.parse(line) as ToolBundleResult
}

// ─── Declaration cache ───────────────────────────────────────────────────────

type DeclareCacheFile = {
    inputHash: string
    files: [string, DeclaredFile][]
}

/**
 * Where this root's tool caches live.
 *
 * Prefers an existing frame (same detection bench/typegen.ts uses) so the
 * cache sits in the `cache/` area with the rest of that project's disposable
 * output. When the root has no frame at all, `.module/cache` is CREATED
 * rather than giving up.
 *
 * Returning null here meant "no cache", and the roots that hit it were exactly
 * the ones that most need one: a source module being developed in place has no
 * `.module/` until something builds it, so every boot re-ran ts.createProgram()
 * and Bun.build() in two spawned workers — 1.4s per module, on every boot and
 * every watcher reload, forever, because nothing ever wrote the cache that
 * would have prevented it. One agent with one source module was paying ~1.4s of
 * a ~1.8s blueprint load for work whose inputs had not changed.
 *
 * Creating the directory is safe: it is the same generated-output location the
 * module's own build would use, it is already gitignored by convention, and the
 * cache is keyed on a content hash so a stale entry cannot survive an edit.
 */
function cacheDir(root: string): string | null {
    // Whichever frame this root already has, its `cache/` area. Probing the
    // kinds in order rather than detecting the kind properly keeps this a
    // filesystem question — the scanner runs on module roots that may not be
    // a project at all.
    for (const kind of ["agent", "module", "cognet"] as const) {
        const frame = Frame({ root: root, kind: kind })
        if (fsx.exists(frame.dir)) {
            try {
                return frame.ensure("cache")
            } catch {
                return null
            }
        }
    }
    try {
        return Frame({ root: root, kind: "module" }).ensure("cache")
    } catch {
        // A read-only root (a module vendored into node_modules by a package
        // manager that chowned it, a container mount) still scans correctly —
        // it just pays the uncached cost. Never fail a boot over a cache.
        return null
    }
}

/** Hash every tool file's content, sorted — order-independent, content-only (a rename with identical bodies is still a cache hit is NOT desired here, so path is part of the hash too). */
function hashToolFiles(toolFiles: string[], sources: Map<string, string>): string {
    const hash = createHash("sha256")
    for (const file of [...toolFiles].sort()) {
        hash.update(file)
        hash.update("\0")
        hash.update(sources.get(file) ?? "")
    }
    return hash.digest("hex")
}

/**
 * declareTools() is real ts.createProgram() work — expensive (500ms-1.5s
 * cold) and, worse, entirely synchronous/blocking (see runDeclareWorker's
 * doc comment). Gated the same way bundleCognet() gates Bun.build(): hash
 * the actual inputs, skip straight to the cached result when unchanged.
 * The common case (reboot, nothing in src/tools/ touched) never spawns
 * the worker at all.
 */
async function cachedDeclarations(root: string, toolFiles: string[], sources: Map<string, string>): Promise<Map<string, DeclaredFile>> {
    const inputHash = hashToolFiles(toolFiles, sources)
    const dir = cacheDir(root)
    const cachePath = dir ? join(dir, "tools-declare-cache.json") : null

    if (cachePath) {
        const cached = await readCache<DeclareCacheFile>(cachePath)
        if (cached && cached.inputHash === inputHash && Array.isArray(cached.files) && cached.files.length === toolFiles.length) {
            return new Map(cached.files)
        }
    }

    const result = await runDeclareWorker(toolFiles)
    if (!result.ok) {
        // The reason FIRST, the root after it.
        //
        // The root still has to be named — an agent's own src/tools failing and
        // an installed module's failing share one error code, and the message
        // alone cannot otherwise tell you which broke. But it was leading, and
        // a profile path is ~90 columns, so in a terminal the one actionable
        // sentence ("references type X but no definition could be resolved")
        // was pushed off the end while two lines of path nobody can act on
        // survived. The worker's message is also a thrown Error, so it carries
        // a stack that means nothing to a user installing a module — cut to
        // the first line, which is the sentence.
        const reason = result.message.split("\n")[0]!.replace(/^Error:\s*/, "").trim()
        throw err("TOOL_DECLARE_FAILED", { detail: `${reason}\n  in ${root}`, context: { root } })
    }

    // A declaration for every file we asked about, or this is not a result
    // worth keeping. The worker reports ok:true for anything that did not
    // throw, so a partial answer arrives looking exactly like a complete one —
    // and caching it against the source hash is what turned a single failure
    // into a permanent one, served from disk on every subsequent boot.
    if (result.files.length !== toolFiles.length) {
        const declared = new Set(result.files.map(([file]) => file))
        const missing = toolFiles.filter(file => !declared.has(file))
        throw err("TOOL_DECLARE_FAILED", {
            detail: `${root}: no declaration produced for ${missing.join(", ")}`,
            context: { root, missing },
        })
    }

    if (cachePath) await writeCache(cachePath, { inputHash, files: result.files } satisfies DeclareCacheFile)

    return new Map(result.files)
}

// ─── Bundle cache ──────────────────────────────────────────────────────────────

type BundleCacheFile = {
    inputHash: string
    tools: Record<string, string>
}

/**
 * Bundles the tool files to self-contained source, gated by the SAME content
 * hash as declarations — Bun.build() is expensive and blocking, so the common
 * case (reboot, nothing in src/tools/ touched) reads the cache and never spawns
 * the worker. Rides the existing watcher→rescan reload path for freshness: a
 * changed tool file changes the hash, which misses the cache and rebundles.
 */
async function cachedToolBundles(root: string, toolFiles: string[], sources: Map<string, string>): Promise<Map<string, string>> {
    const inputHash = hashToolFiles(toolFiles, sources)
    const dir = cacheDir(root)
    const cachePath = dir ? join(dir, "tools-bundle-cache.json") : null

    if (cachePath) {
        const cached = await readCache<BundleCacheFile>(cachePath)
        if (cached && cached.inputHash === inputHash && cached.tools && Object.keys(cached.tools).length === toolFiles.length) {
            return new Map(Object.entries(cached.tools))
        }
    }

    const result = await runToolBundleWorker(toolFiles)
    if (!result.ok) {
        throw err("TOOL_BUNDLE_FAILED", { detail: `${root}: ${result.message}`, context: { root } })
    }

    // Same completeness rule as declarations: a tool with no bundle cannot be
    // loaded into the sandbox, so a partial result is a failed scan, not a
    // smaller one.
    const bundled = Object.keys(result.tools)
    if (bundled.length !== toolFiles.length) {
        const missing = toolFiles.filter(file => !(file in result.tools))
        throw err("TOOL_BUNDLE_FAILED", {
            detail: `${root}: no bundle produced for ${missing.join(", ")}`,
            context: { root, missing },
        })
    }

    if (cachePath) await writeCache(cachePath, { inputHash, tools: result.tools } satisfies BundleCacheFile)

    return new Map(Object.entries(result.tools))
}

/**
 * Read a cache file, treating anything unreadable as a miss.
 *
 * A cache is derived data — it exists only to skip work whose answer is already
 * known. Corrupt JSON (a kill mid-write; Bun.write is not atomic) means the
 * answer is NOT known, which is a miss and a rebuild. Letting CORRUPT_JSON
 * propagate made a truncated cache fatal to the whole scan, and the scan's own
 * catch then degraded that to "this agent has no tools" — a wipe caused
 * entirely by a file that existed to make things faster.
 */
async function readCache<T>(path: string): Promise<T | null> {
    try {
        return await fsx.readJson<T>(path)
    } catch {
        return null
    }
}

/**
 * Write a cache file atomically: a temp file in the same directory, then a
 * rename. Bun.write() alone can leave a truncated file if the process dies
 * mid-write, and while readCache() now treats that as a miss, a cache that
 * cannot be half-written is better than one that is merely tolerated.
 */
async function writeCache(path: string, value: unknown): Promise<void> {
    const temp = `${path}.${process.pid}.tmp`
    try {
        await Bun.write(temp, JSON.stringify(value))
        await rename(temp, path)
    } catch {
        // A cache that cannot be written is a slower scan, never a failed one.
        await rm(temp, { force: true }).catch(() => {})
    }
}

/**
 * Tools — one source: src/tools/*.ts. Every export lands in the agent's
 * global scope under its own name; the filename groups, it does not
 * namespace. Real author source, run through actual TypeScript
 * declaration emission (declareTools) so return types are the compiler's
 * real inference (Promise<string>, never Promise<unknown>) and any ambient
 * type an export references is captured and carried alongside it.
 *
 * package.json dependencies are deliberately NOT scanned. A dependency is
 * available to the agent project's SOURCE — the author may import it — but
 * the capsule is a separate OS process, and being importable here grants
 * nothing there. Treating them as tools produced entries the capsule could
 * never load: filtered out at the capsule boundary, but still rendered into
 * the editor's ambient declarations, which is how an agent came to be told
 * it could call @vue/compiler-sfc internals. An author who wants a package
 * callable re-exports it from src/tools/ deliberately.
 */
export type ToolsOpts = {
    /**
     * Whether a tool that will not compile is FATAL.
     *
     * True for an agent's own `src/tools/` — the scope is the contract between
     * what the author wrote and what the model is told it can call, so a
     * missing tool means the running agent is not the agent that was asked
     * for. That is an invalid state, and invalid states crash.
     *
     * False for a MODULE's tools, and the distinction is the whole point: an
     * agent that installed a broken module is not an invalid agent, it is the
     * agent it was before the install. Crashing the whole runtime over one
     * dependency leaves the user unable to boot the terminal they need in
     * order to remove it — which is exactly the trap a bad publish set.
     *
     * Defaults to true: a caller that has not thought about it gets the strict
     * behaviour, and only the module scanner opts out deliberately.
     */
    required?: boolean
}

export async function Tools(root: string, opts: ToolsOpts = {}): Promise<Scanned<AxonTool>> {
    const entries: AxonTool[] = []
    const warnings: Scanned<AxonTool>["warnings"] = []

    // ── src/tools/*.ts ───────────────────────────────────────────────────────
    const toolsDir = join(root, "src", "tools")
    const toolFiles: string[] = []
    for (const file of await fsx.list(toolsDir)) {
        if (!file.endsWith(".ts") || file.endsWith(".d.ts") || file.endsWith(".test.ts")) continue
        toolFiles.push(join(toolsDir, file))
    }

    if (toolFiles.length > 0) {
        const sources = new Map<string, string>()
        for (const filePath of toolFiles) sources.set(filePath, (await fsx.readText(filePath)) ?? "")

        // One ts.Program over the whole directory — a tool file importing a
        // shared type from a sibling file needs the checker to see both.
        //
        // ── Fatal for an agent, degraded for a module ────────────────────────
        //
        // These THROW when `required` (an agent's own src/tools/): the scope is
        // the contract between what the author wrote and what the model is told
        // it can call, so a missing tool means the running agent is not the
        // agent that was asked for. Invalid state, so it crashes.
        //
        // A MODULE's tools are the opposite. An agent that installed something
        // broken is not invalid — it is the agent it was before the install —
        // and crashing the runtime leaves the user unable to boot the terminal
        // they need in order to uninstall it.
        //
        // Degrading was tried before and reverted for two good reasons, both
        // of which had to be fixed first rather than argued away:
        //
        //   1. The warning reached nobody. Scan warnings are committed as
        //      `build:warning`, which classified as DEBUG and was therefore
        //      hidden at default verbosity — so "warn and skip" was
        //      indistinguishable from silence. It is now info-level and renders
        //      as its own row (see visibility.ts, session-event.vue).
        //
        //   2. The empty result was CACHED against the source hash, so one
        //      failure survived every reboot with no recovery but deleting the
        //      cache by hand. cachedDeclarations/cachedToolBundles only ever
        //      write a cache on success, so a failed scan retries next boot —
        //      which is what makes a republish or an upstream fix take effect
        //      without the user knowing a cache exists.
        let declared: Map<string, DeclaredFile>
        let bundled: Map<string, string>

        // A PUBLISHED module ships the answer. Read it rather than
        // re-deriving it, for correctness before speed:
        //
        // `declareTools()` asks TypeScript to emit declarations, and TypeScript
        // treats node_modules as external library code — it silently SKIPS
        // declaration emit for anything inside it. A module whose tool file
        // imports a sibling therefore got one .d.ts where it needed two, and
        // every type declared in that sibling became unresolvable. The scan
        // then blamed the author for a missing re-export their source already
        // had (@axon/arxiv, `QueryOptions`).
        //
        // The manifest's declarations were emitted in the module's OWN
        // directory at publish time, where the compiler behaves. They are
        // strictly more correct than anything derivable from the installed
        // copy — and reading them costs one file read instead of a
        // ts.createProgram() and a bundle pass.
        //
        // Null means "not a complete published manifest" and falls through to
        // compiling, which is the pre-existing behaviour for an agent's own
        // src/tools/ and for anything installed from source.
        const published = await publishedTools(root, toolFiles)
        if (published) {
            declared = published.declared
            bundled = published.bundled
        } else {
        try {
            declared = await cachedDeclarations(root, toolFiles, sources)
            // Bundle each tool to self-contained source so the capsule never
            // imports it by path — the box needs nothing of the project mounted.
            bundled = await cachedToolBundles(root, toolFiles, sources)
        } catch (cause) {
            if (opts.required !== false) throw cause

            // Nothing from this root enters scope. That is the invariant that
            // keeps degradation honest: the model is never told about a tool
            // whose source the capsule cannot load, so it cannot call one that
            // does not exist.
            warnings.push({
                domain: "tools",
                error: cause instanceof Error ? cause.message : String(cause),
                // The structured failure travels with it, so the UI can render
                // the same error card it would for a crash — in warning
                // colours, because nothing crashed.
                ...(cause && typeof cause === "object" && "isAxonError" in cause
                    ? { cause: cause as never }
                    : {}),
            })
            return { entries, warnings }
        }
        }

        for (const filePath of toolFiles) {
            const file = filePath.slice(toolsDir.length + 1)
            const result = declared.get(filePath)

            // A file that exports nothing callable contributes nothing — an
            // author's shared internal module (the documented `_http.ts`
            // pattern) is exactly this and is not an error.
            if (!result || result.fns.length === 0) continue

            const source = bundled.get(filePath)
            if (source === undefined) {
                // Declaration and bundling are independent passes over the same
                // files; if they disagree about which succeeded, the tool would
                // enter scope with no source for the sandbox to load.
                throw err("TOOL_BUNDLE_FAILED", {
                    detail: `${root}: ${file} declared but produced no bundle`,
                    context: { root, file: filePath },
                })
            }

            entries.push({
                name: file.slice(0, -3),
                fns: result.fns,
                origin: "src",
                // Self-contained bundled source is authoritative: the capsule
                // materializes it inside the box, so no tool path is mounted.
                // entryPath is retained for editor/typecheck tooling that reads
                // the author's real file, not for capsule loading.
                entryPath: filePath,
                source,
                ...(result.ambientTypes.length > 0 ? { ambientTypes: result.ambientTypes } : {}),
            })
        }
    }

    return { entries, warnings }
}
