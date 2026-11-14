// A generated entry, written by hand (see ../fixture/entry.ts): more lagged
// worker systems than workers. `sense` writes a reading every tick; `left`
// and `right`, each on a worker with `lag: 2`, take it — on a pool of one.
import { CognetHost } from "../../../../src/host"
import { Discovered } from "../../../../src/discovered"
import { component, type EcsT } from "../../../../src/ecs"
import { clock, defineSystem } from "../../../../src/schedule"

const ecs = () => (globalThis as unknown as { ecs: EcsT }).ecs

const reading = component<number>()
const left = component<number>()
const right = component<number>()

let count = 0

const sense = defineSystem({
    on: [clock],
    writes: [reading],
    run() {
        count += 1
        ecs().component.set("self", reading, count)
    },
})

/** A lagged worker system that keeps the last reading it was given. */
function keeper(into: typeof left) {
    return defineSystem({
        thread: "worker",
        lag: 2,
        reads: [reading],
        writes: [into],
        run() {
            ecs().component.set("self", into, ecs().component.get("self", reading) ?? 0)
        },
    })
}

const discovered = Discovered({
    definitions: [{ file: "components.ts", module: { reading: reading, left: left, right: right }, names: ["reading", "left", "right"] }],
    systems: [
        { file: "sense.system.ts", module: { default: sense } },
        { file: "left.system.ts", module: { default: keeper(left) } },
        { file: "right.system.ts", module: { default: keeper(right) } },
    ],
})

export default CognetHost(
    { name: "crowded", version: "1.0.0", abi: "4", mode: { kind: "continuous", hz: 1 }, threads: 1, systems: discovered.systems },
    async () => {},
)
