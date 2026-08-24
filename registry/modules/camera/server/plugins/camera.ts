import { VideoCapture } from "../../src/capture"
import { resolveDevice } from "../../src/devices"

/**
 * One capture per configured camera.
 *
 * Runs ONCE however many times the module is listed — multiplicity lives in
 * the options, and `axon.modules.all()` is how this one run learns it has
 * several cameras to open.
 *
 * Streams every frame the sensor produces, unjudged. No motion detection,
 * no keyframing, no "this looks like the last one" — all of those are
 * perception, and perception belongs to the mind.
 */

type CameraOptions = {
    device?: string
    fps?: number
    width?: number
    quality?: number
    channel?: string
}

/** How often to look for a camera that was not there a moment ago. */
const RETRY_MS = 3_000

const CAMERAS = Symbol.for("axon.camera.captures")
type Cameras = {
    /** The runtime receiving frames — swapped on reload, never re-created. */
    target: { stim: (type: "cognet:stimulus:visual", data: Record<string, unknown>) => Promise<unknown> } | null
    stop: () => void
}
const store = globalThis as typeof globalThis & { [CAMERAS]?: Cameras }

export default defineAxonPlugin(axon => {
    const running = store[CAMERAS]
    if (running) {
        // A hot reload re-runs plugins in the same process. The devices stay
        // open and keep streaming; only the runtime they feed changes.
        // Re-opening would close and re-acquire an EXCLUSIVE device for no
        // reason, which is how a reload becomes a failure.
        running.target = axon
        return
    }

    const instances = axon.modules.all<CameraOptions>("camera")
    const teardowns: Array<() => void> = []

    for (const options of instances) {
        const selector = options.device ?? "auto"
        const channel = options.channel ?? "cam0"

        let capture: ReturnType<typeof VideoCapture> | null = null
        let retry: ReturnType<typeof setTimeout> | null = null
        let shut = false
        /**
         * Whether the absent state has been reported since it last changed.
         * Silence while absent keeps a machine with no camera from logging
         * the same sentence every three seconds — but TOTAL silence is
         * worse, being indistinguishable from a plugin that failed to load.
         * Said once per transition.
         */
        let reportedAbsent = false

        teardowns.push(() => {
            shut = true
            if (retry) clearTimeout(retry)
            capture?.stop()
            capture = null
        })

        /**
         * Attach for as long as there is something to attach to, then look
         * again.
         *
         * A camera is not like a microphone: on many machines the device
         * node itself appears and disappears with a privacy switch or USB
         * power management, so "no camera at boot" is a temporary answer
         * rather than a permanent one. Checking once would leave a camera
         * switched on thirty seconds into a run invisible for the whole
         * session, and the body's job is to report what is there NOW.
         */
        const attach = async (): Promise<void> => {
            if (shut) return

            const device = await resolveDevice(selector)
            if (!device) {
                if (!reportedAbsent) {
                    reportedAbsent = true
                    console.warn(`[camera] ${channel}: no camera for "${selector}" — watching for one every ${RETRY_MS / 1000}s`)
                }
                retry = setTimeout(() => void attach(), RETRY_MS)
                return
            }

            try {
                capture = VideoCapture({
                    device: device.path,
                    fps: options.fps ?? 24,
                    width: options.width ?? 320,
                    quality: options.quality ?? 8,
                })
            } catch (cause) {
                if (!reportedAbsent) {
                    reportedAbsent = true
                    console.warn(`[camera] ${channel}: ${cause instanceof Error ? cause.message : String(cause)}`)
                }
                capture = null
                retry = setTimeout(() => void attach(), RETRY_MS)
                return
            }

            const active = capture
            void (async () => {
                let announced = false
                for await (const frame of active.frames()) {
                    // Announced on the FIRST FRAME, never at spawn: a device
                    // node can exist and still refuse to open (busy,
                    // unplugged mid-run, no permission), and claiming to
                    // watch before a frame arrived is a claim the body
                    // cannot yet make. This is also where `auto` becomes
                    // legible — a module that resolves a device for you owes
                    // you the name of the one it picked.
                    if (!announced) {
                        announced = true
                        reportedAbsent = false
                        console.log(`[camera] ${channel} ← ${device.name} (${device.path}) @ ${options.fps ?? 24}fps`)
                    }

                    await cameras.target?.stim("cognet:stimulus:visual", {
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
                // Losing an eye is not losing the mind: say so once, then go
                // back to looking. Reported through the same
                // once-per-transition flag as an absent device, since a
                // camera held by another process fails identically every
                // few seconds.
                if (shut || reportedAbsent) return
                reportedAbsent = true
                console.warn(`[camera] ${channel} lost — ${cause instanceof Error ? cause.message : String(cause)}`)
            }).finally(() => {
                if (shut) return
                capture = null
                retry = setTimeout(() => void attach(), RETRY_MS)
            })
        }

        void attach()
    }

    const cameras: Cameras = {
        target: axon,
        stop: () => {
            for (const teardown of teardowns) teardown()
        },
    }
    store[CAMERAS] = cameras

    axon.hooks.hook("shutdown:before", () => {
        // A reload fires this too and must NOT stop the captures — they
        // outlive any one runtime. Detach only; the next runtime re-points
        // `target`. Process exit takes ffmpeg with it, being a child.
        if (cameras.target === axon) cameras.target = null
    })
})
