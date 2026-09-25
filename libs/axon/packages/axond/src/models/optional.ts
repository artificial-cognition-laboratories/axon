/**
 * Import a package the BUILD must not resolve.
 *
 * ── What this replaced, and why it was broken ───────────────────────────────
 *
 * The three model adapters each hid their optional dependency from the
 * bundler by splitting the specifier: `const s = "onnxruntime" + "-node"`,
 * then `import(s)`. That reads as opaque and is not — Bun's minifier folds
 * the concatenation back into a literal, and once it is a literal in a build
 * that marks the package `external`, Bun hoists the dynamic import into a
 * STATIC one at module scope:
 *
 *     import * as dWr from "onnxruntime-node"     // in axond-core.js
 *
 * So the dependency the adapters exist to work without became a hard
 * module-scope requirement of the daemon bundle. On glibc it merely loaded
 * ~300MB of native binaries nobody asked for; on Alpine/musl the addon cannot
 * be dlopen'd at all, and `axon daemon up` died before it started — with a
 * linker error, on a machine whose user had never touched a local model.
 * `.catch(() => null)` in the adapters could not help: a static import fails
 * before any of their code runs.
 *
 * ── Why `new Function` ──────────────────────────────────────────────────────
 *
 * It is the one form no bundler can see through: the specifier is a string
 * handed to a function compiled at runtime, so there is no import expression
 * in the module graph to fold, hoist or rewrite. That is the whole
 * requirement. The literal specifier can then be written plainly at the call
 * site, which is also what makes the intent readable — the previous trick
 * looked like a typo and was load-bearing.
 *
 * Resolution is relative to this file's location, exactly as a static import
 * would be, so an optional dependency installed beside the bundle resolves
 * normally.
 */
const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
) => Promise<unknown>

/**
 * Resolve an optional package at runtime, or reject.
 *
 * Callers own the absence: every adapter turns a rejection into `null` and
 * reports MODEL_RUNTIME_MISSING with the install command. This function does
 * NOT swallow the error — an adapter that cannot say why it has no runtime is
 * worse than one that crashes.
 */
export function optionalImport(specifier: string): Promise<unknown> {
    return dynamicImport(specifier)
}
