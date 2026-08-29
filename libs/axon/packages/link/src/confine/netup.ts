import { mkdtempSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nftScript, hostsFile } from "./network"
import type { NetworkSpec } from "./spec"

/**
 * Bringing the box's network up, from INSIDE the box.
 *
 * ── Why this is a script and not more argv ──────────────────────────────────
 *
 * The nft ruleset has to be installed in the box's own network namespace, by a
 * process already inside it. bwrap execs exactly one command, so there is no
 * "run this, then run that" — the one command has to be a small shell program
 * that arms the filter and then execs the real entrypoint.
 *
 * `exec` at the end is what keeps this honest: the shell REPLACES itself with
 * the agent, so there is no extra process in the tree, the agent keeps pid 1 in
 * its pid namespace, and `--die-with-parent` still refers to the thing that
 * matters. A launcher that lingered would break the supervisor's process
 * accounting and hold a shell inside a box whose whole point is that `sh` is
 * not available to the agent.
 *
 * ── The ordering is the security property ───────────────────────────────────
 *
 * Rules are installed BEFORE the agent is exec'd, never after. A window in
 * which the agent runs with an unfiltered namespace is a window in which it can
 * open a connection that `ct state established` will then keep alive for the
 * rest of the run — the filter would be armed and the connection it was meant
 * to prevent would already be through it.
 *
 * If nft fails, the script EXITS rather than continuing. A box whose filter did
 * not install must not run the agent: that is the silent-downgrade failure this
 * whole layer exists to refuse, and it is worth an unbootable agent to avoid.
 *
 * ── The capability MUST be dropped before the agent runs ────────────────────
 *
 * Installing the ruleset needs CAP_NET_ADMIN in the box's namespace. Keeping it
 * afterwards hands the agent the key to its own cell: measured, an agent inside
 * a filtered box ran `nft flush ruleset`, the ruleset became empty, and a host
 * that had been blocked (000) returned 301. The network wall was self-defeating
 * — we granted the capability that deletes it.
 *
 * So the launcher drops EVERY capability before exec'ing the agent, and the
 * order is the security property: rules installed, capabilities dropped, agent
 * started, in that sequence and never any other.
 *
 * `capsh --drop=all --caps=''` rather than `--drop` alone, because `--drop`
 * touches only the bounding set — `CapEff` still showed the bits and `nft
 * flush` still succeeded. Clearing every set gives `CapEff: 0`, after which
 * both `nft flush` and `ip link` are refused while ordinary egress through the
 * already-installed rules keeps working. Dropping CAP_SETPCAP too means the
 * agent cannot re-raise anything: the drop is one-way.
 */

export type NetUp = {
    /** Path to the launcher, bound into the box and exec'd as its command. */
    script: string
    /** Path to the generated hosts file, or null when DNS is not filtered. */
    hosts: string | null
    /** Directory holding both, removed on cleanup. */
    dir: string
}

/**
 * Write the launcher and its data files.
 *
 * Everything lands in one temp directory that is bind-mounted read-only into
 * the box, so the agent can execute the launcher and read the ruleset but can
 * never rewrite either.
 */
export function netUp(spec: NetworkSpec, inner: string[]): NetUp {
    const dir = mkdtempSync(join(tmpdir(), "axon-net-"))

    const rules = join(dir, "rules.nft")
    writeFileSync(rules, nftScript(spec), { mode: 0o444 })

    // `dns: "allowlist"` makes this file the resolver: only granted names exist.
    const hosts = spec.dns === "allowlist" ? join(dir, "hosts") : null
    if (hosts) writeFileSync(hosts, hostsFile(spec), { mode: 0o444 })

    const script = join(dir, "netup.sh")
    writeFileSync(script, [
        "#!/bin/sh",
        // Loopback is down by default in a fresh namespace, and the agent's own
        // link socket plus anything it binds locally needs it up.
        "ip link set lo up 2>/dev/null || true",
        // Wait for the supervisor's slirp4netns to furnish the tap device.
        // Bounded: a stack that never arrives is a boot failure, not a hang.
        'i=0; while [ $i -lt 100 ]; do ip addr show tap0 2>/dev/null | grep -q "inet " && break; i=$((i+1)); sleep 0.05; done',
        // ARM THE FILTER BEFORE THE AGENT EXISTS. A failure here is fatal by
        // design — see the header. `||` rather than `set -e` so the message
        // reaches stderr and the supervisor can report a cause.
        `nft -f ${rules} || { echo "AXON_NET_FILTER_FAILED: could not install the egress ruleset" >&2; exit 78; }`,
        /**
         * Drop every capability, THEN become the agent.
         *
         * `exec` twice over: capsh replaces this shell, and the agent replaces
         * capsh, so nothing of the launcher survives into the process tree and
         * the agent still holds pid 1 in its pid namespace.
         *
         * A failure here is fatal for the same reason a failed nft is: an agent
         * running with CAP_NET_ADMIN can delete the wall that is the only thing
         * making its `net` policy real.
         */
        `command -v capsh >/dev/null || { echo "AXON_NET_CAPSH_MISSING: cannot drop capabilities before starting the agent" >&2; exit 78; }`,
        `exec capsh --drop=all --caps='' -- -c ${shellQuote(inner.map(shellQuote).join(" "))}`,
        "",
    ].join("\n"), { mode: 0o555 })
    chmodSync(script, 0o555)

    return { script, hosts, dir }
}

/**
 * Quote one argv entry for the launcher.
 *
 * Single-quoted with embedded quotes escaped the POSIX way, so a path
 * containing a space or a quote cannot break out of its argument and become
 * another command. This is the one place the box builds a shell string, and it
 * is exactly where an injection would be most valuable.
 */
function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`
}
