import { Axon as AxonRuntime } from "@axon/core"
import type { AxonPartialBlueprint } from "@arcforge/types"
import { KERNEL_ABI_VERSION } from "@arcforge/types"
import { TestCognet } from "./cognet"

type TestAxonOpts = {
    blueprint?: AxonPartialBlueprint
    cwd?: string
}

/**
 * Test entry point — injects the TestCognet the way the CLI injects a
 * bundled cognets/* package. The runtime itself ships no brain and a
 * blueprint without one refuses to normalize, so every test boots through
 * here (or supplies its own definition explicitly).
 */
export function Axon(opts?: TestAxonOpts) {
    const blueprint = opts?.blueprint ?? {}
    return AxonRuntime({
        ...opts,
        blueprint: {
            cognet: { name: "test", version: "1.0.0", abi: KERNEL_ABI_VERSION, definition: TestCognet() },
            ...blueprint,
        },
    })
}
