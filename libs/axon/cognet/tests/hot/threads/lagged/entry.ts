// A generated entry, written by hand (see ../fixture/entry.ts): a mind whose
// heavy system runs over its ticks rather than inside them. `sense` writes a
// reading every tick; `integrate`, on a worker with `lag: 2`, adds up every
// reading since it last ran — longer than a tick's work — and `look` says,
// every tick, what it believes the total is.
import { CognetHost } from "../../../../src/host"
import { Discovered } from "../../../../src/discovered"
import { component, type EcsT } from "../../../../src/ecs"
import { clock, defineSystem } from "../../../../src/schedule"

const ecs = () => (globalThis as unknown as { ecs: EcsT }).ecs

/** One reading a tick: the tick's own count. Equal readings in a row still count — so it is sometimes the same. */
const reading = component<number>()
/** Every reading added up, as far as `integrate` has got. */
const total = component<number>()
/** What `look` believed the total was, tick by tick. */
const seen = component<number[]>()

/** Burn the time a heavy system would. */
function spin(ms: number): void {
    const end = performance.now() + ms
    while (performance.now() < end) { /* working */ }
}

let count = 0

const sense = defineSystem({
    on: [clock],
    writes: [reading],
    run() {
        count += 1
        // Ticks 3 and 4 read the same — a write that changes nothing is still a reading.
        ecs().component.set("self", reading, count === 4 ? 3 : count)
    },
})

const integrate = defineSystem({
    thread: "worker",
    lag: 2,
    streams: [reading],
    recalls: [total],
    writes: [total],
    run({ since }) {
        spin(80)
        const before = ecs().component.get("self", total) ?? 0
        ecs().component.set("self", total, before + since(reading).reduce((sum, one) => sum + one.value, 0))
    },
})

const look = defineSystem({
    on: [clock],
    recalls: [total, seen],
    writes: [seen],
    run() {
        const so = ecs().component.get("self", seen) ?? []
        ecs().component.set("self", seen, [...so, ecs().component.get("self", total) ?? 0])
    },
})

const discovered = Discovered({
    definitions: [{ file: "components.ts", module: { reading: reading, total: total, seen: seen }, names: ["reading", "total", "seen"] }],
    systems: [
        { file: "sense.system.ts", module: { default: sense } },
        { file: "integrate.system.ts", module: { default: integrate } },
        { file: "look.system.ts", module: { default: look } },
    ],
})

export default CognetHost(
    // Continuous, as a mind with lagged systems is; the test wakes it itself, a tick a wake. Its own clock asks the
    // test's kernel for a wake once a second, is refused — the kernel here has none to give — and stops.
    { name: "lagged", version: "1.0.0", abi: "4", mode: { kind: "continuous", hz: 1 }, threads: 1, systems: discovered.systems },
    async () => {},
)
