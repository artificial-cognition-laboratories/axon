import { run, type MockContext, type MockTurn } from "@arcforge/engines/mock"
import { CODE_SAMPLE, LOREM, MARKDOWN_SAMPLE, THOUGHTS, UNICODE_SAMPLE, WIDE_SAMPLE } from "./samples"

/**
 * One simulated behaviour, addressed by a leading slash word.
 *
 * A command is a function of the tick, not a canned string, because the
 * point of this agent is watching a loop RUN — `/log` is only interesting
 * because tick 0 acts and tick 1 sees the result. A map of patterns to
 * replies could not express that, and a fixed-length sequence could not
 * express `/loop 5`.
 */
export type Command = {
    /** One line, shown by `/help`. Written for someone deciding what to type next. */
    readonly summary: string
    /** Shown by `/help` when the command takes an argument. */
    readonly usage?: string
    /**
     * What the model does on this tick. Return a bare step to end the turn,
     * or `{ step, continue: true }` to wake again and keep the loop going.
     */
    turn(ctx: CommandContext): MockTurn
}

/** What a command knows: where it is in the loop, and what followed its name. */
export type CommandContext = MockContext & {
    /** Everything after the command word, trimmed. Empty string when absent. */
    readonly arg: string
}

/**
 * Reads a positive integer argument, falling back when it is absent or junk.
 *
 * Deliberately lenient: this agent is driven by a human typing into a
 * terminal, and `/loop five` should show a loop rather than an error about
 * argument parsing. A mock that is fussy about its own input is a mock
 * nobody reaches for.
 */
function count(arg: string, fallback: number, max: number): number {
    const parsed = Number.parseInt(arg, 10)
    if (!Number.isFinite(parsed) || parsed < 1) return fallback
    return Math.min(parsed, max)
}

// ── Output rendering ────────────────────────────────────────────────────────
// What the surface does with text the agent speaks. Every one of these is a
// single tick: there is no loop to watch, only a render to look at.

const hello: Command = {
    summary: "Reply with a short greeting. The smoke test.",
    turn: () => "Hello world!",
}

const markdown: Command = {
    summary: "Speak a document using every common markdown construct.",
    turn: () => MARKDOWN_SAMPLE,
}

const code: Command = {
    summary: "Speak fenced code blocks in several languages.",
    turn: () => CODE_SAMPLE,
}

const long: Command = {
    summary: "Speak a long reply. Exercises scrollback and wrapping.",
    usage: "/long [paragraphs]",
    turn: ({ arg }) => {
        const paragraphs = count(arg, 8, 200)
        return Array.from({ length: paragraphs }, (_, i) => `**Paragraph ${i + 1}.** ${LOREM}`).join("\n\n")
    },
}

const wide: Command = {
    summary: "Speak content wider than the pane. Exercises horizontal overflow.",
    turn: () => WIDE_SAMPLE,
}

const unicode: Command = {
    summary: "Speak emoji, CJK, RTL, combining marks and box drawing.",
    turn: () => UNICODE_SAMPLE,
}

// ── Loop shape ──────────────────────────────────────────────────────────────
// The reason this agent exists. Each of these takes more than one tick, so
// what you watch is the runtime's act→observe→speak arc rather than a string.

const log: Command = {
    summary: "Run a console.log in the capsule, then report what it printed.",
    turn: ({ tick }) => tick === 0
        ? { step: run(`console.log("hello from the capsule")`), continue: true }
        : "That ran in the capsule — its output came back to me on the next tick, and this is me reading it.",
}

const tool: Command = {
    summary: "Call a real tool, see the result, then speak about it.",
    turn: ({ tick }) => tick === 0
        ? { step: run(`await process.run("echo axon")`), continue: true }
        : "The command ran under this agent's real policy. Its result entered the session log, and I read it back on this tick.",
}

const loop: Command = {
    summary: "Take a given number of visible loop ticks before finishing.",
    usage: "/loop [ticks]",
    turn: ({ tick, arg }) => {
        const total = count(arg, 3, 50)
        const step = `Tick ${tick + 1} of ${total}.`
        return tick + 1 < total ? { step, continue: true } : `${step} Done — the loop stops here.`
    },
}

const think: Command = {
    summary: "Take several reasoning-shaped ticks without acting.",
    usage: "/think [ticks]",
    turn: ({ tick, arg }) => {
        const total = count(arg, 4, 50)
        const step = THOUGHTS[Math.min(tick, THOUGHTS.length - 1)]!
        return tick + 1 < total ? { step, continue: true } : `${step} That is as far as it goes.`
    },
}

const fail: Command = {
    summary: "Throw inside the capsule. Exercises the error path.",
    turn: () => run(`throw new Error("mock: this failure is deliberate")`),
}

// ── Timing ──────────────────────────────────────────────────────────────────
// How the surface behaves while output is arriving rather than after.

/**
 * Output that arrives gradually rather than at once.
 *
 * Note this is MANY TICKS, not a slowed-down stream. Per-token pacing is a
 * `Mock()` construction argument (`tokenms`), so nothing a command returns
 * can change it — a `/slow` that claimed to throttle the stream would be
 * naming a mechanism it does not touch. Successive ticks are the real way to
 * make output trickle in, and it exercises the same thing worth watching:
 * the surface holding a turn open while more keeps coming.
 */
const slow: Command = {
    summary: "Deliver a reply gradually, one line per tick.",
    usage: "/slow [lines]",
    turn: ({ tick, arg }) => {
        const total = count(arg, 6, 50)
        const step = `${tick + 1}. ${LOREM}`
        return tick + 1 < total ? { step, continue: true } : `${step}\n\nThat is the last line.`
    },
}

const burst: Command = {
    summary: "Speak one short line with nothing to stream.",
    turn: () => "Done.",
}

// ── The set ─────────────────────────────────────────────────────────────────

/**
 * Every command, keyed by the word you type. `/help` renders itself from
 * this, so a command added here documents itself without a second edit.
 */
export const commands: Record<string, Command> = {
    hello,
    markdown,
    code,
    long,
    wide,
    unicode,
    log,
    tool,
    loop,
    think,
    fail,
    slow,
    burst,
    help: {
        summary: "List every command.",
        turn: () => renderHelp(),
    },
}

/** Renders the command list as a markdown table, in declaration order. */
export function renderHelp(): string {
    const rows = Object.entries(commands)
        .map(([name, command]) => `| \`${command.usage ?? "/" + name}\` | ${command.summary} |`)
        .join("\n")

    return [
        "**Mock agent** — a deterministic agent for exercising surfaces that talk to Axon.",
        "",
        "| Command | What it does |",
        "| --- | --- |",
        rows,
        "",
        "Anything else is echoed back verbatim.",
    ].join("\n")
}
