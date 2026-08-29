import type { FrameworkSet, FrameworkSource } from "./manifest/package"
import { basename, dirname, join } from "node:path"
import { fsx } from "../../utils/fs"
import { INLINE_COGNET_DIR } from "../blueprint/cognet"
import { scaffoldAgent } from "./create/agent"
import { scaffoldBench } from "./create/bench"
import { scaffoldCognet } from "./create/cognet"
import { scaffoldModule } from "./create/module"
import { scaffoldPrompt } from "./create/prompt"
import { scaffoldExtension } from "./create/extension"
import { scaffoldProfile } from "./create/profile"

// The kind union and the frame layout are defined one stage down, in
// build/frame — the lowest layer, which imports nothing so that blueprint/
// and project/ can both read it without depending on each other. Re-exported
// here because `kinds.ts` is where callers already look for anything
// kind-shaped.
export type { ProjectKind } from "../frame"
export { Frame, FRAME, type FrameT, type FrameArea } from "../frame"

import type { ProjectKind as Kind } from "../frame"

/** What a scaffolder receives. Every kind takes the same input. */
export type ScaffoldOpts = {
    name: string
    dir: string
    /** Pinned into the manifest by kinds that declare framework deps at scaffold time. */
    frameworkVersion: string
    frameworkSource?: FrameworkSource
    repoRoot?: string
    /** Registry URL baked into an agent's bunfig.toml. Agents only; ignored elsewhere. */
    apiBase?: string
}

/**
 * How one project kind differs from the others — and nothing else.
 *
 * Every per-kind decision in this package reads a field here. That is the
 * point: a kind used to be an `if` repeated across projects.ts, prepare.ts,
 * publish.ts, typegen/index.ts, generators.ts and tsconfig.ts, and cognet
 * proved what happens when six branches must agree and one is forgotten —
 * `axon cognet init` wrote its type frame before anything was installed and
 * crashed on its own assert.
 *
 * Adding a sixth kind is adding a row. If something about a kind cannot be
 * expressed as a field, that is the signal to widen the table rather than to
 * reintroduce a branch somewhere.
 */
export type KindSpec = {
    /** The file whose presence on disk identifies this kind. */
    config: string

    /**
     * tsconfig `include` globs, written relative to the PROJECT ROOT.
     *
     * The generated tsconfig lives at `.<dir>/types/tsconfig.json`, two levels
     * down, so these are rebased by the writer rather than authored with the
     * right number of `../` segments here. Stating them from the root is both
     * what a reader expects and what stops the table from breaking if the
     * frame's interior ever gains another level: the depth is computed in one
     * place (see `rebase()` in typegen/tsconfig.ts), not spelled 30 times.
     *
     * `./**` paths are the exception and stay frame-relative — they name the
     * generated .d.ts files sitting beside the tsconfig itself.
     *
     * Empty when the kind has no frame.
     */
    include: string[]

    /**
     * Which ambient declaration file the frame carries. "axon" is the
     * framework globals every agent-shaped project sees; "cognet" is the
     * narrower authoring surface (loop, kernel, phase, system); "prompt" is
     * the narrowest of all — definePrompt and nothing else; "tui" is the
     * extension surface (tui, palette, commands, keys, mode, input, agents),
     * shared by a profile and the extensions it loads.
     */
    globals: "axon" | "cognet" | "prompt" | "tui" | "none"

    /**
     * Whether prepare() writes a type frame for this kind.
     *
     * Every kind has one today, because every kind has at least one ambient
     * global to declare — even a prompt package, whose whole authoring
     * surface is definePrompt().
     */
    frame: boolean

    /**
     * Whether prepare() installs dependencies before writing the frame.
     *
     * False for prompt packages: a prompt is text and declares nothing, so
     * there is no node_modules to create. Its frame is self-contained
     * precisely so that stays true — see prompt-dts.ts.
     *
     * Split from `frame` because the two stopped coinciding: a prompt needs
     * declarations without an install, and folding both into one flag meant
     * "no dependencies" silently bought "no types" as well.
     */
    installs: boolean

    /**
     * WHICH framework packages this kind declares. Only meaningful when
     * `installs` is true.
     *
     * "all" is the agent set — engines, the cognet host, the AIR grammar, h3.
     * "types" is @arcforge/types alone, which is all a profile or an extension
     * needs: they configure the terminal rather than run an agent, and their
     * only requirement is that `tsconfig.base.json` and the Bun globals
     * resolve. Declaring the full set for them is not just noise — under
     * `file:` linking it changed how the tree hoisted and @types/bun stopped
     * resolving, silently degrading every symbol in a user's plugin to any.
     */
    framework: FrameworkSet

    /**
     * How publish() packages it. "source" ships the project's own files for
     * the consumer to build; agent and module are pre-built images.
     */
    bundle: "agent" | "module" | "source"

    /**
     * Whether the registry accepts this kind.
     *
     * Backed by a Postgres enum (`registry_artifact_kind`), so this is not a
     * preference — a kind the backend has never heard of is rejected at the
     * API, and adding one is a migration. Every kind is publishable except a
     * PROFILE, which never can be: it holds one person's credentials, history
     * and agents.
     *
     * Stated here rather than as a union in publish.ts so the fact lives with
     * every other per-kind fact, and so a kind that becomes publishable is one
     * field plus a migration.
     */
    publishable: boolean

    /**
     * Extra tarball entries this kind contributes beyond the common set
     * (config file, package.json, src/, plugins/, README.md), resolved against
     * the project root at bundle time.
     *
     * Exists so the source bundler carries no per-kind branch: a prompt pack
     * keeps its prompts at the TOP LEVEL — the folder IS the pack, and every
     * .vue/.md in it is an invokable unit — which is a fact about prompts, so
     * it is stated here with the rest of them rather than as an `if` inside
     * the bundler.
     */
    files?: (root: string) => Promise<string[]>

    /** Visibility a freshly-scaffolded project publishes at. */
    public: boolean

    /**
     * Write the project's source files and return its root.
     *
     * Scaffolders write only what the USER owns. Generated frames belong to
     * prepare() — which runs after install, the only point at which writing
     * them can succeed.
     */
    scaffold: (opts: ScaffoldOpts) => Promise<string>
}

export const KINDS: Record<Kind, KindSpec> = {
    agent: {
        config: "axon.config.ts",
        include: [
            "axon.config.ts",
            "./**/*.d.ts",
            "src/**/*.ts",
            "src/**/*.vue",
            "scripts/**/*.ts",
            "server/**/*.ts",
            "modules/**/*.ts",
            "modules/**/*.vue",
        ],
        globals: "axon",
        frame: true,
        framework: "all",
        installs: true,
        bundle: "agent",
        publishable: true,
        public: false,
        scaffold: scaffoldAgent,
    },

    module: {
        config: "module.config.ts",
        include: [
            "module.config.ts",
            "./**/*.d.ts",
            "src/**/*.ts",
            "server/**/*.ts",
            "src/prompts/**/*.vue",
            "tests/**/*.ts",
        ],
        globals: "axon",
        frame: true,
        framework: "all",
        installs: true,
        bundle: "module",
        publishable: true,
        public: true,
        scaffold: scaffoldModule,
    },

    cognet: {
        config: "cognet.config.ts",
        // A cognet's whole directory is brain source, so the entry may sit at
        // `src/main.ts` or `main.ts` and either is compiled (see
        // resolveCognetMain). `*.ts` at the root covers cognet.config.ts and a
        // flat entry alike; node_modules is excluded below rather than dodged
        // by enumerating subdirectories.
        include: [
            "./**/*.d.ts",
            "*.ts",
            "src/**/*.ts",
            "plugins/**/*.ts",
            "tests/**/*.ts",
        ],
        globals: "cognet",
        frame: true,
        framework: "all",
        installs: true,
        bundle: "source",
        publishable: true,
        public: true,
        scaffold: scaffoldCognet,
    },

    bench: {
        config: "bench.config.ts",
        // fixtures/ is deliberately absent: it holds author-side inputs and
        // whole agent projects, which carry their own tsconfig scope.
        include: [
            "bench.config.ts",
            "./**/*.d.ts",
            "tests/**/*.ts",
        ],
        globals: "axon",
        frame: true,
        framework: "all",
        installs: true,
        bundle: "source",
        publishable: true,
        public: true,
        scaffold: scaffoldBench,
    },

    prompt: {
        config: "prompt.config.ts",
        include: [
            "prompt.config.ts",
            "./**/*.d.ts",
        ],
        globals: "prompt",
        frame: true,
        // A prompt declares no dependencies — see `installs`.
        framework: "all",
        installs: false,
        bundle: "source",
        publishable: true,
        public: true,
        scaffold: scaffoldPrompt,
        // The pack's invokable units live at the top level, and components/
        // travels with them (fragments they compose, never invokable alone).
        async files(root) {
            const top = (await fsx.list(root)).filter(
                name => name.endsWith(".vue") || name.endsWith(".md"),
            )
            return fsx.exists(join(root, "components")) ? [...top, "components"] : top
        },
    },

    extension: {
        config: "extension.config.ts",
        // `*.ts` at the root covers extension.config.ts, main.ts, and anything
        // the author splits out and imports — the same globs a profile gets,
        // because it is the same layout.
        include: [
            "./**/*.d.ts",
            "*.ts",
            "src/**/*.ts",
            "plugins/**/*.ts",
        ],
        globals: "tui",
        frame: true,
        // An extension declares @arcforge/types (for tsconfig.base.json and the
        // Bun globals) and may declare anything else it needs — it is ordinary
        // TypeScript running in the CLI's process, not a sandbox.
        framework: "types",
        installs: true,
        // Source, not a built image: an extension is loaded by the TUI on the
        // user's machine, which compiles it the same way it compiles a user's
        // own main.ts. There is no separate artifact to produce.
        bundle: "source",
        publishable: true,
        public: true,
        scaffold: scaffoldExtension,
    },

    /**
     * The user's own Axon directory — ~/.axon/profiles/<email>/.
     *
     * A project kind like any other, and for the same payoff: it gets a type
     * frame, a tsconfig, an install and a scaffolder without any of those
     * growing a special case. What makes it unusual is only WHO runs it —
     * every other kind is scaffolded by a person typing `axon init`, while a
     * profile is prepared on boot for whoever logs in.
     *
     * Never published: it holds one person's credentials, history and agents.
     * `bundle` is set to "source" because the field is not optional, and
     * `public: false` states the intent; nothing calls publish() on a profile.
     */
    profile: {
        config: "profile.config.ts",
        // `*.ts` at the root covers main.ts, profile.config.ts and any file the
        // user splits out and imports (keybindings.ts, commands.ts). Root-level
        // rather than enumerated so a file is typechecked whether or not
        // anything imports it yet — an orphan with no checking is a worse
        // first experience than one extra glob.
        include: [
            "./**/*.d.ts",
            "*.ts",
            "plugins/**/*.ts",
            "extensions/**/*.ts",
        ],
        globals: "tui",
        frame: true,
        framework: "types",
        installs: true,
        bundle: "source",
        publishable: false,
        public: false,
        scaffold: scaffoldProfile,
    },
}

export const PROJECT_KINDS = Object.keys(KINDS) as Kind[]

/**
 * "@me/thing" → "thing" — the directory takes only the unscoped segment while
 * package.json keeps the full name. npm does the same: the folder is "thing",
 * the package is "@me/thing". Every scaffolder needs this, so it lives once.
 */
export function bareName(name: string): string {
    return name.split("/").at(-1) ?? name
}

/**
 * What kind of project a directory holds, if any — decided by which config
 * file is present.
 *
 * Lives with the table it reads: identifying a kind is the same question the
 * table answers, and it used to sit on Project() where Projects() had to import
 * it back from the thing it constructs.
 *
 * An agent's INLINE cognet is deliberately not a project. `<agent>/cognet/`
 * holds a cognet.config.ts, so the table alone would call it one — and since
 * `Projects.find()` walks UP from the cwd, running any command from inside
 * that folder would open a standalone cognet with no package.json, no
 * node_modules and nothing to publish. It is a part of the agent, the way
 * `src/tools/` is; the agent above it is the project.
 */
export function detectKind(root: string): Kind | null {
    const kind = PROJECT_KINDS.find(k => fsx.exists(join(root, KINDS[k].config))) ?? null
    if (kind === "cognet" && isInlineCognet(root)) return null
    return kind
}

/** Whether this cognet directory is an agent's inline brain rather than its own project. */
function isInlineCognet(root: string): boolean {
    return basename(root) === INLINE_COGNET_DIR
        && fsx.exists(join(dirname(root), KINDS.agent.config))
}
