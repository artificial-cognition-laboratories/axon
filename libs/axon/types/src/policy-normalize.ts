import { resolveIsolation } from "./policy-resolve"
import { isRulePair } from "./policy"
import type { CapsulePolicy, EffectiveRule, PolicyBucket, PolicyRule, ResolvedCapsulePolicy, ResolvedToolBag, ResolvedToolEntry, ToolBucket, ToolRule } from "./policy"

/**
 * The key a blanket rule normalises to — see `PolicyBucket`.
 *
 * ONE declaration now. It used to exist three times (capsule's Blueprint, the
 * kernel's ceiling resolver, and the guest mediator) with a test asserting the
 * literals matched, because the guest could not import across the subprocess
 * boundary. Resolution happens here, above every consumer, so the duplicates
 * and their guard are gone.
 */
export const POLICY_WILDCARD = "*"

/** A rule with no keys of its own — `true`, `false`, `"escalate"`, or a glob object. */
function isBareRule(value: PolicyBucket): value is PolicyRule {
    if (typeof value === "boolean" || value === "escalate") return true
    // The glob object form. Distinguished from a keyed bucket by its OWN keys:
    // `allow`/`deny`/`escalate` are the rule's vocabulary, and a bucket keyed
    // by a module actually named "allow" is a collision nobody can author
    // (module names are scoped identifiers, not bare verbs).
    if (typeof value !== "object" || value === null) return false
    const keys = Object.keys(value)
    return keys.length > 0 && keys.every(key => key === "allow" || key === "deny" || key === "escalate")
}

function bucket(value: PolicyBucket | undefined): Record<string, PolicyRule> {
    if (value === undefined) return {}
    return isBareRule(value) ? { [POLICY_WILDCARD]: value } : value
}

/** bucket(), for the one surface whose entries may be per-member bags. */
function toolBucket(value: ToolBucket | undefined): Record<string, ToolRule> {
    if (value === undefined) return {}
    return isBareRule(value) ? { [POLICY_WILDCARD]: value } : value
}

/**
 * One entry in the `tools` map: a verdict for the whole name, or a bag of
 * per-member verdicts one level deep (`fs: { read: true }`).
 *
 * Bags are an AGENT-side facility only — see mergeTools below.
 */
export type ToolPolicyEntry = ResolvedToolEntry

export type NormalizedPolicy = Omit<AuthoredPolicy, "tools" | "shell"> & {
    tools?: Record<string, ToolPolicyEntry>
    shell?: NonNullable<ResolvedCapsulePolicy["shell"]>
}

/**
 * A policy as a human authored it — bare rules still un-expanded.
 *
 * `net`, `env` and `limits` are already in their final shape: they are lists
 * and scalars, not rule maps, so there is no bare form to expand. Only `tools`
 * (a keyed bucket) and `shell` (a bare verdict standing for the whole surface)
 * need normalising.
 */
export type AuthoredPolicy = Omit<Partial<CapsulePolicy>, "tools" | "shell"> & {
    tools?: ToolBucket
    /** `shell: false` is the common statement and expands to a full deny. */
    shell?: NonNullable<CapsulePolicy["shell"]> | boolean
}

/**
 * One authored policy, with every bare surface rule expanded to `{ "*": rule }`.
 *
 * `tools: "escalate"` and `tools: { "*": "escalate" }` are the same statement;
 * this makes them the same VALUE, so nothing downstream has to ask which was
 * written. `shell` takes a bare boolean for the same reason, expanded into the
 * full block rather than becoming a key no verb would match.
 */
export function keyed(policy: AuthoredPolicy): NormalizedPolicy {
    const { tools, shell, ...rest } = policy
    return {
        ...rest,
        ...(tools !== undefined ? { tools: toolBucket(tools) } : {}),
        // `shell: false` — the whole surface off — is the statement most
        // policies want, so it is authorable as a bare boolean and expanded
        // here into the deny-everything form the enforcer reads.
        ...(shell !== undefined
            ? { shell: typeof shell === "boolean" ? shellFromBare(shell) : shell }
            : {}),
    }
}

/**
 * `shell: true` / `shell: false` as a full shell block.
 *
 * `false` is a total denial: no program, and explicitly no raw shell. `true`
 * grants execution but STILL leaves `raw` off — turning on shell access should
 * not silently also hand over `sh -c`, which is the one switch that makes every
 * other rule in this surface unenforceable.
 */
/**
 * An already-resolved pair cannot itself be a ceiling operand.
 *
 * Intersection runs over AUTHORED policies, where every slot is a plain rule.
 * A pair only ever appears in this function's OUTPUT, so encountering one on
 * the way in means a resolved policy was fed back through the resolver — a
 * wiring fault, and one that would silently drop a layer if it were coerced.
 */
function asRule(rule: ToolPolicyEntry | undefined): PolicyRule | undefined {
    if (isRulePair(rule)) throw new Error("POLICY_ALREADY_RESOLVED: cannot intersect a resolved rule pair")
    // A bag reaching here is a caller error the same way a pair is: bags are
    // handled by mergeTools before this point, so one arriving means the two
    // branches disagree about what shape they are looking at.
    if (isMemberBag(rule)) throw new Error("POLICY_BAG_NOT_A_RULE: a member bag has no single verdict")
    return rule
}

function shellFromBare(allowed: boolean): NonNullable<CapsulePolicy["shell"]> {
    return allowed ? { allow: ["*"], raw: false } : { allow: [], deny: ["*"], raw: false, spawn: false }
}

/**
 * One capability's rule under both layers.
 *
 * A bare profile verdict wins outright — it cannot be narrowed further by a
 * pattern and cannot be widened at all. Otherwise the agent's rule stands and
 * the profile's is carried alongside for the mediator to evaluate against.
 */
function pairRule(profile: PolicyRule | undefined, agent: PolicyRule | undefined): EffectiveRule {
    if (profile === false) return false
    if (profile === "escalate" && agent !== false) return "escalate"
    if (profile === undefined) return agent ?? true
    if (profile === true) return agent ?? true
    // Profile is glob-shaped. With no agent rule the profile IS the rule.
    if (agent === undefined) return profile
    // A bare agent verdict cannot widen a glob ceiling, but it can narrow: a
    // `false` is final, and an `escalate` is stricter than any allow the
    // profile's globs could produce.
    if (agent === false) return false
    if (agent === "escalate") return "escalate"
    // `agent === true` does NOT collapse to true — that would discard the
    // ceiling entirely. The profile's globs still bind, so the profile stands
    // alone as the rule.
    if (agent === true) return profile
    // Both glob-shaped: carry BOTH. Collapsing here is what let an agent's
    // allowlist widen past its profile's — see PolicyRulePair.
    return { profile, agent }
}

/**
 * The `tools` ceiling merge — pairRules, plus the bag case.
 *
 * A PROFILE rule is always a bare verdict or a glob: per-member bags are an
 * AGENT-side facility, deliberately. A profile ceiling is a blunt instrument
 * — "this machine does not do filesystem writes" — and it holds however the
 * agent's tool surface changes. Per-member precision belongs to the agent,
 * which is the only layer that knows what it actually installed.
 *
 * So a bag is never intersected member-by-member. The profile's verdict for
 * the whole name applies to everything under it: a profile `fs: false`
 * denies the bag outright, no matter what the agent wrote inside it, and a
 * profile that says nothing lets the bag stand as authored.
 *
 * That keeps the ceiling honest without inventing intersection semantics for
 * a case nobody has asked for — and it means a bag can never be the thing
 * that widens a permission.
 */
function mergeTools(
    profile: Record<string, ToolPolicyEntry> | undefined,
    agent: Record<string, ToolPolicyEntry> | undefined,
): Record<string, ToolPolicyEntry> {
    const keys = new Set([...Object.keys(profile ?? {}), ...Object.keys(agent ?? {})])
    const out: Record<string, ToolPolicyEntry> = {}
    const blanket = profile?.[POLICY_WILDCARD]

    for (const key of keys) {
        const agentEntry = agent?.[key]
        const profileEntry = profile?.[key] ?? blanket

        if (isMemberBag(agentEntry)) {
            // The ceiling still binds — it just binds to the whole bag.
            // `false` and `"escalate"` are final either way; anything else
            // leaves the agent's per-member rules exactly as written.
            if (profileEntry === false) { out[key] = false; continue }
            if (profileEntry === "escalate") { out[key] = "escalate"; continue }
            out[key] = agentEntry
            continue
        }

        // A profile bag is not a thing. Treated as "no opinion" rather than
        // silently half-applied, so a mistyped ceiling cannot read as a
        // narrower one than it is.
        const ceiling = isMemberBag(profileEntry) ? undefined : profileEntry
        out[key] = pairRule(asRule(ceiling), asRule(agentEntry as ToolPolicyEntry | undefined))
    }

    return out
}

/**
 * A per-member bag rather than a verdict for the whole name.
 *
 * Both are objects, so the KEYS decide: a glob `PolicyRule` carries only
 * `allow`/`deny`/`escalate`; anything else is a member name. An empty object
 * is a rule — `{}` states nothing about any member.
 *
 * EXPORTED because the mediator asks the same question at call time. Two
 * copies of this test would be two chances for a rule to normalise as one
 * shape and evaluate as the other, which is a silent permission change.
 */
export function isMemberBag(entry: ToolPolicyEntry | undefined): entry is ResolvedToolBag {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false
    const keys = Object.keys(entry)
    if (keys.length === 0) return false
    // A carried PAIR is also an object, and its keys are `profile`/`agent` —
    // neither a rule's vocabulary nor a member name. Excluded explicitly, or a
    // ceiling-resolved rule would be walked as though it were a bag of two
    // tools called "profile" and "agent".
    if ("profile" in entry && "agent" in entry) return false
    return !keys.some(key => key === "allow" || key === "deny" || key === "escalate")
}

/** pairRule across two keyed maps, over the union of their keys. */
function pairRules(
    profile: Record<string, EffectiveRule> | undefined,
    agent: Record<string, EffectiveRule> | undefined,
): Record<string, EffectiveRule> {
    const keys = new Set([...Object.keys(profile ?? {}), ...Object.keys(agent ?? {})])
    const out: Record<string, EffectiveRule> = {}

    // A profile WILDCARD applies to every key, not only to `*`.
    //
    // Without this the ceiling leaks in exactly the case the wildcard exists
    // for: a profile saying `tools: "escalate"` normalises to `{ "*":
    // "escalate" }`, an agent's `tools: { fs: true }` keeps its own key, and
    // the mediator's exact-match then hands back `true` — the profile's
    // blanket never consulted. A ceiling a named grant can punch through is
    // not a ceiling.
    //
    // Paired per key rather than replacing the agent's rule, so the profile's
    // blanket and the agent's specific are BOTH carried to the mediator and
    // the verdict can still name which layer decided.
    const blanket = profile?.[POLICY_WILDCARD]

    for (const key of keys) out[key] = pairRule(asRule(profile?.[key] ?? blanket), asRule(agent?.[key]))
    return out
}

/**
 * Intersect the profile ceiling with an agent's own policy.
 *
 * ── Why this is a UNION of keys, not of permissions ─────────────────────────
 *
 * Both layers' rules are carried forward per capability, and the MEDIATOR
 * evaluates the pair at call time (see resolveVerdict in @arcforge/types).
 * That split is deliberate: merging two glob rules into one is where a ceiling
 * silently springs a leak — `allow: ["git status"]` unioned with
 * `allow: ["git push"]` permits a command neither layer permitted alone.
 *
 * So this composes the SHAPE (which capabilities each layer has an opinion
 * about) and leaves the VERDICT to per-call evaluation, where both rules are
 * still separately available and the answer can name which one decided.
 *
 * ── The bare cases collapse here ────────────────────────────────────────────
 *
 * `true`/`false`/`"escalate"` carry no patterns, so there is nothing to defer:
 * a profile `false` is final regardless of what the agent says, and a profile
 * `true` adds no constraint the agent could violate. Collapsing them at this
 * seam keeps the common case (a profile that just says "no shell") from
 * costing a pair lookup on every call.
 *
 * fs and limits are NOT intersected: they are OS-layer facts (bind mounts,
 * cgroups) with no verdict to evaluate, and the mediator never sees them. The
 * profile's are taken when present, since a ceiling that a bind mount ignores
 * is not a ceiling.
 */
export function intersect(
    profile: NormalizedPolicy | undefined,
    agent: NormalizedPolicy,
): NormalizedPolicy {
    if (!profile) return agent

    // resolveIsolation returns undefined only when BOTH layers are silent, in
    // which case the key must stay absent rather than become an explicit
    // `undefined` — Policy() reads its absence to infer the tier from whether
    // containment was asked for at all.
    const isolation = resolveIsolation(profile.isolation, agent.isolation)

    return {
        ...agent,
        ...(isolation !== undefined ? { isolation } : {}),

        // The OS wall. A profile grant is the outer bound, so an agent's paths
        // are kept only where the profile has no opinion at all — otherwise a
        // narrower mount would have to be computed, which bind mounts cannot
        // express as an intersection of globs.
        ...(profile.fs ? { fs: profile.fs } : {}),
        ...(profile.limits ? { limits: profile.limits } : {}),

        // ── net: the LIST intersection ─────────────────────────────────────
        //
        // Not pairRules: there are no per-key verdicts to rank. A ceiling over
        // two allowlists is their INTERSECTION — a destination must be admitted
        // by both layers — and the denylists UNION, because either layer
        // refusing is a refusal. This is the one surface where merging is not
        // only safe but required, precisely because there are no globs to
        // widen: entries are literal hosts and the intersection of two literal
        // sets cannot contain a member neither set had.
        ...(profile.net || agent.net ? { net: mergeNet(profile.net, agent.net) } : {}),

        // env: same shape, same reasoning. A host variable must be granted by
        // both layers to cross into the box.
        ...(profile.env || agent.env
            ? { env: { allow: intersectLists(profile.env?.allow, agent.env?.allow) } }
            : {}),

        ...(profile.tools || agent.tools
            ? { tools: mergeTools(profile.tools, agent.tools) }
            : {}),

        ...(profile.shell || agent.shell ? { shell: mergeShell(profile.shell, agent.shell) } : {}),
    }
}


/**
 * Two allowlists under a ceiling: what BOTH layers admit.
 *
 * `undefined` from a layer is "no opinion" and defers to the other — the same
 * silence rule the verdict resolver uses. Two present lists intersect, so a
 * profile can only ever shrink what an agent reaches.
 */
function intersectLists(profile: string[] | undefined, agent: string[] | undefined): string[] {
    if (profile === undefined) return agent ?? []
    if (agent === undefined) return profile
    const ceiling = new Set(profile)
    return agent.filter(entry => ceiling.has(entry))
}

/** Either layer's denial stands. */
function unionLists(profile: string[] | undefined, agent: string[] | undefined): string[] {
    return [...new Set([...(profile ?? []), ...(agent ?? [])])]
}

/**
 * The `net` ceiling: allowlists intersect, denylists union.
 *
 * `dns` takes the STRICTER setting rather than the agent's, ranked
 * off < allowlist < open — a profile that closed DNS cannot be reopened by an
 * agent declaring `"open"`.
 */
const DNS_RANK = { off: 0, allowlist: 1, open: 2 } as const

function mergeNet(
    profile: CapsulePolicy["net"],
    agent: CapsulePolicy["net"],
): NonNullable<CapsulePolicy["net"]> {
    const dns = ((): NonNullable<CapsulePolicy["net"]>["dns"] | undefined => {
        if (profile?.dns === undefined) return agent?.dns
        if (agent?.dns === undefined) return profile.dns
        return DNS_RANK[agent.dns] < DNS_RANK[profile.dns] ? agent.dns : profile.dns
    })()

    return {
        allow: intersectLists(profile?.allow, agent?.allow),
        deny: unionLists(profile?.deny, agent?.deny),
        ...(dns !== undefined ? { dns } : {}),
    }
}

/**
 * The `shell` ceiling.
 *
 * Programs intersect and denials union, like `net`. `raw` is an AND: a shell is
 * available only if both layers permit it, so a profile turning it off holds
 * against every agent. `args` pairs per program through the ordinary rule
 * ceiling, since those ARE glob rules with verdicts.
 */
function mergeShell(
    profile: NormalizedPolicy["shell"],
    agent: NormalizedPolicy["shell"],
): NonNullable<ResolvedCapsulePolicy["shell"]> {
    const spawnRule = (entry: NormalizedPolicy["shell"]) =>
        (entry?.spawn !== null && typeof entry?.spawn === "object" && "rule" in entry.spawn
            ? entry.spawn.rule
            : entry?.spawn as EffectiveRule | undefined)
    const spawnMax = (entry: NormalizedPolicy["shell"]) =>
        (entry?.spawn !== null && typeof entry?.spawn === "object" && "max" in entry.spawn
            ? entry.spawn.max
            : undefined)

    const maxes = [spawnMax(profile), spawnMax(agent)].filter((n): n is number => typeof n === "number")

    return {
        allow: intersectLists(profile?.allow, agent?.allow),
        deny: unionLists(profile?.deny, agent?.deny),
        ...(profile?.args || agent?.args
            ? { args: pairRules(profile?.args, agent?.args) }
            : {}),
        // Both must permit it. Absent means "no opinion", which for the one
        // switch that disarms every other rule defaults CLOSED.
        raw: (profile?.raw ?? false) && (agent?.raw ?? false),
        spawn: {
            rule: pairRule(asRule(spawnRule(profile)), asRule(spawnRule(agent))),
            // The tighter cap wins; no cap on either side means unlimited.
            ...(maxes.length > 0 ? { max: Math.min(...maxes) } : {}),
        },
    }
}

/**
 * Path resolution WITHOUT `node:path`.
 *
 * This package is the cross-package contract — it is imported by the runtime,
 * the kernel, the TUI and the website, and it declares no runtime
 * dependencies. A top-level `import { isAbsolute, resolve } from "node:path"`
 * here reached the browser through the barrel in `index.ts`: Vite replaced the
 * builtin with a stub that exports only `default`, so the named import threw
 * `does not provide an export named 'resolve'` at module-evaluation time and
 * took down every page on the site with a 500 — including ones that never
 * touch a policy.
 *
 * The two operations are POSIX string manipulation, not filesystem access, so
 * they are written out rather than imported. Policy paths are always POSIX:
 * they are authored in `axon.config.ts` and consumed by the capsule's Linux
 * sandbox, so Windows drive letters and backslashes are not in scope. If that
 * ever changes, this needs a real path implementation — NOT `node:path` back,
 * which would reintroduce exactly this failure.
 */
function isAbsolutePath(p: string): boolean {
    return p.startsWith("/")
}

/**
 * `root` + `p`, with `.` and `..` segments resolved. Mirrors
 * `path.resolve(root, p)` for the relative-POSIX case this seam sees.
 */
function joinPath(root: string, p: string): string {
    const segments: string[] = []
    for (const segment of `${root}/${p}`.split("/")) {
        if (segment === "" || segment === ".") continue
        // `..` pops, but never past the root — a policy path that climbs out
        // of the project is a broken grant, and silently letting it escape is
        // the one outcome a sandbox must not have.
        if (segment === "..") {
            segments.pop()
            continue
        }
        segments.push(segment)
    }
    return `/${segments.join("/")}`
}

/**
 * fs paths are authored relative to the AGENT PROJECT, not the directory the
 * user happened to launch from. `fs: { read: ["./workspace"] }` in
 * agents/foo/axon.config.ts means agents/foo/workspace, wherever axon was run.
 * Resolved at this one seam, so the OS builders only ever see absolute paths.
 */
export function resolveFsPaths(fs: NonNullable<CapsulePolicy["fs"]>, root: string): CapsulePolicy["fs"] {
    const abs = (p: string) => (isAbsolutePath(p) ? p : joinPath(root, p))
    return {
        ...(fs.read ? { read: fs.read.map(abs) } : {}),
        ...(fs.write ? { write: fs.write.map(abs) } : {}),
    }
}
