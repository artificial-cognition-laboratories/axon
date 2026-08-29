import type { FrameworkSource } from "./manifest/package"
import { resolveDefaultBaseUrl, type AxonCloudClient, type DeployOptions, type DeployStep } from "@arcforge/cloud"
import { err } from "@arcforge/err"
import type { ProviderEntry } from "@arcforge/types"
import { Bundle, type BundleArtifact } from "./bundle"
import { Cognet } from "./cognet"
import { Deploy, type DeployResult } from "./deploy"
import { Installer } from "./installer"
import { Manifest } from "./manifest"
import { SourceModules } from "./modules"
import { Prepare } from "./prepare"
import { Publish, type PublishResult, type PublishStep } from "./publish"
import { Tree } from "./tree"
import type { VerifyReport } from "./verify"
import { Typegen } from "./typegen"
import { Watcher } from "./watcher"
import type { WatcherT, DuringOptions } from "./watcher"
import { type ProjectKind } from "./kinds"
import { Bench, type BenchT, type BenchExtras } from "../bench"

export type { ProjectKind }

type ProjectOpts = {
    root: string
    kind: ProjectKind
    name: string
    cloud: AxonCloudClient
    /** CLI version — prepare pins/repairs the project's @arcforge framework deps to it. */
    frameworkVersion: string
    frameworkSource?: FrameworkSource
    repoRoot?: string
    /** Bench-only collaborators, supplied by Projects. */
    bench: BenchExtras
    /** The active profile's inference sources — carried onto every blueprint this project loads. */
    profileProviders?: () => Promise<readonly ProviderEntry[] | undefined>
}

/**
 * Project — one project of any kind on disk. Pure composition: the verbs are
 * owned by their leaves (Installer, Typegen, Prepare, Publish, bundle); the
 * handle just wires them to one root.
 *
 * Every kind gets the same surface. What a kind IS lives in the kind table
 * (kinds.ts), not in branches here — the one exception being `deploy`, which
 * is genuinely agent-only and says so.
 */
export function Project(opts: ProjectOpts) {
    const { root, kind, name } = opts

    const manifest = Manifest({ root: root })
    const tree = Tree({ root: root })
    const modules = SourceModules({ root: root, manifest: manifest })

    /**
     * Watchers outside this project's root that must suspend along with it.
     *
     * A registry cognet's source lives in `node_modules/<name>/`, and the agent
     * watches it so an edit to the brain rebuilds. But `bun install` rewrites
     * all of node_modules, so an install fired that watcher — unsuspended —
     * straight into the middle of the tree rebuild. The scan then ran against a
     * half-written tree and reported the cognet as missing (AX-COGNET-014) for
     * an install that was working correctly.
     *
     * Registered rather than constructed here because the cognet's location is
     * only known after a blueprint has compiled, which happens in the runtime
     * above this. The project owns the suspension; it does not own the watcher.
     */
    const linked = new Set<WatcherT>()

    /**
     * Suspend this project's watcher AND every linked one for the duration.
     *
     * Nested rather than merged, so each watcher keeps its own suspend depth
     * and pending path. Restoration is guaranteed by each `during()`'s own
     * finally, including on a throw partway through the chain.
     */
    function during<T>(fn: () => Promise<T>, options?: DuringOptions): Promise<T> {
        let run = fn
        for (const other of linked) {
            const inner = run
            run = () => other.during(inner, options)
        }
        return watcher.during(run, options)
    }

    // `during` is a thunk because `watcher` is constructed below — the
    // installer suspends the watcher around its own writes so a reload cannot
    // land between the manifest edits and the node_modules rebuild.
    const installer = Installer({
        root: root,
        cloud: opts.cloud,
        manifest: manifest,
        tree: tree,
        during: (fn, options) => during(fn, options),
    })
    const typegen = Typegen({ root: root, kind: kind })
    // `prepare` is a getter: Prepare() is built below and bundling needs it.
    const bundle = Bundle({ root: root, manifest: manifest, modules: modules, prepare: () => prepare })

    // A bench owns verbs no other kind has (run, result, coordinates) and
    // declarations generated from its own config. It is the one kind with an
    // extension, and it hangs off the project rather than beside it.
    const bench = kind === "bench" ? Bench({ root, cloud: opts.cloud, ...opts.bench }) : null

    const prepare = Prepare({
        root: root,
        kind: kind,
        installer: installer,
        modules: modules,
        manifest: manifest,
        tree: tree,
        typegen: typegen,
        frameworkVersion: opts.frameworkVersion,
        ...(opts.frameworkSource ? { frameworkSource: opts.frameworkSource } : {}),
        ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
        ...(bench ? { extend: async () => { await bench.prepare() } } : {}),
        ...(opts.profileProviders ? { profileProviders: opts.profileProviders } : {}),
    })
    const publish = Publish({ kind, root, bundle, manifest, cloud: opts.cloud })
    const deploy = Deploy({ bundle, manifest, cloud: opts.cloud })
    const watcher = Watcher({ root })

    return {
        root: root,
        kind: kind,
        name: name,

        /** Registry module management (agent projects). */
        modules: installer,

        /**
         * The agent's brain, as an updatable dependency. One per agent, so a
         * single answer rather than a list — see Cognet() for why swapping it
         * is deliberately not offered here.
         */
        cognet: Cognet({ manifest, installer, tree }),

        /**
         * The engine this agent runs on — read it, or point it at another
         * model. A surgical edit to the author's own axon.config.ts, which is
         * what makes the TUI's model picker a change to the agent rather than a
         * switch to something else. Exposed alone rather than the whole
         * manifest: identity and bunfig are the build pipeline's business,
         * but the model is the user's.
         */
        model: manifest.model,

        /**
         * The agent's own environment — its keys, and setting one.
         *
         * Sits beside `model` for the same reason, and env moved into this
         * category when it stopped being read-only. A deploy reading .env IS
         * pipeline business; a user handing THIS agent a Telegram token is not
         * — it is a per-agent boundary they control, which is the whole point
         * of each agent having its own .env rather than inheriting a shared
         * one. The rest of the manifest stays unexposed.
         */
        env: manifest.env,

        /**
         * Benchmark verbs — run, result, coordinates, config. Null on every
         * other kind, so reaching for them is a type error rather than a
         * runtime surprise.
         */
        bench: bench as BenchT | null,

        /**
         * Generated type declarations. Agents pass a loaded blueprint —
         * the dev loop reuses its own to avoid a double scan.
         */
        typegen: typegen.write,

        /**
         * Regenerate ONE domain's declarations without a full write.
         *
         * The registry (what a config registers, as completable names) is the
         * case this exists for: it changes on every config save, and rewriting
         * the whole frame for one edited line would make saving cost an install
         * check and a manifest read.
         *
         * Exposed as the generators object rather than as one verb per domain,
         * so a caller reaches exactly what it needs and this handle does not
         * grow a method every time a generator is added.
         */
        generate: typegen.generate,

        /** Package into the publishable artifact — image.json + source.tar.gz. */
        bundle(): Promise<BundleArtifact> {
            return bundle.build(kind)
        },

        /** Install declared modules, then generate types. What `axon prepare`/`dev` run. */
        prepare: prepare,

        /**
         * Report what is wrong with this project's installed state, repairing
         * nothing. What `axon doctor` runs.
         *
         * Deliberately the same primitive `prepare` gates on, not a parallel
         * set of checks: a diagnostic that can disagree with the thing it
         * diagnoses is worse than none. The only difference is that this never
         * acts on what it finds.
         *
         * Reads the DECLARED dependency set rather than the one an install run
         * computes — `managed` is a product of resolving, and a diagnostic must
         * not resolve. That makes this a strictly narrower view than prepare's:
         * it can see everything the manifest declares, and nothing about what
         * a fresh resolve would add.
         */
        async diagnose(): Promise<VerifyReport> {
            const declared = await manifest.package.dependencies.all()
            return tree.verify({
                manifest,
                managed: declared,
                registryOrigin: resolveDefaultBaseUrl(),
            })
        },

        /**
         * Bundle → register → upload → sync visibility. What `axon [module]
         * publish` runs. Pass `onProgress` to observe each step; a publish can
         * spend a long time inside any one of them.
         */
        publish: publish,

        /** Bundle → register → publish → provision → wait until running. Agents only. */
        deploy(options?: DeployOptions & { onProgress?: (step: DeployStep) => void }): Promise<DeployResult> {
            if (kind !== "agent") throw err("DEPLOY_AGENTS_ONLY")
            return deploy(options)
        },

        /** Raw fs change notifications for this root — inert until start() is called (Agent does, for dev). */
        watcher: watcher,

        /**
         * Suspend a watcher OUTSIDE this root alongside this project's own.
         *
         * For a watcher pointed at something an install rewrites but that does
         * not live under `root` — today that is the registry cognet's source in
         * `node_modules`. Without this it reloads mid-`bun install` and reports
         * the cognet missing for an install that is working.
         *
         * Returns an unlink function; a caller that stops its watcher must call
         * it, or a suspension keeps reaching a watcher nobody is listening to.
         */
        link(other: WatcherT): () => void {
            linked.add(other)
            return () => linked.delete(other)
        },
    }
}

export type ProjectT = ReturnType<typeof Project>
