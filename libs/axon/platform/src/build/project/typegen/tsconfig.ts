import { join } from "node:path"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { err } from "@arcforge/err"
import { Tree } from "../tree"
import { Frame, FRAME } from "../../frame"
import { INLINE_COGNET_DIR, inlineCognetDir } from "../../blueprint/cognet"
import { COGNET_GLOBALS } from "./cognet-dts"
import { KINDS, type ProjectKind } from "../kinds"

// ── Compiler options ──────────────────────────────────────────────────────────
//
// Agent/module/cognet projects get their compiler options by `extends`-ing
// @arcforge/types/tsconfig.base.json — a real published file resolved through
// the project's own node_modules. There is no machine-local path resolution:
// the project declares @arcforge/types + @arcforge/engines as dependencies and
// `bun install` puts them on disk, so `@arcforge/types` and `import("h3")`
// resolve the ordinary way. `axon prepare` only writes .agent/ codegen (the
// .d.ts + a thin extends-only tsconfig) — it never resolves framework paths.

const TSCONFIG_BASE = "@arcforge/types/tsconfig.base.json"

// ── Tsconfig shapes ───────────────────────────────────────────────────────────

// The per-kind `include` globs live in the kind table — see kinds.ts. The one
// scope that is NOT a kind is an agent's tests/ directory: it gets its own
// tsconfig specifically so it never sees axon.d.ts's `Axon` (the engine
// constructor) alongside axon-test.d.ts's `Axon` (the test runtime spawner) in
// one ambient scope — see axon-dts.ts's file-level comment. Both configs glob
// `*.d.ts` (so tool-globals.d.ts/prompts.d.ts/etc are picked up automatically)
// but `exclude` carves out the one file belonging to the OTHER scope.
//
// Root-relative, like the kind table's globs, and rebased by the same helper.
const TESTS_INCLUDE = [
    "./**/*.d.ts",
    "tests/**/*.ts",
]

// The scope of an agent's inline `cognet/`.
//
// The WHOLE folder, not a list of the subdirectories a standalone cognet
// happens to use. Everything under `cognet/` is brain source by definition —
// the directory exists for exactly one purpose — so enumerating `src/` and
// `plugins/` only means a brain written as a flat `cognet/main.ts` gets no
// globals and reads as broken. The compiler accepts either layout (see
// resolveCognetMain), and the editor must agree with the compiler.
const INLINE_COGNET_INCLUDE = [
    "./**/*.d.ts",
    `${INLINE_COGNET_DIR}/**/*.ts`,
]

/**
 * Rewrite a root-relative glob so it resolves from the generated tsconfig,
 * which sits at `.<dir>/types/` — two levels below the project root.
 *
 * `./`-prefixed globs are left alone: they deliberately name the .d.ts files
 * generated beside the tsconfig itself, so they are already correct wherever
 * that file lands. Everything else gets the prefix, computed from the frame
 * depth rather than hard-coded, so moving the interior another level down is
 * a change to one constant instead of thirty strings in kinds.ts.
 */
const FRAME_DEPTH = 2
const UP = "../".repeat(FRAME_DEPTH)

function rebase(globs: string[]): string[] {
    return globs.map(glob => (glob.startsWith("./") ? glob : `${UP}${glob}`))
}

// ── Dependency guard ──────────────────────────────────────────────────────────

/**
 * The generated tsconfigs `extends` @arcforge/types/tsconfig.base.json and the
 * generated .d.ts references @arcforge/types / @arcforge/engines / h3 — all of
 * which must be installed in the project's node_modules for types to resolve.
 * If they aren't, fail loud with the fix, rather than writing a config that
 * silently degrades every framework symbol to `any`.
 *
 * `Tree.frameworkInstalled` walks the directory tree for
 * node_modules/@arcforge/types on disk — the same check, and the same leaf,
 * prepare uses to decide whether to install. Reading disk rather than resolving
 * avoids two failure modes bun's resolver has: a per-process resolution cache
 * (a miss cached BEFORE prepare's install wrongly persisting after it) and
 * resolution through the global install cache (a hit for a project whose
 * node_modules is empty).
 */
function assertFrameworkInstalled(projectRoot: string): void {
    if (Tree({ root: projectRoot }).frameworkInstalled()) return
    throw err("FRAMEWORK_NOT_INSTALLED", {
        detail: `@arcforge/types cannot be resolved from ${projectRoot} — `
            + "run `bun install` in the project before `axon prepare`.",
        context: { root: projectRoot },
    })
}

// ── Writers ───────────────────────────────────────────────────────────────────

/**
 * The frame of a kind that installs nothing.
 *
 * Everything else `extends` @arcforge/types/tsconfig.base.json out of the
 * project's node_modules. A prompt package has no node_modules by design, so
 * that path resolves to nothing and every symbol silently degrades to `any` —
 * the exact failure assertFrameworkInstalled() exists to prevent elsewhere.
 * These options are therefore stated inline: modern, strict, and checking
 * nothing but the config file's own call.
 */
function writeStandaloneFrame(root: string, kind: ProjectKind, include: string[]): void {
    const frame = Frame({ root: root, kind: kind })
    const typesDir = frame.ensure("types")

    writeFileSync(
        join(typesDir, "tsconfig.json"),
        JSON.stringify({
            compilerOptions: {
                target: "ESNext",
                module: "ESNext",
                moduleResolution: "bundler",
                strict: true,
                skipLibCheck: true,
                noEmit: true,
                // Deliberately NOT ["bun"], unlike the published base config
                // this kind cannot extend: a prompt package installs nothing,
                // so naming a @types package here would reference something
                // provably absent from disk and degrade every symbol to `any`.
                types: [],
            },
            include: rebase(include),
        }, null, 2) + "\n",
        "utf-8"
    )

    ensureRootPointer(join(root, "tsconfig.json"), `./${frame.name}/${FRAME.types}/tsconfig.json`)
}

/** Write a thin extends-only root tsconfig if one isn't already correctly pointed. */
function ensureRootPointer(rootPath: string, extendsTarget: string): void {
    let needsWrite = !existsSync(rootPath)
    if (!needsWrite) {
        try {
            const existing = JSON.parse(readFileSync(rootPath, "utf-8"))
            if (existing.include || existing.extends !== extendsTarget) needsWrite = true
        } catch {
            needsWrite = true
        }
    }
    if (needsWrite) {
        writeFileSync(rootPath, JSON.stringify({ extends: extendsTarget }, null, 2) + "\n", "utf-8")
    }
}

/**
 * Write a project's frame tsconfig and the thin root pointer into it.
 *
 * One writer for every kind: the frame directory and its `include` globs come
 * from the kind table, and an agent's tests/ scope is the single genuine
 * addition on top. This used to be three near-identical functions that had to
 * be kept in step by hand.
 */
export function ensureProjectTsConfig(root: string, kind: ProjectKind): void {
    const spec = KINDS[kind]
    if (!spec.frame) return

    // A kind that installs nothing has no node_modules to resolve through,
    // so its frame must stand alone — it neither extends the published base
    // config nor references a framework package. Guarding on `installs`
    // rather than naming the kind keeps the rule where the reason is.
    if (!spec.installs) {
        writeStandaloneFrame(root, kind, spec.include)
        return
    }

    assertFrameworkInstalled(root)

    const frame = Frame({ root: root, kind: kind })
    const typesDir = frame.ensure("types")
    const inlineCognet = kind === "agent" ? inlineCognetDir(root) : null

    // Agents carve out tests/ — and cognet/ when one is inlined — each of
    // which lives in a sibling config below. Every other kind has one scope.
    //
    // The exclusions are the load-bearing half: three ambient surfaces share
    // this one directory, and a scope that can see another's declarations gets
    // `Axon` (engine constructor) and `Axon` (test spawner), or the agent's
    // globals alongside the cognet's, in the same lexical space.
    const exclude = kind === "agent"
        ? {
            exclude: [
                `${UP}tests/**`,
                "./axon-test.d.ts",
                ...(inlineCognet ? [`${UP}${INLINE_COGNET_DIR}/**`, `./${COGNET_GLOBALS}`] : []),
            ],
        }
        : {}

    writeFileSync(
        join(typesDir, "tsconfig.json"),
        JSON.stringify({ extends: TSCONFIG_BASE, include: rebase(spec.include), ...exclude }, null, 2) + "\n",
        "utf-8"
    )

    if (kind === "agent") {
        // tests/ scope — the flip side: sees axon-test.d.ts, never axon.d.ts.
        writeFileSync(
            join(typesDir, "axon-test.tsconfig.json"),
            JSON.stringify({ extends: TSCONFIG_BASE, include: rebase(TESTS_INCLUDE), exclude: ["./axon.d.ts"] }, null, 2) + "\n",
            "utf-8"
        )

        const testsDir = join(root, "tests")
        if (!existsSync(testsDir)) mkdirSync(testsDir, { recursive: true })
        ensureRootPointer(
            join(testsDir, "tsconfig.json"),
            `../${frame.name}/${FRAME.types}/axon-test.tsconfig.json`,
        )
    }

    // The inline cognet's own scope: the brain-authoring globals (loop,
    // kernel, phase, system, defineCognet) and NOTHING the agent declares.
    // Written only when the folder exists, so an agent without one carries no
    // config pointing at an empty directory.
    if (inlineCognet) {
        writeFileSync(
            join(typesDir, "cognet.tsconfig.json"),
            JSON.stringify({
                extends: TSCONFIG_BASE,
                include: rebase(INLINE_COGNET_INCLUDE),
                // Everything generated for the AGENT. Listed by name rather
                // than by a glob, because `./**/*.d.ts` in the include above is
                // what picks up the cognet's own declarations — an exclusion
                // broad enough to catch the agent's would catch those too.
                exclude: ["./axon.d.ts", "./axon-test.d.ts", "./tool-globals.d.ts",
                    "./prompts.d.ts", "./scripts.d.ts", "./components.d.ts",
                    "./env.d.ts", "./hooks.d.ts"],
            }, null, 2) + "\n",
            "utf-8"
        )
        ensureRootPointer(
            join(inlineCognet, "tsconfig.json"),
            `../${frame.name}/${FRAME.types}/cognet.tsconfig.json`,
        )
    }

    ensureRootPointer(join(root, "tsconfig.json"), `./${frame.name}/${FRAME.types}/tsconfig.json`)
}
