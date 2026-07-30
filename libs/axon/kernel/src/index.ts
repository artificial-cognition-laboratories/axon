// @arcforge/kernel — ring 0.
//
// Owns the machine's resources and the execution of everything an agent asks
// for. The ONLY constructor of the unprivileged capsule, and the one place
// policy is enforced. Knows nothing about cognition: it hands the cognet a
// syscall table (KernelAbi, in @arcforge/types) and never learns what the
// model sees or how the brain thinks.
//
// Its collaborators — the event bus and the loaded cognet — arrive through
// opts as structural contracts (./contracts), never as imports from the
// composition root that builds them. That is what keeps ring 0 free of any
// dependency on the layer above it.
export { Kernel, type AxonKernelT } from "./kernel"
export type { KernelBus, KernelCognet } from "./contracts"

// The capsule's executable surface, and its rendering as TypeScript
// declarations — the kernel reports executable reality, callers decide how it
// enters model context.
export { toScope, toScopeModule, isLoadable } from "./scope"
export { scopeToDts, scopeMemberCount } from "./scope-dts"
