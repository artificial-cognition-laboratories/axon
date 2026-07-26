import type { CognetDefinition } from "@arcforge/types"

/**
 * The cognet authoring surface. Cognet projects (cognets/*) call this in
 * their main.ts; the CLI bundle gets it as an injected global — the
 * desugared form and the global form compile to the same thing, so there
 * is never a side channel around the ABI.
 */
export function defineCognet(definition: CognetDefinition): CognetDefinition {
    return definition
}
