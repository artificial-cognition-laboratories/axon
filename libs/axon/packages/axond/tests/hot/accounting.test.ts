import { describe, expect, test } from "bun:test"
import { Accounting, Attribution } from "../../src/machine"

/**
 * Accounting against real processes: a part is a root and everything it
 * started, its CPU a rate (unknown until a second reading), its memory what
 * the kernel says it holds — and, one level down, every thread.
 */

/** No driver on this path: the GPU is unmeasured, never zero. */
const NO_GPU = Attribution({ command: ["/nonexistent/nvidia-smi"] })

/**
 * A pmon stand-in: one sample every 50ms. Process 111 is busy 60% in every
 * sample; 222 is listed with "-" (nothing) in every other one and 40% in the rest.
 */
function feed(): string[] {
    const script = [
        "i=0",
        "while :; do",
        "  echo '# gpu pid type sm mem enc dec jpg ofa fb ccpm command'",
        "  echo '    0  111  C  60  1  -  -  -  -  512  0  model'",
        "  if [ $((i % 2)) -eq 0 ]; then echo '    0  222  G  40  -  -  -  -  -  64  0  game'; else echo '    0  222  G  -  -  -  -  -  -  64  0  game'; fi",
        "  i=$((i+1)); sleep 0.05",
        "done",
    ].join("\n")
    return ["timeout", "3", "sh", "-c", script]
}

describe("accounting", () => {
    test("counts a root and its descendants, and measures CPU as a rate", async () => {
        // A shell that starts a busy child: the part must include the child.
        // Bounded by `timeout`, so a failed assertion can never leave it spinning.
        const shell = Bun.spawn(["sh", "-c", "timeout 1 sh -c 'while :; do :; done' & wait"])
        await Bun.sleep(100)
        const accounting = Accounting({ attribution: NO_GPU })
        const first = accounting.measure({ busy: { roots: [shell.pid], shared: false } })
        expect(first.busy!.processes).toBeGreaterThanOrEqual(2)
        expect(first.busy!.cpu).toBeNull()
        expect(first.busy!.ram).toBeGreaterThan(0)
        expect(first.busy!.gpu).toBeNull()

        await Bun.sleep(400)
        const second = accounting.measure({ busy: { roots: [shell.pid], shared: false } })
        expect(second.busy!.cpu).toBeGreaterThan(0.5)
        expect(second.busy!.cpu).toBeLessThan(1.5)
        await shell.exited
    })

    test("says a part with nothing running costs nothing, and carries sharing through", () => {
        const empty = Accounting({ attribution: NO_GPU }).measure({ world: { roots: [], shared: true } })
        expect(empty.world).toMatchObject({ cpu: 0, ram: 0, processes: 0, shared: true })
    })

    test("measures every thread, by name, as a rate", async () => {
        const accounting = Accounting({ attribution: NO_GPU })
        const first = accounting.threads([process.pid])
        const main = first.find(thread => thread.tid === process.pid)
        expect(main).toBeDefined()
        expect(main!.cpu).toBeNull()
        const end = performance.now() + 150
        while (performance.now() < end) { /* busy on the main thread */ }
        const second = accounting.threads([process.pid])
        expect(second.find(thread => thread.tid === process.pid)!.cpu).toBeGreaterThan(0.3)
        expect(second.every(thread => thread.pid === process.pid && thread.name.length > 0)).toBe(true)
    })
})

describe("attribution — GPU per process, averaged", () => {
    test("averages each process over the samples in a reader's window, not the instant", async () => {
        const attribution = Attribution({ command: feed() })
        try {
            const start = Date.now()
            expect(attribution.since(start)).toBeNull()
            await Bun.sleep(600)
            const window = attribution.since(start)!
            expect(window.get(111)!.busy).toBeCloseTo(60, 0)
            // Busy in half the samples: half its busy, not 0 and not 40.
            expect(window.get(222)!.busy).toBeGreaterThan(14)
            expect(window.get(222)!.busy).toBeLessThan(26)
            expect(window.get(111)!.memory).toBe(512 * 1024 * 1024)
        } finally {
            attribution.stop()
        }
    })

    test("is unmeasured, not zero, without a driver", () => {
        expect(NO_GPU.since(0)).toBeNull()
    })
})
