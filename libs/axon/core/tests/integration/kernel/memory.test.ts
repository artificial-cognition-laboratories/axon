import { Axon as AxonRuntime } from "@arcforge/core"
import { KERNEL_ABI_VERSION } from "@arcforge/types"
import type { KernelAbi } from "@arcforge/types"
import { defineCognet } from "@arcforge/cognet"
import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Long-term memory, through the live ABI — the only surface it exists on.
 * The kernel says where a database lives and nothing else, so that is all
 * these assert: a name becomes a place in the agent's own data, and anything
 * that is not a name is refused.
 */

function ProbeCognet(capture: (abi: KernelAbi) => void) {
    return defineCognet({
        name: "probe",
        version: "1.0.0",
        abi: KERNEL_ABI_VERSION,
        mode: { kind: "invocation" },
        load(abi) {
            capture(abi)
        },
        async wake() {},
    })
}

async function boot() {
    const root = await mkdtemp(path.join(tmpdir(), "axon-memory-"))
    const data = path.join(root, ".agent", "data")
    // A holder rather than a `let`: the probe fills it inside a callback,
    // which flow analysis cannot see.
    const captured: { abi?: KernelAbi } = {}
    const runtime = await AxonRuntime({
        blueprint: {
            cognet: { name: "probe", version: "1.0.0", abi: KERNEL_ABI_VERSION, definition: ProbeCognet(abi => { captured.abi = abi }) },
            knowledge: [],
            paths: { root: root, data: data },
        },
    })
    if (!captured.abi) throw new Error("probe cognet never received its ABI")
    return { runtime: runtime, memory: captured.abi.memory, data: data }
}

describe("kernel.memory", () => {
    test("a name is a database in the agent's own data, under the cognet's name", async () => {
        const { runtime, memory, data } = await boot()
        expect(memory.connect("long-term")).toEqual({ type: "sqlite", path: path.join(data, "memory", "probe", "long-term.db") })
        await runtime.shutdown()
    })

    test("anything that is not a name is refused", async () => {
        const { runtime, memory } = await boot()
        for (const bad of ["", "../escape", "a/b", "Upper", "dot.db", "with space", "-dash"]) {
            expect(() => memory.connect(bad)).toThrow(/not a database name/)
        }
        await runtime.shutdown()
    })
})
