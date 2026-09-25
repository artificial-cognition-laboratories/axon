import { describe, expect, it } from "bun:test"
import { Hardware } from "../../src/machine/hardware"
import { Identity } from "../../src/machine/identity"

/**
 * Constructing the machine layer must not run a subprocess.
 *
 * `Hardware()` and `Identity()` used to probe at construction — `nvidia-smi`
 * for video memory, `ioreg` for the macOS machine id. `Axond()` is built
 * in-process by the TUI and by every CLI command, so `axon --version` spawned a
 * GPU query to answer a question about a string.
 *
 * It was also the release blocker. A synchronous spawn from inside a bun test
 * worker can wedge — the child exits, the parent never resumes — and every
 * `apps/tui` test that touches the CLI constructs `Axond()`. That showed up on
 * the `axon` gate as an eleven-minute hang on a defunct `[nvidia-smi]`, green
 * on one run and hung on the next with no code change between them.
 *
 * These tests pin the property that fixes it: building the handle is free.
 */

/** Count subprocesses started while `body` runs, whatever spawns them. */
function spawnsDuring(body: () => void): number {
    const realSync = Bun.spawnSync
    const real = Bun.spawn
    let spawns = 0
    Bun.spawnSync = (...args: unknown[]) => { spawns++; return realSync(...(args as Parameters<typeof realSync>)) }
    Bun.spawn = (...args: unknown[]) => { spawns++; return real(...(args as Parameters<typeof real>)) }
    try {
        body()
    } finally {
        Bun.spawnSync = realSync
        Bun.spawn = real
    }
    return spawns
}

describe("machine probes are lazy", () => {
    it("constructing Hardware() spawns nothing", () => {
        expect(spawnsDuring(() => { Hardware() })).toBe(0)
    })

    it("constructing Identity() spawns nothing", () => {
        expect(spawnsDuring(() => { Identity() })).toBe(0)
    })

    /**
     * The value must still be read AT MOST once. Laziness that re-probed per
     * call would put a subprocess on the path of every status query, which is
     * the cost the original eager read existed to avoid.
     */
    it("Hardware().current() probes once and caches", () => {
        const hardware = Hardware()
        const first = hardware.current()
        const again = spawnsDuring(() => { hardware.current() })
        expect(again).toBe(0)
        expect(hardware.current()).toBe(first)
    })

    it("Identity().current() reads the id once and caches", () => {
        const identity = Identity()
        const first = identity.current().id
        const again = spawnsDuring(() => { identity.current() })
        expect(again).toBe(0)
        expect(identity.current().id).toBe(first)
    })

    /** Still answers correctly — laziness must not change what is reported. */
    it("still reports real capacity when asked", () => {
        const capacity = Hardware().current()
        expect(capacity.cores).toBeGreaterThan(0)
        expect(capacity.ram).toBeGreaterThan(0)
    })
})
