/**
 * @axon/camera — sight.
 *
 * Install it and the agent sees. Every option defaults and the device
 * defaults to `auto`, so `modules: ["@axon/camera"]` gives a working camera
 * on any machine with one.
 *
 * WHAT `auto` MEANS, and why it takes more work here than for a microphone.
 * ALSA has `default` — the OS already routes audio, so a mic module can
 * defer to a choice the user made in their sound settings. V4L2 has no
 * equivalent, so this module must genuinely choose, and existence is not
 * enough to choose on: a webcam typically registers TWO device nodes with
 * the SAME NAME, one that captures and one that carries metadata and yields
 * nothing. `auto` therefore picks the first node that reports a capture
 * format, which is a question only a probe can answer.
 *
 * NAME YOUR CAMERA, DO NOT NUMBER IT. `/dev/video0` is an accident of
 * enumeration order and moves when devices are replugged or the machine
 * reboots; `device: "C920"` is what the camera calls itself and does not
 * move. Paths are accepted for the cases where a name cannot disambiguate.
 *
 * A DEVICE THAT IS NOT THERE IS NOT AN ERROR. Webcams are unplugged, their
 * privacy shutters are closed, and on many machines the device node itself
 * disappears under USB power management. The module watches for one to
 * appear rather than failing at boot, and an agent with no camera simply
 * runs without sight.
 */
export default defineModule({
    options: {
        /**
         * Which camera.
         *   "auto"        — the first node that reports a capture format
         *   "C920"        — by name, case-insensitive substring
         *   "/dev/video2" — a specific node
         */
        device: {
            type: "string" as const,
            default: "auto",
            required: false,
            description: "Camera to open: \"auto\", a name like \"C920\", or a path like \"/dev/video2\".",
        },
        /**
         * Frames per second. 24 is smooth enough to read motion and cheap
         * enough to inline: every frame lands in the sensory ring as base64.
         */
        fps: {
            type: "number" as const,
            default: 24,
            required: false,
            description: "Frames per second.",
        },
        /**
         * Emitted frame width. Height follows the SOURCE aspect, so a
         * camera that only does 4:3 is not stretched into 16:9.
         *
         * Distinct from the sensor's own resolution, which is never
         * configured: this is a cost/detail dial, not a fact about hardware.
         */
        width: {
            type: "number" as const,
            default: 320,
            required: false,
            description: "Width of emitted frames in px. Height follows the camera's aspect.",
        },
        /** JPEG quality, ffmpeg's scale: 2 is best, 31 is worst. */
        quality: {
            type: "number" as const,
            default: 8,
            required: false,
            description: "JPEG quality, 2 (best) to 31 (worst).",
        },
        /** Channel this feed arrives on. Give each instance its own when listing several. */
        channel: {
            type: "string" as const,
            default: "cam0",
            required: false,
            description: "Channel for this camera.",
        },
    },
})
