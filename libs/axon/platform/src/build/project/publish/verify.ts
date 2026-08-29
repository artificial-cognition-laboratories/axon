import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readdir, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { err } from "@arcforge/err"
import { bundleCognet } from "../../blueprint/cognet/bundle"
import { Tools } from "../../blueprint/scan/tools"
import { DisposerSink, loadSource } from "../../extensions/load"
import type { ProjectKind } from "../kinds"

/**
 * Verify a built artifact by BUILDING IT THE WAY A CONSUMER WILL.
 *
 * A published version is immutable: a broken artifact cannot be repaired, only
 * superseded, and every consumer who already resolved it stays stuck until
 * they explicitly move. So the last moment a defect is cheap is here, before
 * `artifacts.create()` — after which it is permanent and someone else's
 * problem.
 *
 * Everything publish did until now concerned TRANSPORT: tar the files, upload,
 * register. Nothing asked whether the thing being shipped works. That is how a
 * cognet went out whose `src/main.ts` imported `../config` while the packager's
 * whitelist dropped `config.ts` from the tarball — valid gzip, correct
 * metadata, accepted by the registry, resolvable, downloadable, and impossible
 * to compile. The only place it could fail was a consumer's machine, naming a
 * path that existed on the author's disk and nowhere else.
 *
 * THIS MUST REUSE THE CONSUMER'S OWN CODE PATH. A parallel "is it valid?"
 * checker is a second model of correctness, and a second model can drift from
 * the first — which is precisely the bug being fixed. Calling bundleCognet()
 * means this gate cannot disagree with the consumer, because it IS the
 * consumer.
 *
 * It verifies the TARBALL, not the project directory. The tarball is the
 * artifact; the project root always holds every file whether or not it
 * shipped, so building from the root would pass exactly when the bug is
 * present.
 */

type VerifyOpts = {
    kind: ProjectKind
    /** Absolute path to the built source.tar.gz — the thing consumers download. */
    tarball: string
    /**
     * The project root. Used ONLY to resolve the installed cognet runtime the
     * bundle fuses to — the source being compiled comes from the tarball.
     */
    root: string
    name: string
}

/**
 * Kinds whose artifact is SOURCE the consumer compiles.
 *
 * A cognet's whole artifact is source that bundles on the consumer's machine.
 *
 * A module's is source in the part that matters here: its `src/tools/*.ts`
 * are read by the installing agent's scanner, which compiles their TypeScript
 * declarations to build the tool scope. Nothing in publishing exercised that,
 * so a module whose exported signature referenced an unresolvable type
 * published cleanly and failed on every consumer's install instead —
 * @axon/arxiv@0.1.4 shipped with `QueryOptions` used in an exported signature
 * and never re-exported, and the only surface that ever said so was a user's
 * terminal mid-install.
 */
/**
 * An extension's is source too, and it is IMPORTED rather than compiled: the
 * TUI evaluates `main.ts` and `plugins/*` on the user's machine. An import
 * that cannot resolve is the same defect class as a module's unresolvable
 * type — invisible to the author, fatal for every consumer, and immutable
 * once published. An extension left unverified was the last kind whose
 * failure surfaced only in someone else's terminal.
 */
const COMPILES = new Set<ProjectKind>(["cognet", "module", "extension"])

export async function verifyArtifact(opts: VerifyOpts): Promise<void> {
    if (!COMPILES.has(opts.kind)) return

    // Scratch lives UNDER the project root, not in /tmp. The generated entry
    // imports the cognet runtime by bare specifier, so it must sit somewhere a
    // resolver can walk up from and find node_modules — which /tmp is not.
    const scratch = await mkdtemp(join(opts.root, ".axon-verify-"))
    try {
        const extracted = join(scratch, "src")
        await mkdir(extracted, { recursive: true })

        // Both pipes are drained CONCURRENTLY with the wait, never after it.
        // A pipe has a finite buffer (~64KB): a child that fills one blocks on
        // write and never exits, so `await proc.exited` before reading is a
        // deadlock waiting for a big enough tarball. Reading stderr only on
        // the failure path has the same shape — it leaves an undrained pipe
        // holding the event loop open on every success.
        const untar = Bun.spawn(["tar", "-xzf", opts.tarball, "-C", extracted], {
            stdout: "pipe",
            stderr: "pipe",
        })
        const [untarCode, , untarStderr] = await Promise.all([
            untar.exited,
            new Response(untar.stdout).text(),
            new Response(untar.stderr).text(),
        ])
        if (untarCode !== 0) {
            throw err("PUBLISH_VERIFY_FAILED", {
                detail: `${opts.name}: could not extract the built tarball — ${untarStderr}`,
                context: { name: opts.name, tarball: opts.tarball },
            })
        }

        // npm-format tarballs put everything under package/.
        const sourceDir = join(extracted, "package")

        if (opts.kind === "module") {
            await verifyModuleTools(sourceDir, opts.name, scratch)
            return
        }

        if (opts.kind === "extension") {
            await verifyExtensionLoads(sourceDir, opts.name)
            return
        }

        try {
            // agentRoot is the PROJECT root, not the scratch dir: the cognet
            // runtime it compiles against is resolved from an installed
            // node_modules, and the extracted tarball has none. Output lands
            // under scratch so a verify never touches the project's own
            // .agent/ artifacts.
            await bundleCognet({ sourceDir, agentRoot: opts.root, outDir: join(scratch, "out") })
        } catch (cause) {
            throw err("PUBLISH_VERIFY_FAILED", {
                detail:
                    `${opts.name} was packaged but does not compile from its own artifact — `
                    + `a consumer installing it would hit this same error. Most often a file `
                    + `the source imports was not included in the package.`,
                context: { name: opts.name, kind: opts.kind },
                cause,
            })
        }
    } finally {
        await rm(scratch, { recursive: true, force: true })
    }
}

/**
 * Load an extension exactly as the TUI will, from its own artifact.
 *
 * Same rule as the two gates above: call the CONSUMER'S function rather than
 * reimplementing the check. `loadSource` is what the TUI runs on every boot,
 * so a defect it does not catch is a defect the user will not hit, and one it
 * does catch is one they certainly would.
 *
 * ── What this can and cannot prove ──────────────────────────────────────────
 *
 * It proves the package RESOLVES and EVALUATES: every import present, no
 * throw at module scope, syntax valid. That is the failure that matters,
 * because it is total — an extension that cannot be imported contributes
 * nothing at all, and the author's only signal today is a stranger's install.
 *
 * It cannot prove the extension is CORRECT. The globals it registers against
 * belong to the TUI, so they are stubbed here: a call is recorded, never
 * executed. An extension that registers a broken command still publishes,
 * which is right — that is a bug in its behaviour, not in its packaging, and
 * publishing is not the place to run someone's terminal.
 *
 * The stubs are permissive on purpose. A missing global would make this
 * report a defect in OUR harness as a defect in THEIR package, which is the
 * one outcome worse than not checking at all.
 */
async function verifyExtensionLoads(sourceDir: string, name: string): Promise<void> {
    const restore = installStubGlobals()
    try {
        const result = await loadSource({
            root: sourceDir,
            label: name,
            sink: DisposerSink(),
            mainError: "EXTENSION_LOAD_FAILED",
        })

        const failed = result.files.find(file => file.error !== null)
        if (!failed) return

        throw err("PUBLISH_VERIFY_FAILED", {
            detail:
                `${name} was packaged but does not load from its own artifact — `
                + `a user installing it would hit this same error. Most often a file `
                + `the source imports was not included in the package.`,
            context: { name, kind: "extension", file: failed.path },
            cause: failed.error,
        })
    } finally {
        restore()
    }
}

/**
 * Stand-ins for the globals a config is written against, for the duration of
 * one verification.
 *
 * A Proxy per global answers any property with a no-op returning a disposer,
 * so an extension calling `commands.register(...)`, `theme.create(...)` or
 * anything added later evaluates without this file needing to track the API
 * surface. Keeping that list in sync would mean a new global silently failing
 * every publish until someone noticed.
 *
 * Previous values are restored rather than deleted: this runs inside the
 * user's own CLI process, which may itself have loaded a config.
 */
function installStubGlobals(): () => void {
    const scope = globalThis as Record<string, unknown>
    const names = ["tui", "palette", "commands", "keys", "mode", "input", "agents", "theme", "lines", "components"]
    const previous = new Map(names.map(key => [key, scope[key]]))

    const noop = (): (() => void) => () => {}
    const stub = new Proxy({}, {
        get: () => noop,
        // An extension may read a value (`theme.active`) as well as call a
        // verb, and answering every read with a function is enough for
        // evaluation to proceed.
        has: () => true,
    })

    for (const key of names) if (previous.get(key) === undefined) scope[key] = stub

    return () => {
        for (const [key, value] of previous) {
            if (value === undefined) delete scope[key]
            else scope[key] = value
        }
    }
}

/**
 * Compile a module's tool declarations exactly as an installing agent will.
 *
 * The consumer's scanner reads `src/tools/*.ts` to build the tool scope — the
 * model needs each tool's signature and every type that signature names. A
 * type with no resolvable definition throws on the consumer's machine, at
 * install time, for an artifact that is already immutable.
 *
 * Same rule as the cognet gate above: this calls the CONSUMER'S function
 * rather than reimplementing the check. A parallel "are these types
 * resolvable?" validator would be a second model of correctness, free to
 * drift from the real one — and drift is the bug class this exists to catch.
 *
 * VERIFYING IN THE CONSUMER'S LOCATION IS PART OF CALLING THE CONSUMER'S
 * FUNCTION. This extracted to a plain scratch directory at first, and the
 * distinction turned out to be the whole ballgame: TypeScript skips
 * declaration emit for anything under `node_modules`, so a module that
 * verified perfectly in scratch failed for every consumer that installed it.
 * @axon/arxiv shipped twice that way. Same bytes, same function, different
 * answer — so the location is an input to the check, and the check has to use
 * the real one.
 *
 * A module with no tools verifies trivially: plenty are routes, plugins or
 * prompts, and having nothing to declare is not a defect.
 */
async function verifyModuleTools(sourceDir: string, name: string, scratch: string): Promise<void> {
    if (!existsSync(join(sourceDir, "src", "tools"))) return

    // Re-root the extracted package under a node_modules path, because that is
    // where a consumer's copy lives and TypeScript behaves differently there.
    // Named for the module so the path a consumer would have is reproduced as
    // closely as the scratch allows.
    const installedAs = join(scratch, "node_modules", ...name.split("/"))
    await mkdir(dirname(installedAs), { recursive: true })
    await rename(sourceDir, installedAs)

    const toolsDir = join(installedAs, "src", "tools")
    if (!existsSync(toolsDir)) return

    const files = (await readdir(toolsDir))
        .filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts"))
        .map(file => join(toolsDir, file))
    if (files.length === 0) return

    try {
        // The consumer's ENTRY POINT, not the compiler underneath it. Tools()
        // is what an installing agent calls, and it prefers the published
        // manifest over recompiling — so verifying through declareTools()
        // directly would test a path the consumer no longer takes, which is
        // the same class of mistake as verifying in the wrong directory.
        //
        // `required: true` makes a failure throw rather than degrade to a
        // warning: at publish time there is no running agent to keep alive,
        // and a warning nobody reads is how a broken artifact ships.
        const scanned = await Tools(installedAs, { required: true })

        // A tool file that produced no entry is a silent omission — the model
        // is never told the tool exists, and the author's only signal is its
        // absence. Publishing that is worse than failing here.
        if (scanned.entries.length !== files.length) {
            const found = new Set(scanned.entries.map(entry => entry.name))
            const missing = files
                .map(file => file.slice(file.lastIndexOf("/") + 1, -3))
                .filter(base => !found.has(base))
            throw err("PUBLISH_VERIFY_FAILED", {
                detail:
                    `${name} was packaged but ${missing.join(", ")} produced no tool declaration — `
                    + `an agent installing it would not see ${missing.length === 1 ? "that tool" : "those tools"} at all.`,
                context: { name, kind: "module", missing },
            })
        }
    } catch (cause) {
        throw err("PUBLISH_VERIFY_FAILED", {
            detail:
                `${name} was packaged but its tools do not compile from its own artifact — `
                + `an agent installing it would hit this same error, and the published `
                + `version cannot be changed afterwards.`,
            context: { name, kind: "module" },
            cause,
        })
    }
}
