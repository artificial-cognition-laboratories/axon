/**
 * @axon/screenshare — the screen, as a sense.
 *
 * A video feed of what is on a display, which is the sense a computer-use
 * agent runs on: it sees what the user sees.
 *
 * WHAT IS CONFIGURED AND WHAT IS NOT. The agent names a screen; it never
 * states where that screen is or how big it is. Position, resolution and
 * orientation are facts about the hardware right now, published by the
 * display server, and resolved at boot — so moving a monitor, rotating it,
 * or changing its resolution needs no config change. A config carrying
 * `{ x: 0, y: 563, width: 2560 }` is correct for one arrangement of one desk
 * and silently wrong after any change to it.
 *
 * TWO SCREENS ARE TWO FEEDS. List the module twice:
 *
 * ```ts
 * modules: [
 *     [Screen, { output: "DP-2", channel: "/screen/main" }],
 *     [Screen, { output: "DP-0", channel: "/screen/side", fps: 1 }],
 * ]
 * ```
 *
 * The module's code is scanned once and its plugin runs once; the plugin
 * reads every instance through `axon.modules.all()` and opens one capture
 * each. The platform invents no identity for the instances — what makes two
 * screens different is which output they are, and only this module knows
 * that.
 */
export default defineModule({
    options: {
        /**
         * Which screen. Three forms:
         *   "primary" — role, not identity: survives replugging and reorder
         *   "all"     — the whole desktop, every monitor in one frame
         *   "DP-2"    — a specific output, by its RandR name
         */
        output: {
            type: "string" as const,
            default: "primary",
            required: false,
            description: "Screen to capture: \"primary\", \"all\", or an output name like \"DP-2\".",
        },
        /**
         * Frames per second. Low by default: a screen changes far less than
         * a camera scene, and every frame is inlined into the sensory ring.
         * 2fps is enough to follow interaction and costs ~40x less than 24.
         */
        fps: {
            type: "number" as const,
            default: 2,
            required: false,
            description: "Frames per second. 2 follows interaction cheaply; raise for motion.",
        },
        /**
         * Emitted frame width. Height follows the SOURCE aspect, so a
         * rotated monitor stays rotated.
         *
         * Distinct from the screen's own resolution, which is never
         * configured: this is a cost/detail dial, not a fact about hardware.
         */
        width: {
            type: "number" as const,
            default: 960,
            required: false,
            description: "Width of emitted frames in px. Height follows the screen's aspect.",
        },
        /** JPEG quality, ffmpeg's scale: 2 is best, 31 is worst. */
        quality: {
            type: "number" as const,
            default: 8,
            required: false,
            description: "JPEG quality, 2 (best) to 31 (worst).",
        },
        /** Channel this feed arrives on. Two instances must differ here. */
        channel: {
            type: "string" as const,
            default: "/screen",
            required: false,
            description: "Channel for this feed. Give each instance its own when capturing several screens.",
        },
        /** X display. Absent uses $DISPLAY. */
        display: {
            type: "string" as const,
            required: false,
            description: "X display to capture from, e.g. \":0\". Defaults to $DISPLAY.",
        },
    },
})
