import { createHash } from "node:crypto"
import { readdir, rename, rm } from "node:fs/promises"
import { existsSync, lstatSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { err } from "@arcforge/err"
import { KERNEL_ABI_VERSION } from "@arcforge/types"
import type { CognetBlueprint, CognetDefinition } from "@arcforge/types"
import { fsx } from "../../../utils/fs"
import { Frame } from "../../frame"
import { readCognetAbi } from "./abi"

// The subprocess entry that actually runs Bun.build() — see runBundleWorker()
// for why this isn't inline.
//
// Packaged builds ship the worker as a sibling .js (see vterm.config.ts's
// onBundle + packageFiles); source checkouts run the .ts directly. Same
// resolution pattern as declare-worker/tool-bundle-worker — without it the
// installed CLI looks for a .ts that was never published and every agent
// fails to compile its brain.
const packagedWorker = resolve(import.meta.dir, "bundle-worker.js")
const BUNDLE_WORKER_PATH = existsSync(packagedWorker)
    ? packagedWorker
    : resolve(import.meta.dir, "bundle-worker.ts")

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
async function runBundleWorker(entryPath: string, external: string[]): Promise<BundleWorkerResult> {
    const proc = Bun.spawn(["bun", "run", BUNDLE_WORKER_PATH, entryPath, external.join(",")], {
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
        .filter(({ relPath }) => /\.(ts|tsx|js|mjs|json)$/.test(relPath))
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
 * The authoring surface is two clutter-free files — cognet.config.ts
 * (declaration via defineCognet) and src/main.ts (a raw script declaring
 * loop() against ambient globals). This step is the desugar:
 *
 * 1. WRAP main.ts — hoist its import statements out, defer its body into
 *    an exported async function. The script becomes callable; the host
 *    runs it once at load(), after the kernel global is bound.
 * 2. GENERATE an entry that imports the host FIRST (module evaluation
 *    order — installing the globals before config/main evaluate), then
 *    composes: `export default CognetHost({ ...config, ...identity }, main)`,
 *    with identity resolved here from package.json + the kernel's ABI.
 * 3. BUNDLE the entry (Bun.build) — host, config, main, and their whole
 *    import graph inlined into one file the runtime imports and verifies.
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
 * The brain's entry file — `src/main.ts`, or `main.ts` at the cognet root.
 *
 * Both, because both are natural at their own scale. A published cognet with
 * plugins, state and several modules wants `src/`; a brain inlined in an agent
 * is often one file, and making it sit alone inside a `src/` directory is
 * ceremony with nothing to organize. The layout is the author's call.
 *
 * `src/` wins when both exist rather than erroring: it is the conventional
 * layout, so a stray top-level `main.ts` beside a real `src/main.ts` is far
 * more likely to be a leftover than an intentional second entry.
 *
 * Throws with both candidates named — a cognet with no entry compiles to
 * nothing, and the ENOENT this used to raise pointed only at `src/main.ts`,
 * which was actively misleading for a flat layout.
 */
function resolveCognetMain(sourceDir: string): string {
    const nested = join(sourceDir, "src", "main.ts")
    if (fsx.isFile(nested)) return nested

    const flat = join(sourceDir, "main.ts")
    if (fsx.isFile(flat)) return flat

    throw err("COGNET_INVALID", {
        detail: `no brain entry in ${sourceDir} — expected src/main.ts or main.ts`,
        context: { sourceDir, candidates: [nested, flat] },
    })
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

    const mainSource = await Bun.file(mainPath).text()

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

    const inputHash = await hashCognetInputs(opts.sourceDir, opts.agentRoot)
    const cached = await readCachedArtifact(manifestFile, outFile, inputHash)
    if (cached) return cached

    // Nothing in this project's frame, but the SAME brain may already have
    // been compiled for another project on this machine — the input hash is
    // portable, so identical sources share an entry. Copy the artifact in and
    // write this project's own manifest around it (path/sourceDir are
    // project-specific, so only the .mjs travels).
    const shared = await readSharedArtifact(inputHash)
    if (shared) {
        await Bun.write(outFile, shared.code)
        await Bun.write(
            manifestFile,
            JSON.stringify({ ...shared.blueprint, path: outFile, inputHash, sourceDir: opts.sourceDir }, null, 4),
        )
        return { blueprint: { ...shared.blueprint, path: outFile } }
    }

    // 1. wrap the raw script — imports hoisted, body deferred
    const { imports, body } = splitImports(mainSource, dirname(mainPath))
    const wrapped = [
        `// generated by axon — the raw script ${relative(opts.sourceDir, mainPath)}, made callable.`,
        "// imports hoisted; body runs once at load(), after kernel binds.",
        imports,
        "export default async function __cognet_main(): Promise<void> {",
        body,
        "}",
    ].join("\n")
    await Bun.write(join(buildDir, "main.ts"), wrapped)

    // 2. the composed entry — import order IS the wiring:
    //    host first (installs the ambient globals, incl. definePlugin),
    //    then plugins (their definePlugin(...) calls register hooks at import
    //    time — before load() fires "boot"), then config, then main.
    const plugins = await discoverPlugins(opts.sourceDir)

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
    const identity = {
        ...(await cognetIdentity({ sourceDir: opts.sourceDir, agentRoot: opts.agentRoot, inline: opts.inline })),
        abi: (hasConfig ? await readCognetAbi(opts.sourceDir) : null) ?? KERNEL_ABI_VERSION,
    }

    // Identity is MERGED INTO the config object rather than passed as its own
    // argument. CognetHost is a published package's public surface, and a
    // compiled bundle inlines whichever copy of it the agent has installed —
    // so widening the call to three arguments would mean a new CLI emitting a
    // call an older installed host cannot answer, shifting `main` into
    // `config` and killing the brain at load(). Spread last: identity is the
    // resolved fact, and a config that somehow still carries a stale name
    // must not win over it.
    const entry = [
        "// generated by axon — composes identity + plugins + script into the definition.",
        `import { CognetHost } from ${JSON.stringify(HOST_SPECIFIER)}`,
        ...plugins.map((p, i) => `import ${specifier(p)} // plugin ${i}`),
        `import config from ${configImport}`,
        `import main from "./main.ts"`,
        `export default CognetHost({ ...config, ...${JSON.stringify(identity)} }, main)`,
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

    const result = await runBundleWorker(entryPath, external)
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
        ...(definition.wakeOn ? { wakeOn: definition.wakeOn } : {}),
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
        // `path` is deliberately dropped — it names the frame of whichever
        // project happened to compile first, and every consumer overwrites it
        // with its own. Storing it would invite someone to trust it.
        const { path: _local, ...portable } = blueprint
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
async function hashCognetInputs(sourceDir: string, agentRoot: string): Promise<string> {
    const hash = createHash("sha256")

    hash.update(`${HOST_SPECIFIER}@${await hostVersion(agentRoot)}\0`)

    // Everything compilable under the cognet root, minus the build's own
    // output and installed dependencies (whose identity rides on the runtime
    // version above, not on their bytes).
    const walked = await fsx.walk(sourceDir, { skipDirs: ["node_modules", ".cognet", ".git"] })
    const files = walked
        .filter(({ relPath }) => /\.(ts|tsx|js|mjs|json)$/.test(relPath))
        .map(({ absPath }) => absPath)
        .sort()

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

// ── plugin discovery ──────────────────────────────────────────────────────────

/**
 * Absolute paths of the cognet's lifecycle plugins — plugins/*.ts, sorted
 * for deterministic import order. Each is imported into the entry AFTER the
 * host (so definePlugin exists) and BEFORE main (so hooks are registered
 * before "boot" fires). Convention over config: no manifest, the folder IS
 * the registry — same as agents/modules.
 */
async function discoverPlugins(sourceDir: string): Promise<string[]> {
    const dir = join(sourceDir, "plugins")
    let names: string[]
    try {
        names = await readdir(dir)
    } catch {
        return []
    }
    return names
        .filter(n => n.endsWith(".ts") && !n.endsWith(".d.ts") && !n.endsWith(".test.ts"))
        .sort()
        .map(n => join(dir, n))
}
