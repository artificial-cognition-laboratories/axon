/**
 * outputs — what screens exist, and where they are.
 *
 * THE DECOUPLING LIVES HERE. An agent's config names a screen ("DP-2",
 * "primary"); it never states a resolution or a position. Those are facts
 * about the hardware right now, and the display server already publishes
 * them — so the module resolves them at boot rather than making the user
 * copy them into a config that silently rots the moment a monitor moves,
 * rotates, or changes resolution.
 *
 * The coupled alternative is what a first draft writes:
 * `{ x: 0, y: 563, width: 2560, height: 1440 }`. Correct for exactly one
 * arrangement of one desk, wrong forever after, and wrong SILENTLY —
 * capture keeps working and simply grabs the wrong region.
 *
 * Reads xrandr rather than an X11 binding: RandR's geometry is what the
 * user's own display settings speak, the CLI is present wherever X is, and
 * parsing one line of text is cheaper than binding a second library.
 */

export type Output = {
    /** RandR name — "DP-2", "HDMI-0". Stable across reboots and replugging. */
    name: string
    /** Whether the desktop treats this as the primary display. */
    primary: boolean
    width: number
    height: number
    /** Position in the root window, which is what a grab region needs. */
    x: number
    y: number
}

/** `2560x1440+0+563` — geometry as RandR states it. */
const GEOMETRY = /(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/

/**
 * Every connected output, in RandR's order.
 *
 * Disconnected outputs are excluded: a port with no monitor is not a screen
 * anyone can share, and offering it would produce a capture of nothing.
 */
export async function listOutputs(display?: string): Promise<Output[]> {
    const proc = Bun.spawn(["xrandr", "--query"], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...(display ? { DISPLAY: display } : {}) },
    })

    const text = await new Response(proc.stdout).text()
    await proc.exited

    const outputs: Output[] = []
    for (const line of text.split("\n")) {
        // "DP-2 connected primary 2560x1440+0+563 (normal ...) 597mm x 336mm"
        if (!/ connected/.test(line)) continue

        const geometry = GEOMETRY.exec(line)
        if (!geometry) continue

        const name = line.split(/\s+/)[0]
        if (!name) continue

        outputs.push({
            name,
            primary: / primary /.test(line),
            width: Number(geometry[1]),
            height: Number(geometry[2]),
            x: Number(geometry[3]),
            y: Number(geometry[4]),
        })
    }

    return outputs
}

/**
 * The whole desktop as one region — every output's bounding box.
 *
 * What `output: "all"` grabs. On a multi-monitor desk this includes the dead
 * space between differently-sized screens, which is honest: that is what the
 * root window contains, and pretending otherwise would mean silently
 * cropping one of the user's displays.
 */
export function boundingBox(outputs: Output[]): Output {
    const right = Math.max(...outputs.map(o => o.x + o.width))
    const bottom = Math.max(...outputs.map(o => o.y + o.height))
    return { name: "all", primary: false, x: 0, y: 0, width: right, height: bottom }
}

/**
 * Resolve a configured selector to a real region.
 *
 * Three forms, in the order a user reaches for them:
 *   "primary" — role, not identity. Survives replugging and reordering.
 *   "all"     — the whole desktop, every monitor in one frame.
 *   "DP-2"    — a specific output by RandR name.
 *
 * An unknown name throws with the list of what IS connected: a typo'd
 * output would otherwise capture nothing forever, and "no frames" is a much
 * worse error message than "no output named DP-3; found DP-0, DP-2".
 */
export function resolveOutput(outputs: Output[], selector: string): Output {
    if (outputs.length === 0) throw new Error("no connected outputs")

    if (selector === "all") return boundingBox(outputs)

    if (selector === "primary") {
        // A single-monitor setup often marks nothing primary; the only
        // screen is unambiguously the one meant.
        return outputs.find(output => output.primary) ?? outputs[0]!
    }

    const match = outputs.find(output => output.name === selector)
    if (!match) {
        throw new Error(`no output named "${selector}" — connected: ${outputs.map(o => o.name).join(", ")}`)
    }
    return match
}
