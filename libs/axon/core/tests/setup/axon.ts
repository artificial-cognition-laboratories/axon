import { Axon as AxonRuntime } from "@axon/core"
import type { AxonPartialBlueprint, ProviderEntry } from "@arcforge/types"
import { KERNEL_ABI_VERSION } from "@arcforge/types"
import { TestCognet } from "./cognet"
import { Mock } from "@arcforge/engines"

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
/**
 * A hand-built driver, as a provider entry.
 *
 * Tests that exercise engine FAILURE build their own driver — one that
 * throws, stalls, or returns a scripted malformed reply — because the point
 * is the runtime's reaction to a bad engine rather than a bad model. The
 * provider layer resolves models from catalogues, which those doubles have
 * no business implementing, so this wraps one as a single-capability
 * provider: it supplies exactly itself, and resolution binds it.
 */
export function driver(def: { name?: string; create(res: never): unknown }): ProviderEntry {
    return {
        provider: def.name ?? "test",
        // Read back by the test harness's own buildProvider override below.
        // Not a field ProviderEntry declares, for the same reason Mock()'s
        // script is not: a test double carrying behaviour is what makes it a
        // double rather than a source of inference.
        driver: def,
    } as ProviderEntry & { driver: unknown }
}

export function Axon(opts?: TestAxonOpts) {
    const blueprint = opts?.blueprint ?? {}
    return AxonRuntime({
        ...opts,
        blueprint: {
            cognet: { name: "test", version: "1.0.0", abi: KERNEL_ABI_VERSION, definition: TestCognet() },
            ...blueprint,
            // Inference the harness supplies so a test need not.
            //
            // TestCognet declares a `main` role, and a role nothing can fill
            // refuses to boot — but most tests are about the capsule, the log
            // or the scheduler and have no opinion on inference.
            //
            // BOTH SIDES are declared. An absent profile means "never
            // configured" and defaults to the managed route, which for a test
            // means reaching the live Axon backend; naming Mock here keeps the
            // harness hermetic. Profile providers rank ahead of an agent's, so
            // the profile side is the one that decides.
            //
            // A test overrides either by passing its own. One exercising an
            // agent with NO inference passes
            // `blueprint: { profileProviders: [], config: { providers: [] } }`.
            // A test that declares its OWN agent providers gets an empty
            // profile side, so its declaration is the one that resolves —
            // profile providers rank first, and a default Mock there would
            // shadow the driver the test built to exercise a specific path.
            profileProviders: blueprint.profileProviders
                ?? (blueprint.config?.providers ? [] : [Mock()]),
            config: {
                providers: [Mock()],
                ...blueprint.config,
            },
        },
    })
}
