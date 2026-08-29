// ─── Policy Rule ──────────────────────────────────────────────────────────────

/**
 * Low-level capsule rule for a single capability.
 *
 * - `true` always allows the operation.
 * - `false` always denies the operation.
 * - `"escalate"` pauses and asks the outer system for approval.
 * - An object applies glob-based `allow`, `deny`, and `escalate` matching to the
 *   first string argument, such as a path, host, or command.
 *
 * @see https://axon.arclabs.it/docs/v2/api/config/policy
 */
export type PolicyRule =
    | boolean
    | "escalate"
    | {
        allow?: string[]
        deny?: string[]
        escalate?: string[]
    }



/**
 * One entry in the `tools` map: a verdict for the whole name, or a bag of
 * per-member verdicts one level deep.
 *
 * The bag branch is written as an index signature rather than
 * `Record<string, PolicyRule>` so a literal like `{ read: true }` is not
 * excess-property-checked against the glob branch (`{ allow?, deny? }`) and
 * rejected — TypeScript picks the first union member a literal could match,
 * and a bag shares no keys with a glob rule.
 */
export type ToolRule = PolicyRule | ToolMemberBag

/**
 * Per-member verdicts for one tool bag (`fs: { read: true, remove: false }`).
 *
 * The `allow`/`deny`/`escalate` keys are excluded because those make an
 * object a GLOB RULE, not a bag — the same test `isMemberBag` applies at
 * runtime. Encoding it here means TypeScript picks the right union branch
 * for an object literal instead of excess-property-checking a bag against
 * the glob shape and rejecting every member name.
 */
export type ToolMemberBag = {
    [member: string]: PolicyRule
} & {
    allow?: never
    deny?: never
    escalate?: never
}

/**
 * A whole enforcement surface's policy — one rule for everything in it, or a
 * rule per key.
 *
 * The bare form is what makes "lock this down" expressible. Keyed alone, a
 * blanket statement had to be written out as one entry per installed module —
 * a list that is complete the day it is written and silently stale the moment
 * anything else is installed. `tools: "escalate"` cannot go stale, because it
 * names the surface rather than its current contents.
 *
 * Deliberately NOT offered at the top level of `CapsulePolicy`. That object
 * also holds `isolation`, `fs` and `limits`, which are OS facts with no
 * verdict to give — so a bare `policy: "deny"` would have to mean "the
 * permission-ish subset of these keys", a scope a reader has to be told rather
 * than read. Each key here names exactly one surface, so a rule on it is
 * unambiguous.
 *
 * The two forms compose: `{ "*": "escalate", fs: true }` is the keyed form
 * with a wildcard, and a named key beats it — ordinary glob precedence, within
 * one layer. Across layers the profile's blanket still wins outright; see
 * `intersect`.
 *
 * AUTHORING ONLY. `CapsulePolicy` — the wire type the capsule enforces — stays
 * keyed, because the mediator should never have to ask which shape it was
 * handed on a hot path. The bare form is normalised into `{ "*": rule }` at
 * the one seam that already normalises everything else.
 */
export type PolicyBucket = PolicyRule | Record<string, PolicyRule>

/**
 * The `tools` bucket as an author writes it — a bare verdict for everything,
 * or a map whose entries may themselves be per-member bags.
 *
 * Separate from `PolicyBucket` because only `tools` has the second level:
 * `network` keys hosts and `process` has two fixed verbs, neither of which
 * has members to address.
 */
export type ToolBucket = PolicyRule | Record<string, ToolRule>

/**
 * The wire type every enforcement layer reads. Passed to the agent on boot or
 * via `update()`.
 *
 * ── Two layers with different expressive power ──────────────────────────────
 *
 *   OS CONFINEMENT (Linux) is the WALL. `fs` becomes mount-namespace bind
 *   mounts, `net` becomes a network namespace with an nft default-drop
 *   ruleset, `limits` becomes cgroup caps, `env` becomes an explicit
 *   environment built from nothing. A path not granted does not exist; a host
 *   not allowed is unroutable. No process inside can argue with any of it.
 *
 *   The MEDIATOR (everywhere) is the SOFT layer: it gates tool calls and
 *   program execution by glob, returns typed denials the model can reason
 *   about, raises escalations a human answers, and emits a span per decision.
 *
 * Where they overlap the OS layer is the truth and the mediator is the polite
 * error in front of it. Off Linux only the mediator runs, which is a real
 * reduction and is stated as one: `fs`, `net`, `limits` and `env` have no OS
 * enforcement there.
 *
 * ── The shape follows what can be enforced ──────────────────────────────────
 *
 * Each surface is written to match its enforcement mechanism rather than to be
 * uniform with its neighbours. `net` is an allow/deny list with no escalation
 * because nftables filters packets and cannot ask a question. `shell` names
 * binaries rather than command lines because a string matcher cannot survive
 * four spellings of the same command. Uniformity that lets a user express what
 * the kernel will not do is worse than an irregular API, and every place this
 * type is irregular, that is why.
 */
export type CapsulePolicy = {
    /**
     * OS confinement tier. Linux only; a no-op elsewhere (mediator still runs).
     *
     * The tiers map to what the occupant is and who's running it:
     *
     * - `"none"` — no OS wall. The subprocess runs as the invoking user with
     *   mediator enforcement only. This is what "I didn't set a security policy"
     *   means: a personal agent with full access to your machine, zero hassle,
     *   zero host dependencies. The default when no fs/network/limits is set.
     *
     * - `"auto"` — rootless containment. A bubblewrap box gives the subprocess
     *   (and every child) its own filesystem view (only declared paths exist),
     *   pid namespace, network on/off, and cgroup resource caps via
     *   `systemd-run --user`. Runs as the invoking user — isolation is by
     *   namespace, not by a second uid — so it needs NO privilege, NO password,
     *   NO `axon install`. This is the "don't read my keys / only this folder"
     *   tier: light security that just works. The default when any
     *   fs/network/limits policy is set.
     *
     * - `"container"` — the CONTAINER is the box. Declared, never inferred.
     *
     *   For a hosted runtime (Cloud Run, a managed platform) where the process
     *   is already inside a per-tenant sandbox and cannot nest another. That is
     *   not a preference: bwrap needs unprivileged user namespaces plus mount
     *   operations, and a standard container gives it neither — measured, it
     *   needs `seccomp=unconfined` AND `apparmor=unconfined` AND CAP_SYS_ADMIN
     *   together, and Cloud Run offers none of the three (gVisor implements
     *   user namespaces but not the mount operations bwrap performs).
     *
     *   The honest consequence, stated rather than hidden: the USER'S declared
     *   fs/network/limits policy gets no OS enforcement here. The container
     *   boundary handles tenant isolation and the mediator remains the only
     *   per-agent layer. This is NOT weaker hosting — gVisor is a stronger
     *   sandbox than bwrap — it is a different thing being enforced by a
     *   different party.
     *
     *   DECLARED, never inferred, precisely because it is weaker per-agent: a
     *   runtime that quietly fell back here when namespaces were unavailable
     *   would turn a misconfigured host into a silent downgrade, which is the
     *   failure mode `Confinement.build()` already refuses. The deploy path
     *   knows it is deploying and says so; everywhere else, asking for `auto`
     *   and not getting it stays fatal.
     *
     * - `"hardened"` — privileged containment. Everything in `"auto"` plus a
     *   dedicated unprivileged OS user (true uid separation), system cgroups,
     *   and kernel network allowlisting. This is the org / VPS / untrusted-agent
     *   tier. Requires `axon install` (one-time root setup) and a privileged
     *   helper at runtime; a missing primitive is a hard boot error, never a
     *   silent downgrade. Explicit opt-in only — never defaulted into.
     */
    isolation?: "none" | "auto" | "container" | "hardened"

    /**
     * Filesystem view, enforced by the mount namespace under `isolation: "auto"`.
     * Paths outside these grants do not exist inside the box — a forbidden read
     * fails as "no such file", not "permission denied". The capsule cwd and the
     * runtime are always mounted; these extend that. Ignored under `"none"`.
     */
    fs?: {
        /** Extra paths mounted read-only. */
        read?: string[]
        /** Paths mounted read-write. */
        write?: string[]
    }

    /**
     * Network destinations the box may reach.
     *
     * ── Why this is a LIST, not a glob map ──────────────────────────────────
     *
     * This was `Record<host, PolicyRule>`, which let a host carry `"escalate"`
     * or a glob. Neither survives contact with the enforcement layer: nftables
     * matches packets on ADDRESS and PORT, and it cannot pause to ask a human
     * mid-connect. A shape that can express what the kernel cannot enforce is
     * how `{ "*": false }` came to mean "unrestricted internet" — the rule read
     * as a denial and compiled to nothing.
     *
     * So the shape is deliberately narrower than the rest of the policy: an
     * allowlist and a denylist of `host` or `host:port`, and no escalation.
     * What it says is what the kernel does.
     *
     * ── Enforcement ────────────────────────────────────────────────────────
     *
     * Under `isolation: "auto"` the box gets its own network namespace, gains
     * connectivity through a userspace stack (slirp4netns), and carries an nft
     * ruleset whose default policy is DROP. Rootless — no privilege, no helper.
     * A raw socket cannot bypass it because the filter is the namespace's own
     * egress hook, not a library call.
     *
     * Absent = no network at all (`--unshare-net`, no stack whatsoever).
     * Present = default-drop plus exactly what is listed here.
     *
     * ── Hostnames are PINNED, not resolved per connection ──────────────────
     *
     * nft filters addresses, so each hostname is resolved when the box is built
     * and its addresses become rules. The consequence is real and stated rather
     * than hidden: a host whose DNS rotates mid-run (a CDN, a load balancer)
     * may drop out from under a long-lived agent. `dns: "allowlist"` is what
     * keeps that honest — see below.
     */
    net?: {
        /**
         * Destinations the box may reach: `"api.github.com"` (any port) or
         * `"api.github.com:443"` (that port only). An IP or CIDR is taken
         * literally and never resolved.
         */
        allow?: string[]
        /**
         * Destinations refused even when an `allow` entry would admit them.
         * Deny beats allow, matching every other surface.
         */
        deny?: string[]
        /**
         * How DNS is handled inside the box.
         *
         * - `"allowlist"` (default when `allow` is set) — a resolver that
         *   answers only for allowlisted names. Without this, an agent can
         *   resolve any name it likes and reach an allowlisted IP that happens
         *   to be shared hosting, or use DNS itself as an exfiltration channel.
         * - `"open"` — port 53 to the host resolver, unfiltered. The pragmatic
         *   choice while a name is resolvable but its addresses churn.
         * - `"off"` — no DNS. Only literal addresses in `allow` are reachable.
         */
        dns?: "allowlist" | "open" | "off"
    }

    /**
     * Shell access — running programs.
     *
     * ── Why the BINARY is the unit, not the command line ───────────────────
     *
     * This was `process: { run, spawn }`, matching a glob against the whole
     * command string. That is not enforceable against an adversary: the same
     * command reaches the same binary as `git push --force`, `git  push
     * --force`, `env git push --force`, or `sh -c "git push --force"`, and a
     * string matcher catches one of the four. An allowlist that four spellings
     * defeat is a linter, not a control.
     *
     * So `allow`/`deny` name PROGRAMS — resolved to a binary before matching —
     * and argument patterns are a separate, explicitly advisory layer.
     */
    shell?: {
        /** Programs the agent may execute, by name (`"git"`) or absolute path. */
        allow?: string[]
        /** Programs refused outright. Deny beats allow. */
        deny?: string[]
        /**
         * Argument patterns per program, matched against the argv tail.
         *
         * ADVISORY — mediator-only, and honest about it. A program that is
         * allowed to run can generally be driven to the same effect by another
         * spelling, so this catches mistakes and model misfires, not a
         * determined bypass. The durable statement is which binaries exist at
         * all (`allow`) and whether a shell is one of them (`raw`).
         */
        args?: Record<string, PolicyRule>
        /**
         * Whether the agent may invoke a shell — `sh -c`, `bash -c`, and
         * friends.
         *
         * Its own switch because it is the bypass for everything above: a
         * shell turns one allowed program into arbitrary execution, so a user
         * reading `allow: ["git"]` must not have to infer that `sh` was in
         * scope. Defaults to false whenever any `shell` rule is declared.
         */
        raw?: boolean
        /** Long-lived child processes — a different privilege from running one. */
        spawn?: PolicyRule | {
            /** Rule governing which programs may be spawned. */
            rule?: PolicyRule
            /** Concurrent long-lived children the agent may hold. */
            max?: number
        }
    }

    /**
     * Environment variables the agent's process receives.
     *
     * ── The box starts EMPTY ───────────────────────────────────────────────
     *
     * The environment used to be `{ ...process.env }` — every variable in the
     * invoking shell, handed to model code. An `fs` policy would carefully deny
     * reading `.env` from disk and then the same secrets arrived as
     * environment. Now the box is built with `--clearenv` and receives exactly
     * three things:
     *
     *   1. the RUNTIME FLOOR — HOME, PATH, TZ, LANG and Axon's own plumbing.
     *      Not a grant; the box cannot start without it, and it never appears
     *      in `axon policy` as though the user had asked for it.
     *   2. the agent's own `.env`, beside its code and already gitignored.
     *      This is where an agent's credentials belong, and it is why
     *      deny-by-default costs nothing: the common case needs no rule here.
     *   3. whatever this block names.
     *
     * Inference credentials are in NONE of those, deliberately: the provider
     * key is held by the supervisor and the agent asks for a ROLE, so no engine
     * key exists inside the box to leak.
     *
     * ── What this block is for ─────────────────────────────────────────────
     *
     * The escape hatch: a variable the agent should read from the HOST rather
     * than from its own `.env` — a shared token, something CI injects. Rare by
     * design. A name listed here that is unset on the host is not an error; a
     * name that is set but NOT listed produces a denial that names the variable
     * and the fix, because a missing credential surfacing as a downstream 401
     * is the failure mode that makes people turn policy off.
     */
    env?: {
        /** Host variables passed into the box. Absent = none. */
        allow?: string[]
    }

    /**
     * OS resource caps, enforced as a systemd cgroup scope under
     * `isolation: "auto"`. Limits apply to the whole process tree, so children
     * cannot multiply the budget by spawning helpers. Ignored under `"none"`.
     */
    limits?: {
        /** Hard memory cap (systemd size, e.g. "2G"). OOM-killed on breach. */
        memory?: string
        /** CPU quota as a percent of one core (e.g. "50%" or "200%" for 2 cores). */
        cpu?: string
        /** Max processes/threads in the tree (fork-bomb cap). */
        pids?: number
        /**
         * Writable-space cap, applied as the size of the box's tmpfs.
         *
         * Not a cgroup control — cgroup v2 has no disk-space knob — so it
         * bounds what the box can write to its OWN scratch space, not what it
         * can write into a granted `fs.write` path. Stated plainly because the
         * difference matters: a policy granting `write: ["./output"]` on a real
         * filesystem can still fill that filesystem.
         */
        disk?: string
        /**
         * Wall-clock ceiling on one agent run (e.g. "30m"). The tree is killed
         * on breach. The cheapest guard against a loop that burns tokens
         * forever, and the one limit that is about cost rather than safety.
         */
        wall?: string
    }

    /**
     * Tool permissions, addressed exactly as the agent's code addresses them.
     *
     * The key IS the global. Every export from `src/tools/*.ts` lands in the
     * agent's scope under its own name, and this map mirrors that scope
     * one-for-one — so a rule and a call site are the same address:
     *
     * ```ts
     * tools: {
     *     "*": "escalate",             // anything not named below
     *     fs: { read: true, remove: false },  // one bag, per-member rules
     *     tavily: false,               // the whole bag
     *     read: false,                 // a bare `read()` global — NOT fs.read
     * }
     * ```
     *
     * Resolution walks the address from most specific to least:
     * `fs.remove` → `fs` → `*`. A bare `read()` tries `read` → `*`.
     *
     * ONE LEVEL of nesting, because that is what the scope has: a global is
     * either a function or a bag of functions, never deeper.
     *
     * `fs.read` and a bare `read` are INDEPENDENT rules, deliberately — they
     * are two different globals, and the flat scope guarantees there is only
     * ever one of each (a second export claiming a taken name fails at
     * install, so an address here is never ambiguous).
     *
     * This is the high-granularity escape hatch, not the primary control:
     * locking the filesystem or the network itself is the durable statement,
     * since those hold however the tool surface changes. These rules are
     * specific to the tools an agent happens to have installed.
     */
    tools?: Record<string, ToolRule>
}


/**
 * Which layer produced a verdict.
 *
 * The ceiling model resolves two independently-authored policies, and a user
 * reading a denial has to know WHICH said no — a profile denying `**\/secrets/**`
 * while an agent allows `./data/**` denies `data/secrets/key`, and without the
 * source that reads as the agent's own rule misbehaving.
 *
 * "grant" is a standing approval satisfying an escalation that would otherwise
 * have prompted. Reported so an allow that came from a remembered decision is
 * distinguishable from one the policy always permitted — the two look identical
 * at the call site and mean very different things to someone auditing.
 */
export type PolicyLayer = "profile" | "agent" | "grant"

/**
 * Two layers' rules for one capability, kept SEPARATE so both can be evaluated.
 *
 * ── Why a pair and not a merged rule ────────────────────────────────────────
 *
 * The ceiling used to collapse at the normalisation seam: when both layers were
 * glob-shaped, `pairRule` returned the agent's and dropped the profile's. So a
 * profile allowing `["git status"]` under an agent allowing `["git push
 * --force"]` resolved to the agent's rule alone, and the force-push ran — the
 * exact widening the ceiling exists to make impossible.
 *
 * Merging the two rules instead is worse, and is why this type exists rather
 * than a smarter merge: unioning two allowlists permits everything either layer
 * allowed, and intersecting two glob patterns is not something globs can
 * express. Carrying both and evaluating each against the subject at call time
 * is the only form that cannot widen, and it is what lets a denial name the
 * layer that produced it.
 *
 * Only constructed where BOTH layers declared a glob rule. Every collapsible
 * case (a bare verdict on either side) still collapses at the seam, so the hot
 * path stays a plain rule.
 */
export type PolicyRulePair = {
    profile: PolicyRule
    agent: PolicyRule
}

/** A rule as the enforcer receives it: one layer's, or both carried together. */
export type EffectiveRule = PolicyRule | PolicyRulePair

/**
 * A policy after the ceiling has run — the shape the ENFORCER reads.
 *
 * Identical to `CapsulePolicy` except that every slot holding a verdict may
 * hold a carried pair instead. Kept as a distinct type rather than widening
 * `CapsulePolicy` so the AUTHORED surface stays exactly what a user can write:
 * nobody hand-writes a `{ profile, agent }` pair, and a config type that
 * accepted one would document a shape with no authoring meaning.
 */
export type ResolvedCapsulePolicy = Omit<CapsulePolicy, "tools" | "shell"> & {
    tools?: Record<string, ResolvedToolEntry>
    shell?: Omit<NonNullable<CapsulePolicy["shell"]>, "args" | "spawn"> & {
        args?: Record<string, EffectiveRule>
        spawn?: EffectiveRule | { rule?: EffectiveRule; max?: number }
    }
}

/**
 * One resolved `tools` entry: a verdict for the whole name (possibly a carried
 * pair), or a bag of per-member verdicts one level deep.
 *
 * The bag branch is a Record of EffectiveRule and NOT of ResolvedToolEntry:
 * nesting stops at one level because the scope does — a global is a function or
 * a bag of functions, never deeper.
 */
export type ResolvedToolEntry = EffectiveRule | ResolvedToolBag

/** Per-member verdicts for one resolved tool bag. */
export type ResolvedToolBag = {
    [member: string]: EffectiveRule
} & { profile?: never; agent?: never; allow?: never; deny?: never; escalate?: never }

/** Distinguishes a carried pair from an ordinary rule. */
export function isRulePair(rule: EffectiveRule | undefined): rule is PolicyRulePair {
    return (
        typeof rule === "object"
        && rule !== null
        && !Array.isArray(rule)
        && "profile" in rule
        && "agent" in rule
    )
}

/**
 * Why an operation was denied or escalated — structured, never a string.
 *
 * This replaced `rule: String(rule)`, which stringified the object form to
 * "[object Object]": the one case that carries the actual patterns was the one
 * case that reported nothing. Every surface that has to explain a decision
 * (the timeline, an escalation prompt, Fleet's policy view) reads this.
 */
export type PolicyVerdictSource = {
    /** Which policy layer decided. */
    layer: PolicyLayer
    /** The subject matched against — a command, host, or tool namespace. */
    subject: string
    /**
     * The specific pattern that matched, when the rule was glob-shaped.
     * Absent for a bare `true`/`false`/`"escalate"`, which has no pattern.
     */
    pattern?: string
    /** The rule as authored, for a surface that wants to show it verbatim. */
    rule: PolicyRule
}

/** Command sent back to the capsule to allow or deny a pending escalation. */
export type PolicyResponseCommand = {
    id: string
    type: "policy:response"
    allow: boolean
}

export type PolicyCall = {
    /** Fully qualified function being evaluated, for example `"fs.write"` or `"proc.spawn"`. */
    fn: string
    /** Original arguments passed to the operation. */
    args: unknown[]
}

/** A pending escalation surfaced to the host's escalate callback. */
export type EscalationCall = {
    /** Escalation id — the policy:response answering this must echo it. */
    id: string
    /** Fully qualified function, e.g. "fs.write". */
    fn: string
    args: unknown[]
    /** The policy rule that triggered escalation. */
    rule: string
}