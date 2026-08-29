import { afterAll, describe, expect, it } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanup, inBox, status, tempDir } from "./harness"

/**
 * The filesystem and environment walls, asserted from INSIDE a real box.
 *
 * Paired with negative controls throughout: each denial is matched by the same
 * operation succeeding when the policy permits it, so a pass cannot come from a
 * box that simply fails to run anything.
 */

const boxed = status.auto ? describe : describe.skip

afterAll(cleanup)

boxed("the OS wall — filesystem", () => {
    const dir = tempDir("axon-wall-fs-")
    const secret = join(dir, "secret.txt")
    writeFileSync(secret, "must-not-be-read")
    writeFileSync(join(dir, "granted.txt"), "readable")

    it("an ungranted path does not EXIST — ENOENT, not EACCES", async () => {
        // The distinction is the whole point of a mount namespace: the agent
        // cannot even enumerate what it was not granted, so a denial leaks no
        // information about what is there.
        const { out } = await inBox(
            { fs: { read: [dir + "/granted.txt"] } },
            `cat ${secret} 2>&1 | head -1`,
        )
        expect(out).toContain("No such file")
    }, 30_000)

    it("negative control: the granted path IS readable", async () => {
        const { out } = await inBox({ fs: { read: [join(dir, "granted.txt")] } }, `cat ${join(dir, "granted.txt")}`)
        expect(out).toBe("readable")
    }, 30_000)

    it("a read-only grant refuses a write", async () => {
        // The shell's own redirect error goes to ITS stderr, which the
        // redirect cannot capture — so the probe reports the outcome instead.
        const { out } = await inBox(
            { fs: { read: [join(dir, "granted.txt")] } },
            `(echo x > ${join(dir, "granted.txt")}) 2>/dev/null && echo WROTE || echo REFUSED`,
        )
        expect(out).toBe("REFUSED")
    }, 30_000)

    it("a symlink cannot escape the box to an ungranted target", async () => {
        // The bypass a path-checking mediator misses and a mount namespace does
        // not: the link resolves inside the box, where the target is absent.
        const { out } = await inBox(
            { fs: { write: [dir] } },
            `ln -sf /etc/shadow ${dir}/escape 2>/dev/null; cat ${dir}/escape 2>&1 | head -1`,
        )
        expect(out).not.toContain("root:")
    }, 30_000)
})

boxed("the OS wall — environment", () => {
    it("a host variable does not cross into the box", async () => {
        // The box is --clearenv'd. Before that, every variable in the invoking
        // shell reached model code — so an fs policy denying `.env` on disk was
        // undone by the same secrets arriving as environment.
        const { out } = await inBox({}, `echo "[$AXON_WALL_SECRET]"`)
        expect(out).toBe("[]")
    }, 30_000)

    it("negative control: a granted variable IS present", async () => {
        const { out } = await inBox({}, `echo "[$AXON_WALL_SECRET]"`, { AXON_WALL_SECRET: "granted" })
        expect(out).toBe("[granted]")
    }, 30_000)

    it("keeps the runtime floor so the box can actually run", async () => {
        // Deny-by-default must not mean unbootable: PATH and HOME are wiring,
        // not grants, and are added by the builder rather than by policy.
        const { out } = await inBox({}, `echo "$PATH"`)
        expect(out).toContain("/usr/bin")
    }, 30_000)
})
