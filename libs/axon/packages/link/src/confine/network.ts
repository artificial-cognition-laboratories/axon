import { lookup } from "node:dns/promises"
import type { CapsulePolicy } from "@arcforge/types"
import type { NetRule, NetworkSpec } from "./spec"

/**
 * Network confinement — turning a `net` policy into rules the kernel enforces.
 *
 * ── What this replaced ──────────────────────────────────────────────────────
 *
 * Network used to be BINARY. Any grant at all and the box kept the host's whole
 * network stack; the per-host rules were carried through the policy, mirrored
 * in the mediator, documented as an nft allowlist — and compiled to nothing. A
 * policy reading `{ "api.github.com": true, "*": false }` had unrestricted
 * internet access, which is the worst possible failure for a security control:
 * it reads as the tightest rule available and is the widest outcome.
 *
 * ── How it is enforced now ──────────────────────────────────────────────────
 *
 * The box gets its OWN network namespace. Inside it there is no route to
 * anywhere until a userspace stack (slirp4netns) attaches a tap device, and an
 * nft ruleset with `policy drop` decides what may leave. A raw socket cannot
 * bypass this: the filter is the namespace's own egress hook, not a library
 * call the agent could route around.
 *
 * All of it is ROOTLESS. The namespace comes from `--unshare-user --unshare-net`,
 * and nft inside a user namespace manages that namespace's own tables. No
 * privileged helper, no `axon install`, no setuid binary — which is why this
 * belongs in the `auto` tier rather than behind `hardened`, where the earlier
 * "deliberate follow-up" note had placed it.
 *
 * ── The lossy step, stated ──────────────────────────────────────────────────
 *
 * nftables matches ADDRESSES. A policy names HOSTS. So every hostname is
 * resolved once, when the box is built, and its addresses become rules. Two
 * consequences that are real and must never be papered over:
 *
 *   - A host whose addresses rotate mid-run (a CDN, a load balancer) can drop
 *     out from under a long-lived agent. `dns: "allowlist"` narrows this by
 *     ensuring the agent cannot resolve anything else, but it does not remove it.
 *   - A name that resolves to shared hosting grants that ADDRESS, which may
 *     serve other names too. An allowlist of one host on a shared IP is not the
 *     same guarantee as an allowlist of one host.
 *
 * Both are recorded on the spec (`unresolved`) or accepted deliberately. The
 * alternative — a filtering DNS proxy that pins names to addresses per
 * connection — is the correct long-term shape and a real component; this is the
 * enforcement that holds until it exists.
 */

/** Where the box's resolver points when DNS is filtered rather than open. */
const DNS_PORT = 53

/**
 * Split `host:port` into its parts.
 *
 * A bare host means every port on that host. An IPv6 literal is bracketed
 * (`[::1]:443`) so the colons in the address are not read as a port separator.
 */
export function parseDestination(entry: string): { host: string; port?: number } {
    const bracketed = entry.match(/^\[(.+)\](?::(\d+))?$/)
    if (bracketed) {
        return { host: bracketed[1]!, ...(bracketed[2] ? { port: Number(bracketed[2]) } : {}) }
    }
    /**
     * An UNBRACKETED address containing more than one colon is IPv6 with no
     * port, and has no port to split off.
     *
     * Splitting on the last colon regardless turned `2001:db8::1` into host
     * `2001:db8:` port `1` — a grant silently pointing at a destination the
     * user never wrote, which is worse than rejecting it. Bracket notation
     * (`[2001:db8::1]:443`) is the only way to give an IPv6 address a port, and
     * that form is handled above.
     */
    if ((entry.match(/:/g)?.length ?? 0) > 1) return { host: entry }

    const colon = entry.lastIndexOf(":")
    // One colon, numeric tail: a host:port pair.
    if (colon > 0 && /^\d+$/.test(entry.slice(colon + 1))) {
        return { host: entry.slice(0, colon), port: Number(entry.slice(colon + 1)) }
    }
    return { host: entry }
}

/** An address literal or CIDR, which is used as written rather than resolved. */
function isLiteral(host: string): boolean {
    return /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(host) || host.includes(":")
}

/**
 * Resolve one policy entry into the rules nftables will carry.
 *
 * A name with several A records yields several rules — all of them, because any
 * of the addresses is a legitimate answer for that name and admitting only the
 * first would fail intermittently in a way nobody could diagnose.
 */
async function resolveEntry(entry: string): Promise<{ rules: NetRule[]; unresolved?: string }> {
    const { host, port } = parseDestination(entry)
    if (isLiteral(host)) return { rules: [{ address: host, ...(port !== undefined ? { port } : {}) }] }

    try {
        const addresses = await lookup(host, { all: true, family: 4 })
        if (addresses.length === 0) return { rules: [], unresolved: entry }
        return {
            rules: addresses.map(({ address }) => ({
                address,
                ...(port !== undefined ? { port } : {}),
                host,
            })),
        }
    } catch {
        // A name that does not resolve is REPORTED, never silently dropped: an
        // allowlist entry that quietly became no rule is a grant the user
        // believes they made and did not.
        return { rules: [], unresolved: entry }
    }
}

/**
 * Resolve a `net` policy into a NetworkSpec.
 *
 * Returns null when the policy declares no network at all, which the box
 * expresses as `--unshare-net`: not an empty allowlist but the absence of a
 * network stack, which is strictly stronger and costs nothing to provide.
 */
export async function resolveNetwork(net: CapsulePolicy["net"]): Promise<NetworkSpec | null> {
    if (!net) return null

    const allow: NetRule[] = []
    const deny: NetRule[] = []
    const unresolved: string[] = []

    for (const entry of net.allow ?? []) {
        const { rules, unresolved: failed } = await resolveEntry(entry)
        allow.push(...rules)
        if (failed) unresolved.push(failed)
    }
    for (const entry of net.deny ?? []) {
        const { rules } = await resolveEntry(entry)
        deny.push(...rules)
    }

    // An allowlist with nothing in it is the same statement as no network, and
    // is served better by having no stack at all.
    if (allow.length === 0 && unresolved.length === 0) return null

    return {
        allow,
        deny,
        dns: net.dns ?? "allowlist",
        unresolved,
    }
}

/**
 * The nft ruleset for one box, as a script fed to `nft -f -`.
 *
 * Default policy is DROP, so the ruleset is an allowlist by construction rather
 * than by remembering to add a final deny. Ordering inside the chain:
 *
 *   1. loopback — the agent's own link socket and anything it binds locally.
 *   2. established/related — return traffic for connections already admitted.
 *      Without this every allowed connection dies on its first response packet.
 *   3. deny rules — before allows, so a denial cannot be out-ordered.
 *   4. DNS, per the policy's `dns` setting.
 *   5. allow rules.
 */
export function nftScript(spec: NetworkSpec): string {
    const lines = [
        "table inet axon {",
        "  chain output {",
        "    type filter hook output priority 0; policy drop;",
        "    oifname lo accept",
        "    ct state established,related accept",
    ]

    for (const rule of spec.deny) lines.push(`    ${match(rule)} drop`)

    if (spec.dns !== "off") lines.push(`    udp dport ${DNS_PORT} accept`, `    tcp dport ${DNS_PORT} accept`)

    for (const rule of spec.allow) lines.push(`    ${match(rule)} accept`)

    lines.push("  }", "}")
    return lines.join("\n")
}

/** One rule's match clause — address, and port when the policy named one. */
function match(rule: NetRule): string {
    const family = rule.address.includes(":") ? "ip6" : "ip"
    const address = `${family} daddr ${rule.address}`
    return rule.port === undefined ? address : `${address} tcp dport ${rule.port}`
}

/**
 * The `/etc/hosts` the box sees when DNS is filtered to the allowlist.
 *
 * With `dns: "allowlist"` the box has no route to a resolver, so names are
 * answered from this file and only allowlisted names exist. That is what closes
 * the gap the address-pinning leaves open: an agent cannot resolve a name it
 * was not granted, so it cannot discover an address to try.
 */
export function hostsFile(spec: NetworkSpec): string {
    const lines = ["127.0.0.1 localhost", "::1 localhost"]
    const seen = new Set<string>()
    for (const rule of spec.allow) {
        if (!rule.host || seen.has(rule.host)) continue
        seen.add(rule.host)
        lines.push(`${rule.address} ${rule.host}`)
    }
    return lines.join("\n") + "\n"
}
