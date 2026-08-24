import { Pointer } from "../../src/pointer"

/**
 * The pointer, wired to whatever agent installed this module.
 *
 * A module's `server/plugins/` is merged into the agent's own, so this file
 * receives the full `axon` handle — including `stim()`, which is what makes
 * a sense expressible as a module at all. `setup()` could not do this: its
 * handle is boot-time wiring (hooks, env, policy, routes) with no door to
 * cognition, and a sense is a long-lived attachment to a device rather than
 * a piece of wiring.
 *
 * Two channels from one device, because they are two measurements. Position
 * is continuous and in pixels; buttons are discrete and unitless. Folding
 * them into one six-component reading would put incommensurable numbers on
 * a shared axis — and a multi-trace lane normalises across components, so a
 * button flicking 0→1 would rescale a 4000px axis to nothing.
 *
 * ONE READING IS ONE QUANTITY. A device may report several.
 */

type MouseOptions = {
    display?: string
    hz?: number
    channel?: string
}

const POINTER = Symbol.for("axon.mouse.pointer")
type PointerStore = {
    /** The runtime receiving readings — swapped on reload, never re-created. */
    target: { stim: (type: "cognet:stimulus:vector", data: Record<string, unknown>) => Promise<unknown> } | null
    stop: () => void
}
const store = globalThis as typeof globalThis & { [POINTER]?: PointerStore }

export default defineAxonPlugin(axon => {
    const running = store[POINTER]
    if (running) {
        // A hot reload re-runs plugins in the same process. The device stays
        // open and the loop keeps running; only the runtime it feeds
        // changes. Re-opening would mean closing and re-acquiring a device
        // for no reason, which on exclusive hardware is how a reload becomes
        // a failure.
        running.target = axon
        return
    }

    // The agent's configuration, validated against this module's declared
    // schema. Defaults are applied by the loader, so an agent that
    // configured nothing still lands on the documented values.
    const options = axon.modules.options<MouseOptions>("mouse")
    const hz = options.hz ?? 20
    const prefix = options.channel ?? "/pointer"

    let pointer: ReturnType<typeof Pointer>
    try {
        pointer = Pointer(options.display)
    } catch (cause) {
        // No X display is ordinary on a server, or under Wayland without
        // XWayland. An honest partial body — the agent runs, and nothing
        // downstream is told a pointer exists.
        const reason = cause instanceof Error ? cause.message : String(cause)
        console.warn(`[mouse] no pointer — ${reason}`)
        return
    }

    console.log(`[mouse] tracking on ${pointer.size.width}x${pointer.size.height} @ ${hz}Hz → ${prefix}`)

    let sampling = false
    const clock = setInterval(() => {
        // Skipped rather than queued if the previous sample is still in
        // flight: a missed position is a missed position, and catching up
        // would deliver a stale reading stamped with a fresh time.
        if (sampling) return
        sampling = true

        void (async () => {
            const state = pointer.read()
            // Pointer on another screen — a real state, and one nothing
            // measured, so nothing is reported.
            if (!state) return

            await pointerStore.target?.stim("cognet:stimulus:vector", {
                channel: `${prefix}/position`,
                values: [state.x, state.y],
                unit: "px",
                labels: ["x", "y"],
                profile: "pointer.position",
            })

            await pointerStore.target?.stim("cognet:stimulus:vector", {
                channel: `${prefix}/buttons`,
                values: state.buttons,
                // No unit: a button is a state, not a quantity of anything.
                // Absent is more honest than inventing "bool".
                labels: ["left", "middle", "right", "back", "forward"],
                profile: "pointer.buttons",
            })
        })().catch((cause: unknown) => {
            console.error("[mouse] sampling stopped:", cause)
        }).finally(() => {
            sampling = false
        })
    }, 1000 / hz)

    const pointerStore: PointerStore = {
        target: axon,
        stop: () => {
            clearInterval(clock)
            pointer.close()
        },
    }
    store[POINTER] = pointerStore

    axon.hooks.hook("shutdown:before", () => {
        // A reload fires this too and must NOT stop the clock — the capture
        // outlives any one runtime. Detach only; the next runtime re-points
        // `target` at itself. Process exit closes the display.
        if (pointerStore.target === axon) pointerStore.target = null
    })
})
