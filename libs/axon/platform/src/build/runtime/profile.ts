import { err } from "@arcforge/err"
import type { StoreT } from "../../services/store"
import { scaffoldProfile } from "../project/create/profile"
import type { ProjectsT, ProjectT } from "../project"

type ProfileOpts = {
    store: StoreT
    projects: ProjectsT
    /** CLI version — pinned into the profile's own manifest, same as any scaffold. */
    frameworkVersion: string
}

/**
 * Profile — the user's own Axon directory, guaranteed to be prepared.
 *
 * `~/.axon/profiles/<email>/` became a real project the moment it gained code:
 * a `main.ts`, a `plugins/` folder, and `extensions/` the user can write and
 * install. So it is a project KIND (see kinds.ts), and this is the thing that
 * guarantees one exists and is buildable, exactly as Zeno() guarantees an agent
 * exists to send a message to.
 *
 * The pairing is deliberate — those are the two things a first-run user must
 * have and cannot create for themselves: somewhere to send a message, and
 * somewhere to configure the terminal.
 *
 * ── Idempotent, never destructive ────────────────────────────────────────────
 *
 * Unlike Zeno, a broken profile is NEVER replaced. Zeno can be re-cloned
 * because it is a published artifact the user did not write; a profile holds
 * their config, their credentials, their history and their agents. So
 * `ensure()` only ever ADDS what is missing: scaffoldProfile() writes each file
 * only when absent, and prepare() regenerates the frame, which is generated
 * output by definition.
 *
 * That is what makes this safe to run on every boot, which is what makes a
 * profile that gained `plugins/` in a later release acquire the folder without
 * the user doing anything.
 *
 * ── Failure is not fatal ─────────────────────────────────────────────────────
 *
 * `prepare()` installs from the network. A user with no connection must still
 * get a terminal — their config simply does not load — so the caller decides
 * severity and this reports rather than throws. What must NOT happen is a
 * silent skip: an unprepared profile means none of the user's commands, keys or
 * extensions exist, and a terminal that quietly ignores its own config is
 * indistinguishable from one that is broken.
 */
export function Profile(opts: ProfileOpts) {
    function root(): string {
        const profile = opts.store.profiles.active()
        if (!profile) throw err("NOT_AUTHENTICATED")
        return profile.root
    }

    return {
        /** Absolute path to the active profile's directory. */
        get root(): string {
            return root()
        },

        /**
         * The active profile as a project, scaffolded and prepared if needed.
         *
         * Safe to call on every boot: an already-prepared profile costs a
         * manifest read and a typegen rewrite.
         */
        async ensure(): Promise<ProjectT> {
            const target = root()

            // Writes only what is absent — a returning user's own main.ts is
            // never touched, and a profile predating extensions/ gains it here.
            await scaffoldProfile({
                name: "profile",
                dir: target,
                frameworkVersion: opts.frameworkVersion,
            })

            const project = await opts.projects.open(target)

            // Installs @arcforge/types and writes .axon/types. The frame's
            // tsconfig extends a package resolved out of the profile's own
            // node_modules, so the install is what makes the user's editor
            // work at all — without it every global degrades to any.
            await project.prepare()

            return project
        },
    }
}

export type ProfileT = ReturnType<typeof Profile>
