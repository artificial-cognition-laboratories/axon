import { describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Bwrap } from "../../../src/confine/bwrap"
import { probe } from "../../../src/confine/probe"
import { fromPolicy } from "../../../src/confine/spec"
import { nftScript } from "../../../src/confine/network"
import { boxedPid } from "../../../src/confine/netns"
import type { CapsulePolicy } from "@arcforge/types"

/**
 * An agent TRYING TO ESCAPE.
 *
 * Every other test here asserts the policy denies what it says it denies. These
 * assert the box survives an occupant actively attacking it, which is a
 * different question and the one that matters for an untrusted agent.
 *
 * The first case is not hypothetical. It was a live escape: the box grants
 * CAP_NET_ADMIN so the launcher can install its nft ruleset, and an agent that
 * kept that capability ran `nft flush ruleset` and reached a host its policy
 * denied — 000 before the flush, 301 after. The wall handed over the key to its
 * own cell.
 */

const status = probe()
const boxed = status.auto ? describe : describe.skip

/** A box with a real egress filter, running an attacker script inside it. */
async function attack(script: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "axon-escape-"))
    const spec = fromPolicy({
        policy: { net: { allow: ["20.26.156.210:443"] } } as CapsulePolicy,
        tier: "auto",
        cwd: process.cwd(),
        entrypoint: "/bin/sh",
        runtime: ["/bin/sh"],
        network: { allow: [{ address: "20.26.156.210", port: 443 }], deny: [], dns: "off", unresolved: [] },
    })

    writeFileSync(join(dir, "rules.nft"), nftScript(spec.network!), { mode: 0o444 })
    const probe_ = join(dir, "probe.sh")
    writeFileSync(probe_, `#!/bin/sh\n${script}\n`, { mode: 0o555 })
    chmodSync(probe_, 0o555)

    const launcher = join(dir, "up.sh")
    writeFileSync(launcher, [
        "#!/bin/sh",
        "ip link set lo up 2>/dev/null || true",
        'i=0; while [ $i -lt 60 ]; do ip addr show tap0 2>/dev/null | grep -q "inet " && break; i=$((i+1)); sleep 0.05; done',
        `nft -f ${join(dir, "rules.nft")} || exit 78`,
        `exec capsh --drop=all --caps='' -- -c '${probe_}'`,
        "",
    ].join("\n"), { mode: 0o555 })
    chmodSync(launcher, 0o555)

    const boxSpec = { ...spec, runtime: [...spec.runtime, dir] }
    const child = Bun.spawn(Bwrap(boxSpec).wrap([launcher]), { stdout: "pipe", stderr: "pipe" })

    const inner = await boxedPid(child.pid, { timeoutMs: 4_000 })
    const stack = inner
        ? Bun.spawn(["slirp4netns", "--configure", "--mtu=65520", "--disable-host-loopback", String(inner), "tap0"],
            { stdout: "ignore", stderr: "ignore" })
        : null

    const out = await new Response(child.stdout).text()
    await child.exited
    stack?.kill()
    return out.trim()
}

boxed("an agent attacking its filesystem view", () => {
    async function fsAttack(policy: Partial<CapsulePolicy>, script: string): Promise<string> {
        const spec = fromPolicy({
            policy: policy as CapsulePolicy,
            tier: "auto",
            cwd: process.cwd(),
            entrypoint: "/bin/sh",
            runtime: ["/bin/sh"],
        })
        const child = Bun.spawn(Bwrap(spec).wrap(["/bin/sh", "-c", script]), { stdout: "pipe", stderr: "ignore" })
        const out = await new Response(child.stdout).text()
        await child.exited
        return out.trim()
    }

    it("cannot reach the host root through /proc/self/root", async () => {
        // The classic namespace escape: /proc/self/root is a magic symlink to
        // the process's own root. Inside the box it resolves to the box's root,
        // so it grants nothing — but a box that mounted /proc from the HOST
        // would leak every process's root through /proc/*/root.
        const out = await fsAttack({ fs: { read: ["/etc/hostname"] } },
            `ls /proc/self/root/home 2>/dev/null | head -3; echo "done"`)
        expect(out).toBe("done")
    }, 60_000)

    it("cannot see other processes through its own /proc", async () => {
        // A pid namespace with its own /proc shows only the box's processes. If
        // the host's /proc were visible, /proc/<pid>/root and /proc/<pid>/environ
        // would hand over other users' files and secrets.
        const out = await fsAttack({ fs: { read: ["/etc/hostname"] } },
            `ls /proc | grep -c '^[0-9]*$'`)
        // sh, the grep pipeline, and little else — certainly not a host's worth.
        expect(Number(out)).toBeLessThan(15)
    }, 60_000)

    it("cannot follow a symlink out to an ungranted target", async () => {
        const out = await fsAttack({ fs: { write: ["/tmp"] } },
            `ln -sf /etc/shadow /tmp/esc 2>/dev/null; cat /tmp/esc 2>/dev/null | head -1; echo "done"`)
        expect(out).toBe("done")
    }, 60_000)
})
