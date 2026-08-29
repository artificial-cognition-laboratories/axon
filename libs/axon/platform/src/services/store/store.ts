import { randomUUID } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import { err } from "@arcforge/err"
import { policyGlobMatch } from "@arcforge/types"
import type { Distribution } from "../cloud"
import { Disk } from "./disk"
import type { ActiveProfile, AppIntent, AppState, EnvTarget, HistoryEntry, PolicyGrant, PolicyRequest, ProfileRecord, ProfileSettings, UpdateRecord } from "./types"


type StoreOpts = {
    /** Override the store root — tests point this at a scratch dir. */
    root?: string
    /**
     * The active profile's declared settings, read fresh per call.
     *
     * A thunk because settings live in `profile.config.ts`, which is
     * TypeScript — parsing it is `build/extensions`' job, and Store is
     * constructed long before that exists. Handing the values in keeps the
     * dependency pointing the right way: the store never learns what a config
     * file is, and the config never learns where the store keeps things.
     *
     * Synchronous, so `extraRoots()` stays synchronous — every caller of it is.
     * Whoever supplies this caches; see useSettings.
     */
    settings?: () => { paths?: string[] }
    /**
     * Persist a settings change. Same reasoning as `settings` above — the
     * write lands in `profile.config.ts`, which only build/extensions can edit.
     *
     * Omitted by a store with no config behind it (tests, a first boot before
     * login): `watch()` then throws rather than writing somewhere the read
     * path would never look, which is the failure that made `paths` silently
     * do nothing.
     */
    setSetting?: (key: string, value: unknown) => Promise<unknown>
}

/**
 * The app-written area of a profile — profiles/<email>/store/.
 *
 * Named once and joined everywhere rather than spelled into each path, because
 * it was spelled seven times and the profile root has since become a directory
 * a USER authors (main.ts, profile.config.ts, plugins/, extensions/). Keeping
 * the app's own files in one named room is what keeps that root readable, and
 * one constant is what stops half of them drifting back out.
 */
const STORE_DIR = "store"

/** profiles/<id>/store — the app-written area of one profile. */
function storeDir(id: string): string {
    return `profiles/${id}/${STORE_DIR}`
}

/**
 * Store — the ONE interface to ~/.axon. A typed client over the dotdir:
 * profiles (identity, credentials, settings), sent-message history,
 * app-remembered continuity state, the environment target, and registry
 * caches. Nothing else in the platform reads or writes .axon.
 *
 * Layout owned here:
 *   env                                 — "local" | "cloud"
 *   profiles/<email>/profile.config.ts  — which extensions load (user-authored)
 *   profiles/<email>/main.ts            — the user's own TUI config (user-authored)
 *   profiles/<email>/plugins/           — the user's own lifecycle plugins
 *   profiles/<email>/extensions/        — extension source, local and installed
 *   profiles/<email>/agents/            — the user's agent projects
 *   profiles/<email>/.axon/             — generated type frame
 *   profiles/<email>/store/             — everything the APP writes (see STORE_DIR)
 *   cache/running/<sessionId>.json      — liveness record for a local agent process
 *   cache/active-profile.json           — who is logged in
 *   cache/<name>.json                   — registry caches
 *
 * A profile root is now authored-vs-generated, not a flat bag: everything at
 * the top level is written by a person, and everything the app writes for
 * itself lives under store/. That split is the same one the build frames make
 * (see build/frame) — grouping by what a file IS, rather than by its format,
 * is what tells a user which files are safe to edit.
 *
 * Profiles are keyed by email, not the backend's user id — this directory
 * is meant to be navigated by hand, and a UUID tells a developer nothing.
 * Every caller above this layer (Cloud(), useAuth()) still calls it "id";
 * that's fine, they never depend on it being a UUID, only on it being a
 * stable, unique key per person — which email already is (no email-change
 * feature exists on the backend, so this holds for the app's current scope).
 */
export function Store(opts: StoreOpts = {}) {
    const root = opts.root ?? join(homedir(), ".axon")
    const disk = Disk({ root })

    /**
     * Who is logged in — app state, so it lives under cache/ rather than in
     * profiles/.
     *
     * `profiles/` is a USER SURFACE now: it holds main.ts, plugins/,
     * profile.config.ts and agents — files a person opens and edits. An
     * index.json the app wrote for itself, sitting among them, is one more
     * thing a reader has to work out is not theirs. Same split the frames make
     * (see build/frame) and the same reason a profile's own app state lives
     * under `store/`.
     *
     * Migrated from the old location on first read rather than on a version
     * check: the old file is the only evidence the old layout existed, so
     * moving it when it is seen is both the detection and the fix. Without it,
     * upgrading would silently log every user out.
     */
    const active = disk.json<ActiveProfile>("cache/active-profile.json")
    const legacyActive = disk.json<ActiveProfile>("profiles/index.json")
    if (!active.get()) {
        const previous = legacyActive.get()
        if (previous) {
            active.set(previous)
            legacyActive.delete()
        }
    }
    const env = disk.text("env")

    function profile(id: string) {
        const base = `profiles/${id}`
        const store = storeDir(id)
        return {
            id,
            /** The profile root — where the user's own main.ts and profile.config.ts live. */
            root: join(root, base),
            record: disk.json<ProfileRecord>(`${store}/profile.json`),
            settings: disk.json<ProfileSettings>(`${store}/settings.json`),
            /** Absolute path to settings.json — `axon settings` opens this in $EDITOR. */
            settingsPath: join(root, store, "settings.json"),
            history: disk.jsonl<HistoryEntry>(`${store}/history.jsonl`),

            /**
             * Escalations raised on this profile — the audit trail, and the
             * queue any surface answers from.
             *
             * Append-only like grants and for the same reason: a request and
             * its outcome are two facts in time, and rewriting the first to
             * carry the second loses when each happened.
             */
            requests: (() => {
                const file = disk.jsonl<PolicyRequest>(`${store}/requests.jsonl`)
                return {
                    /** Record a raised escalation. Returns it, so the caller can report the id. */
                    raise(request: Omit<PolicyRequest, "id" | "raisedAt">): PolicyRequest {
                        const entry: PolicyRequest = { ...request, id: randomUUID(), raisedAt: Date.now() }
                        file.append(entry)
                        return entry
                    },

                    /**
                     * Record how one settled. Appended as a second entry
                     * naming the same id — folded on read, never rewritten.
                     */
                    settle(id: string, outcome: NonNullable<PolicyRequest["outcome"]>): void {
                        const raised = this.all().find(entry => entry.id === id)
                        if (!raised) return
                        file.append({ ...raised, outcome })
                    },

                    /**
                     * Every request, latest state per id, newest first.
                     *
                     * A settled entry supersedes the raise it names, so a
                     * caller sees one row per request rather than the raw
                     * append log.
                     */
                    list(): PolicyRequest[] {
                        const latest = new Map<string, PolicyRequest>()
                        for (const entry of file.read()) latest.set(entry.id, entry)
                        return [...latest.values()].reverse()
                    },

                    /** Requests still awaiting an answer. */
                    open(): PolicyRequest[] {
                        return this.list().filter(entry => !entry.outcome)
                    },

                    /** The raw log, including superseded raises — for an audit view. */
                    all: file.read,
                }
            })(),

            /**
             * Standing policy approvals — what "allow always" writes.
             *
             * Append-only, including revocation: a decision made and later
             * withdrawn is two facts, not zero, and this file is the audit
             * trail for every capability a person handed an agent.
             *
             * Owns MATCHING as well as storage, deliberately. Whether a grant
             * covers a call is policy semantics — the same glob rules the
             * mediator applies — and a caller re-deriving it is how the two
             * drift into disagreeing about what was approved.
             */
            grants: (() => {
                const file = disk.jsonl<PolicyGrant>(`${store}/grants.jsonl`)
                return {
                    /**
                     * Every grant still in force, newest first.
                     *
                     * Revocations are folded here rather than at the write, so
                     * the file keeps the full history while callers only ever
                     * see what is live.
                     */
                    active(): PolicyGrant[] {
                        const all = file.read()
                        const revoked = new Set(all.map(entry => entry.revokes).filter(Boolean))
                        return all
                            .filter(entry => !entry.revokes && !revoked.has(entry.id))
                            .reverse()
                    },

                    /**
                     * Does a live grant cover this call?
                     *
                     * An agent matches its own grants and any written for
                     * `"*"`. The subject is matched with the SAME matcher
                     * policy uses, so a grant reads exactly like the rule it
                     * satisfies rather than being a second pattern language.
                     */
                    covers(agent: string, fn: string, subject: string): PolicyGrant | null {
                        return this.active().find(grant =>
                            (grant.agent === agent || grant.agent === "*")
                            && grant.fn === fn
                            && policyGlobMatch(grant.subject, subject),
                        ) ?? null
                    },

                    /** Record a new grant. Returns it, so a caller can report the id. */
                    add(grant: Omit<PolicyGrant, "id" | "grantedAt">): PolicyGrant {
                        const entry: PolicyGrant = { ...grant, id: randomUUID(), grantedAt: Date.now() }
                        file.append(entry)
                        return entry
                    },

                    /** Withdraw one, by id. Appends a tombstone; nothing is rewritten. */
                    revoke(id: string): void {
                        file.append({
                            id: randomUUID(),
                            agent: "",
                            fn: "",
                            subject: "",
                            grantedAt: Date.now(),
                            revokes: id,
                        })
                    },

                    /** The raw log, including revocations — for an audit view. */
                    all: file.read,
                }
            })(),

            /**
             * Every agent this profile can see, across two kinds of pool:
             * watched directories the user added via settings.paths
             * (`axon watch`), and profiles/<id>/agents/ where installs land.
             * Each is scanned the same way — immediate subdirectories are
             * agent projects.
             *
             * An agent is identified by the name in its package.json, not
             * by the directory holding it, so `@cody/barry` and
             * `@alice/barry` are two agents rather than one collision. A
             * WATCHED pool outranks the installed one: watching a path is
             * the statement that the checkout there is being worked on, and
             * a working tree must beat a cache — otherwise editing an
             * agent's source silently does nothing because a stale install
             * answers first.
             */
            agents: {
                /**
                 * The canonical agents directory — profiles/<id>/agents.
                 * Where a clone lands by default, and the lowest-priority
                 * pool `find()` searches. Exposed because callers that
                 * WRITE an agent need the directory itself, and rebuilding
                 * it from `store.root` outside this module duplicates the
                 * one piece of layout knowledge this object exists to own.
                 */
                root: join(root, base, "agents"),

                /** Extra scan roots from settings, resolved to absolute paths (~ expanded). */
                extraRoots(): string[] {
                    // From profile.config.ts via the thunk — settings.json is
                    // no longer read. A caller that supplied none gets the
                    // canonical agents dir alone, which is the correct answer
                    // for a store with no profile loaded yet.
                    const paths = opts.settings?.().paths ?? []
                    return paths.map((p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : resolve(p)))
                },

                /**
                 * Register an extra scan root (`axon watch`). Stored ~-collapsed
                 * when under the home dir, so a config stays portable across
                 * machines with different usernames — a no-op if already
                 * watched.
                 */
                async watch(path: string): Promise<void> {
                    if (!opts.setSetting) throw err("SETTINGS_NOT_WRITABLE")
                    const stored = collapseHome(resolve(path))
                    const existing = opts.settings?.().paths ?? []
                    if (existing.includes(stored)) return
                    await opts.setSetting("paths", [...existing, stored])
                },

                /** Remove an extra scan root (`axon unwatch`). Matches on resolved path — untouched if it was never watched. */
                async unwatch(path: string): Promise<void> {
                    if (!opts.setSetting) throw err("SETTINGS_NOT_WRITABLE")
                    const target = resolve(path)
                    const existing = opts.settings?.().paths ?? []
                    const next = existing.filter((p: string) =>
                        resolve(p.startsWith("~") ? join(homedir(), p.slice(1)) : p) !== target)
                    if (next.length === existing.length) return
                    await opts.setSetting("paths", next)
                },

                /**
                 * Every pool this profile searches, nearest first.
                 *
                 * Watched roots outrank the canonical agents dir, and that
                 * order is the whole point: `axon watch <path>` is a
                 * deliberate statement that an agent is being DEVELOPED
                 * there, while profiles/<id>/agents is where installs land
                 * — a cache. A working checkout must beat a cache, or
                 * editing source silently does nothing because a stale
                 * install shadows it.
                 */
                pools(): { root: string; kind: "watched" | "installed" }[] {
                    return [
                        ...this.extraRoots().map(root => ({ root, kind: "watched" as const })),
                        { root: this.root, kind: "installed" as const },
                    ]
                },

                /**
                 * Find an agent by the name it CALLS ITSELF — package.json's
                 * `name`, falling back to the directory name when there is no
                 * readable manifest.
                 *
                 * Matching on identity rather than directory name is what
                 * makes a scoped ref mean one specific agent: `@cody/barry`
                 * and `@alice/barry` both live in a folder called `barry`,
                 * and a directory-name match would silently run whichever
                 * was found first. An unscoped ref still matches a scoped
                 * agent's trailing segment, so `barry` keeps working as the
                 * short form of exactly one installed `@cody/barry`.
                 *
                 * Returns every match rather than the first. A name that
                 * resolves two ways is a question for the caller, not
                 * something to settle by search order.
                 */
                find(ref: string): { root: string; name: string; kind: "watched" | "installed" }[] {
                    const found: { root: string; name: string; kind: "watched" | "installed" }[] = []
                    const seen = new Set<string>()
                    // `@cody/barry@1.4.0` — a pin is a constraint on WHICH
                    // version, never part of the identity. Local resolution
                    // has exactly one copy of an agent, so the pin narrows
                    // nothing here; stripping it keeps a pinned ref from
                    // silently matching nothing.
                    const wanted = ref.startsWith("@")
                        ? "@" + (ref.slice(1).split("@")[0] ?? "")
                        : (ref.split("@")[0] ?? ref)

                    for (const pool of this.pools()) {
                        for (const dir of listDir(pool.root)) {
                            const root = join(pool.root, dir)
                            // The same directory reachable through two pools
                            // (a watched root that contains agents/) is one
                            // agent, not an ambiguity.
                            if (seen.has(root)) continue
                            seen.add(root)

                            const name = identity(root)
                            if (name === wanted || (!wanted.startsWith("@") && name.split("/").pop() === wanted)) {
                                found.push({ root, name, kind: pool.kind })
                            }
                        }
                    }

                    return found
                },

                /**
                 * Every agent visible to this profile, nearest pool first.
                 *
                 * Returns resolved entries, not bare directory names: every
                 * caller needs the root, and handing back a name they then
                 * have to look up again is what let two different lookups
                 * disagree about which `barry` was meant.
                 *
                 * Deduped by identity — a watched checkout and an installed
                 * copy of the same agent are one entry, and the watched one
                 * wins, matching find()'s precedence.
                 */
                /**
                 * Every agent DIRECTORY across every pool, deduped by path.
                 *
                 * `list()` answers "which agents can I run", so it dedupes by
                 * IDENTITY and lets a watched checkout shadow an installed
                 * copy of the same name — correct, because running the stale
                 * install instead of the source you are editing is the bug
                 * that precedence exists to prevent.
                 *
                 * History is a different question. A shadowed install still
                 * holds the sessions that were recorded against it, and those
                 * conversations happened: dropping the directory drops them
                 * from every listing with nothing to say they existed. That is
                 * how a LIVE agent could be missing from the sessions shelf —
                 * it was running out of an installed copy whose name a
                 * checkout had claimed.
                 *
                 * So: same pools, same order, deduped by ROOT instead of name.
                 * Anything asking "where could an agent have written" uses
                 * this; anything asking "which agent do I run" uses list().
                 */
                locations(): { root: string; name: string; kind: "watched" | "installed" }[] {
                    const entries: { root: string; name: string; kind: "watched" | "installed" }[] = []
                    const seen = new Set<string>()

                    for (const pool of this.pools()) {
                        for (const dir of listDir(pool.root)) {
                            const root = join(pool.root, dir)
                            // One directory reachable through two pools (a
                            // watched root that contains agents/) is one
                            // location, not two.
                            if (seen.has(root)) continue
                            seen.add(root)
                            entries.push({ root, name: identity(root), kind: pool.kind })
                        }
                    }

                    return entries
                },

                list(): { root: string; name: string; kind: "watched" | "installed" }[] {
                    const entries: { root: string; name: string; kind: "watched" | "installed" }[] = []
                    const seen = new Set<string>()

                    for (const pool of this.pools()) {
                        for (const dir of listDir(pool.root)) {
                            const root = join(pool.root, dir)
                            const name = identity(root)
                            if (seen.has(name)) continue
                            seen.add(name)
                            entries.push({ root, name, kind: pool.kind })
                        }
                    }

                    return entries
                },
            },
        }
    }

    return {
        root,

        update: {
            state: disk.json<UpdateRecord>("update.json"),
            statePath: join(root, "update.json"),
        },

        /**
         * Delete the managed base workspace left behind by the old naked-model
         * flow — profiles/<id>/base/ and its base.json manifest.
         *
         * Models are a property of an agent now, so nothing reads either path;
         * they are dead bytes in a directory meant to be navigated by hand.
         * Safe to remove unconditionally BECAUSE base was platform-authored:
         * the config was regenerated from a template on every model pick and
         * hash-guarded against hand edits, so nothing of the user's could
         * survive there. Anything they wanted to keep had to be copied into a
         * named agent, which is a directory this never touches.
         *
         * Idempotent — a profile that never used the old flow has neither path,
         * and removing a missing path is a no-op.
         */
        pruneLegacyBase(): void {
            for (const id of disk.list("profiles").filter(name => name !== "index.json")) {
                disk.remove(`profiles/${id}/base`)
                disk.remove(`profiles/${id}/base.json`)
            }
        },

        /** Which backend the CLI targets. Default: cloud. */
        env: {
            get(): EnvTarget {
                return env.get()?.trim() === "local" ? "local" : "cloud"
            },
            set(target: EnvTarget): void {
                env.set(target)
            },
        },

        profiles: {
            /** The active profile's scoped handle, or null when logged out. */
            active() {
                const pointer = active.get()
                return pointer ? profile(pointer.userId) : null
            },

            /** The active profile resolved to its record — null when logged out or the record is missing. */
            current(): { id: string; record: ProfileRecord } | null {
                const pointer = active.get()
                if (!pointer) return null
                const record = profile(pointer.userId).record.get()
                return record ? { id: pointer.userId, record } : null
            },

            /**
             * Write a profile record and point the active pointer at it —
             * the login persistence step. Always keyed by the record's own
             * email, never the caller's `id` param — makes it structurally
             * impossible to end up with two directories (id-keyed and
             * email-keyed) for the same person.
             */
            save(_id: string, record: ProfileRecord): void {
                const key = record.user.email
                profile(key).record.set(record)
                active.set({ userId: key })
            },

            activate(id: string): void {
                active.set({ userId: id })
            },

            deactivate(): void {
                active.delete()
            },

            list(): string[] {
                return disk.list("profiles").filter(name => name !== "index.json")
            },

            get: profile,

            delete(id: string): void {
                const pointer = active.get()
                if (pointer?.userId === id) active.delete()
                disk.remove(`profiles/${id}`)
            },
        },

        /** Registry caches — typed json files under cache/. */
        cache: {
            file<T>(name: string) {
                return disk.json<T>(`cache/${name}.json`)
            },
        },

        /**
         * Sent-message history for the active profile — one flat log
         * (not per-agent, a user picking a past message cares about "what
         * did I type recently," not which agent it went to). Always scoped
         * to whichever profile is currently active, same resolution
         * profiles.active() already does — never takes an id param.
         */
        history: {
            /** Appends a sent message. Throws when logged out — losing the record of a message that really was sent is a real loss, not a no-op. */
            append(content: string, agentName: string | null): void {
                const profile = active.get()
                if (!profile) throw err("NOT_AUTHENTICATED")

                const entry: HistoryEntry = {
                    id: crypto.randomUUID(),
                    content,
                    agentName,
                    createdAt: new Date().toISOString(),
                }
                disk.jsonl<HistoryEntry>(`${storeDir(profile.userId)}/history.jsonl`).append(entry)
            },

            /**
             * Most recent entries first, capped at `limit`, deduped exactly
             * like zsh's HIST_IGNORE_ALL_DUPS: each unique `content` appears
             * once, at its most-recent position. The on-disk log stays
             * append-only (every send is a real record) — dedup is a read-time
             * view over it, same log-is-truth / recent()-is-the-view split the
             * rest of Store uses. Match is raw (no trim), like zsh. Dedup runs
             * across the whole log BEFORE the limit, so `limit` means "50 unique
             * commands", never a raw window that could hide an older unique one.
             * Empty when logged out or nothing sent yet.
             */
            recent(limit = 50): HistoryEntry[] {
                const profile = active.get()
                if (!profile) return []
                const all = disk.jsonl<HistoryEntry>(`${storeDir(profile.userId)}/history.jsonl`).read()
                const seen = new Set<string>()
                const deduped: HistoryEntry[] = []
                for (let i = all.length - 1; i >= 0; i--) {
                    const entry = all[i]!
                    if (seen.has(entry.content)) continue
                    seen.add(entry.content)
                    deduped.push(entry)
                    if (deduped.length >= limit) break
                }
                return deduped
            },
        },

        /**
         * The running-agent registry moved to the DAEMON.
         *
         * It lived here while the platform spawned agents and therefore wrote
         * the record. The daemon supervises now — it owns the process, knows
         * its pid, and is still running when the record needs removing — so it
         * owns the registry too. `@arcforge/axond`'s `agents.registry` reads
         * the same directories, including this store's, so nothing that was
         * observable stopped being so.
         */

        /**
         * App-remembered continuity state for the active profile (e.g. last
         * selected agent) — distinct from settings (user-configured
         * preferences the user edits directly). Always scoped to whichever
         * profile is currently active, same resolution profiles.active()
         * already does — never takes an id param. Deciding WHAT to do with
         * this on boot (e.g. auto-selecting the last agent) is a frontend
         * concern, not the platform's — this only reads/writes the file.
         */
        state: {
            /** Null when logged out or nothing has been recorded yet. */
            get(): AppState | null {
                const profile = active.get()
                if (!profile) return null
                return disk.json<AppState>(`${storeDir(profile.userId)}/state.json`).get() ?? {}
            },

            /** Merges fields into the active profile's state. Throws when logged out. */
            update(fn: (current: AppState) => AppState): void {
                const profile = active.get()
                if (!profile) throw err("NOT_AUTHENTICATED")
                disk.json<AppState>(`${storeDir(profile.userId)}/state.json`).update({}, fn)
            },
        },

        /**
         * What the TUI should open on its next boot — written by a CLI
         * command, consumed once by the app.
         *
         * A separate file from state.json, not a field in it. The two have
         * opposite lifetimes: state is remembered forever and re-read every
         * launch, an intent is carried out once and must not survive. Sharing
         * a file would make "clear the intent" a rewrite of unrelated
         * continuity data, and a crash between read and write would either
         * lose the last agent or re-fire the intent.
         */
        intent: {
            /** Record what the next TUI boot should do. Throws when logged out. */
            set(intent: AppIntent): void {
                const profile = active.get()
                if (!profile) throw err("NOT_AUTHENTICATED")
                disk.json<AppIntent>(`${storeDir(profile.userId)}/intent.json`).set(intent)
            },

            /**
             * Read the pending intent and clear it, in one call.
             *
             * Never a bare `get`: an intent read but not cleared re-fires on
             * every subsequent boot, which for `attach` means silently
             * reconnecting to a URL the user visited once. Taking is the only
             * correct way to observe one, so it is the only way offered.
             *
             * Cleared BEFORE the caller acts on it. A failed attach must not
             * leave the intent behind to retry forever — the user sees the
             * error and decides, exactly as they would inside the app.
             */
            take(): AppIntent | null {
                const profile = active.get()
                if (!profile) return null
                const file = disk.json<AppIntent>(`${storeDir(profile.userId)}/intent.json`)
                const pending = file.get()
                if (pending) file.delete()
                return pending ?? null
            },
        },
    }
}

export type StoreT = ReturnType<typeof Store>
export type ProfileT = ReturnType<StoreT["profiles"]["get"]>

/**
 * Where ~/.axon lives for a given build.
 *
 * Development uses a SEPARATE directory (.axon-dev): an installed production
 * app and a source checkout must never share credentials, or logging into
 * staging from source silently re-points the installed app.
 */
export function storeRoot(distribution: Distribution): string {
    return join(homedir(), distribution === "production" ? ".axon" : ".axon-dev")
}

/** Immediate subdirectory names of an absolute path outside ~/.axon. Missing/non-dir = []. */
function listDir(absolutePath: string): string[] {
    if (!existsSync(absolutePath)) return []
    return readdirSync(absolutePath, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
}

/**
 * What an agent directory calls itself: package.json's `name`, else the
 * directory name.
 *
 * The fallback is deliberate rather than a swallowed failure. A directory
 * with no manifest is not yet an agent and simply will not match a scoped
 * ref; a directory whose manifest is malformed still has a true, usable
 * identity in its folder name, and blanking it would make an agent
 * unreachable because of a stray comma. Neither case is a state this
 * function can repair — opening the project is what surfaces a broken
 * manifest, with the error that actually explains it.
 */
function identity(root: string): string {
    const manifest = join(root, "package.json")
    if (!existsSync(manifest)) return basename(root)
    try {
        const name = (JSON.parse(readFileSync(manifest, "utf-8")) as { name?: string }).name
        return name ?? basename(root)
    } catch {
        return basename(root)
    }
}

/** Rewrites a path under the home dir back to its `~`-prefixed form, so settings.json stays portable across machines/usernames. Paths outside home pass through unchanged. */
function collapseHome(absolutePath: string): string {
    const home = homedir()
    return absolutePath === home || absolutePath.startsWith(home + "/")
        ? "~" + absolutePath.slice(home.length)
        : absolutePath
}