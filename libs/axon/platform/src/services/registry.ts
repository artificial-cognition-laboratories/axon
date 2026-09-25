import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import type { AxonCloudClient } from "@arcforge/cloud"
import { err, type AxonError } from "@arcforge/err"
import { parseSpecifier } from "../build/project/specifier"

/**
 * Registry source retrieval. This deliberately has no repository semantics:
 * it resolves one immutable published artifact and materializes it once.
 * Git history, remotes, updates, and merges remain Git's job.
 */
/**
 * PromptCache — published prompts on disk, machine-wide, never installed into
 * an agent.
 *
 * A prompt is CONTENT, not code: nothing links against it, it has no ABI, and
 * it has no runtime presence in the agent. Installing one used to mean a
 * registry resolve, a full node_modules rewrite, a lockfile change, an
 * axon.config.ts edit and an agent reload — about a second of churn, and a
 * permanent dependency — to obtain a few KB of text. Worse, the tree rewrite
 * raced the agent's own file watcher, so a reload could fire while
 * @arcforge/cognet was momentarily absent and report a compile failure for an
 * install that actually succeeded.
 *
 * So prompts are fetched here instead: content-addressed by name and version
 * under ~/.axon/cache/prompts/, shared by every agent on the machine, and
 * rendered straight off that path. Rendering still happens IN the focused
 * agent's runtime — that is what gives a template its `axon` handle and the
 * agent's own resolved env (see core's promptContext) — but the runtime only
 * ever needed an absolute filePath, never a node_modules entry, which is the
 * coupling this removes.
 *
 * Versioned rather than a mutable "latest" directory: a cached render stays
 * reproducible, and an upgrade is a new directory rather than a silent change
 * under a prompt the user already trusts.
 */
export function PromptCache(opts: { cloud: AxonCloudClient; root: string }) {
    /** ~/.axon/cache/prompts/<scope>/<name>/<version>/ */
    function pathFor(name: string, version: string): string {
        return join(opts.root, "cache", "prompts", ...name.split("/"), version)
    }

    return {
        /**
         * The local directory for a published prompt, downloading it only if
         * this machine has never fetched that exact version.
         *
         * Resolution still goes to the registry (that is what turns "@axon/tdd"
         * into a version), so a first use needs the network; the payload
         * fetch is what the cache skips. A prompt fetched once renders offline
         * forever after.
         */
        async ensure(ref: string): Promise<{ name: string; version: string; root: string }> {
            if (!ref) throw err("CLONE_REF_REQUIRED")

            const { name, version: requested } = parseSpecifier(ref)
            const resolved = await opts.cloud.registry.resolve(name, requested)
            const target = pathFor(resolved.name, resolved.version)

            if (!existsSync(target) || (await readdir(target)).length === 0) {
                await extract(await download(resolved.downloadUrl), target)
            }

            return { name: resolved.name, version: resolved.version, root: target }
        },

        /** Every version of every prompt already on disk — what renders with no network. */
        async cached(): Promise<{ name: string; version: string; root: string }[]> {
            const base = join(opts.root, "cache", "prompts")
            if (!existsSync(base)) return []

            const found: { name: string; version: string; root: string }[] = []
            // <scope>/<name>/<version> — scopes are always present, since the
            // registry refuses unscoped artifact names.
            for (const scope of await readdir(base)) {
                for (const pkg of await readdir(join(base, scope)).catch(() => [])) {
                    for (const version of await readdir(join(base, scope, pkg)).catch(() => [])) {
                        found.push({ name: `${scope}/${pkg}`, version, root: join(base, scope, pkg, version) })
                    }
                }
            }
            return found
        },
    }
}

export type PromptCacheT = ReturnType<typeof PromptCache>

/**
 * `reportPrepareFailure` is opt-in, never the default — see runPrepare().
 * Only a caller that asked for FILES (the `axon clone` / `axon fork` commands)
 * wants a half-installed tree back instead of a throw.
 */
export type CloneOptions = { dir?: string; reportPrepareFailure?: boolean }

/**
 * Fetching the artifact bytes is an INJECTABLE seam, not a bare global.
 *
 * `download` used to reach straight for `globalThis.fetch`, which left a test
 * no way to serve a fixture tarball except to assign over that global. With
 * `parallel = true` in bunfig, Bun interleaves test FILES in one process, so
 * one file's stub was live inside every other file running at the same
 * moment: `zeno.test.ts` called clone() and was served `registry.test.ts`'s
 * archive of a directory that test had already deleted. 94 failures traced to
 * that one assignment, and an `afterEach` restore cannot help — it runs after
 * its own describe, long after a concurrent file has been handed the wrong
 * fetch.
 *
 * Injected the same way `Framework({ fetch })` in libs/repo already does it:
 * the default is the real thing, so production wiring passes nothing.
 */
export type ArtifactDownload = (url: string) => Promise<ArrayBuffer>

export function Registry(opts: {
    cloud: AxonCloudClient
    prepare(root: string): Promise<void>
    download?: ArtifactDownload
}) {
    const fetchArtifact: ArtifactDownload = opts.download ?? download

    /**
     * Install what was downloaded. Throws by DEFAULT; reports only on request.
     *
     * `clone` and `fork` each do two things — fetch an artifact, then install
     * its dependencies — and who is asking decides whether the second failing
     * should destroy the first.
     *
     * `axon clone` asks for FILES ("copy a published artifact into a
     * directory"). Its prepare step can fail for reasons belonging to the
     * artifact's AUTHOR rather than to the person cloning: an agent pinning a
     * cognet built for another kernel ABI aborted the clone outright
     * (COGNET_ABI_MISMATCH, seen in production). The tarball had already been
     * extracted, so the user got a tree on disk, no node_modules, and a fatal
     * error naming a version pin they never chose. The prepare-time ABI gate
     * catches a bad pairing at the moment it is CHOSEN — true of `axon
     * prepare` on your own agent, false of cloning someone else's.
     *
     * Every OTHER caller — zeno's first-run scaffold, an extension install, a
     * bench fixture — asked for a working project and never sees the
     * directory. For them a returned error is a silent failure by another
     * name: zeno would be installed broken, and the extension loader would
     * record a version for something that cannot load. So the throw is the
     * default and tolerance is opt-in, which also means no existing caller
     * changes behaviour.
     *
     * Nothing unsafe is admitted either way: core/src/cognet refuses a bad ABI
     * pairing at agent boot, so a cloned-but-unprepared project cannot quietly
     * run against the wrong kernel.
     */
    async function runPrepare(target: string, report: boolean): Promise<AxonError | null> {
        try {
            await opts.prepare(target)
            return null
        } catch (cause) {
            if (!report) throw cause
            return err(cause)
        }
    }

    async function clone(ref: string, cwd: string, options: CloneOptions = {}) {
        if (!ref) throw err("CLONE_REF_REQUIRED")

        const { name, version: requestedVersion } = parseSpecifier(ref)
        const resolved = await opts.cloud.registry.resolve(name, requestedVersion)
        const target = resolve(cwd, options.dir ?? directoryName(resolved.name))
        await extract(await fetchArtifact(resolved.downloadUrl), target)
        const prepareError = await runPrepare(target, options.reportPrepareFailure === true)

        return { ...resolved, root: target, prepareError }
    }

    async function fork(ref: string, cwd: string, options: CloneOptions & { as?: string } = {}) {
        if (!options.as) throw err("FORK_NAME_REQUIRED")

        if (!ref) throw err("FORK_REF_REQUIRED")
        const { name, version: requestedVersion } = parseSpecifier(ref)
        const resolved = await opts.cloud.registry.resolve(name, requestedVersion)
        const target = resolve(cwd, options.dir ?? directoryName(options.as))
        await extract(await fetchArtifact(resolved.downloadUrl), target)

        const cloneResult = { ...resolved, root: target }
        const packagePath = join(cloneResult.root, "package.json")
        const raw = JSON.parse(await readFile(packagePath, "utf-8")) as Record<string, unknown>
        const previousAxon = raw.axon && typeof raw.axon === "object" && !Array.isArray(raw.axon)
            ? raw.axon as Record<string, unknown>
            : {}

        raw.name = options.as
        raw.version = "0.1.0"
        raw.axon = {
            ...previousAxon,
            forkedFrom: { name: cloneResult.name, version: cloneResult.version },
        }
        await writeFile(packagePath, JSON.stringify(raw, null, 2) + "\n")
        const prepareError = await runPrepare(target, options.reportPrepareFailure === true)

        return { ...cloneResult, name: options.as, version: "0.1.0", prepareError }
    }

    return { clone, fork }
}

export type RegistryT = ReturnType<typeof Registry>

function directoryName(name: string): string {
    return basename(name)
}

/**
 * Runs `tar`, returning its result rather than throwing on a non-zero exit
 * — the caller distinguishes "listing failed" from "extraction failed".
 *
 * node:child_process rather than Bun.$: this module is reached from the
 * Fleet extension host, which runs Node, and `Bun` is simply undefined
 * there. The platform's own header calls the TUI and the extension "I/O
 * adapters over this one object", which is only true if the object itself
 * is runtime-portable — a Bun builtin on the clone path made it false, and
 * clone threw for one of the two adapters.
 */
function tar(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise(resolve => {
        execFile("tar", args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
            resolve({
                // execFile reports a spawn failure (no tar on PATH) with no
                // code — 1 keeps that an ordinary failure for the caller.
                exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
                stdout,
                stderr: stderr || (error ? error.message : ""),
            })
        })
    })
}

async function download(url: string): Promise<ArrayBuffer> {
    const response = await fetch(url)
    if (!response.ok) {
        throw err("ARTIFACT_DOWNLOAD_FAILED", {
            detail: `${response.status} ${response.statusText}`,
            context: { status: response.status },
        })
    }
    return response.arrayBuffer()
}

async function extract(buffer: ArrayBuffer, target: string): Promise<void> {
    let created = false
    if (existsSync(target)) {
        if ((await readdir(target)).length > 0) {
            throw err("CLONE_TARGET_EXISTS", { detail: `${target} is not empty`, context: { target } })
        }
    } else {
        await mkdir(target, { recursive: true })
        created = true
    }

    const archive = join(target, `.axon-clone-${createHash("sha256").update(new Uint8Array(buffer)).digest("hex")}.tar.gz`)
    try {
        await writeFile(archive, new Uint8Array(buffer))

        // npm tarballs nest everything under a single "package/" directory and
        // every package manager strips exactly that component on extract (see
        // Stage()'s own comment). Modules and cognets are staged that way
        // so `bun add` can install them; agent bundles are not. Detect which
        // shape this archive is rather than assuming, so one extractor handles
        // both — without this, a cloned module landed at <target>/package/ and
        // `prepare` reported PROJECT_NOT_FOUND at a directory that looked empty.
        const listing = await tar(["-tzf", archive])
        const paths = listing.stdout.split("\n").filter(Boolean)
        const npmPrefixed = paths.length > 0 && paths.every(entry => entry === "package/" || entry.startsWith("package/"))

        const result = npmPrefixed
            ? await tar(["-xzf", archive, "-C", target, "--strip-components=1"])
            : await tar(["-xzf", archive, "-C", target])
        if (result.exitCode !== 0) {
            throw err("ARTIFACT_EXTRACT_FAILED", {
                detail: result.stderr.trim(),
                context: { exitCode: result.exitCode },
            })
        }
    } catch (error) {
        // A failed extraction must not leave a half-project that then blocks retry.
        if (created) await rm(target, { recursive: true, force: true })
        throw error
    } finally {
        await rm(archive, { force: true })
    }
}
