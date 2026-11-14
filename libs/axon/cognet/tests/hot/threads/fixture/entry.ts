// A generated entry, written by hand: the host first, then the definitions
// and systems, then the composition. The test BUNDLES this, exactly as the
// compile step does, so the host's `import.meta.url` is the bundle and its
// workers load the same brain.
import { CognetHost } from "../../../../src/host"
import { Discovered } from "../../../../src/discovered"
import { component, type EcsT } from "../../../../src/ecs"
import { clock, defineSystem } from "../../../../src/schedule"

const ecs = () => (globalThis as unknown as { ecs: EcsT }).ecs

/** What sense saw, big enough that copying it is real — and recorded as a digest. */
const frame = component<{ n: number; pixels: Float32Array }>()
/** A running total `left` keeps for itself — recalled, so it stays on the worker that holds it. */
const total = component<number>()
const left = component<number>()
const right = component<number>()
const joined = component<number>()

/** Burn the time a heavy system would, so overlap is measurable. */
function spin(ms: number): void {
    const end = performance.now() + ms
    while (performance.now() < end) { /* working */ }
}

let seen = 0

const sense = defineSystem({
    on: [clock],
    writes: [frame],
    run() {
        seen += 1
        ecs().component.set("self", frame, { n: seen, pixels: new Float32Array(50_000).fill(seen) })
    },
})

const measureLeft = defineSystem({
    thread: "worker",
    reads: [frame],
    recalls: [total],
    writes: [left, total],
    run() {
        spin(60)
        const seen = ecs().component.get("self", frame)!
        let sum = 0
        for (const value of seen.pixels) sum += value
        const kept = (ecs().component.get("self", total) ?? 0) + seen.n
        ecs().component.set("self", total, kept)
        ecs().component.set("self", left, sum + kept)
    },
})

const measureRight = defineSystem({
    thread: "worker",
    reads: [frame],
    writes: [right],
    run() {
        spin(60)
        const seen = ecs().component.get("self", frame)!
        if (seen.n === 3) throw new Error("right refuses frame 3")
        ecs().component.set("self", right, seen.n * 2)
    },
})

const join = defineSystem({
    reads: [left, right],
    writes: [joined],
    run() {
        ecs().component.set("self", joined, ecs().component.get("self", left)! + ecs().component.get("self", right)!)
    },
})

const discovered = Discovered({
    definitions: [{ file: "components.ts", module: { frame: frame, total: total, left: left, right: right, joined: joined }, names: ["frame", "total", "left", "right", "joined"] }],
    systems: [
        { file: "sense.system.ts", module: { default: sense } },
        { file: "measure/left.system.ts", module: { default: measureLeft } },
        { file: "measure/right.system.ts", module: { default: measureRight } },
        { file: "join.system.ts", module: { default: join } },
    ],
})

export default CognetHost(
    { name: "threads", version: "1.0.0", abi: "4", mode: { kind: "invocation" }, threads: 2, systems: discovered.systems },
    async () => {},
)
