/**
 * The TUI extension contract — what a user's `main.ts`, a profile config, and
 * a published extension are written against.
 *
 * ── This file is copied verbatim into generated type frames ──────────────────
 *
 * `axon prepare` writes this source text into a profile's `.axon/types/` and an
 * extension's `.extension/types/` as ambient globals. That is why it declares
 * NO imports: a profile directory has no node_modules for an import to resolve
 * through (see prompt-dts.ts, which accepted the same constraint for the same
 * reason). Unlike prompts, there is no duplicated copy to keep in step — the
 * generator reads THIS file, so the contract and the globals cannot drift.
 *
 * Adding an import here breaks every profile's typecheck. Add the type instead.
 *
 * ── What this layer is for ───────────────────────────────────────────────────
 *
 * Workflow design in the terminal, and nothing more. The rule that draws the
 * boundary: an extension DRIVES the conversation, it never CONSUMES it.
 * `agents.send()` returns void — an extension that awaited model output and
 * branched on its text would be writing an agent, in the config layer, badly.
 * Agent behaviour belongs in a cognet, which the same user can build.
 *
 * The surface is deliberately small and complete against one test: everything
 * reachable from the keyboard is reachable from code. Mode keys → `mode`,
 * typing → `input`, palette navigation → `palette`, `:` → `commands`, chords →
 * `keys`, `~`/`/`/`^` → `agents`, Ctrl+C → `tui`. `keys.send()` backstops
 * whatever this missed. Nothing here renders: user surfaces are built from the
 * palette primitives, so every extension's UI is as good as the built-in one
 * and stays that way when the palette improves.
 */

// ── Disposal ─────────────────────────────────────────────────────────────────

/**
 * Undoes one registration.
 *
 * Every `register`/`create` returns one, and the loader tracks them per
 * extension so a hot-reload can tear the previous load down before running
 * setup again. Without this, each reload leaves its registrations behind and
 * one keystroke fires N handlers — the accumulation `Hooks().reset()` exists to
 * prevent on the agent runtime side.
 */
export type Disposer = () => void

// ── Palette ──────────────────────────────────────────────────────────────────

/**
 * One row in any palette — user-created or built-in.
 *
 * This is the SAME item type the TUI's own modes produce. A user palette that
 * could not express what `~` or `^` expresses would turn every gap into a
 * feature request, so the built-ins hold no privileged row shape: they are
 * simply the palettes that ship.
 */
export type PaletteItem = {
    id: string
    label: string
    description?: string
    /**
     * Independently-searchable parts of this row, for a list long enough that
     * one substring match over `label` stops being enough — every query term
     * narrows against any chunk. The model palette sets route and model id as
     * separate chunks, which is what lets ~800 rows live in one flat list with
     * no tabs or pages. Omit for ordinary rows.
     */
    chunks?: readonly string[]
    /**
     * Run on Enter. A returned promise holds the palette in its working state
     * until it settles. The signal aborts when the user escapes mid-flight —
     * actions that cannot be cancelled may ignore it.
     */
    action?: (signal: AbortSignal) => void | Promise<void>
    /** Selecting this row rewrites the query to this text instead of running `action` — descending into a group. */
    descendQuery?: string
    /** Selecting this row shows these rows as a follow-up list — a confirm/choice step. Computed at the moment it is confirmed. */
    choices?: () => PaletteItem[]
    /** Run on cursor movement, before confirming — live preview. */
    preview?: () => void
    /** Shown in the working row while an async `action` is in flight. */
    workingMessage?: string
    /**
     * Close immediately and let `action` finish in the background, rather than
     * holding the list open behind a working row.
     *
     * Only for actions whose progress has its OWN surface. An action that
     * reports nowhere else must not set this, or its failure becomes invisible.
     */
    detach?: boolean
    /** Non-selectable section header. */
    header?: boolean
    /** Non-selectable blank spacer between groups. */
    separator?: boolean
}

/** A tab in a tabbed palette. First tab is active on entry. */
export type PaletteTab = {
    id: string
    label: string
}

/** Loading/error indicator shown above the item list. */
export type PaletteStatus =
    | { kind: "loading"; message: string }
    | { kind: "error"; message: string }
    | null

/**
 * What one query resolves to — items plus everything else this palette has to
 * say about that same query.
 *
 * Derived from a single call so status, breadcrumb and items can never drift
 * out of sync, which is the failure mode of computing them as independently
 * triggered fields. Returning a bare array is shorthand for `{ items }`.
 */
export type PaletteResult = {
    items: PaletteItem[]
    /** Prefix shown on every row — a path walked so far. */
    breadcrumb?: string | null
    status?: PaletteStatus
    /** True when the query cannot resolve to anything selectable — a dead-end token. */
    invalid?: boolean
}

/**
 * A user-defined palette.
 *
 * `list` is the only required member: given the query and active tab, return
 * the rows. It may be async — the palette shows its own loading state while the
 * first call is in flight, and results are cached until `refresh()` is called
 * on the handle.
 */
export type PaletteDefinition = {
    /**
     * Produce the rows for one query.
     *
     * The TUI applies its own substring filter over the returned items unless
     * `filter: false` — so a list that does not care about `query` can ignore
     * the argument entirely and still be searchable.
     */
    list: (query: string, tab: string | null) => PaletteItem[] | PaletteResult | Promise<PaletteItem[] | PaletteResult>
    /** This palette filters by query itself — the TUI must not filter again. */
    filter?: boolean
    /** Declares this palette as tabbed. Omit for a single flat list. */
    tabs?: PaletteTab[]
    /** Max visible rows before scrolling. */
    maxHeight?: number
    /**
     * "top" (default): newest first, cursor starts at the top. "bottom": items
     * are given oldest→newest, the cursor starts on the last row and up-arrow
     * walks back in time — the terminal-log feel of history and session mode.
     */
    anchor?: "top" | "bottom"
    /**
     * A mode key that opens this palette from an empty input, e.g. "&".
     *
     * Throws at registration if the key is already taken — a silently shadowed
     * mode key is unbearable to debug in someone else's config.
     */
    key?: string
    /** Symbol shown in the input bar while this palette is open. Defaults to `key`. */
    symbol?: string
    /** One-line description, shown in `?` (help) alongside the built-in modes. */
    description?: string
}

/** Handle on one registered palette. */
export type PaletteHandle = {
    readonly name: string
    /** Open it. Rejects if another palette is already open — see `palette.open`. */
    open: () => Promise<void>
    /** Drop the cached list so the next open recomputes it. Does not reopen. */
    refresh: () => void
    /** Unregister, closing it first if it is open. */
    dispose: Disposer
}

/** A pick option carrying a value, for `pick` over things that are not strings. */
export type PickOption<T> = {
    label: string
    description?: string
    value: T
}

/**
 * The palette — the TUI's interaction primitive, and the reason this layer can
 * stay small. Registered palettes cover "the user opens a list"; `pick`,
 * `confirm` and `prompt` cover "code asks the user a question".
 *
 * The question verbs return promises rather than taking callbacks, which is
 * what makes multi-step flows fall out for free: they are sequential awaits,
 * not a wizard framework.
 *
 * Every question resolves to a cancelled value on escape — `undefined`, or
 * `false` for `confirm`. That is in the return type deliberately: a caller is
 * forced to handle the user walking away.
 */
export type AxonPalette = {
    /** Register a palette. Throws if `name` is taken. */
    create: (name: string, definition: PaletteDefinition) => PaletteHandle

    /** A registered palette by name, or null. */
    get: (name: string) => PaletteHandle | null

    /**
     * Open a registered palette by name.
     *
     * Throws if no palette has that name, and throws if another palette is
     * already open — stealing the palette out from under someone mid-navigation
     * is exactly the kind of silent degradation that makes an extension system
     * feel haunted. Check `palette.isOpen` first if a keybind might collide.
     */
    open: (name: string) => Promise<void>

    /** Close whatever is open. No-op when nothing is. */
    close: () => void

    /** True while any palette is open, built-in or user-defined. */
    readonly isOpen: boolean

    /** Ask the user to choose one of a list of strings. Resolves undefined on escape. */
    pick: {
        (options: readonly string[], opts?: { placeholder?: string }): Promise<string | undefined>
        <T>(options: readonly PickOption<T>[], opts?: { placeholder?: string }): Promise<T | undefined>
    }

    /** Ask a yes/no question. Resolves false on escape. */
    confirm: (message: string) => Promise<boolean>

    /** Ask for a line of text. Resolves undefined on escape. */
    prompt: (message: string, opts?: { placeholder?: string; initial?: string }) => Promise<string | undefined>
}

// ── Commands ─────────────────────────────────────────────────────────────────

/**
 * Where a command sits in the `:` tree.
 *
 * `"deploy"` is top level; `["theme", "set"]` is nested under a group, which is
 * created on demand. Both forms accepted — a flat command should not have to be
 * written as a one-element array.
 */
export type CommandPath = string | readonly string[]

/**
 * What a command IS — its behaviour and how it presents.
 *
 * ── Why a definition object rather than trailing options ────────────────────
 *
 * The alternative was `register(path, action, options?)`, and it loses for the
 * same reason positional hook arguments do. A third parameter is a fixed slot:
 * the day a command needs a fourth thing, it is either a fourth positional
 * nobody discovers or a breaking change. And `register("x", fn, {...})` reads
 * as a function with some settings bolted on, when the truth is that the
 * behaviour and the presentation are one declaration.
 *
 * It also matches `palette.create(name, definition)`, which already takes its
 * work verb (`list`) inside the object. Two registration APIs shaped
 * differently is a thing to remember for no reason.
 *
 * The verb is `run` because that is what a command does. `action` was the
 * internal name and it describes a slot in a data structure, not the thing a
 * user is writing.
 */
export type CommandDefinition = {
    /**
     * The command's behaviour.
     *
     * A returned promise holds the palette in its working state until it
     * settles. The signal aborts when the user escapes mid-flight — a command
     * that cannot be cancelled may ignore it.
     */
    run: (signal: AbortSignal) => void | Promise<void>
    /** Shown beside the command in the palette. */
    description?: string
    /** Shown in the working row while an async command runs. */
    workingMessage?: string
}

export type AxonCommands = {
    /**
     * Add a command to the `:` tree.
     *
     * Two forms, and the short one is not a legacy shape to be migrated off:
     *
     *     commands.register("deploy", async () => { ... })
     *     commands.register("deploy", {
     *         async run() { ... },
     *         description: "Restart and redeploy",
     *     })
     *
     * A command with nothing to configure is genuinely just its behaviour, and
     * making that case carry `{ run }` would be ceremony charged to the most
     * common thing anyone writes. The moment there IS configuration, the object
     * form keeps it in one declaration instead of trailing off the end.
     *
     * Built-in commands always win a collision, and two extensions colliding is
     * first-registered-wins with a warning naming both — never silent shadowing.
     */
    register: {
        (path: CommandPath, run: (signal: AbortSignal) => void | Promise<void>): Disposer
        (path: CommandPath, definition: CommandDefinition): Disposer
    }

    /**
     * Run a command by path, exactly as pressing Enter on it would.
     *
     * This is how an extension reaches functionality that has a command but no
     * dedicated API — one verb instead of re-exposing every command's
     * implementation. Throws if the path resolves to nothing.
     */
    run: (path: CommandName | CommandPath) => Promise<void>

    /** Every registered command path, built-in and user. */
    list: () => readonly string[][]
}

// ── Keys ─────────────────────────────────────────────────────────────────────

export type AxonKeys = {
    /**
     * Bind a chord, e.g. "ctrl+o".
     *
     * Built-in bindings win; two extensions colliding is first-wins with a
     * warning naming both. Bindings do not fire while a palette is open.
     */
    register: (chord: string, handler: () => void | Promise<void>) => Disposer

    /**
     * Deliver a keypress as though the user had typed it.
     *
     * The escape hatch that keeps this surface honest: anything the API forgot
     * to expose is still reachable, so a missing verb is an inconvenience
     * rather than a wall.
     */
    send: (chord: string) => void
}

// ── Modes ────────────────────────────────────────────────────────────────────

/**
 * Built-in mode names. A user palette registered with a `key` adds its own
 * name to what `mode.set` accepts at runtime, which is why this is not a
 * closed union at the type level.
 */
export type BuiltinMode =
    | "normal"
    | "command"
    | "model"
    | "session"
    | "agent"
    | "instance"
    | "voice"
    | "help"
    | "history"
    | "prompt"
    | "module"
    | "script"

export type ModeName = BuiltinMode | (string & {})

export type AxonMode = {
    /** Switch modes. Throws on an unknown mode rather than silently doing nothing. */
    set: (mode: ModeName) => Promise<void>
    /** The active mode. */
    get: () => ModeName
    /** The symbol currently shown in the input bar. */
    symbol: () => string
}

// ── Input ────────────────────────────────────────────────────────────────────

/** The message box the user types into. */
export type AxonInput = {
    get: () => string
    set: (text: string) => void
    /** Append to the current text without clearing it — the voice-transcript behaviour. */
    append: (text: string) => void
    clear: () => void
    /**
     * Send the current input as a message to the focused agent, exactly as
     * pressing Enter would, and clear the box. No-op when it is empty.
     */
    submit: () => Promise<void>
}

// ── Agents ───────────────────────────────────────────────────────────────────

/** What a running instance looks like to an extension. */
export type AgentInstance = {
    /** Stable identity of this instance. Every instance verb addresses by this. */
    readonly id: string
    /** The agent project's name — several instances may share one. */
    readonly name: string
    /** True for the instance currently on screen. */
    readonly focused: boolean
    /**
     * Null when idle.
     *
     * The last two are ATTACHED instances only — an agent reached over a URL,
     * whose wire can drop without the agent itself stopping. A local instance
     * never reports them: its runtime lives in this process, so there is no
     * connection to lose.
     *
     * Kept in step with `AgentActivity` in the TUI and with the copy in
     * tui-contract.ts, which is what a user's own config typechecks against.
     */
    readonly activity: "booting" | "rebooting" | "shutting-down" | "working" | "reconnecting" | "disconnected" | null
}

/** An agent that can be started — a local project or a deployment. */
export type AgentTarget = {
    readonly name: string
    readonly kind: "local" | "deployed"
    /** Running instances of this agent, most recently focused first. */
    readonly instances: readonly AgentInstance[]
}

/**
 * Agents, addressed the way the TUI addresses them: you START by name and then
 * everything else is BY INSTANCE.
 *
 * That split is not incidental. One agent can have many live instances — that
 * is what `spawn` twice gives you — so a verb taking a name has no answer for
 * "which one", and collapsing the two would make siblings unreachable from
 * extensions.
 */
export type AxonAgents = {
    /** Every agent that can be started, with its live instances. */
    targets: () => Promise<readonly AgentTarget[]>

    /** Every running instance, in spawn order. */
    list: () => readonly AgentInstance[]

    /** One instance by id, or null if it is not running. */
    get: (id: string) => AgentInstance | null

    /** The instance currently on screen, or null when nothing is running. */
    focused: () => AgentInstance | null

    /**
     * Boot a new instance of an agent IN THE BACKGROUND, resolving once it is
     * live. The view does not change.
     *
     * Always a NEW instance — this is the sibling verb.
     *
     * Background is the whole point: a config that booted two agents would
     * otherwise have them race for the screen, and neither asked to be looked
     * at. Showing one is a separate, explicit act — `tui.nav(name)` goes to an
     * agent (booting one if none is live), and `agents.focus(id)` goes to a
     * specific instance.
     *
     * Returns the instance, which is what makes a workflow composable: the id
     * is how every other verb here addresses it, and one agent may have many
     * live instances, so "the one I just started" cannot be recovered from the
     * name afterwards.
     */
    spawn: (name: string) => Promise<AgentInstance>

    /** Put an instance on screen. Throws if it is not running. */
    focus: (id: string) => void

    /**
     * Shut an instance down. The only verb here that ends a conversation.
     *
     * Omit `id` for the focused instance.
     */
    stop: (id?: string) => Promise<void>

    /**
     * Reload an instance's blueprint in place. The conversation survives.
     *
     * Omit `id` for the focused instance.
     */
    reboot: (id?: string) => Promise<void>

    /**
     * Send a message to the FOCUSED instance, as though the user had typed it
     * and pressed Enter.
     *
     * Returns when the message is DELIVERED, not when the agent has answered,
     * and yields nothing: an extension drives the conversation and never
     * consumes it. Reading a model's output to decide what to do next is an
     * agent's job — build a cognet.
     *
     * Focused rather than addressable, deliberately. Delivery is not a simple
     * dispatch — a send during a switch is QUEUED for the agent arriving rather
     * than delivered to the one being left, which is the difference between a
     * message landing in the right conversation and the wrong one. That rule is
     * defined in terms of what the user is looking at, so a per-instance send
     * would need its own answer to a question the focused path already answers
     * correctly.
     *
     * Note that `spawn()` does NOT focus what it starts, so sending to a
     * freshly spawned agent means going to it first:
     *
     *     const reviewer = await agents.spawn("@axon/reviewer")
     *     agents.focus(reviewer.id)
     *     await agents.send("review main")
     */
    send: (content: string) => Promise<void>

    /** Interrupt the focused instance's current wake, as Escape does. True if something was interrupted. */
    interrupt: () => boolean
}

// ── The TUI itself ───────────────────────────────────────────────────────────

/** Terminal dimensions in cells. */
export type TuiSize = {
    readonly width: number
    readonly height: number
}

// ── Themes ───────────────────────────────────────────────────────────────────

/**
 * Every colour name the terminal can render.
 *
 * ── Generated, not written ──────────────────────────────────────────────────
 *
 * The list between the markers is produced by `scripts/contract.ts` from
 * VTerm's own colour parser — its terminal basics (`brightcyan`) plus the full
 * CSS3 named set. Do not edit it by hand; a name here that the parser does not
 * know renders as nothing, which is the failure the union exists to prevent.
 */
export type ColorName =
    // <color-names>
    | "aliceblue"
    | "antiquewhite"
    | "aqua"
    | "aquamarine"
    | "azure"
    | "beige"
    | "bisque"
    | "black"
    | "blanchedalmond"
    | "blue"
    | "blueviolet"
    | "brightblack"
    | "brightblue"
    | "brightcyan"
    | "brightgreen"
    | "brightmagenta"
    | "brightred"
    | "brightwhite"
    | "brightyellow"
    | "brown"
    | "burlywood"
    | "cadetblue"
    | "chartreuse"
    | "chocolate"
    | "coral"
    | "cornflowerblue"
    | "cornsilk"
    | "crimson"
    | "cyan"
    | "darkblue"
    | "darkcyan"
    | "darkgoldenrod"
    | "darkgray"
    | "darkgreen"
    | "darkgrey"
    | "darkkhaki"
    | "darkmagenta"
    | "darkolivegreen"
    | "darkorange"
    | "darkorchid"
    | "darkred"
    | "darksalmon"
    | "darkseagreen"
    | "darkslateblue"
    | "darkslategray"
    | "darkslategrey"
    | "darkturquoise"
    | "darkviolet"
    | "deeppink"
    | "deepskyblue"
    | "dimgray"
    | "dimgrey"
    | "dodgerblue"
    | "firebrick"
    | "floralwhite"
    | "forestgreen"
    | "fuchsia"
    | "gainsboro"
    | "ghostwhite"
    | "gold"
    | "goldenrod"
    | "gray"
    | "green"
    | "greenyellow"
    | "grey"
    | "honeydew"
    | "hotpink"
    | "indianred"
    | "indigo"
    | "ivory"
    | "khaki"
    | "lavender"
    | "lavenderblush"
    | "lawngreen"
    | "lemonchiffon"
    | "lightblue"
    | "lightcoral"
    | "lightcyan"
    | "lightgoldenrodyellow"
    | "lightgray"
    | "lightgreen"
    | "lightgrey"
    | "lightpink"
    | "lightsalmon"
    | "lightseagreen"
    | "lightskyblue"
    | "lightslategray"
    | "lightslategrey"
    | "lightsteelblue"
    | "lightyellow"
    | "lime"
    | "limegreen"
    | "linen"
    | "magenta"
    | "maroon"
    | "mediumaquamarine"
    | "mediumblue"
    | "mediumorchid"
    | "mediumpurple"
    | "mediumseagreen"
    | "mediumslateblue"
    | "mediumspringgreen"
    | "mediumturquoise"
    | "mediumvioletred"
    | "midnightblue"
    | "mintcream"
    | "mistyrose"
    | "moccasin"
    | "navajowhite"
    | "navy"
    | "oldlace"
    | "olive"
    | "olivedrab"
    | "orange"
    | "orangered"
    | "orchid"
    | "palegoldenrod"
    | "palegreen"
    | "paleturquoise"
    | "palevioletred"
    | "papayawhip"
    | "peachpuff"
    | "peru"
    | "pink"
    | "plum"
    | "powderblue"
    | "purple"
    | "rebeccapurple"
    | "red"
    | "rosybrown"
    | "royalblue"
    | "saddlebrown"
    | "salmon"
    | "sandybrown"
    | "seagreen"
    | "seashell"
    | "sienna"
    | "silver"
    | "skyblue"
    | "slateblue"
    | "slategray"
    | "slategrey"
    | "snow"
    | "springgreen"
    | "steelblue"
    | "tan"
    | "teal"
    | "thistle"
    | "tomato"
    | "turquoise"
    | "violet"
    | "wheat"
    | "white"
    | "whitesmoke"
    | "yellow"
    | "yellowgreen"
    // </color-names>

/**
 * Any colour a theme token can hold.
 *
 * A named colour autocompletes; so does `transparent`, which means "paint
 * nothing and let the real terminal show through" — the right answer for
 * `background` in almost every theme.
 *
 * `(string & {})` keeps that autocomplete while still accepting the forms a
 * union cannot enumerate: `#1a1b26`, `rgb(26, 27, 38)`, an rgba() with alpha.
 * Unlike `syntax`, an unrecognised value here is not automatically a typo —
 * hex is the common case — so this stays open where that one is closed.
 */
export type ThemeColor =
    | ColorName
    | "transparent"
    | (string & {})

/**
 * The seven tokens every Axon surface draws from.
 *
 * Closed on purpose. The TUI reached ~30 hard-coded colours before this — four
 * greys nobody chose deliberately, five reds — and a theme API with a field per
 * call site would preserve that forever: a "theme" would mean thirty decisions,
 * and no two themes would agree what any of them were for.
 *
 * Seven decisions, and every surface derives from them. That is what makes a
 * theme portable: whatever an author writes lands on the same things.
 */
export type ThemeTokens = {
    /** Accent. Selection, the input rule, focused rows, links. */
    primary: ThemeColor
    /** The terminal's own ground. */
    background: ThemeColor
    /** Ordinary foreground — what most text is. */
    text: ThemeColor
    /** Secondary foreground: paths, descriptions, timestamps, anything subordinate. */
    dim: ThemeColor
    /** Something needs attention but nothing failed. */
    warn: ThemeColor
    /** Something failed. */
    error: ThemeColor
    /**
     * Syntax highlighting for code blocks and the editor.
     *
     * A bundled theme name autocompletes — see `BundledSyntax` for the full
     * set. An author who wants their own tokenisation passes a TextMate theme
     * object instead, which is the same shape Shiki takes.
     *
     * Deliberately NOT widened with `(string & {})` the way `ThemeColor` is.
     * A colour Axon does not recognise still renders — the terminal hands it
     * to the ANSI layer and something sensible happens. A syntax theme name
     * Shiki does not have loads nothing, so an unrecognised string is always a
     * typo, and the union is what turns it into a red squiggle in the user's
     * editor instead of unhighlighted code they have to diagnose.
     */
    syntax: BundledSyntax | Record<string, unknown>
}

/** A registered theme: its tokens plus the name it is addressed by. */
export type Theme = ThemeTokens & { name: string }

/**
 * Every syntax theme that ships with Axon.
 *
 * ── Generated, not written ──────────────────────────────────────────────────
 *
 * The list between the markers below is produced by `scripts/contract.ts` from
 * Shiki's own `bundledThemes`, and rewritten in place whenever that script
 * runs. Do not edit it by hand — a name here that Shiki does not have is a
 * theme that typechecks and then fails to load at runtime, which is exactly the
 * failure a literal union is supposed to prevent.
 *
 * It is a literal union rather than an import because this file is copied
 * verbatim into a profile's type frame, where there is no node_modules to
 * import Shiki through. The generator is what keeps the copy honest.
 *
 * ── Bundling all of them is nearly free ─────────────────────────────────────
 *
 * Shiki's bundle is a map of dynamic-import thunks and the highlighter is
 * constructed with ONE theme, calling `loadTheme()` for each further one a user
 * actually selects. So the cost of offering every theme is a single import at
 * the moment someone picks it — not the whole set at boot.
 */
export type BundledSyntax =
    // <bundled-syntax>
    | "andromeeda"
    | "aurora-x"
    | "ayu-dark"
    | "catppuccin-frappe"
    | "catppuccin-latte"
    | "catppuccin-macchiato"
    | "catppuccin-mocha"
    | "dark-plus"
    | "dracula"
    | "dracula-soft"
    | "everforest-dark"
    | "everforest-light"
    | "github-dark"
    | "github-dark-default"
    | "github-dark-dimmed"
    | "github-dark-high-contrast"
    | "github-light"
    | "github-light-default"
    | "github-light-high-contrast"
    | "houston"
    | "kanagawa-dragon"
    | "kanagawa-lotus"
    | "kanagawa-wave"
    | "laserwave"
    | "light-plus"
    | "material-theme"
    | "material-theme-darker"
    | "material-theme-lighter"
    | "material-theme-ocean"
    | "material-theme-palenight"
    | "min-dark"
    | "min-light"
    | "monokai"
    | "night-owl"
    | "nord"
    | "one-dark-pro"
    | "one-light"
    | "plastic"
    | "poimandres"
    | "red"
    | "rose-pine"
    | "rose-pine-dawn"
    | "rose-pine-moon"
    | "slack-dark"
    | "slack-ochin"
    | "snazzy-light"
    | "solarized-dark"
    | "solarized-light"
    | "synthwave-84"
    | "tokyo-night"
    | "vesper"
    | "vitesse-black"
    | "vitesse-dark"
    | "vitesse-light"
    // </bundled-syntax>
    /** Axon's own, and the default. */
    | "arcnight"

// ── lines ───────────────────────────────────────────────────────────────────

/**
 * One live value on a line — a name, when it changes, and what it says.
 *
 * THE TRIGGER IS DECLARED, and that is the whole design. A bare `() => string`
 * would leave the terminal with no idea when to call it: re-running every
 * component on every frame makes one slow component stall the paint, and the
 * alternative — asking users to wire their own reactivity — is the thing this
 * API exists to avoid. So a component states what wakes it and the renderer
 * evaluates it then and never otherwise.
 *
 * `render` is SYNCHRONOUS by contract. A frame cannot await, and a component
 * that needs real work (a git branch, a network call) does that work in its
 * trigger and returns the cached value here — the same discipline lualine
 * settles on, arrived at from the render loop rather than from convention.
 *
 * A component with neither `on` nor `every` renders once and stays put, which
 * is the right shape for something static.
 */
export type LineComponent = {
    /**
     * A glyph shown before the value — a NAME from the catalogue, or a literal.
     *
     * A NAME resolves through the active icon set, so one setting swaps every
     * icon at once — which is what makes a shared component work on a machine
     * without a patched font. A literal glyph is the escape hatch for
     * something the catalogue does not name, and it does NOT respond to the
     * setting: an author writing a raw character has said they know what
     * appears.
     *
     * The author's, not the config's — an icon is part of what a component
     * MEANS (a git component without its branch glyph is a worse git
     * component), where colour is part of how a LINE looks and belongs to
     * whoever composes the row.
     *
     * Rendered only when the component has something to say: an icon beside an
     * empty value is a glyph floating on its own.
     */
    icon?: IconName | (string & {})
    /**
     * Hook events that change this value — the same names `tui.hook` takes.
     *
     * Reusing that vocabulary is deliberate: the terminal already emits a
     * precise event for everything it does, so a component author picks from a
     * list they have already learned rather than inventing a subscription.
     */
    on?: readonly TuiHookName[]
    /**
     * Re-render every N milliseconds — for values that change with time rather
     * than with anything the terminal does. A clock is the case; there is no
     * event for "a second passed".
     *
     * Taken as written, with no floor. Painting a string is cheap and the
     * renderer diffs frames for exactly this; a component doing heavy work on
     * a fast interval is the author's call, the same as a slow hook handler.
     */
    every?: number
    /**
     * Run when the user clicks this component.
     *
     * Named for what the AUTHOR does, not for the event vterm dispatches
     * (`@press`). A config says "when this is clicked"; the transport's name
     * for that is an implementation detail of the layer below.
     *
     * What turns a status line into a control surface: a row of agent names
     * becomes a nav bar, a branch indicator becomes a branch picker. Without
     * it a line can only report, and reporting is the smaller half of what a
     * bar sitting in front of you all day could do.
     *
     * Unawaited by the terminal — a handler that takes a second must not hold
     * the frame — and a failure is reported like any other config fault rather
     * than surfacing as a click that silently did nothing.
     */
    click?: () => void | Promise<void>
    /**
     * What to show, coerced to text.
     *
     * Primitives only, deliberately. `string` alone forced `String(count)` on
     * the most ordinary component there is; `unknown` would accept an object,
     * an array or a promise and render `[object Object]` silently — and an
     * author who slipped an `async` onto this would get `[object Promise]` on
     * their line with nothing to explain it. Widening removes ceremony, not
     * the errors the type was catching.
     *
     * `null`/`undefined` are the honest way to say "nothing right now", and
     * render as empty rather than as the text "null".
     */
    render: () => string | number | null | undefined
}

/**
 * A line's content — up to three slots, laid out by the terminal.
 *
 * Axon owns spacing, separators, truncation and colour; a config supplies text
 * and its order. That split is the product decision: every layout knob is a
 * way for two configs to disagree, and the failure mode it prevents is a
 * handful of beautiful setups surrounded by mediocre ones. Users theme,
 * Axon lays out.
 *
 * `left` and `right` push apart. `middle` centres on the LINE, not on the gap
 * between the sides, and truncates when there is no room — one rule, so a
 * three-slot line never needs a negotiation nobody can predict.
 */
export type LineContent = {
    left?: LineSlot
    middle?: LineSlot
    right?: LineSlot
    /**
     * The style this line was DESIGNED for — a default, not a decree.
     *
     * An author knows what their line is meant to look like, so declaring it
     * here means a shared line arrives looking right with no configuration.
     * But the placement wins: a user who wants it plain says so in
     * `lines.set()` and never has to fork the line to restyle it.
     *
     * Precedence, narrowest first: placement → this → `lines.style()`.
     */
    style?: AxonLineStyle
}

/**
 * One slot's contents: a flat list of components, or a list of SECTIONS.
 *
 * A section is the unit a separator divides and a background fills — which is
 * why the nesting exists at all. Inside one section every component shares a
 * ground, so the divider between them is a hairline; between sections the
 * ground changes, so the divider is a filled arrow. That is the whole
 * distinction lualine draws with `component_separators` and
 * `section_separators`, and it cannot be expressed on a flat list.
 *
 * A flat array is one section. Nothing already written changes meaning.
 */
export type LineSlot = readonly ComponentName[] | readonly (readonly ComponentName[])[]

/**
 * A component's name — the catalogue Axon ships, or one you registered.
 *
 * The built-ins are enumerated so an editor completes them and a typo is a
 * compile error rather than a gap you find on screen. `(string & {})` keeps
 * that completion while still accepting names this union cannot know: a
 * component from an extension, or one the same config declared a few lines up.
 *
 * The same shape `ThemeColor` uses, for the same reason — a closed union would
 * make the escape hatch impossible, and an open `string` would make the
 * catalogue undiscoverable.
 */
export type ComponentName = RegistryName<AxonComponentRegistry>

/**
 * A generated registry's names — CLOSED once the registry has entries.
 *
 * ── Why this is not simply `keyof R | (string & {})` ────────────────────────
 *
 * That shape gives completion but never rejects anything: the open arm accepts
 * every string, so a typo typechecks and only fails at runtime — which is the
 * bug the generator exists to remove.
 *
 * An empty registry still has to accept anything, though. A profile before its
 * first `axon prepare` has no generated file, and every name in it would be an
 * error against a `never` union — a config that was fine yesterday would light
 * up red because a build step had not run yet.
 *
 * So the union closes only when it has something to close AROUND: empty means
 * open, populated means exact. A name the generator genuinely cannot see (one
 * computed at runtime) is cast at the call site, which is the honest signal
 * that it is unverifiable rather than a hole left open for every name.
 */
export type RegistryName<R> = keyof R extends never ? string : keyof R & string

/**
 * Every line name known at generation time.
 *
 * Same mechanism as AxonComponentRegistry — see that interface for why these
 * are generated rather than written by hand.
 */
export type LineName = RegistryName<AxonLineRegistry>

/**
 * Every palette name known at generation time.
 */
export type PaletteName = RegistryName<AxonPaletteRegistry>

/**
 * Every command path known at generation time, space-joined.
 */
export type CommandName = RegistryName<AxonCommandRegistry>

/**
 * The registries `axon prepare` fills in.
 *
 * ── Generated, not hand-written ─────────────────────────────────────────────
 *
 * These were a hand-maintained union of the built-in names, which drifted the
 * first time someone added a component and forgot to update it. The generator
 * reads the actual catalogue AND every config's own `create` calls, so what an
 * editor completes is what is really registered — including the component you
 * declared four lines above the line using it.
 *
 * ── Why an interface rather than a type alias ───────────────────────────────
 *
 * Declaration merging. A generated `.d.ts` reopens the interface and adds its
 * keys, which means built-ins, extension contributions and a user's own
 * registrations all land in one union with no privileged tier. An alias could
 * only be replaced, not extended, so every source would need its own name and
 * the consumer would have to union them by hand.
 *
 * Empty here by design: a profile with no generated types still typechecks,
 * because every consuming alias keeps a `(string & {})` arm.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AxonComponentRegistry {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AxonLineRegistry {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AxonPaletteRegistry {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AxonCommandRegistry {}

/**
 * How a line draws its separators and shades its sections.
 *
 * A preset, never individual glyphs. Axon owning the glyph set is the line
 * between "every config looks like Axon" and "everyone invents their own bar"
 * — and a config that picked its own would be choosing a look that has to hold
 * against every theme, which is not a decision anyone should have to make
 * per row.
 *
 * Backgrounds step from the EDGE INWARD: the outermost section takes the
 * accent, each step inward is softer, and the innermost sits on the terminal's
 * own ground. Position in the array is the section, so there is no background
 * to configure — which is what stops two configs disagreeing about what a
 * status bar looks like.
 */
export type AxonLineStyle =
    /** No glyphs. Components separated by spacing alone. */
    | "plain"
    /**
     * Filled arrows between sections, hairlines within — the default.
     *
     * The separator block (`U+E0B0`–`U+E0B7`) predates Nerd Fonts and ships far
     * more widely than the icon range, so a terminal that draws a git icon as a
     * box still renders these. One without even that sets `"plain"`.
     */
    | "powerline"
    /** The same, with round caps. Needs a Nerd Font. */
    | "rounded"
    /**
     * Square edges: a flat boundary between fills and a vertical bar within.
     *
     * The same section model as `powerline`, without the arrow's implied
     * direction — which reads as calmer beside a busy conversation, and is
     * what you want when the bar should sit still rather than point at
     * something. Needs a Nerd Font.
     */
    | "block"
    /** A thin middle dot between components, no section fills. */
    | "minimal"

/**
 * A line's definition: the full three-slot form, or a bare array.
 *
 * The array means LEFT, always — never auto-distributed. Both built-in lines
 * are left-aligned, so it is the common case worth a shorthand, and a rule
 * that reads the same every time beats one that guesses.
 */
export type LineDefinition = LineContent | readonly string[]

/**
 * One entry in the stack: a name, or a name with placement overrides.
 *
 * The bare string is the common case and stays the common case — an object is
 * only needed when this particular placement differs from what the line
 * declared.
 */
export type AxonLineEntry = LineName | AxonLinePlacement

/**
 * How ONE line is placed in ONE stack.
 *
 * ── Why placement owns style ────────────────────────────────────────────────
 *
 * Three layers, three owners: a COMPONENT is what the data is (an extension
 * author's), a LINE is what sits where (shared or personal), and a PLACEMENT
 * is how it looks in this stack (always the user's).
 *
 * Style began on the line and that was the wrong layer. A shared line would
 * ship with its look baked in, so anyone installing `@cody/git-line` had to
 * fork it to restyle — which is the coupling that stops a registry being
 * worth having. A line may still declare a default, because an author knows
 * what their line was designed to look like; the placement wins when it says
 * otherwise.
 *
 * Precedence, narrowest first: this placement → the line's own default →
 * `lines.style()`.
 */
export type AxonLinePlacement = {
    /** The registered line this entry places. */
    line: LineName
    /** How it draws here, overriding the line's default and the stack's. */
    style?: AxonLineStyle
    /**
     * Start hidden, keeping its place in the stack.
     *
     * Declared here rather than left to a `hide()` call afterwards, so the
     * stack is one description instead of a description plus a sequence of
     * mutations. `toggle()` still flips it at runtime.
     */
    hidden?: boolean
}

/**
 * Where a line moves to. `"up"`/`"down"` are relative; a number is an absolute
 * index in the stack, clamped rather than throwing — a keybind that walks a
 * line to the top should stop there, not fail on the last press.
 */
export type LinePosition = "up" | "down" | number

/** A registered line, as `lines.list()` reports it. */
export type Line = {
    /**
     * Unique within the stack — the name is NOT an identity, since a line may
     * be placed more than once (comparing two styles side by side is a real
     * thing to want).
     */
    id: string
    name: string
    content: LineContent
    /** How it draws. Falls back to the stack default when the line declared none. */
    style: AxonLineStyle
    /** False when hidden. A hidden line keeps its place in the stack. */
    visible: boolean
}

/**
 * Components — the live values a line can show.
 *
 * Axon ships a catalogue under the `axon:` prefix (`axon:token/counter` and
 * friends), and anything else registers here. The two are the same kind of
 * thing: a built-in is a component the terminal registered against its own
 * hooks, with no privilege a user's cannot have.
 *
 * Names are `provider:name` rather than a package specifier. A package ships
 * many things; a component comes from one provider — conflating the two would
 * make every component name read like an import path.
 */
export type AxonComponents = {
    /**
     * Register a component. Throws if the name is taken. Returns a disposer.
     *
     * A `render` that throws costs that component and nothing else: it renders
     * empty and the fault is reported, the same containment the config loader
     * applies per file. One bad value must not take down the line around it.
     */
    create: (name: string, component: LineComponent) => Disposer

    /** Every registered component name, built-ins included. */
    list: () => readonly string[]
}

/**
 * Lines — the configurable rows above the input bar.
 *
 * The terminal ships two of its own and they stay its: the cwd/token row and
 * the voice row. A user's lines sit between them, which is the one layout
 * decision Axon does not delegate — the rows that must always be readable are
 * not ones a config can push off screen.
 *
 * Registration and placement are SEPARATE VERBS, and that is what makes the
 * surface extensible: an extension `create`s lines without deciding where they
 * go, and the user `set`s the stack without knowing who authored what.
 */
export type AxonLines = {
    /**
     * Register a line. Throws if the name is taken, or if it names a component
     * that does not exist — a config error the loader can contain, reported
     * where it can be fixed rather than rendered as a blank row.
     */
    create: (name: string, definition: LineDefinition) => Disposer

    /**
     * The default style for every line that does not declare one.
     *
     * A stack-wide setting because a bar with one powerline row among plain
     * ones reads as a mistake, not a choice — and because the common case is
     * wanting ALL of them to match. A line that genuinely differs still says so
     * itself, which is the rarer thing and reads as deliberate at the call site.
     *
     * Called with no argument, returns the current default.
     */
    style: {
        (style: AxonLineStyle): void
        (): AxonLineStyle
    }

    /**
     * The single line ABOVE the conversation, or null to clear it.
     *
     * One line, not a stack. The room above the conversation is scarce in a
     * way the room below it is not — the bottom already holds the input bar
     * and its own rows, so a stack there is bounded by something. A second
     * unbounded stack at the top could push the conversation off screen, and
     * the constraint costs nothing: nobody has wanted two.
     *
     * Takes the same placement object as `set`, so a top line styles itself
     * the same way any other does.
     */
    top: {
        /** Set it by name, with placement options. */
        (name: LineName, options?: Omit<AxonLinePlacement, "line">): void
        /** Set it from a placement object, or clear it with null. */
        (entry: AxonLineEntry | null): void
        /** Read what is currently set. */
        (): Line | null
    }

    /**
     * Set the whole stack, top to bottom. Declarative and idempotent: this is
     * the one place order lives, so reordering is calling it again.
     *
     * An entry is a bare name, or an object when this placement differs from
     * the line's own defaults — see LinePlacement. Registered lines left out
     * of the array are not shown; an unknown name is reported.
     */
    set: (entries: readonly AxonLineEntry[]) => void

    /**
     * Move one line within the stack. Addressed by NAME, never by index —
     * an index shifts when anything above it moves, so a keybind written today
     * would quietly mean something else tomorrow.
     */
    move: (name: string, position: LinePosition) => void

    /** Hide a line. It keeps its place, so showing it again returns it there. */
    hide: (name: string) => void
    /** Show a hidden line, back where it was. */
    show: (name: string) => void
    /** Flip visibility — the verb a keybind wants. */
    toggle: (name: string) => void

    /** Every registered line, in stack order. What a picker palette reads. */
    list: () => readonly Line[]
}

/**
 * Themes — the terminal's colours, and switching between them.
 *
 * A theme is registered like a palette and applied like a mode. `"` opens the
 * built-in picker, which previews as the cursor moves: hovering a row paints it
 * for real, because a preview that rendered differently from the result would
 * be worth nothing.
 */
export type AxonTheme = {
    /**
     * Register a theme. Throws if the name is taken. Returns a disposer.
     *
     * Name first, tokens second — the same shape as `palette.create`, so the
     * two read alike rather than one carrying its identity inside the object
     * and the other beside it.
     */
    create: (name: string, tokens: ThemeTokens) => Disposer

    /** Paint a theme and keep it. Throws on an unknown name. */
    set: (name: string) => void

    /** Every registered theme, built-ins first. */
    list: () => readonly Theme[]

    /** The theme currently painted. */
    readonly active: Theme
}

/**
 * Everything that belongs to the terminal rather than to one of the domains
 * above. Kept deliberately thin — a verb with a natural home in `palette`,
 * `commands`, `keys`, `mode`, `input` or `agents` belongs there.
 */
/** Trailing options for `tui.info` / `warn` / `error`. */
export type NoticeOptions = {
    /** How long the notice holds the row, in milliseconds. Clamped to a few seconds. */
    ms: number
}

export type AxonTui = {
    /**
     * Go to an agent: focus the instance the user was last on, booting one if
     * none is live. The `~` key's behaviour.
     *
     * Name-addressed on purpose — "take me to this agent" is a different verb
     * from "focus this exact instance" (`agents.focus`), and both are real.
     */
    nav: (name: string) => Promise<void>

    /**
     * Register a lifecycle handler. See TuiHooks.
     *
     * Available everywhere — `main.ts`, a `plugins/` file, an extension's
     * `setup()` — because there is no capability difference between them, only
     * a timing one. `plugins/` is where hooks live by convention, not by rule.
     */
    hook: <N extends TuiHookName>(name: N, handler: TuiHooks[N]) => Disposer

    /**
     * A brief label on the cwd row — the same line the ctrl+c and double-esc
     * hints borrow. Flashes for 300ms by default, then the row returns to the
     * path.
     *
     *     tui.info("deployed")
     *     tui.warn("nothing to do", { ms: 600 })
     *     tui.error("command failed")
     *
     * ── A reaction, not a message ───────────────────────────────────────────
     *
     * This row's existing tenants are both feedback about the key just pressed,
     * and these are the same thing: something to catch the eye, not something
     * to read. Longer than ~50 characters is trailed with an ellipsis, which is
     * the honest consequence of a one-line surface rather than a limit to work
     * around.
     *
     * So anything with CONTENT — a reason, a path, a stack — does not belong
     * here. Throw instead: it lands in the config error list on the chat page,
     * which is scrollable and stays put.
     *
     * Takes any number of values and joins them with a space, the way
     * `console.log` does — so a config building a label from several pieces
     * does not have to concatenate first. Non-strings are stringified;
     * objects and arrays go through JSON so a stray value reads as data
     * rather than as `[object Object]`.
     *
     * The terminal's own hints outrank all three verbs — one fired during the
     * ctrl+c window waits rather than displacing the exit ladder.
     *
     * Duration is a trailing `{ ms }` rather than a bare number, because
     * under variadic args a trailing number is DATA: `tui.info("saved", 500)`
     * has to mean "saved 500", not "show this for half a second".
     *
     *     tui.info("[", keys.join(" "), "]")
     *     tui.warn("nothing to do", { ms: 600 })
     */
    info: (...args: unknown[]) => void

    /** As `info`, in the warning colour. */
    warn: (...args: unknown[]) => void

    /** As `info`, in the error colour. For "that failed" — never for why. */
    error: (...args: unknown[]) => void

    readonly size: TuiSize

    /** The directory the TUI was launched from. */
    readonly cwd: string

    /** Version of the running Axon CLI. */
    readonly version: string

    /**
     * Quit, running the same exit guards a Ctrl+C does.
     *
     * There is deliberately no `update()`: a self-update hands off to a helper
     * that runs after the process exits, and an extension triggering that is a
     * way for a config to brick an install mid-session.
     */
    exit: () => Promise<void>
}

// ── Hooks ────────────────────────────────────────────────────────────────────
//
// ONE verb: `tui.hook(name, handler)`. There is deliberately no `.on()`
// alongside it.
//
// A blocking `hook()` and a fire-and-forget `on()` are indistinguishable at the
// call site — one letter apart, differing only in a consequence you cannot see
// — and picking the wrong one buys either a race or a hang. Whether the TUI
// waits is a property of the EVENT, not of how a handler was registered: `boot`
// has a meaningful "before" to run in, `mode:changed` announces something that
// already happened and waiting on it only delays the UI.
//
// So the event decides, the types say which is which, and a user who wants
// fire-and-forget writes it where it is visible:
//
//     tui.hook("tui:boot", () => { void backgroundSync() })

/**
 * Gating hooks — the TUI WAITS for these, and they can fail the operation.
 *
 * Only lifecycle transitions with a real "before" qualify. A slow handler here
 * delays the terminal, so the runtime bounds it: exceeding the budget reports
 * `extension X is blocking <hook>` and continues. It never hangs silently, and
 * a config that stalls boot must always say so — an unexplained frozen terminal
 * is the worst failure this feature can produce.
 */
export type TuiGateHooks = {
    /** Before the TUI becomes interactive. Registration is done; the screen is not up. */
    "tui:boot": (payload: TuiBootPayload) => void | Promise<void>
    /** Before shutdown proceeds. The last point at which anything can be flushed to disk. */
    "tui:shutdown": (payload: TuiShutdownPayload) => void | Promise<void>
}

// ── Hook payloads ────────────────────────────────────────────────────────────
//
// EVERY hook takes exactly one object, always — including the ones that have
// nothing to say. `tui.hook(name, ({ x }) => ...)` is the shape throughout, so
// a handler is written the same way whichever event it listens to, and reading
// one tells you nothing about which.
//
// Positional arguments were the alternative and they lose on every axis that
// matters here. They fix an order, so adding a field is a choice between a
// trailing bag nobody discovers and a breaking change; they cannot be
// destructured by name, so `(a, b)` at a call site says nothing about what a
// and b are; and they make the empty case a THIRD spelling (`() => {}` beside
// `(x) => {}` beside `(x, y) => {}`) for no gain. An empty object costs a
// handler nothing — `() => {}` still type-checks, because a function may always
// ignore parameters it was handed.
//
// So the rule is mechanical and has no exceptions: one payload object per hook,
// named fields, and a payload type declared here even when it is empty. An
// empty payload is where a field will go, and having the type already named is
// what makes adding one a non-event.

/**
 * `tui:boot` — nothing yet.
 *
 * Empty rather than absent: the parameter exists so a later field arrives
 * without changing any handler's shape, and so boot is written exactly like
 * every other hook.
 */
export type TuiBootPayload = {}

/** `tui:shutdown` — nothing yet. Empty for the same reason as boot. */
export type TuiShutdownPayload = {}

/** `tui:reloaded` — nothing yet. Empty for the same reason as boot. */
export type TuiReloadedPayload = {}

/** `tui:resize` — the terminal's new dimensions, in cells. */
export type TuiResizePayload = {
    /** Columns. */
    width: number
    /** Rows. */
    height: number
}

/**
 * `tui:copy` — the text that was copied.
 *
 * The text is CARRIED rather than left for the handler to read back off the
 * selection: copying does not clear the selection, but nothing stops the user
 * (or another handler) from clearing it before this one runs, and a handler
 * that re-read it would then see an empty string for a copy that plainly
 * happened. What is passed is exactly what reached the clipboard.
 *
 * Never empty — an empty selection copies nothing and fires nothing.
 */
export type TuiCopyPayload = {
    /** The copied text, verbatim: original line breaks, no trimming. */
    text: string
}

/**
 * `key:pressed` — one keystroke the TUI did not act on.
 *
 * `mode` rides along because "was a palette open when this fired" is the first
 * question a handler asks, and reading it back through `mode.get()` would race
 * the very transition that may have been caused by this key.
 */
export type KeyPressedPayload = {
    /**
     * The chord, in the spelling `keys.register()` accepts — `"a"`, `"ctrl+o"`,
     * `"shift+tab"`. Round-trips deliberately: a handler that decides to claim
     * a key can pass this string straight to `keys.register`.
     */
    key: string
    /** The mode that was active when the key arrived. */
    mode: ModeName
}

/** `palette:opened` / `palette:closed` — which palette. */
export type PalettePayload = {
    /** The palette's mode name — `"command"`, `"agent"`, or a user palette's. */
    name: ModeName
}

/** What one instance hook reports. */
export type AgentPayload = {
    instance: AgentInstance
}

/**
 * `agent:model` — the pin that is now live, and whose agent it is.
 *
 * `model` is the pin as written (`codex:gpt-5.6-sol`), not a resolved
 * capability: it is what the config says and what a picker shows, and a
 * handler wanting the binding can ask the agent for it.
 */
export type AgentModelPayload = {
    model: string
    instance: AgentInstance
}

/** `message:sent` — the text, and where it went. */
export type MessageSentPayload = {
    content: string
    instance: AgentInstance
}

/** `message:received` — see the hook for why there is no content. */
export type MessageReceivedPayload = {
    instance: AgentInstance
}

/** `mode:changed` — the transition, both ends. */
export type ModeChangedPayload = {
    from: ModeName
    to: ModeName
}

/** `command:ran` / `command:failed` — which command, and how it was reached. */
export type CommandPayload = {
    /**
     * Where the command sits in the command TREE, one segment per level —
     * `["ext", "update"]`, `["theme", "set", "gruvbox"]`.
     *
     * An array rather than a space-joined string because the segments are what
     * both call sites already hold (`[...breadcrumb, node.label]` in the
     * palette, `toPath(path)` in `commands.run()`) and what registration,
     * lookup and COMMAND_NOT_FOUND all use. The string was a lossy projection
     * at one boundary: `split(" ")` is not its inverse once an argument
     * contains a space, so the commands most worth reacting to — a pasted key,
     * a path with spaces — were exactly the ones a handler mis-parsed.
     *
     * A list-backed group puts its chosen row here, not in `arg`: a theme name
     * is a NODE the palette listed, from a closed set, so `:theme set gruvbox`
     * is three segments. That makes every pick a distinct path, which is how a
     * handler knows WHICH theme — so match a namespace with `path[0]`, not a
     * whole-array compare.
     */
    path: string[]

    /**
     * The raw text typed after an input command, or undefined when the command
     * takes none — `"/some/dir"` for `:watch /some/dir`.
     *
     * Separate from `path` because it is a different KIND of thing: a segment
     * comes from a closed set and is matchable, an argument is arbitrary user
     * text. Folding it in would turn "did watch run" from an equality check
     * into a prefix test, and make every invocation its own path.
     *
     * ── The invariant this field rests on ───────────────────────────────────
     *
     * An input node TERMINATES traversal — `CommandInput` has no children, and
     * everything after it is taken as the argument verbatim, spaces included
     * (traverse.ts: `rawSegments.slice(i + 1).join(" ")`). So there is at most
     * one per path and it is always the tail, at whatever depth the input node
     * sits: `:watch <dir>` is depth 1, `:provider openrouter connect <key>` is
     * depth 3, and both put the whole remainder here.
     *
     * If the grammar ever admits MID-PATH arguments (`:agent <name> rename
     * <new>`), this field must change shape — one string cannot represent two.
     * That is a parser change, so it will be caught here rather than silently
     * producing a wrong `arg`.
     */
    arg?: string
    /**
     * How it was invoked: chosen in the command palette, or run by
     * `commands.run()`.
     *
     * Present so a handler can tell the user's action from its own — an
     * extension that reacts to every command by running another would otherwise
     * have no way to avoid recursing into itself.
     *
     * There is deliberately no `"key"`. A key bound to a command calls
     * `commands.run()` from its handler, so it IS an api call and reporting it
     * as its own source would be inventing a distinction the runtime cannot
     * actually make — a handler that checked for it would never match.
     */
    source: "palette" | "api"
}

/** `command:failed` — the above, plus what went wrong. */
export type CommandFailedPayload = CommandPayload & {
    /** The thrown value, exactly as it was thrown. */
    error: unknown
}

/**
 * Notification hooks — announcements of something that ALREADY happened.
 *
 * Handlers return void: nothing waits, and nothing they do can alter the event.
 * That is enforced by the signature rather than documented, so the question
 * "does the TUI block on this?" is answered by the type instead of by reading
 * the runtime. A handler needing async work owns it (`void doThing()`), which
 * keeps the fire-and-forget visible at the call site.
 *
 * There is deliberately no `tui:ready`. It existed, was typed, was documented,
 * and never fired — and the moment it is wired it is indistinguishable from
 * `tui:boot`, which already runs once registration is complete and gates the
 * terminal becoming interactive. Two hooks separated only by whether the screen
 * has painted is a distinction nothing in this API can act on.
 */
export type TuiNotifyHooks = {
    /**
     * The config was reloaded — `:reload`, or a file change.
     *
     * Fires on the NEW generation, after every registration is in place. The
     * old generation is already disposed and never sees it: its handlers went
     * with everything else it registered.
     *
     * Distinct from `tui:boot`, which also runs on a reload but gates it. Use
     * boot for setup that must finish first; use this to react to having been
     * reloaded — refreshing a cached palette, re-reading a file on disk.
     */
    "tui:reloaded": (payload: TuiReloadedPayload) => void

    /**
     * The terminal was resized.
     *
     * Fires after the new size is in effect, so `tui.size` and this payload
     * always agree. Coalesced by the underlying watcher: a drag produces the
     * sizes the terminal actually reported, not one event per column.
     */
    "tui:resize": (payload: TuiResizePayload) => void

    /**
     * Text was copied to the system clipboard.
     *
     * Fires after the copy is dispatched (OSC 52 plus the native fallback), for
     * a selection copy the user made in the terminal. Observational, like every
     * notify hook: a handler cannot alter or veto what was copied, and the
     * clipboard has already been written by the time it runs.
     *
     * It does NOT fire for an empty selection — copying nothing is not an
     * event — nor for text the user pastes, which is the opposite direction and
     * would need its own hook.
     */
    "tui:copy": (payload: TuiCopyPayload) => void

    /**
     * A key the TUI did not handle.
     *
     * ── Unhandled only, and never consumable ────────────────────────────────
     *
     * This fires at the END of dispatch — after reserved chords, after
     * `keys.register()` bindings, after mode keys. A key that did something
     * does not arrive here.
     *
     * That is not a limitation to route around; it is the only shape that can
     * be safe. User key handling is mounted as a WILDCARD, and wildcards fire
     * before exact-key handlers — so a hook able to consume a press would beat
     * every built-in binding, including the ctrl+c exit ladder. The reserved
     * list refuses those chords at registration precisely because a check at
     * press time is already too late.
     *
     * So there is no return value and no consumption: this observes, exactly
     * like every other notify hook. To OWN a key, register it —
     * `keys.register("ctrl+o", ...)` — which is checked against the reserved
     * set and cannot break the terminal.
     */
    "key:pressed": (payload: KeyPressedPayload) => void

    /**
     * A palette opened.
     *
     * Narrower than `mode:changed`, and deliberately its own event: not every
     * mode is a palette. `loading` is a spinner and `voice` is a capture state,
     * and an extension gating on "is the user picking something" has to exclude
     * them — a derivation every consumer would otherwise write, and get wrong
     * the same way.
     */
    "palette:opened": (payload: PalettePayload) => void

    /** A palette closed. Fires for whichever palette was open. */
    "palette:closed": (payload: PalettePayload) => void

    /**
     * A command finished successfully.
     *
     * Covers built-ins and user commands alike, however they were reached —
     * `source` says which. Fires AFTER the action resolves, so an async command
     * reports when it is genuinely done rather than when it started.
     */
    "command:ran": (payload: CommandPayload) => void

    /**
     * A command threw.
     *
     * Its own event rather than a field on `command:ran`, so a handler that
     * only cares about failures does not have to filter — and so the success
     * payload never carries an error slot that is null almost always.
     */
    "command:failed": (payload: CommandFailedPayload) => void

    /** An instance finished booting. */
    "agent:ready": (payload: AgentPayload) => void
    /** An instance shut down. */
    "agent:stopped": (payload: AgentPayload) => void
    /** A different instance came on screen. */
    "agent:focused": (payload: AgentPayload) => void
    /**
     * The focused agent's model changed — what `*` picks.
     *
     * Its own event because nothing else announces it. A pick rewrites
     * axon.config.ts and rebinds the live engine, but it boots nothing and
     * receives nothing, so `agent:ready` and `message:received` both stay
     * silent — and a line component declaring those as its triggers went on
     * showing the previous model until the next boot. The header updated
     * (it reads Vue state) while the component beside it did not, which is
     * what made the two disagree on screen.
     *
     * Fires after the choice is durable AND the running agent is rebound, so a
     * handler reading the model gets the one that will answer the next turn
     * rather than the one being replaced.
     */
    "agent:model": (payload: AgentModelPayload) => void

    /** The user sent a message. Fires once it is delivered. */
    "message:sent": (payload: MessageSentPayload) => void
    /**
     * The agent finished a wake.
     *
     * Carries no content on purpose. A payload with the model's reply would
     * reopen the consumption boundary through the back door — an extension
     * reacting to WHAT was said is writing an agent, which is a cognet's job.
     * This says only THAT a wake completed.
     */
    "message:received": (payload: MessageReceivedPayload) => void

    /**
     * The active mode changed.
     *
     * The general event; `palette:opened`/`closed` are the specific ones. Use
     * this to observe every transition (including `loading` and `voice`), those
     * to react to the user opening something to pick from.
     */
    "mode:changed": (payload: ModeChangedPayload) => void
}

/** Every lifecycle hook, gating and notifying. */
export type TuiHooks = TuiGateHooks & TuiNotifyHooks

export type TuiHookName = keyof TuiHooks

/**
 * Every hook name, as a VALUE — the vocabulary a registration is checked against.
 *
 * The type above says what is declarable; a type cannot be consulted at runtime,
 * so `tui.hook("agnet:ready", …)` from a plugin (untyped at the boundary, or
 * typed and ignored) registered a handler that could never fire and reported
 * nothing. The same hole let a built-in line component name a hook nothing
 * emits and simply go stale on screen.
 *
 * Kept beside the types deliberately: adding a hook means adding it in both
 * places, and `tests/extensions/builtin-components.test.ts` fails if this list
 * and the hooks the app actually raises ever disagree.
 */
export const TUI_HOOK_NAMES = [
    "tui:boot",
    "tui:shutdown",
    "tui:reloaded",
    "tui:resize",
    "tui:copy",
    "agent:ready",
    "agent:stopped",
    "agent:focused",
    "agent:model",
    "message:sent",
    "message:received",
    "mode:changed",
    "palette:opened",
    "palette:closed",
    "command:ran",
    "command:failed",
    "key:pressed",
] as const satisfies readonly TuiHookName[]

/**
 * Fails to compile if `TUI_HOOK_NAMES` is missing a hook.
 *
 * `satisfies` alone only proves every entry is a real name — it says nothing
 * about the ones left out, so adding a hook to `TuiHooks` and forgetting it
 * here would typecheck and then reject the new hook at runtime. This assigns
 * the union to the list's element type, which no longer holds the moment a
 * name is absent.
 */
const _everyHookIsListed: (typeof TUI_HOOK_NAMES)[number] = null as unknown as TuiHookName
void _everyHookIsListed

/**
 * A plugin file under `plugins/`.
 *
 * Plugins need no wrapper and no default export — `tui.hook(...)` at module
 * scope is the whole API, exactly as `main.ts` registers commands at module
 * scope. The file is hooks by convention rather than by ceremony, and there is
 * one way to reach every verb from every file in a profile.
 *
 * What separates a plugin from `setup()` is TIME, not capability: setup runs at
 * load, before anything is on screen, and is where registration belongs —
 * registering a command from a live hook would flicker it into a palette the
 * user is already looking at.
 *
 * A throwing handler disables its extension with a visible error. It never
 * takes the TUI down, and it is never silently swallowed.
 */
export type PluginModule = void

// ── Extensions ───────────────────────────────────────────────────────────────

/**
 * An extension's `extension.config.ts`.
 *
 * ── An extension is a profile, packaged ──────────────────────────────────────
 *
 * There is no `setup()`. An extension's behaviour lives in its `main.ts` and
 * its `plugins/`, registered at module scope, exactly as a user's own profile
 * does — same files, same globals, same moment. That symmetry is the point: a
 * user who has written a `main.ts` can publish it, and a reader who knows one
 * layout knows both.
 *
 * A `setup()` wrapper would have made the two differ for no gain. It exists on
 * `defineModule` because a module has data the loader must read WITHOUT
 * executing it — an options schema to validate, `emits` for typegen to merge,
 * env and policy requirements, sub-modules to flatten at manifest time. An
 * extension has none of that: its identity is package.json, and its behaviour
 * is registration.
 *
 * ── Then why does this file exist? ───────────────────────────────────────────
 *
 * It marks the directory as an extension. A kind is identified by its config
 * file (see detectKind), and `main.ts` cannot be that marker — a profile has
 * one, and so does half of npm.
 *
 * It is deliberately empty today. Keeping it means declarative, inspectable
 * per-extension data has somewhere to land later without a breaking change —
 * options schemas being the obvious candidate, if third-party configuration
 * ever needs a validated boundary rather than a user editing TypeScript.
 */
export type ExtensionConfig = {
    /**
     * Reserved. An extension declares nothing here yet — identity lives in
     * package.json and behaviour lives in main.ts.
     */
    readonly _reserved?: never
}

/** What `defineExtension()` returns. */
export type ExtensionDefinition = {
    _kind: "extension"
    config: ExtensionConfig
}

// ── Profile ──────────────────────────────────────────────────────────────────

/**
 * One inference source, as declared in `providers`.
 *
 * What a provider factory (`Axon()`, `Ollama()`, `HuggingFace()`) returns:
 * an identity plus whatever that source needs to be reachable. Deliberately
 * NOT a model — a provider answers "what can I supply", and which of those
 * fills which role is resolved at boot from the running cognet's declared
 * requirements.
 *
 * Credentials are absent by design. Axon holds a user's provider connections
 * in their account vault, which is what lets a deployed agent use the same
 * connection the terminal does and why a rotated token needs nothing
 * re-entered. `key` exists for the self-hosted case — a user running their
 * own box against their own endpoint has nobody to vault it with.
 */
export type ProviderEntry = {
    /** Which source: "axon", "codex", "openrouter", "ollama", "huggingface". */
    provider: string
    /**
     * Direct credential, for a user supplying their own rather than
     * connecting the account. Omitted means the vault answers.
     */
    key?: string
    /** Endpoint override — self-hosted daemons and local harnesses. */
    url?: string
    /**
     * Ceiling on concurrent calls through this provider.
     *
     * Present because a cognet that fans a role out will use every slot it is
     * given, and a user who has just plugged in a metered route should be
     * able to say how much of it a brain may spend at once without editing
     * the brain.
     */
    slots?: number
}

/**
 * A ceiling on what local inference may use.
 *
 * Sizes are strings with a unit — `"8GB"`, `"512MB"` — rather than raw bytes,
 * because this is a number a person writes and reads. A bare number would be
 * ambiguous at exactly the scale that matters.
 */
export type ResourceBudget = {
    /**
     * Video memory local models may occupy, total.
     *
     * Unparseable or absent means no ceiling. Deliberately permissive: a
     * budget that failed closed would refuse every load on a machine whose
     * owner made a typo, and the honest failure for "I could not read your
     * limit" is to behave as though none was set rather than to stop.
     */
    vram?: string
}

/**
 * One entry in `profile.config.ts`'s `extensions`.
 *
 * `"@axon/vim"` resolves from the registry and installs into the profile
 * frame; `"./extensions/sketch"` is a local directory. The object form lets an
 * extension be disabled without deleting its line — which is what makes this
 * editable by machine, the reason the enabled set is declared here rather than
 * being the side-effect of running code.
 */
export type ExtensionEntry =
    | string
    | {
        /** Registry specifier or local path. */
        source: string
        /** Default true. False keeps the entry but does not load it. */
        enabled?: boolean
    }

/**
 * A user's `profile.config.ts` — what is ENABLED, declaratively.
 *
 * Declarative rather than imperative registration calls specifically so it can
 * be edited by machine: installing an extension from Fleet or the CLI is a data
 * edit to this array, which is not possible when the enabled set is the
 * side-effect of running arbitrary code.
 *
 * Behaviour lives in `main.ts`; this file only says what loads.
 */
/** What the timeline shows. Every field optional; defaults applied at read. */
export type VerbosityProfile = {
    /** Session lifecycle events — quiet: errors only; normal (default): + info (reloads); verbose: + plumbing. */
    session?: "quiet" | "normal" | "verbose"
    /** Interleave kernel:* telemetry (runs, engine calls) into the timeline. Default false. */
    kernel?: boolean
    /** Interleave cognet:* telemetry (ticks, phases, systems). Default false. */
    cognet?: boolean
}

/**
 * The platform's own settings — a CLOSED, typed set.
 *
 * Closed on purpose. These are the keys the terminal itself acts on, so each
 * one has a meaning the platform enforces: `theme` names a registered theme,
 * `paths` are scanned for agents. An open bag would make "is this setting
 * doing anything?" unanswerable, which is the question a settings file exists
 * to answer.
 *
 * Extension settings live OUTSIDE this, as their own top-level key on the
 * profile config (`"@cody/vim": { leader: "," }`). Two reasons: an extension's
 * settings are its own contract rather than the platform's, and keeping them
 * out means adding a platform key can never collide with one an extension
 * already chose.
 */
export type ProfileSettings = {
    /** The active theme, by the name it was registered under. */
    theme?: string
    /**
     * Which glyph set line components draw their icons from.
     *
     * ── Why this is a SETTING and not code ──────────────────────────────────
     *
     * It answers "what does this machine's font support", which is a property
     * of the terminal rather than of the config. A shared line should look
     * right on a laptop with a patched font and on a server without one, and
     * that cannot be true if the answer is compiled into the line.
     *
     * ── Why the default is "auto" ───────────────────────────────────────────
     *
     * Nerd Fonts are the de facto standard — lualine, starship, powerlevel10k
     * and oh-my-posh all assume one — so defaulting them OFF would give the
     * majority a plainer bar than they installed a patched font for.
     *
     * But a font cannot be detected from inside a terminal, so "auto" is a
     * heuristic, not a fact: it reads the same environment the ecosystem uses
     * (TERM_PROGRAM, and whether a font name mentions "Nerd"), and falls back
     * to unicode when nothing says yes. Someone seeing boxes sets "unicode" and
     * is done; someone seeing plain text sets "nerd".
     */
    icons?: IconSet
    /**
     * Extra directories scanned for agent projects, beyond
     * `profiles/<email>/agents/`. `~` expands to the home directory.
     */
    paths?: string[]
    /** What the timeline shows. */
    verbosity?: VerbosityProfile
    /**
     * Blank space around the whole terminal UI, in cells.
     *
     * Shorthand for both axes: `padding-inline`/`padding-block` override it per
     * axis when present, so `{ padding: 1, "padding-inline": 4 }` reads as "one
     * row top and bottom, four columns each side".
     *
     * ── CSS names, spelled exactly ──────────────────────────────────────────
     *
     * This config layer speaks CSS — VTerm mimics browser CSS, and users write
     * scoped CSS in their own extensions. Where CSS already has a name for a
     * thing, these settings use it verbatim rather than a near-synonym, so
     * there is nothing to translate between what you write here and what you
     * write in a stylesheet. (VTerm implements only the physical longhands
     * internally, so these are expanded to `padding-top`/`-left`/... at the
     * layout that consumes them — an implementation detail of the renderer,
     * not a reason to rename the setting.)
     */
    padding?: number
    /** Columns of blank space at the left and right edges. Overrides `padding` horizontally. */
    "padding-inline"?: number
    /**
     * Rows of blank space added at the top and bottom edges. Overrides
     * `padding` vertically.
     *
     * ADDED to the layout's own one-row top offset rather than replacing it, so
     * 0 (the default) is the shipped look. The status line is the bottom edge
     * and sits flush by design; this is what lifts it off.
     */
    "padding-block"?: number
    /** Not wired to anything yet — kept for when it is. */
    telemetry?: boolean
}

/**
 * `profile.config.ts` — the one declarative source of truth for a terminal.
 *
 * Which extensions load, how the platform is configured, and whatever those
 * extensions were configured with. Written by hand AND edited surgically by
 * the terminal (`:theme set`, `axon ext install`) — so what you see in this
 * file is always what is in effect, with no second store that can disagree.
 *
 * Extension settings are top-level keys named after the extension, siblings of
 * `settings` rather than nested inside it:
 *
 *     export default defineProfile({
 *         extensions: ["@cody/vim"],
 *         settings: { theme: "ember" },
 *         "@cody/vim": { leader: "," },
 *     })
 */
export type ProfileConfig = {
    extensions?: ExtensionEntry[]
    /** Platform settings — see ProfileSettings. */
    settings?: ProfileSettings
    /**
     * The inference this user HAS — every agent on this profile inherits it.
     *
     *     providers: [Axon(), Codex(), Ollama(), HuggingFace()]
     *
     * A pool, never a wiring table. The user says what they have; a cognet
     * says what it needs, by names it made up; the runtime matches them. That
     * is the whole configuration step — there is deliberately no way to say
     * "use this model for that role", because a role name belongs to one
     * brain's private vocabulary and typing it here would couple a user's
     * profile to the internals of whatever cognet they happen to run.
     *
     * Each entry is a CATALOGUE, not a model: it answers "what can I supply",
     * so the model a role ends up on is chosen at boot rather than written
     * down. That is what lets one declaration serve every agent, and what
     * lets a user with no network run any cognet whose needs their local
     * models happen to cover.
     *
     * Order is preference, applied only among candidates that all satisfy a
     * requirement — it can never make an unusable model usable.
     */
    providers?: ProviderEntry[]

    /**
     * What local inference may use on this machine.
     *
     *     resources: { vram: "8GB" }
     *
     * A CEILING, not a reservation: nothing is held until a model is actually
     * loaded, and this only bounds how much may be. Absent means no ceiling —
     * local inference uses whatever the hardware has, which is the right
     * default for a machine whose owner has not said otherwise.
     *
     * Declared on the profile because that is where a user configures their
     * machine today. The BUDGET is a fact about hardware rather than about an
     * account, so the state it bounds is keyed by machine — two profiles on
     * one laptop share a GPU, and both must see the same free VRAM or both
     * will decide they have room for the same six gigabytes.
     */
    resources?: ResourceBudget
    /**
     * The machine-wide policy CEILING every agent on this profile runs under.
     *
     * A top-level key rather than a setting: `ProfileSettings` is the set the
     * TERMINAL acts on, and this is read by the runtime and enforced inside
     * the capsule. Folding it in would widen that set's meaning to "anything
     * configurable" and lose the boundary it draws.
     *
     * An agent narrows within this and can never widen it. Set `shell` to
     * `false` here and no agent on the machine gets a shell, whatever its own
     * axon.config.ts says. Set a rule to `"escalate"` and every agent asks you
     * — an agent author cannot suppress the prompt by allowing it.
     *
     *     policy: {
     *         shell: { allow: ["bun", "git"], raw: false },
     *         net:   { allow: ["api.anthropic.com:443"] },
     *         env:   { allow: ["GITHUB_TOKEN"] },
     *         tools: { github: "escalate" },
     *     }
     *
     * Silence is no opinion, never a denial: a capability neither layer
     * mentions falls through to the agent's own policy, so adding one rule
     * here cannot lock out everything else.
     */
    policy?: ProfilePolicy
    /**
     * Extension settings, keyed by the extension's own scoped name.
     *
     * Typed as unknown because the platform has no business knowing an
     * extension's shape — the extension reads and validates its own block.
     */
    [extension: `@${string}/${string}`]: unknown
}

/**
 * One capability's rule.
 *
 * `true` allows, `false` denies, `"escalate"` asks. The object form matches
 * the first string argument — a command, a host, a path — by glob, where `*`
 * stops at a `/` and `**` crosses it. Inside one rule the strictest matching
 * clause wins: deny, then escalate, then allow, regardless of the order they
 * are written in.
 *
 * Declared INLINE rather than imported from the policy module, because this
 * file is copied verbatim into profile type frames and a profile directory has
 * no node_modules for an import to resolve through. `tui-policy.test.ts`
 * asserts it stays structurally identical to the real `PolicyRule` — a drift
 * here means a config that typechecks and does not enforce.
 */
export type ProfilePolicyRule =
    | boolean
    | "escalate"
    | {
        allow?: string[]
        deny?: string[]
        escalate?: string[]
    }

/**
 * The subset of a capsule policy a PROFILE may declare.
 *
 * `fs` and `limits` are OS-layer facts (bind mounts, cgroups) rather than
 * per-call verdicts, and are taken from the profile wholesale when present —
 * a ceiling a bind mount ignores is not a ceiling.
 */
export type ProfilePolicy = {
    /**
     * OS confinement tier — Linux only, a no-op elsewhere. An agent may harden
     * beyond this but never drop below it.
     */
    isolation?: "none" | "auto" | "hardened"
    /** Filesystem view. Enforced by the mount namespace under `auto`/`hardened`. */
    fs?: {
        read?: string[]
        write?: string[]
    }
    /**
     * Network destinations. An allow/deny list of `host` or `host:port`, never
     * a glob map with verdicts — nftables filters addresses and cannot pause to
     * ask, so the shape matches what the kernel will actually do.
     */
    net?: {
        allow?: string[]
        deny?: string[]
        dns?: "allowlist" | "open" | "off"
    }
    /** Program execution. Names BINARIES, because a command string has four spellings. */
    shell?: {
        allow?: string[]
        deny?: string[]
        args?: Record<string, ProfilePolicyRule>
        /** Whether a shell (`sh -c`) may be invoked — the bypass, named. */
        raw?: boolean
        spawn?: ProfilePolicyRule | { rule?: ProfilePolicyRule; max?: number }
    }
    /** Host environment variables an agent may receive. Absent = none. */
    env?: {
        allow?: string[]
    }
    /** OS resource caps, applied to the whole process tree. */
    limits?: {
        memory?: string
        cpu?: string
        pids?: number
        disk?: string
        wall?: string
    }
    /** Tool namespaces, keyed by the name a tool registers under. */
    tools?: Record<string, ProfilePolicyRule>
}

/**
 * A glyph vocabulary.
 *
 * `nerd` is the full Nerd Font range — branch symbols, folder icons, the lot.
 * `unicode` is the subset present in essentially every font (▸ ● ◆), which
 * renders everywhere and reads as deliberate rather than degraded. `none`
 * drops icons entirely, for a bar that should be text and nothing else.
 */
export type IconSet = "auto" | "nerd" | "unicode" | "none"

/**
 * The named icons every set provides.
 *
 * Deliberately small and semantic: a component says what its value MEANS, and
 * the set decides what that looks like. Naming them after appearance
 * ("triangle") would tie every component to one set's vocabulary and defeat
 * the swap.
 */
export type IconName =
    | "agent"
    | "model"
    | "session"
    | "tokens"
    | "messages"
    | "modules"
    | "branch"
    | "changes"
    | "ahead"
    | "behind"
    | "folder"
    | "clock"
    | "user"
    | "warning"
    | "error"

/** What `defineProfile()` returns. */
export type ProfileDefinition = {
    _kind: "profile"
    config: ProfileConfig
}
