import { mkdirSync } from "node:fs"
import { join } from "node:path"

/**
 * Where a project's generated output lives.
 *
 * This stage owns one thing: the shape of the dot-directory every project
 * kind keeps its generated files in. It is deliberately the lowest layer in
 * `build/` — it imports nothing, so both `blueprint/` (whose tool scanner
 * caches into the frame) and `project/` (which writes almost everything else
 * there) can depend on it without either depending on the other. That
 * direction is the package's rule: blueprint uses neither of its siblings.
 *
 * `kinds.ts` made the frame's NAME data (`spec.dir` — ".agent", ".module",
 * …). This makes its INTERIOR data too, for the same reason: every generated
 * file needs a home that is decided once, not re-derived by whichever writer
 * happens to need it. Before this, twenty call sites built
 * `join(root, ".agent", …)` by hand and the frame was a flat pile — type
 * declarations, tool caches, a Dockerfile and a tarball all as siblings, with
 * nothing but a filename to say which was regenerable.
 *
 * That distinction is the whole point of the grouping:
 *
 *   types/   generated .d.ts + tsconfigs      — regenerable
 *   cache/   tool caches, module lock         — regenerable, disposable
 *   build/   Dockerfile, image.json, tarball  — regenerable
 *   cognet/  the compiled brain               — regenerable, but PINNED (see below)
 *   data/    sessions, state, sensory         — NOT regenerable. user history.
 *
 * Everything except `data/` can be deleted and rebuilt by `axon prepare`,
 * which is what makes the migration in `migrate.ts` safe to write as
 * delete-and-regenerate rather than a careful move.
 */
export const FRAME = {
    types: "types",
    cache: "cache",
    build: "build",
    cognet: "cognet",
    data: "data",
} as const

export type FrameArea = keyof typeof FRAME

/**
 * The set of project kinds — DEFINED here, and re-exported by `kinds.ts` as
 * `ProjectKind` for every existing caller.
 *
 * It lives at this layer because a kind's frame is the one thing every stage
 * needs to know about it. `kinds.ts` owns the kind TABLE (config filenames,
 * scaffolders, bundlers) and pulls in every scaffolder to build it, so
 * importing it from here would drag all of `project/` into `blueprint/` —
 * the exact dependency this stage exists to avoid. The union itself carries
 * no such weight, so it sits at the bottom where both sides can reach it.
 */
export type ProjectKind = "agent" | "module" | "cognet" | "bench" | "prompt" | "extension" | "profile"

/**
 * Frame directory names that are NOT the kind's own name dotted.
 *
 * A profile's frame is `.axon`, not `.profile`. The directory a user sees at
 * `~/.axon/profiles/<email>/` is the one place the product's own name means
 * something to them — it is their Axon folder, not an implementation detail of
 * a project kind they never chose. Every other kind derives (see below), and
 * this map exists so that stays true for all of them but one.
 */
const FRAME_DIRS: Partial<Record<ProjectKind, string>> = {
    profile: ".axon",
}

type FrameOpts = {
    root: string
    kind: ProjectKind
}

/**
 * Frame — where a project's generated output lives.
 *
 * One handle per project root, resolving every interior path. Callers ask for
 * an area and get a path; they never spell the frame directory or a
 * subfolder name themselves. A new area is a row in FRAME, not a new
 * `join()` at a call site.
 *
 * `ensure()` is separate from the path getters on purpose: reading a path is
 * free and side-effect-free (a bundler asking "where would this go" must not
 * create directories), while the writers that actually need the directory
 * call `ensure()` at the moment they write.
 */
export function Frame(opts: FrameOpts) {
    // The frame directory is the kind's own name, dotted — .agent, .module,
    // .cognet, .bench, .prompt. Derived rather than stored: `kinds.ts` used to
    // carry a `dir` field that repeated the kind name back, which is a second
    // copy of the same fact and therefore a thing that can drift. FRAME_DIRS
    // holds the one kind that cannot derive (profile → .axon).
    const name = FRAME_DIRS[opts.kind] ?? `.${opts.kind}`
    const dir = join(opts.root, name)

    function area(name: FrameArea): string {
        return join(dir, FRAME[name])
    }

    function ensure(name: FrameArea): string {
        const path = area(name)
        mkdirSync(path, { recursive: true })
        return path
    }

    return {
        /** The frame directory itself — `<root>/.agent`. */
        get dir() { return dir },

        /** The frame directory's name, with its leading dot — ".agent". */
        get name() { return name },

        /** Resolve an area's path without touching disk. */
        path: area,

        /** Resolve an area's path, creating it if absent. */
        ensure: ensure,

        /** A file inside an area, without touching disk. */
        file(name: FrameArea, filename: string): string {
            return join(area(name), filename)
        },
    }
}

export type FrameT = ReturnType<typeof Frame>

/**
 * The frame-relative path of the compiled brain, as it appears INSIDE a
 * published bundle.
 *
 * Pinned deliberately, and the one interior path that is not free to move:
 * `bundle/agent.ts` writes this exact string into the shipped
 * `manifest.json`, and a deployed container resolves the brain through it. A
 * layout change here does not break a rebuild — it breaks agents that are
 * already running in production, which no amount of re-preparing on this
 * machine can fix.
 *
 * It matches the local layout today (`.agent/cognet/`) and must keep
 * matching. If the local frame ever moves the brain, this stays put and the
 * bundle staging step becomes an explicit remap rather than a copy — see
 * `stageCognet()`.
 */
export const BUNDLE_COGNET_DIR = "cognet"
