import { ScreenCapture } from "../../src/capture"
import { listOutputs, resolveOutput } from "../../src/outputs"

/**
 * One capture per configured screen.
 *
 * This plugin runs ONCE however many times the module is listed — the
 * module's files are scanned once, and multiplicity lives entirely in the
 * options. `axon.modules.all()` is how this one run learns it has two
 * screens to open.
 *
 * That is the whole reason the platform does not invent instance identity:
 * what distinguishes two screens is which output they are, which is a fact
 * only this module can interpret. It derives its own channels from its own
 * options, and the runtime never has to model "instance 0" and "instance 1".
 */

type ScreenOptions = {
    output?: string
    fps?: number
    width?: number
    quality?: number
    channel?: string
    display?: string
}

const SCREENS = Symbol.for("axon.screenshare.captures")
type Screens = {
    /** The runtime receiving frames — swapped on reload, never re-created. */
    target: { stim: (type: "cognet:stimulus:visual", data: Record<string, unknown>) => Promise<unknown> } | null
    stop: () => void
}
const store = globalThis as typeof globalThis & { [SCREENS]?: Screens }

export default defineAxonPlugin(async axon => {
    const running = store[SCREENS]
    if (running) {
        // A hot reload re-runs plugins in the same process. The captures stay
        // open and keep streaming; only the runtime they feed changes.
        running.target = axon
        return
    }

    const instances = axon.modules.all<ScreenOptions>("screenshare")

    // Resolved once, at boot: the geometry of every connected screen. This is
    // the step that lets a config name a screen without describing it.
    const display = instances[0]?.display ?? process.env.DISPLAY ?? ":0"
    let outputs: Awaited<ReturnType<typeof listOutputs>>
    try {
        outputs = await listOutputs(display)
    } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause)
        console.warn(`[screen] cannot read outputs — ${reason}`)
        return
    }

    if (outputs.length === 0) {
        console.warn(`[screen] no connected outputs on ${display} — running without screen sense`)
        return
    }

    const captures: Array<{ stop: () => void }> = []

    for (const options of instances) {
        const selector = options.output ?? "primary"
        const channel = options.channel ?? "/screen"

        let region
        try {
            region = resolveOutput(outputs, selector)
        } catch (cause) {
            // A named output that is not connected is a config error worth
            // saying out loud — capture would otherwise be silent forever
            // and "no frames" is a far worse message than "no output DP-3".
            console.warn(`[screen] ${channel}: ${cause instanceof Error ? cause.message : String(cause)}`)
            continue
        }

        let capture: ReturnType<typeof ScreenCapture>
        try {
            capture = ScreenCapture({
                region,
                display,
                fps: options.fps ?? 2,
                width: options.width ?? 960,
                quality: options.quality ?? 8,
            })
        } catch (cause) {
            console.warn(`[screen] ${channel}: ${cause instanceof Error ? cause.message : String(cause)}`)
            continue
        }

        captures.push(capture)
        console.log(`[screen] ${channel} ← ${region.name} ${region.width}x${region.height} @ ${options.fps ?? 2}fps`)

        void (async () => {
            for await (const frame of capture.frames()) {
                await screens.target?.stim("cognet:stimulus:visual", {
                    channel,
                    ref: {
                        uri: `data:image/jpeg;base64,${Buffer.from(frame).toString("base64")}`,
                        mime: "image/jpeg",
                        bytes: frame.byteLength,
                    },
                    kind: "image",
                })
            }
        })().catch((cause: unknown) => {
            // A screen that stops says so once. Losing one feed is not losing
            // the others, and never the agent.
            console.error(`[screen] ${channel} stopped:`, cause instanceof Error ? cause.message : cause)
        })
    }

    const screens: Screens = {
        target: axon,
        stop: () => {
            for (const capture of captures) capture.stop()
        },
    }
    store[SCREENS] = screens

    axon.hooks.hook("shutdown:before", () => {
        // A reload fires this too and must NOT stop the captures — they
        // outlive any one runtime. Detach only; the next runtime re-points
        // `target`. Process exit takes ffmpeg with it, being a child.
        if (screens.target === axon) screens.target = null
    })
})
