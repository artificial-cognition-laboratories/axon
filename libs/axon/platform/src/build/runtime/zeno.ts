import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { err } from "@arcforge/err"
import type { StoreT } from "../../services/store"
import { detectKind, type ProjectsT, type ProjectT } from "../project"

/** The default agent's name, and the directory it occupies under the profile. */
export const ZENO = "zeno"

/** The published artifact zeno is cloned from. */
export const ZENO_REF = "@axon/zeno"

/** Registry modules zeno ships with — enough to be useful on first launch. */
const MODULES = ["@axon/fs", "@axon/subagent"]

type ZenoOpts = {
    store: StoreT
    projects: ProjectsT
    /**
     * Fetches a published artifact and prepares it in place.
     *
     * A thunk rather than the Registry handle: `registry` is constructed after
     * `Runtime` in platform.ts and is defined in terms of `projects`, so taking
     * a value here would force a reorder. Same idiom as the bench axis.
     */
    clone: (ref: string, cwd: string, options?: { dir?: string }) => Promise<{ root: string }>
}

/**
 * Zeno — the agent that is always there.
 *
 * A first-run user has no agents, and an agent is now the only thing that can
 * be run: models are a property of an agent, not a thing you run instead of
 * one. Something has to exist for the very first message to go to, so the
 * platform guarantees exactly one agent — zeno — and nothing else about it.
 *
 * Zeno is an ORDINARY agent project, CLONED FROM THE REGISTRY (`@axon/zeno`)
 * into the profile's own agents directory, then owned by the user: editable,
 * renameable in content, and never written to again. That is the whole
 * difference from the managed base workspace this replaced — base regenerated
 * its config from a template on every model pick, which forced an ownership
 * hash to detect the user's edits and refuse them. Nothing here writes a config
 * after creation, so there is nothing to guard.
 *
 * From the REGISTRY rather than the local scaffold template, deliberately: zeno
 * is the first thing a new user meets and the de facto face of the product, so
 * improving it must not require shipping a CLI release. Publishing a new
 * `@axon/zeno` reaches every install on its next first-run. A local template
 * would freeze the mascot at whatever version each user happened to install.
 *
 * "Cannot be deleted" is therefore not enforcement — delete the directory and
 * `ensure()` simply scaffolds it again on the next boot. It is a guarantee that
 * the TUI always has somewhere to send a message, not a lock on the file.
 */
export function Zeno(opts: ZenoOpts) {
    function root(): string {
        const profile = opts.store.profiles.active()
        if (!profile) throw err("NOT_AUTHENTICATED")
        return join(profile.agents.root, ZENO)
    }

    return {
        get name(): string {
            return ZENO
        },

        /**
         * True once zeno is USABLE for the active profile — the directory
         * alone is not enough. A zeno whose axon.config.ts was deleted or
         * mangled is a directory that exists and a project that cannot open,
         * which is precisely the state ensure() has to repair. Detecting the
         * config is the same check projects.open() makes, so `exists` and
         * "can be opened" can never disagree.
         */
        get exists(): boolean {
            return detectKind(root()) === "agent"
        },

        /**
         * The default agent, scaffolded if it is not there — and re-cloned if
         * what IS there is broken. Idempotent: a healthy zeno is opened
         * untouched, never re-templated.
         *
         * Self-repairing by design. Zeno is the one agent the platform
         * guarantees, so "the user deleted or mangled it" cannot be a dead end:
         * a directory that fails to open is replaced rather than reported. That
         * is the whole point of the guarantee — the TUI must always have
         * somewhere to send a message.
         */
        async ensure(): Promise<ProjectT> {
            const profile = opts.store.profiles.active()
            if (!profile) throw err("NOT_AUTHENTICATED")

            const target = join(profile.agents.root, ZENO)
            // Not existsSync(target): a directory with no (or a broken) config
            // is unopenable, and returning it here just moves the failure to
            // the caller. Re-clone over it instead.
            if (detectKind(target) === "agent") return opts.projects.open(target)
            if (existsSync(target)) await rm(target, { recursive: true, force: true })

            // clone() downloads, extracts and prepares — so the agent surface
            // (node_modules, compiled brain, typegen) is materialized before
            // this returns. `dir` pins the directory name to ZENO rather than
            // letting it derive from the scoped artifact name.
            await opts.clone(ZENO_REF, profile.agents.root, { dir: ZENO })
            const project = await opts.projects.open(target)

            // Through the installer rather than a config edit: these have to be
            // present in node_modules for zeno's first boot, not merely named in
            // the config. clone() already prepared the project, so this is the
            // one install that follows.
            await project.modules.install(MODULES)

            return project
        },
    }
}

export type ZenoT = ReturnType<typeof Zeno>
