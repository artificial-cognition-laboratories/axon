import { workerPath } from "../../../utils/packaged"
import { createHash } from "node:crypto"
import { readdir, rename, rm } from "node:fs/promises"
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { err } from "@arcforge/err"
import { KERNEL_ABI_VERSION } from "@arcforge/types"
import type { CognetBlueprint, CognetDefinition, CognetUse, ServiceUse } from "@arcforge/types"
import { fsx } from "../../../utils/fs"
import { Frame } from "../../frame"
import { CognetConfigFile } from "./config"
import { Crate, NATIVE_DIR } from "./native"
import { PythonProject } from "./python"
import type { PythonSystem } from "@arcforge/cognet"
import { Schema, type Described } from "./schema"

// The subprocess entry that actually runs Bun.build() — see runBundleWorker()
// for why this isn't inline.
//
// Packaged builds ship the worker as a sibling .js (see vterm.config.ts's
// onBundle + packageFiles); source checkouts run the .ts directly. Same
// resolution pattern as declare-worker/tool-bundle-worker — without it the
// installed CLI looks for a .ts that was never published and every agent
// fails to compile its brain.
const BUNDLE_WORKER_PATH = workerPath(import.meta.dir, "bundle-worker.js", "bundle-worker.ts")

type BundleWorkerResult =
    | { ok: true; code: string; mapCode?: string }
    | { ok: false; message: string }

/**
 * Runs bundle-worker.ts as a subprocess and reads its one JSON stdout line.
 * Bun.build() is a native, single-threaded compute burst with no
 * cooperative yield points — inline, it freezes VTerm's render/input loop
 * for the whole compile (the bundle inlines @arcforge/core's entire source
 * tree, so this is not a trivial burst). A subprocess moves that freeze
 * off the process that owns the terminal.
 */
async function runBundleWorker(entryPath: string, external: string[], schemaDir: string): Promise<BundleWorkerResult> {
    const proc = Bun.spawn(["bun", "run", BUNDLE_WORKER_PATH, entryPath, external.join(","), schemaDir], {
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
        return { ok: false, message: `bundle-worker produced no output (exit ${exitCode})${stderr ? `\n${stderr}` : ""}` }
    }
    return JSON.parse(line) as BundleWorkerResult
}

export type CognetArtifact = {
    /** what the blueprint carries — pure data, path+hash form */
    blueprint: CognetBlueprint & { path: string; hash: string }
}

/**
 * Where, in the agent frame's `cognet/`, a cognet's schemas are generated —
 * and the specifier cognet source imports them by: `#schema/control/control`
 * is `<frame>/cognet/schema/control/control.ts`. The bundle worker resolves
 * it; the agent's cognet tsconfig maps it for the editor, tsc and bun test.
 */
export const SCHEMA_DIR = "schema"
export const SCHEMA_SPECIFIER = "#schema/"

/**
 * The host module the generated entry composes with — a BARE SPECIFIER,
 * resolved by the bundler from the agent's own node_modules.
 *
 * This used to be an absolute path into @arcforge/core's source tree, which
 * resolved only inside this workspace: a published CLI ships no source, so
 * cognet compilation could never have worked from an npm install. The host
 * is a published package now (@arcforge/cognet), installed into every agent
 * alongside @arcforge/types, so the same import works identically in a
 * source checkout and a real install.
 */
const HOST_SPECIFIER = "@arcforge/cognet"

/**
 * The runtime a compiled bundle fuses to is @arcforge/cognet, and its VERSION
 * is what the cache key needs — not a directory hash.
 *
 * This was previously a recursive hash of @arcforge/core's entire source tree, on
 * the belief that the host pulled all of core in transitively. It never did:
 * the host's real graph is itself plus the clock/ecs, and nothing from the
 * kernel. So every unrelated core change rebuilt every agent's brain for no
 * reason, and the one thing that genuinely matters — which runtime version got
 * inlined — wasn't tracked at all. Reading the installed package's version
 * fixes both directions.
 */
async function hostVersion(agentRoot: string): Promise<string> {
    let dir = resolve(agentRoot)
    while (true) {
        const hostDir = join(dir, "node_modules", "@arcforge", "cognet")
        const manifest = join(hostDir, "package.json")
        if (existsSync(manifest)) {
            // A LINKED host is a source checkout, and its version is frozen
            // at whatever was last published while its bytes change on every
            // edit. Versioning it alone is the assumption above holding for
            // exactly the case it was written for and failing silently for
            // the other: a fixed host would be inlined into a bundle the
            // cache already believed current, so the brain keeps running the
            // old runtime and the fix looks like it did nothing.
            //
            // Only reached when a developer has linked the framework, so a
            // published install pays nothing for it.
            const linked = await linkedHostIdentity(hostDir)
            if (linked) return linked

            const pkg = await Bun.file(manifest).json() as { version?: string }
            if (pkg.version) return pkg.version
        }
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
    }
    // Declared but absent means the tree is mid-write, not that the agent is
    // broken: `bun install` tears node_modules down and rebuilds it, so a scan
    // landing inside that window sees a runtime that genuinely is not there
    // for the instant it looks. Distinguishing the two lets a reload treat the
    // transient case as "look again" instead of tearing down a working agent
    // and printing a compile failure for an install that succeeded.
    //
    // Not declared at all is a real misconfiguration and still fails loudly.
    const declared = await isDeclared(agentRoot)
    throw err(declared ? "COGNET_RUNTIME_UNAVAILABLE" : "COGNET_BUILD_FAILED", {
        detail: declared
            ? `${HOST_SPECIFIER} is declared but not present under ${agentRoot} — the dependency tree is being rewritten, or the project needs \`axon prepare\``
            : `${HOST_SPECIFIER} is not installed under ${agentRoot} — run \`axon prepare\` to install the cognet runtime`,
        context: { agentRoot, specifier: HOST_SPECIFIER },
    })
}

/**
 * A content identity for a host that is a symlink into a source checkout.
 *
 * Null when the host is an ordinary installed directory — the version is the
 * right key there, and hashing a published package's bytes on every compile
 * would spend real time re-deriving a constant.
 *
 * Hashes only what the bundle actually inlines (`src/`), so an edit to the
 * host's tests or README does not invalidate every agent's brain.
 */
async function linkedHostIdentity(hostDir: string): Promise<string | null> {
    let real: string
    try {
        if (!lstatSync(hostDir).isSymbolicLink()) return null
        real = realpathSync(hostDir)
    } catch {
        return null
    }

    const hash = createHash("sha256")
    const walked = await fsx.walk(join(real, "src"), { skipDirs: ["node_modules"] })
    const files = walked
        .filter(({ relPath }) => /\.(ts|tsx|js|mjs|json|rs|toml|lock|proto)$/.test(relPath))
        .sort((a, b) => a.relPath.localeCompare(b.relPath))

    for (const { absPath, relPath } of files) {
        const text = await Bun.file(absPath).text().catch(() => null)
        if (text !== null) hash.update(`${relPath}\0${text}`)
    }

    return `link:${hash.digest("hex")}`
}

/** Whether the project's own package.json declares the cognet runtime. */
async function isDeclared(agentRoot: string): Promise<boolean> {
    const manifest = join(agentRoot, "package.json")
    if (!existsSync(manifest)) return false
    try {
        const pkg = await Bun.file(manifest).json() as { dependencies?: Record<string, string> }
        return Boolean(pkg.dependencies?.[HOST_SPECIFIER])
    } catch {
        // A package.json being rewritten right now is itself the transient
        // case — an unreadable manifest is not evidence of a missing pin.
        return true
    }
}

/**
 * Compile one cognet source project into the agent's brain slot:
 *
 *   <agent>/.agent/cognet/cognet.mjs       — single self-contained ESM file
 *   <agent>/.agent/cognet/cognet.mjs.map   — sourcemap (debuggability)
 *   <agent>/.agent/cognet/manifest.json    — { name, version, abi, hash, wakeOn }
 *
 * The authoring surface is plain files against ambient globals —
 * cognet.config.ts (defineCognet), `*.system.ts` files anywhere under the
 * cognet, and an optional main.ts (a raw script that may declare loop()).
 * This step is the desugar:
 *
 * 1. DISCOVER every `*.system.ts`, and every file defining components or
 *    queries. WRAP main.ts — hoist its imports, defer its body into an
 *    exported async function the host runs once at load().
 * 2. GENERATE an entry that imports the host FIRST (installing the globals
 *    before anything else evaluates), then plugins, config, the discovered
 *    files and the script, and composes them — `Discovered()` names every
 *    definition from where it is defined, and `CognetHost` receives the
 *    systems with identity resolved from package.json + the kernel's ABI.
 * 3. BUNDLE the entry (Bun.build) — host, config, systems, main, and their
 *    whole import graph inlined into one file the runtime imports.
 *
 * The blueprint's identity is then read back off the ARTIFACT: we import the
 * fresh bundle once here and read the composed definition's own fields, so
 * what the blueprint claims and what the kernel will load cannot disagree.
 *
 * The Bun.build() + dynamic import() cycle below is real, non-trivial work
 * (and — separately — importing a fresh built module repeatedly in the same
 * process has shown module-resolution instability under bun test). Neither
 * is free, so a source-input hash gates it: unchanged inputs since the last
 * compile skip straight to the existing manifest instead of rebuilding.
 */
/**
 * The brain's script — `src/main.ts`, or `main.ts` at the cognet root — or
 * null when it has none.
 *
 * Optional since systems: a brain made only of `*.system.ts` files needs no
 * script, and the host runs its systems every tick. Whether a brain has
 * ANYTHING to run is checked once discovery is done, where both are known.
 *
 * `src/` wins when both exist: it is the conventional layout, so a stray
 * top-level `main.ts` beside a real `src/main.ts` is far more likely to be a
 * leftover than an intentional second entry.
 */
function resolveCognetMain(sourceDir: string): string | null {
    const nested = join(sourceDir, "src", "main.ts")
    if (fsx.isFile(nested)) return nested

    const flat = join(sourceDir, "main.ts")
    if (fsx.isFile(flat)) return flat

    return null
}

/**
 * Who a cognet IS — read from its package.json, never from its config.
 *
 * One source of truth, and it is the one everything else already uses: the
 * registry publishes under it, the installer resolves it, `package.json` in
 * the agent depends on it. A `name`/`version` in cognet.config.ts was a second
 * writable copy of the same fact and drifted exactly as duplicated facts do —
 * @axon/zero published as 1.0.44 while identifying itself to the kernel as
 * 0.1.2, undetected because publish read one file and the runtime read the
 * other.
 *
 * An INLINE brain has no package.json of its own — it ships inside the agent's
 * bundle and is asked for by nobody — so it borrows the agent's identity.
 * `-brain` distinguishes the two in a flame graph and in the manifest, where
 * seeing the agent's bare name would be confusing.
 */
async function cognetIdentity(opts: { sourceDir: string; agentRoot: string; inline?: boolean }): Promise<{ name: string; version: string }> {
    if (opts.inline) {
        const agent = await fsx.readJson<{ name?: string; version?: string }>(join(opts.agentRoot, "package.json"))
        const bare = (agent?.name ?? "agent").split("/").at(-1) ?? "agent"
        return { name: `${bare}-brain`, version: agent?.version ?? "0.0.0" }
    }

    const pkg = await fsx.readJson<{ name?: string; version?: string }>(join(opts.sourceDir, "package.json"))
    if (!pkg?.name || !pkg.version) {
        throw err("COGNET_INVALID", {
            detail: `${opts.sourceDir} — a published cognet must have a package.json with name and version; that IS its identity`,
            context: { sourceDir: opts.sourceDir },
        })
    }
    return { name: pkg.name, version: pkg.version }
}

/**
 * The config module a brain gets when it declares no cognet.config.ts.
 *
 * Only `mode` — identity is resolved separately and injected, so this carries
 * nothing an author could have written differently. It defaults to invocation,
 * the shape of an agent that answers when spoken to, which is what an author
 * writing their first `loop()` almost always means. A continuous brain is a
 * deliberate choice about scheduling, and deliberate choices go in a file.
 */
function synthesizedConfig(): string {
    return [
        "// generated by axon — this inline cognet declares no cognet.config.ts.",
        "// Add one to set the schedule, wake mask, or model weights yourself;",
        "// identity comes from package.json either way and is never authored.",
        "export default {",
        `    mode: { kind: "invocation" as const },`,
        "}",
    ].join("\n")
}

export async function bundleCognet(opts: {
    sourceDir: string
    agentRoot: string
    /**
     * Whether this brain lives inside the agent (`<agent>/cognet/`).
     *
     * Only relaxes the cognet.config.ts requirement — everything downstream
     * treats the two identically, because by compile time they are.
     */
    inline?: boolean
    /**
     * Where the compiled artifact lands. Defaults to the agent's own
     * `.agent/cognet/`, which is what every real compile wants.
     *
     * Publish verification overrides it: it compiles a candidate tarball to
     * prove a consumer could, and must not overwrite the agent's live brain
     * (or its manifest cache) to do so.
     */
    outDir?: string
}): Promise<CognetArtifact> {
    const mainPath = resolveCognetMain(opts.sourceDir)
    const configPath = join(opts.sourceDir, "cognet.config.ts")
    const outDir = opts.outDir ?? Frame({ root: opts.agentRoot, kind: "agent" }).path("cognet")
    const buildDir = join(outDir, ".build")
    const outFile = join(outDir, "cognet.mjs")
    const manifestFile = join(outDir, "manifest.json")


    // A cognet.config.ts is OPTIONAL for every brain, published or inline.
    //
    // It was once required of a published cognet, on the grounds that its
    // name, version and ABI could come from nowhere else. All three now do:
    // identity from package.json (the one copy the registry and installer
    // already use), and the ABI from the kernel the compile ran against unless
    // the author pinned one. What is left in the file is `mode`, which has a
    // default — so requiring it meant a config file's worth of ceremony to
    // restate three known facts.
    //
    // Absent, a config declaring only the default mode is synthesized. An
    // author who wants a non-default schedule, a wake mask or engine
    // requirements writes the file and gets the full surface.
    const hasConfig = await Bun.file(configPath).exists()
    const declared = CognetConfigFile({ sourceDir: opts.sourceDir }).read()
    const named = await cognetIdentity({ sourceDir: opts.sourceDir, agentRoot: opts.agentRoot, inline: opts.inline })

    // The schemas first: what they generate — into this agent's frame, never the source — is an input
    // the hash below must see, and a module the discovery below must name.
    const schemaDir = join(outDir, SCHEMA_DIR)
    // Its Rust systems, compiled into the one module the entry loads — with the schemas' Rust, when there are any.
    const crate = Crate({ sourceDir: opts.sourceDir, agentRoot: opts.agentRoot, out: join(outDir, "native"), owned: !opts.sourceDir.split(sep).includes("node_modules") })
    const rust = await crate.sources()
    const native = rust.some(source => source.system !== null)
    const hasRustProject = native || (rust.length > 0 && existsSync(join(opts.sourceDir, "Cargo.toml")))
    const python = PythonProject({ sourceDir: opts.sourceDir, agentRoot: opts.agentRoot, out: join(outDir, "python"), owned: !opts.sourceDir.split(sep).includes("node_modules") })
    const pythonSources = await python.sources()
    // A hot reload's copy (see core's cognet resolve), left behind by a process that never swapped it out.
    for (const left of existsSync(outDir) ? (await readdir(outDir)).filter(entry => /^cognet\.[0-9a-f]+\.mjs$/.test(entry)) : []) await rm(join(outDir, left), { force: true })
    // An inline brain's own interfaces are its agent's: `@cody/terry/features@1`, not the synthetic `terry-brain`'s.
    const scope = opts.inline ? (await fsx.readJson<{ name?: string }>(join(opts.agentRoot, "package.json")))?.name ?? named.name : named.name
    const schema = await Schema({ sourceDir: opts.sourceDir, agentRoot: opts.agentRoot, cognet: scope, uses: declared?.uses ?? {}, out: schemaDir, rust: hasRustProject ? crate.schema() : null, python: pythonSources.length > 0 ? join(outDir, "python", "generated") : null, stage: join(outDir, ".schema") }).generate()
    // Each use joined to the interface it names, as compiled: what the kernel grants and serves by, and what each
    // run's `services` calls through.
    const uses = declared?.uses && Object.keys(declared.uses).length > 0 ? joined(declared.uses, schema.interfaces) : null
    const builtNative = hasRustProject ? await crate.build(rust) : null
    if (!builtNative) crate.clear()
    const nativeModule = native ? builtNative : null
    const pythonProject = pythonSources.length > 0 ? await python.prepare(pythonSources) : null
    if (!pythonProject) python.clear()

    const inputHash = await hashCognetInputs(opts.sourceDir, opts.agentRoot, schemaDir, nativeModule ? basename(nativeModule) : null)
    const cached = await readCachedArtifact(manifestFile, outFile, inputHash)
    if (cached) return cached

    // Nothing in this project's frame, but the SAME brain may already have
    // been compiled for another project on this machine — the input hash is
    // portable, so identical sources share an entry. Copy the artifact in and
    // write this project's own manifest around it (path/sourceDir are
    // project-specific, so only the .mjs travels).
    const shared = await readSharedArtifact(inputHash)
    if (shared) {
        // `uses` names where each interface's cases are on THIS machine, for THIS project: never the cached copy's.
        const { uses: _, ...identified } = shared.blueprint
        const blueprint = { ...identified, ...(uses ? { uses: uses } : {}), path: outFile }
        await Bun.write(outFile, shared.code)
        await Bun.write(manifestFile, JSON.stringify({ ...blueprint, inputHash, sourceDir: opts.sourceDir }, null, 4))
        return { blueprint: blueprint }
    }

    // 1. what the brain is made of: its systems, the files defining the
    //    components and queries they use, and its optional script.
    const systems = await discover.systems(opts.sourceDir)
    const definitions = [...await discover.definitions(opts.sourceDir, naming(opts.sourceDir)), ...await discover.definitions(schemaDir, relPath => relPath)]
    if (!mainPath && systems.length === 0 && !native && !pythonProject) {
        throw err("COGNET_NO_LOOP", {
            detail: `no brain in ${opts.sourceDir} — expected *.system.ts, *.system.rs, *.system.py, src/main.ts, or main.ts`,
            context: { sourceDir: opts.sourceDir },
        })
    }

    const wrapped = mainPath ? script(mainPath, opts.sourceDir) : NO_SCRIPT
    await Bun.write(join(buildDir, "main.ts"), wrapped)

    // 2. the composed entry — import order IS the wiring:
    //    host first (installs the ambient globals, incl. definePlugin),
    //    then plugins (their definePlugin(...) calls register hooks at import
    //    time — before load() fires "boot"), then config, then main.
    const plugins = await discover.plugins(opts.sourceDir)

    // An inline brain with no config file gets one written into the build
    // scratch, so the composition below stays identical for every cognet —
    // CognetHost always receives a real config module, and only its origin
    // differs.
    let configImport = specifier(configPath)
    if (!hasConfig) {
        const synthesized = join(buildDir, "config.ts")
        await Bun.write(synthesized, synthesizedConfig())
        configImport = `"./config.ts"`
    }

    // Identity is resolved HERE and baked into the entry, never read off the
    // config. The ABI a config may pin is honoured; absent, this compile's own
    // kernel is stamped in, which is the truthful answer — the bundle really
    // was built against it.
    // The host is given what it calls by — never where the cases are, which is this machine's and not the brain's.
    const identity = { ...named, abi: declared?.abi ?? KERNEL_ABI_VERSION, ...(uses ? { uses: Object.fromEntries(Object.entries(uses).map(([name, { conformance: _, ...use }]) => [name, use])) } : {}) }

    // Identity is MERGED INTO the config object rather than passed as its own
    // argument. CognetHost is a published package's public surface, and a
    // compiled bundle inlines whichever copy of it the agent has installed —
    // so widening the call to three arguments would mean a new CLI emitting a
    // call an older installed host cannot answer, shifting `main` into
    // `config` and killing the brain at load(). Spread last: identity is the
    // resolved fact, and a config that somehow still carries a stale name
    // must not win over it.
    const entry = [
        "// generated by axon — composes identity + plugins + systems + script into the definition.",
        ...composition({ plugins: plugins, configImport: configImport, identity: identity, systems: systems, definitions: definitions, native: nativeModule ? `./${NATIVE_DIR}/${basename(nativeModule)}` : null, python: pythonProject, sourceDir: opts.sourceDir }),
    ].join("\n")
    const entryPath = join(buildDir, "entry.ts")
    await Bun.write(entryPath, entry)

    // 3. bundle — off-process, see runBundleWorker()'s doc comment
    // The cognet's own declared dependencies stay external, resolved from
    // node_modules at runtime rather than inlined. A native addon cannot be
    // inlined at all (see bundle-worker), and a 259MB ONNX runtime should not
    // be even if it could. @arcforge/* is excluded: the host must be the ONE
    // copy the agent runs, and a second nested runtime would give the brain a
    // different ambient scope than the kernel bound.
    const cognetPkg = await fsx.readJson<{ dependencies?: Record<string, string> }>(
        join(opts.sourceDir, "package.json"),
    )
    const external = Object.keys(cognetPkg?.dependencies ?? {})
        .filter(name => !name.startsWith("@arcforge/"))

    const result = await runBundleWorker(entryPath, external, schemaDir)
    if (!result.ok) {
        throw err("COGNET_BUILD_FAILED", { detail: result.message, context: { sourceDir: opts.sourceDir } })
    }

    const contents = result.code
    await Bun.write(outFile, contents)

    if (result.mapCode) await Bun.write(`${outFile}.map`, result.mapCode)

    const hash = createHash("sha256").update(contents).digest("hex")

    // read identity off the artifact itself — hash-busted import, fresh module
    const module = (await import(`${pathToFileURL(outFile).href}?v=${hash}`)) as { default?: CognetDefinition }
    const definition = module.default
    if (!definition || typeof definition.load !== "function" || typeof definition.wake !== "function") {
        throw err("COGNET_INVALID", { detail: `${opts.sourceDir} — compile did not yield a cognet definition`, context: { sourceDir: opts.sourceDir } })
    }

    const blueprint: CognetArtifact["blueprint"] = {
        name: definition.name,
        version: definition.version,
        abi: definition.abi,
        mode: definition.mode,
        ...(definition.wakeOn ? { wakeOn: definition.wakeOn } : {}),
        ...(definition.stimuli ? { stimuli: definition.stimuli } : {}),
        ...(uses ? { uses: uses } : {}),
        path: outFile,
        hash,
    }

    // `sourceDir` rides along so a LATER Cognet() instance can answer "where
    // did this brain come from" without being told. The dev watcher needs it
    // and is constructed from a different instance than the one that
    // compiled, so in-memory state cannot serve it — and guessing the
    // registry default there silently watched (and reported) the wrong cognet.
    await Bun.write(manifestFile, JSON.stringify({ ...blueprint, inputHash, sourceDir: opts.sourceDir }, null, 4))

    await publishSharedArtifact(inputHash, outFile, blueprint)

    return { blueprint }
}

/** Each use the config declares, with the interface it names as compiled — what the kernel grants and serves by. */
function joined(uses: Readonly<Record<string, ServiceUse>>, interfaces: readonly Described[]): Record<string, CognetUse> {
    return Object.fromEntries(Object.entries(uses).map(([name, use]) => {
        const compiled = interfaces.find(one => one.written === use.interface)
        if (!compiled) throw err("INTERFACE_NOT_FOUND", { detail: `uses.${name}: ${use.interface} was not compiled`, context: { use: name, interface: use.interface } })
        return [name, { ...use, named: compiled.name, methods: compiled.methods, ...(compiled.conformance ? { conformance: compiled.conformance } : {}) }]
    }))
}

// ── machine-wide artifact cache ───────────────────────────────────────────────

/**
 * Compiled brains, shared across projects on this machine.
 *
 * The per-project gate above (manifest inputHash) makes a REcompile free, but
 * a fresh project has no manifest and so always paid full price — every
 * scaffold recompiled a brain that is byte-identical to one already sitting
 * in another project's frame. The input hash is portable, so it can address a
 * machine-wide entry just as well as a local one.
 *
 * Only the compiled `.mjs` and its identity travel. `path` and `sourceDir`
 * are where THIS project keeps things, so each consumer writes its own
 * manifest around the shared artifact rather than copying one in.
 */
const ARTIFACT_CACHE = join(homedir(), ".axon", "cache", "cognets")

type SharedArtifact = { code: ArrayBuffer; blueprint: CognetArtifact["blueprint"] }

/** A previously compiled brain with this input hash, or null. */
async function readSharedArtifact(inputHash: string): Promise<SharedArtifact | null> {
    const dir = join(ARTIFACT_CACHE, inputHash)
    const code = Bun.file(join(dir, "cognet.mjs"))
    const meta = Bun.file(join(dir, "blueprint.json"))
    if (!(await code.exists()) || !(await meta.exists())) return null

    try {
        return { code: await code.arrayBuffer(), blueprint: JSON.parse(await meta.text()) }
    } catch {
        // A truncated or half-written entry reads as a miss; the caller
        // compiles and republishes over it.
        return null
    }
}

/**
 * Store a compiled brain under its input hash, atomically.
 *
 * Written beside the cache and renamed in, so a reader sees a complete entry
 * or none. Failures are swallowed deliberately: the caller already has a
 * valid artifact in its own frame, and an unwritable cache must slow a build
 * down rather than break it.
 */
async function publishSharedArtifact(
    inputHash: string,
    outFile: string,
    blueprint: CognetArtifact["blueprint"],
): Promise<void> {
    const final = join(ARTIFACT_CACHE, inputHash)
    if (existsSync(final)) return

    const pending = `${final}.pending-${crypto.randomUUID().slice(0, 8)}`
    try {
        await Bun.write(join(pending, "cognet.mjs"), Bun.file(outFile))
        // `path` and `uses` are deliberately dropped — they name the frame and
        // the conformance cases of whichever project happened to compile
        // first, and every consumer writes its own. Storing them would invite
        // someone to trust them.
        const { path: _local, uses: _uses, ...portable } = blueprint
        await Bun.write(join(pending, "blueprint.json"), JSON.stringify(portable))
        await rename(pending, final)
    } catch {
        await rm(pending, { recursive: true, force: true }).catch(() => {})
    }
}

// ── rebuild gating ────────────────────────────────────────────────────────────

/**
 * Hash everything a compile actually reads: the cognet's WHOLE source tree,
 * plus the VERSION of the runtime it fuses to.
 *
 * The tree, not a list of known entrypoints. This used to hash exactly
 * `cognet.config.ts`, `src/main.ts` and `plugins/*`, on the claim that
 * "nothing else can affect the output" — which was false the moment a brain
 * imported anything. `main.ts` importing `../config` is ordinary TypeScript
 * and the bundler inlines it, so editing that file changed the bundle without
 * changing the key: the cache served a stale brain forever, and every edit
 * appeared to do nothing. Tuning a constant and watching the vehicle ignore
 * you is exactly the kind of silent staleness a content-addressed cache
 * exists to prevent.
 *
 * Hashing the tree is the conservative direction. Following the real import
 * graph would be tighter, but a false MISS only costs a recompile while a
 * false HIT ships the wrong brain — so when in doubt, rebuild.
 */
/**
 * The shape of a cached artifact's blueprint. Bump it whenever a field is
 * added to, or removed from, what the bundle writes: every entry written
 * before then is then a miss, rebuilt, rather than read without the field.
 *
 *   2 — `mode`, so a client knows what kind of mind it is talking to
 */
const ARTIFACT_FORMAT = "artifact/2"

async function hashCognetInputs(sourceDir: string, agentRoot: string, schemaDir: string, native: string | null): Promise<string> {
    const hash = createHash("sha256")
    // What a cached entry HOLDS is an input too: an entry written in an older shape is a miss, never a blueprint missing a field.
    hash.update(`${ARTIFACT_FORMAT}\0`)
    // The entry loads its native module by name, and the name is the module's content: a new one is a new bundle.
    hash.update(`native\0${native ?? ""}\0`)

    hash.update(`${HOST_SPECIFIER}@${await hostVersion(agentRoot)}\0`)

    // Everything compilable under the cognet root, minus the build's own
    // output and installed dependencies (whose identity rides on the runtime
    // version above, not on their bytes).
    const walked = await fsx.walk(sourceDir, { skipDirs: ["node_modules", ".cognet", ".git"] })
    const files = walked
        .filter(({ relPath }) => /\.(ts|tsx|js|mjs|json|rs|py|toml|lock|proto)$/.test(relPath))
        .map(({ absPath }) => absPath)
        .sort()

    // What the schemas generated is compiled too — and differs whenever the generator does, whatever the schemas say.
    for (const file of existsSync(schemaDir) ? (await fsx.walk(schemaDir)).map(({ absPath }) => absPath).sort() : []) {
        const text = await Bun.file(file).text()
        hash.update(`${SCHEMA_SPECIFIER}${relative(schemaDir, file)}\0${text}`)
    }

    for (const file of files) {
        const text = await Bun.file(file).text().catch(() => null)
        // Path RELATIVE to the cognet root, never absolute: the same brain
        // installed under two different projects is the same brain, and
        // hashing where it happens to sit made every fresh scaffold a
        // guaranteed miss even though the bytes were identical.
        if (text !== null) hash.update(`${relative(sourceDir, file)}\0${text}`)
    }

    return hash.digest("hex")
}

/** The last compile's manifest, if its recorded input hash matches and the artifact it points to still exists. */
async function readCachedArtifact(manifestFile: string, outFile: string, inputHash: string): Promise<CognetArtifact | null> {
    if (!existsSync(manifestFile) || !existsSync(outFile)) return null

    const text = await Bun.file(manifestFile).text().catch(() => null)
    if (text === null) return null

    let manifest: (CognetArtifact["blueprint"] & { inputHash?: string }) | null = null
    try {
        manifest = JSON.parse(text)
    } catch {
        return null
    }
    if (!manifest || manifest.inputHash !== inputHash) return null

    const { inputHash: _drop, ...blueprint } = manifest
    return { blueprint }
}

// ── the wrap transform ────────────────────────────────────────────────────────

/** The script of a brain that has none: its systems are the whole program. */
const NO_SCRIPT = [
    "// generated by axon — this brain has no main.ts; its systems are the whole program.",
    "export default async function __cognet_main(): Promise<void> {}",
].join("\n")

/** The raw script, made callable — imports hoisted, body deferred to load(). */
function script(mainPath: string, sourceDir: string): string {
    const { imports, body } = splitImports(readFileSync(mainPath, "utf8"), dirname(mainPath))
    return [
        `// generated by axon — the raw script ${relative(sourceDir, mainPath)}, made callable.`,
        "// imports hoisted; body runs once at load(), after kernel binds.",
        imports,
        "export default async function __cognet_main(): Promise<void> {",
        body,
        "}",
    ].join("\n")
}

/**
 * Split a raw script into its top-level import statements and everything
 * else. Relative specifiers are re-anchored to the script's own directory
 * (the wrapped file lives in .agent/cognet/.build/) so `./context` keeps
 * working. Static top-level imports only — the honest limitation of the
 * v1 transform; a lexer replaces the regex when someone actually hits it.
 */
function splitImports(source: string, sourceDir: string): { imports: string; body: string } {
    // One import per match: the clause segment excludes quotes, so a match
    // can never lazily swallow a following import's specifier; the tail
    // absorbs `;` and trailing comments to end-of-line. Multiline named
    // imports (braces spanning lines) still match — the exclusion spans \n.
    const importPattern = /^import\s[^'"]*?["'][^"']+["'][^\n]*$|^import\s*["'][^"']+["'][^\n]*$/gm

    const imports: string[] = []
    const body = source.replace(importPattern, (statement) => {
        imports.push(reanchor(statement, sourceDir))
        return ""
    })

    return { imports: imports.join("\n"), body }
}

/**
 * An absolute path as a module specifier literal, ready to splice into
 * generated source.
 *
 * THE ONE WAY a path enters generated code. Forward slashes, because ESM
 * accepts them on every platform and a raw win32 path inside a TS string
 * literal is not a path at all — `C:\Users\tester\.axon\...` parses as
 * `\t`/`\b`/`\n` escapes, and the bundler then reports an unresolvable import
 * against a mangled specifier. That broke cognet compilation for every
 * Windows install (AX-COGNET-012), and it broke it in the one place that
 * hand-rolled the splice while its neighbours used JSON.stringify. Normalizing
 * here removes the escaping question instead of answering it three times.
 */
function specifier(path: string): string {
    return JSON.stringify(path.split(sep).join("/"))
}

/** `./x` and `../x` specifiers → absolute paths (the wrapped file moved). */
function reanchor(statement: string, sourceDir: string): string {
    return statement.replace(/(["'])((?:\.\.?\/)[^"']+)\1/, (_match, _quote: string, spec: string) => {
        const absolute = isAbsolute(spec) ? spec : resolve(sourceDir, spec)
        return specifier(absolute)
    })
}

// ── discovery ─────────────────────────────────────────────────────────────────

/** Directories no discovered file lives under: installed code and build output. */
const SKIP_DIRS = ["node_modules", ".git", ".cognet", ".agent"]

/** `export const flow = component<Flow>(...)` / `export const tracked = query({...})` / `export const world = frame({...})` */
const DEFINITION = /^export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:component|query|frame)\s*[<(]/gm

/** A file under the cognet root that defines components or queries, and the exports it defines. */
type DefinitionFile = { absPath: string; relPath: string; names: string[]; named: string }

/** A `*.system.ts` file under the cognet root. */
type SystemFile = { absPath: string; relPath: string }

const discover = {
    /**
     * Absolute paths of the cognet's lifecycle plugins — plugins/*.ts, sorted
     * for deterministic import order. Imported AFTER the host (so definePlugin
     * exists) and BEFORE main (so hooks register before "boot" fires).
     *
     * No plugins folder is an ordinary brain. Any OTHER failure to read it —
     * permissions, a file where the folder should be — throws: returning
     * "no plugins" there compiles a brain silently missing its tick driver.
     */
    async plugins(sourceDir: string): Promise<string[]> {
        const dir = join(sourceDir, "plugins")
        if (!existsSync(dir)) return []
        const names = await readdir(dir)
        return names
            .filter(n => n.endsWith(".ts") && !n.endsWith(".d.ts") && !n.endsWith(".test.ts"))
            .sort()
            .map(n => join(dir, n))
    },

    /**
     * Every `*.system.ts` under the cognet, wherever it sits. Convention over
     * config: the suffix IS the registration, and the schedule orders them
     * from their data, so where a system lives is the author's choice.
     */
    async systems(sourceDir: string): Promise<SystemFile[]> {
        const walked = await fsx.walk(sourceDir, { skipDirs: SKIP_DIRS })
        return walked.filter(({ relPath }) => relPath.endsWith(".system.ts"))
    },

    /**
     * Every file defining components or queries, with the exports it defines.
     *
     * Read as text, not executed: a definition's NAME is its folder plus its
     * export name, which is a fact about the source. The generated entry
     * imports each file and names exactly these exports; a handle defined any
     * other way stays unnamed and throws the first time a system uses it.
     */
    async definitions(sourceDir: string, named: (relPath: string) => string): Promise<DefinitionFile[]> {
        if (!existsSync(sourceDir)) return []
        const walked = await fsx.walk(sourceDir, { skipDirs: SKIP_DIRS })
        const found: DefinitionFile[] = []
        for (const file of walked) {
            if (!file.relPath.endsWith(".ts") || file.relPath.endsWith(".d.ts") || file.relPath.endsWith(".test.ts")) continue
            const source = readFileSync(file.absPath, "utf8")
            const names = [...source.matchAll(DEFINITION)].map(match => match[1]!)
            if (names.length > 0) found.push({ ...file, names: names, named: named(file.relPath) })
        }
        return found
    },
}

/**
 * The path a file is NAMED by. A cognet that keeps its code under `src/`
 * names everything from there — `L0/sense/vestibular/velocity`, not
 * `src/L0/…` — because `src/` is where the code lives, not part of what it
 * means. Files outside `src/` keep their path from the cognet root; a clash
 * between the two is refused by `Discovered` like any other.
 */
function naming(sourceDir: string): (relPath: string) => string {
    const hasSource = existsSync(join(sourceDir, "src"))
    return relPath => hasSource && relPath.startsWith("src/") ? relPath.slice("src/".length) : relPath
}

/**
 * The generated entry's body — import order IS the wiring.
 *
 * Host first (installs the ambient globals — definePlugin, component, query,
 * defineSystem), then plugins, config, the definition and system files, the
 * script, and finally the composition. `Discovered` is imported only when
 * there are systems: it exists only in hosts that can run them, so a new CLI
 * against an old installed host fails HERE, at build, instead of shipping a
 * brain whose systems never run. A loop-only brain stays buildable against
 * either.
 */
function composition(opts: {
    plugins: string[]
    configImport: string
    identity: Record<string, unknown>
    systems: SystemFile[]
    definitions: DefinitionFile[]
    /** Where the cognet's Rust systems' module sits, relative to the bundle; null when it has none. */
    native: string | null
    python: { systems: PythonSystem[]; executable: string } | null
    sourceDir: string
}): string[] {
    const hasSystems = opts.systems.length > 0 || opts.native !== null || opts.python !== null

    // One namespace import per file, shared when a system file also defines.
    const namespaces = new Map<string, string>()
    for (const file of [...opts.definitions, ...opts.systems]) {
        if (!namespaces.has(file.absPath)) namespaces.set(file.absPath, `__m${namespaces.size}`)
    }

    const lines = [
        `import { CognetHost${hasSystems ? ", Discovered" : ""}${opts.python ? ", Python" : ""} } from ${JSON.stringify(HOST_SPECIFIER)}`,
        ...opts.plugins.map((p, i) => `import ${specifier(p)} // plugin ${i}`),
        `import config from ${opts.configImport}`,
        ...[...namespaces].map(([path, name]) => `import * as ${name} from ${specifier(path)}`),
        `import main from "./main.ts"`,
        // Loaded beside the bundle, relative to it — on the main thread and in every worker the bundle becomes.
        ...(opts.native ? [`import { createRequire } from "node:module"`, `const native = createRequire(import.meta.url)(${JSON.stringify(opts.native)})`] : []),
        ...(opts.python ? [
            `import { fileURLToPath } from "node:url"`,
            `const python = Python({ project: fileURLToPath(new URL("./python/", import.meta.url)), executable: ${JSON.stringify(opts.python.executable)}, systems: ${JSON.stringify(opts.python.systems)} })`,
            `definePlugin(({ hooks }) => { hooks.on("shutdown", () => python.close()) })`,
        ] : []),
    ]

    if (!hasSystems) {
        return [...lines, `export default CognetHost({ ...config, ...${JSON.stringify(opts.identity)} }, main)`]
    }

    const named = naming(opts.sourceDir)
    const definitions = opts.definitions.map(file =>
        `        { file: ${JSON.stringify(file.named)}, module: ${namespaces.get(file.absPath)}, names: ${JSON.stringify(file.names)} },`)
    const systems = opts.systems.map(file =>
        `        { file: ${JSON.stringify(named(file.relPath))}, module: ${namespaces.get(file.absPath)} },`)

    return [
        ...lines,
        "const discovered = Discovered({",
        "    definitions: [",
        ...definitions,
        "    ],",
        "    systems: [",
        ...systems,
        "    ],",
        ...(opts.native ? ["    native: native,"] : []),
        ...(opts.python ? ["    python: python,"] : []),
        "})",
        `export default CognetHost({ ...config, ...${JSON.stringify(opts.identity)}, systems: discovered.systems }, main)`,
    ]
}
