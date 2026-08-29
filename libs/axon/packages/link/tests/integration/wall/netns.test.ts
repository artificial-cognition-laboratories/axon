import { describe, expect, it } from "bun:test"
import { readlinkSync } from "node:fs"
import { boxedPid } from "../../../src/confine/netns"
import { probe } from "../../../src/confine/probe"

/**
 * Finding the process inside the box's network namespace.
 *
 * This exists because production and the integration test disagreed and only
 * the test was right: `confined.ts` handed slirp4netns the pid it spawned,
 * which is `systemd-run`/`bwrap` and stays in the HOST's namespaces. Every
 * agent with a `net` policy would have failed to boot — slirp refuses with
 * "setns(CLONE_NEWNET): Operation not permitted", the in-box launcher waits for
 * a tap device that never arrives, and the agent never starts.
 *
 * The bug was invisible because nothing tested the production spawn path: the
 * wall tests built their own argv, and the boxed test wrote its own (correct)
 * attach. Two implementations, one tested, and the untested one shipped.
 */

const boxed = probe().auto ? describe : describe.skip

boxed("finding the boxed pid", () => {
    it("returns a descendant in a DIFFERENT network namespace", async () => {
        const child = Bun.spawn(
            ["bwrap", "--unshare-net", "--unshare-user", "--uid", "0",
                "--proc", "/proc", "--ro-bind-try", "/usr", "/usr",
                "--ro-bind-try", "/bin", "/bin", "--ro-bind-try", "/lib", "/lib",
                "--ro-bind-try", "/lib64", "/lib64",
                "--", "/bin/sh", "-c", "sleep 5"],
            { stdout: "ignore", stderr: "ignore" },
        )
        try {
            const inner = await boxedPid(child.pid, { timeoutMs: 4_000 })
            expect(inner).not.toBeNull()
            expect(inner).not.toBe(child.pid)

            // The property that matters: the pid we hand slirp must be in a
            // namespace that is not ours, or the join is refused.
            const ours = readlinkSync("/proc/self/ns/net")
            expect(readlinkSync(`/proc/${inner}/ns/net`)).not.toBe(ours)
        } finally {
            child.kill()
        }
    }, 20_000)

    it("finds it through the FULL production wrapper chain", async () => {
        // systemd-run → bwrap → sh, which is what Confinement actually builds.
        // The outer pid here is two hops from the box; a fix that counted hops
        // rather than comparing namespaces would pass the test above and fail
        // this one.
        const child = Bun.spawn(
            ["systemd-run", "--user", "--scope", "--quiet", "--collect",
                "bwrap", "--unshare-net", "--unshare-user", "--uid", "0",
                "--proc", "/proc", "--ro-bind-try", "/usr", "/usr",
                "--ro-bind-try", "/bin", "/bin", "--ro-bind-try", "/lib", "/lib",
                "--ro-bind-try", "/lib64", "/lib64",
                "--", "/bin/sh", "-c", "sleep 5"],
            { stdout: "ignore", stderr: "ignore" },
        )
        try {
            const inner = await boxedPid(child.pid, { timeoutMs: 4_000 })
            expect(inner).not.toBeNull()
            const ours = readlinkSync("/proc/self/ns/net")
            expect(readlinkSync(`/proc/${inner}/ns/net`)).not.toBe(ours)
        } finally {
            child.kill()
        }
    }, 20_000)

    it("returns null rather than hanging when no box is ever created", async () => {
        // An unconfined child shares our namespace, so there is nothing to
        // find. The caller turns this into a boot failure with a cause; a throw
        // or a hang here would present as the agent silently never starting.
        const child = Bun.spawn(["/bin/sh", "-c", "sleep 3"], { stdout: "ignore", stderr: "ignore" })
        try {
            expect(await boxedPid(child.pid, { timeoutMs: 500 })).toBeNull()
        } finally {
            child.kill()
        }
    }, 20_000)
})
