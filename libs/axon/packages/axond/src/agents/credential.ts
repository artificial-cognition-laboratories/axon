import { err } from "@arcforge/err"
import { Cloud } from "@arcforge/platform/services"
import { Store, storeRoot } from "@arcforge/platform/store"
import type { AxonCloudClient } from "@arcforge/cloud"
import type { Actor } from "../jobs/index"
import { distribution } from "../control/paths"

type CredentialOpts = {
    /** This build's version, stamped onto crash reports. */
    version?: string
    /** Override the store root. Tests point this at a scratch dir. */
    store?: string
}

/**
 * Credential — who is signed in on this machine, as the daemon sees it.
 *
 * ── Why the daemon reads it rather than being handed it ─────────────────────
 *
 * `Supervise` holds the provider credential so an agent never does, which is
 * the whole reason supervision moved into the daemon. But the daemon is
 * started by systemd at boot, by a keybind, by nothing at all — there is no
 * launcher standing by to hand it a login. A daemon that could only supervise
 * when someone passed it a credential could never boot an agent at boot, which
 * is the one thing it exists for.
 *
 * So it reads the SAME store the CLI writes at login. That is not a second
 * answer to "who is signed in" — the store is the answer, and this is another
 * reader of it. Deriving one from environment variables would be a second
 * answer, and that is the thing to keep refusing.
 *
 * ── Lazy, because construction touches nothing ──────────────────────────────
 *
 * `Store()` reads disk on construction. `Axond()` must not, so this builds on
 * first use — which also means a daemon on a machine nobody has logged into
 * still starts, still reports the machine, still browses the registry, and
 * fails only at the spawn that actually needed an account.
 *
 * ── The distribution split is load-bearing ──────────────────────────────────
 *
 * A source daemon reads `~/.axon-dev` and an installed one reads `~/.axon`,
 * from the same `NODE_ENV` signal the socket path uses. So logging in with the
 * published CLI does NOT sign a source checkout in. That is the intended
 * isolation, not a bug — but it is why a source daemon reports nobody logged
 * in on a machine whose installed CLI is authenticated.
 */
export function Credential(opts: CredentialOpts = {}) {
    let wired: { store: ReturnType<typeof Store>; cloud: ReturnType<typeof Cloud> } | null = null

    /**
     * The store and the client built from it, on first use.
     *
     * Both, because they answer different halves of one question: the client
     * is what supervises, and the store is who is signed in. Reading the
     * account from the client would mean asking the backend for something
     * already on disk.
     */
    function built(): { store: ReturnType<typeof Store>; cloud: ReturnType<typeof Cloud> } {
        if (!wired) {
            const build = distribution()
            const store = Store({ root: opts.store ?? storeRoot(build) })
            wired = {
                store: store,
                cloud: Cloud({ store: store, distribution: build, release: opts.version ?? "0.0.0" }),
            }
        }
        return wired
    }

    return {
        /**
         * Whether a credential is on disk.
         *
         * Cheap and local — it does NOT ask the backend whether the credential
         * still works. A caller gating a UI must use the cloud client's own
         * `validate()`; this answers "is there something to try with", which is
         * what decides whether spawning can be attempted at all.
         */
        get authenticated(): boolean {
            return built().cloud.authenticated
        },

        /**
         * Who is running this command.
         *
         * ── The mark, and exactly how strong it is ──────────────────────────
         *
         * An agent is recognised by `AXON_SESSION_ID`, which the link sets on
         * every confined incarnation so agent code shelling out to `axon` can
         * say "me". Checked FIRST and deliberately: an agent that also had a
         * readable store must still be recorded as an agent, because the point
         * is to describe who acted, not what they could reach.
         *
         * A person is recognised by possession of the signed-in account. That
         * is honest for a confined agent, which has no credential and cannot
         * read the store — the invariant `Supervise` exists to enforce. It is
         * NOT proof against a process already running unconfined as this user:
         * such a process can read the store and reach the socket, and nothing
         * here changes that. The mark is as strong as the confinement, no
         * stronger, and it should not be described as more.
         *
         * Null when neither: a command run by nobody in particular can still
         * read, and the caller decides whether its verb needs an actor.
         */
        /**
         * Who is signed in, for a surface that has to decide whether to ask.
         *
         * Reads the store rather than validating with the backend: this is
         * called on every state tick, and a network round trip per tick to
         * answer "is there a profile" would make the panel's poll a login
         * check. A stale credential still surfaces — as a failure from the
         * command that used it, which is where it can actually be acted on.
         */
        identity(): { signedIn: boolean; email: string | null } {
            try {
                const profile = built().store.profiles.current()
                return { signedIn: !!profile, email: profile ? profile.id : null }
            } catch {
                // No store on this machine yet. Not signed in is the honest
                // answer, and it is the one that offers the way forward.
                return { signedIn: false, email: null }
            }
        },

        actor(): Actor | null {
            const session = process.env.AXON_SESSION_ID
            if (session) return { kind: "agent", session: session }

            const profile = built().store.profiles.current()
            return profile ? { kind: "human", account: profile.id } : null
        },

        /**
         * The client to supervise with.
         *
         * Throws when nobody is signed in rather than returning a client whose
         * every call 401s: an agent booted against an anonymous client fails
         * deep inside inference, minutes later, with an error that names
         * nothing the user can act on.
         */
        client(): AxonCloudClient {
            const current = built().cloud
            if (!current.authenticated) {
                throw err("DAEMON_NOT_AUTHENTICATED", {
                    detail: `no account is signed in for this ${distribution()} store — run \`axon login\``,
                    context: { store: storeRoot(distribution()) },
                })
            }
            return current.client
        },
    }
}

export type CredentialT = ReturnType<typeof Credential>
