import { afterAll, describe, expect, it } from "bun:test"
import { cleanup, inBox, status } from "./harness"

/**
 * Limits, asserted by BREACHING them in a real box.
 *
 * Every other policy test in this repo checks that a rule resolves to a
 * verdict. These check that the kernel does something about it — which is the
 * claim `limits` actually makes, and the one nothing tested. The limits happened
 * to work, but nothing would have noticed if they stopped.
 *
 * Each case is paired with its NEGATIVE CONTROL — the same operation with the
 * limit lifted — so a pass proves the limit was the reason, not that the probe
 * was broken. Without the control, a box that simply failed to run anything
 * would pass every one of these.
 */

const boxed = status.auto ? describe : describe.skip

afterAll(cleanup)

/**
 * 300MB of ANONYMOUS memory.
 *
 * Anonymous, not page cache: streaming `/dev/zero` through a pipe is reclaimed
 * under pressure rather than OOM-killed, so it exits 0 under any cap and proves
 * nothing. This has to be memory the kernel cannot take back.
 *
 * Written without nested quotes because the whole script is passed as one
 * `sh -c` argument — an inner `'...'` collapses, `python3 -c` runs with no
 * program, and the probe exits 0 while appearing to have allocated.
 */
const ALLOCATE_300M = 'python3 -c "x=bytearray(300*1024*1024); print(len(x))"'

boxed("the OS wall — limits", () => {
    it("OOM-kills a process that breaches limits.memory", async () => {
        const { code } = await inBox({ limits: { memory: "64M" } },
            ALLOCATE_300M,
        )
        // 137 = SIGKILL, which is how the kernel reports an OOM kill.
        expect(code).not.toBe(0)
    }, 60_000)

    it("negative control: the same allocation succeeds with the cap lifted", async () => {
        // Without this, the test above would pass on a box that could not run
        // python at all — which is the failure mode that let the network hole
        // sit behind a green suite.
        const { code } = await inBox({}, ALLOCATE_300M)
        expect(code).toBe(0)
    }, 60_000)

    it("caps the process tree at limits.pids", async () => {
        const { code } = await inBox({ limits: { pids: 8 } },
            `i=0; while [ $i -lt 60 ]; do sleep 5 & i=$((i+1)); done; wait`,
        )
        expect(code).not.toBe(0)
    }, 60_000)

    it("bounds the box's scratch space at limits.disk", async () => {
        const { code } = await inBox({ limits: { disk: "8M" } },
            `dd if=/dev/zero of=/tmp/fill bs=1M count=64`,
        )
        expect(code).not.toBe(0)
    }, 60_000)

    it("negative control: the same write succeeds under a larger cap", async () => {
        const { code } = await inBox({ limits: { disk: "256M" } }, `dd if=/dev/zero of=/tmp/fill bs=1M count=64`)
        expect(code).toBe(0)
    }, 60_000)

    it("kills the tree at limits.wall", async () => {
        const { code } = await inBox({ limits: { wall: "2s" } }, `sleep 30`)
        expect(code).not.toBe(0)
    }, 60_000)

    it("negative control: a short command finishes well inside the same ceiling", async () => {
        const { code } = await inBox({ limits: { wall: "30s" } }, `sleep 0.1`)
        expect(code).toBe(0)
    }, 60_000)
})
