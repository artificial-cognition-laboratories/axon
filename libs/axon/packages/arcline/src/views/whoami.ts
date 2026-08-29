/**
 * whoami — the identity this machine is using.
 *
 *     Account:  cody@hexlabs.co.uk
 *     Scope:    @cody
 *     Member:   since March 2025
 *
 * No header and no ✓: nothing happened, so there is nothing to report having
 * done. The block IS the answer, which is the same shape `prepare` settles to
 * when it has nothing to say — a quiet command reads as quiet.
 *
 * The identity block is shared with `login`; see views/identity.ts for why the
 * scope is the field that matters.
 */

import { identity, type Identity } from "./identity.ts"
import type { RendererHandle } from "../core/index.ts"

export type WhoamiOpts = Identity

export function whoami(r: RendererHandle, who: WhoamiOpts): string {
    // Hinted here, unlike in login: this block is the whole answer, so if
    // publishing is blocked this is the only place saying so.
    return identity(r, who, { hintMissingScope: true }).join("\n")
}
