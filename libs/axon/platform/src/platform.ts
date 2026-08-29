import type { FrameworkSource } from "./build/project/manifest/package"
import { Store, storeRoot } from "./services/store"
import { Ollama } from "./services/ollama"
import { Mic } from "./services/mic"
import { Files } from "./services/files"
import { Cloud } from "./services/cloud"
import { Deployments } from "./services/deployments"
import { Projects } from "./build/project"
import { Profile, Runtime } from "./build/runtime"
import type { AgentSupervisor } from "./build/runtime/instances"
import { Extensions, ProfileConfigFile } from "./build/extensions"
import { Resources } from "./services/resources"

import { TestRunner } from "./services/test"
import { Registry, PromptCache } from "./services/registry"
import { Prompts } from "./services/prompts"
import { Updates } from "./services/update"
import { join, resolve } from "node:path"
import type { Distribution } from "./services/cloud"
import type { ProviderEntry } from "@arcforge/types"

const BUILD_DISTRIBUTION: Distribution = process.env.NODE_ENV === "production" ? "production" : "development"

/**
 * Platform — the composition root of the Axon developer platform.
 * Headless: no terminal, no reactivity, no prompts. The TUI and the Fleet
 * extension are I/O adapters over this one object.
 *
 * Owns exactly the process-lifetime state:
 *   store    — ~/.axon (credentials, settings, caches)
 *   cloud    — a real AxonCloud client plus disk wiring (profiles, providers)
 *   projects — every project kind: find, open, create, prepare, publish
 *   profile  — the user's own directory (main.ts, plugins, extensions)
 *   agents   — every agent running on this machine, and the focused one
 *   ollama   — local models: what's installed, what's available, pulling more
 *   tests    — native Bun execution projected into structured lifecycle events
 * plus the domain operations both surfaces invoke.
 *
 * Anything stateless (Blueprint, Capsule, Air, core) is a library the
 * operations import — Platform does not re-export the world.
 */
export function Platform(opts: PlatformOpts) {
    const cwd = resolve(opts.cwd ?? process.cwd())
    const distribution = opts.distribution ?? BUILD_DISTRIBUTION

    /**
     * Settings live in `profile.config.ts`, which only build/extensions can
     * read — and Extensions is constructed further down, in terms of the very
     * store being built here. So the store takes thunks and the binding is
     * completed once both exist.
     *
     * A cached synchronous snapshot, because `extraRoots()` is synchronous and
     * every caller of it is: parsing TypeScript per call, on a path resolved
     * during an agent scan, is not something to do lazily.
     */
    let settingsCache: { paths?: string[] } = {}

    const store = Store({
        root: opts.store ?? storeRoot(distribution),
        settings: () => settingsCache,
        setSetting: async (key, value) => {
            const result = await extensions.setSetting(key, value)
            await refreshSettings()
            return result
        },
    })
    const cloud = Cloud({ store: store, distribution: distribution })

    const ollama = Ollama() // local models via the Ollama daemon
    const mic = Mic() // mic capture + visualizer service
    // The user's working tree, for referencing paths by hand. Rooted at the
    // invocation directory rather than at any agent's project: `@` means "a
    // file in what I'm working on", and an agent lives under ~/.axon.
    const files = Files({ root: cwd })
    const tests = TestRunner() // standalone event-based Bun runner

    // A bench project's `agent` axis may name a registry ref, which has to be
    // fetched and prepared before any cell can boot — so a bench needs both
    // the registry and project preparation. Both are defined below in terms of
    // `projects`, so they arrive as thunks rather than values: construction is
    // wiring, and nothing here calls anything.
    /**
     * The active profile's declared inference sources.
     *
     * ASYNC because reading them evaluates the user's own `profile.config.ts`
     * — the same single evaluator the extension loader uses, so the two can
     * never disagree about what a profile declares. Read per prepare rather
     * than cached: a profile switch or a config edit must be visible on the
     * next agent boot, and prepare is already doing far more expensive work.
     *
     * Silent on failure by design. A broken profile config reports through
     * the extension loader, which owns telling a user their config is wrong;
     * a second message from here would only make the first one ambiguous.
     */
    async function profileProviders(): Promise<readonly ProviderEntry[] | undefined> {
        const root = store.profiles.active()?.root
        if (!root) return undefined
        const { providers } = await ProfileConfigFile(root)
        // Undefined travels: it means "never configured", which the pool
        // answers with the default. Returning [] here would tell every
        // profile written before this field existed that it has no inference.
        return providers
    }

    /**
     * This machine's local-inference capacity and what is holding it.
     *
     * Constructed here because it is machine state every surface shares: the
     * TUI shows it, Fleet lists it, and a provider consults it before loading
     * weights. The budget is read from the active profile per call — a user
     * who raises their ceiling must not have to restart the terminal.
     */
    const resources = Resources({
        budget: () => undefined,
    })

    const projects = Projects({
        cloud: cloud.client,
        // Read fresh per call, never captured: the active profile changes
        // while the process runs, and every agent prepared afterwards must
        // see the new user's providers rather than the boot-time one's.
        profileProviders: () => profileProviders(),
        frameworkVersion: opts.version,
        ...(opts.frameworkSource ? { frameworkSource: opts.frameworkSource } : {}),
        ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
        bench: {
            tests: tests,
            clone: (ref, cwd, options) => registry.clone(ref, cwd, options),
            prepare: async root => { await (await projects.open(root)).prepare() },
        },
    }) // project management, every kind

    // `clone` arrives as a thunk for the same reason the bench axis does:
    // `registry` is constructed below, in terms of `projects`.
    const agents = Runtime({
        ...(opts.daemon ? { daemon: opts.daemon } : {}),
        store: store,
        projects: projects,
        cloud: cloud.client,
        cwd: cwd,
        clone: (ref, cwd, options) => registry.clone(ref, cwd, options),
        ...(opts.control ? { control: opts.control } : {}),
    }) // every agent running on this machine

    const registry = Registry({
        cloud: cloud.client,
        async prepare(root) {
            // Clone resolves across the shared namespace, so a cloned artifact
            // may be an agent, module, cognet or bench. project.prepare() is
            // kind-aware — let it dispatch on what was actually cloned.
            const project = await projects.open(root)
            await project.prepare()
        },
    }) // immutable registry source retrieval
    
    // Prompts are fetched to a machine-wide cache and rendered off that path —
    // never installed into an agent. See services/prompts.ts.
    const prompts = Prompts({ cache: PromptCache({ cloud: cloud.client, root: store.root }) })

    const updates = Updates({ cloud: cloud.client, store: store, currentVersion: opts.version })
    const deployments = Deployments({ cloud: cloud.client }) // the user's deployed agents, cached

    // The user's own directory, as a project. Beside `projects` rather than
    // inside `agents`: Runtime() is every agent running on this machine, and a
    // profile is not an agent — it is where a person configures the terminal.
    const profile = Profile({ store: store, projects: projects, frameworkVersion: opts.version })

    // The user's TUI config — their main.ts and plugins/, plus the extensions
    // they enable. A thunk for `install` for the same reason zeno's clone is
    // one: registry is constructed below, in terms of projects.
    /**
     * Re-read the config's settings into the cache.
     *
     * Called after every write here, and by the TUI after every config load —
     * so a hand edit takes effect on save exactly like a `:` command does.
     */
    async function refreshSettings(): Promise<void> {
        // No profile yet (a first boot before login) is a real "nothing is
        // declared", not a failure — there is no config to read.
        if (!store.profiles.active()) {
            settingsCache = {}
            return
        }
        // Deliberately NOT caught. An unreadable profile.config.ts used to
        // land here as an empty cache, which made "your config is broken"
        // and "your config declares nothing" the same observable state —
        // and that is precisely how a declared `paths` entry could silently
        // stop being scanned. The loader owns explaining the breakage; this
        // owns not pretending it did not happen.
        settingsCache = (await extensions.settings()) as { paths?: string[] }
    }

    const extensions = Extensions({
        root: () => profile.root,
        install: async (ref, dir) => {
            // The resolved version comes back from the registry and is handed
            // up so the caller can PIN it — both in the config entry and as
            // the directory the shared store files it under. Without it the
            // install would have to guess, and a pin that guesses is not a pin.
            const cloned = await registry.clone(ref, join(dir, ".."), { dir: dir.split("/").at(-1)! })
            return { version: cloned.version }
        },
        // Resolution only — no download, no write. `updates()` asks what the
        // registry publishes; installing it stays a separate, explicit act.
        latest: async name => (await cloud.client.registry.artifacts.resolve(name)).version,
    })

    return {
        cloud: cloud,
        store: store,
        deployments: deployments,
        projects: projects,
        profile: profile,
        extensions: extensions,
        /**
         * Re-read `profile.config.ts` settings into the store's cache.
         *
         * Called by whoever loads the config — every load, including the
         * watcher's. Without it, `paths` added by hand would not be scanned
         * until the next process start.
         */
        refreshSettings: refreshSettings,
        agents: agents,
        registry: registry,
        prompts: prompts,
        tests: tests,
        mic: mic,
        files: files,
        ollama: ollama,
        /** This machine's local-inference capacity, and what is holding it. */
        resources: resources,
        updates: updates,
    }
}

export type PlatformT = ReturnType<typeof Platform>

type PlatformOpts = {
    /**
     * Who supervises a spawned agent.
     *
     * The platform no longer supervises. Everything about BUILDING an agent
     * still lives here — resolve, prepare, blueprint.load — and the moment
     * there is a process to boot, that is the daemon's.
     *
     * OPTIONAL, and `spawn` is what refuses when it is absent. Most consumers
     * of a Platform never boot an agent — they read the store, publish a
     * project, browse the registry — and requiring a supervisor for those
     * would make every one of them construct a daemon it will not use.
     *
     * Deliberately NOT defaulted to a locally-built one. That would look
     * convenient and would silently put the credential back in whichever
     * process happened to call spawn, which is exactly what moved out.
     */
    daemon?: AgentSupervisor
    /**
     * The consuming app's version (the TUI's package.json version, the
     * Fleet extension's, …). Injected rather than read from this
     * package's own manifest: it is stamped into created projects as
     * their framework version and reported by the updater, so it must be
     * the shipped app's version, not the library's.
     */
    version: string
    /**
     * Where a scaffolded project's framework dependencies resolve from.
     *
     * Defaults to "published" — the exact CLI version, which is what a real
     * user installs. The TEST SUITE passes "workspace" with a repoRoot, so a
     * fixture links this repo's tree instead of npm and the suite validates
     * the commit rather than the last release. See FrameworkSource.
     */
    frameworkSource?: FrameworkSource
    /** Repo root for "workspace" resolution. Required with it, ignored without. */
    repoRoot?: string
    /** Override the store root (~/.axon) — tests point this at a scratch dir. */
    store?: string
    /** Invocation directory inherited by every agent capsule booted by this platform. */
    cwd?: string
    /** Build distribution override for tests. Normal callers use the compile-time default. */
    distribution?: Distribution

    /**
     * The local control channel this process serves, published on every
     * instance record it spawns so an editor can find and dial it.
     *
     * Supplied by the app that HAS one — the TUI serves conversations an
     * editor can drive; a headless `axon run` does not and passes nothing.
     * A thunk because the server binds a port and Platform() construction is
     * wiring only: the app starts listening when it is ready, and each spawn
     * reads whatever is live at that moment.
     */
    control?: () => { port: number; token: string } | null
}
