/**
 * @axon/microphone — hearing.
 *
 * Install it and talk. Every option defaults, and the device defaults to
 * `auto`, so `modules: ["@axon/microphone"]` gives a working microphone on
 * any machine with one. Being specific is available and never required.
 *
 * WHAT `auto` MEANS. The system's own default capture device — which on a
 * modern Linux desktop routes through PipeWire or PulseAudio to whatever
 * the user chose in their sound settings. The module does not second-guess
 * that: picking a card itself would silently override a decision the user
 * already made. If there is no routing daemon it falls back to the first
 * hardware card that actually opens, and if nothing opens the agent simply
 * runs without hearing.
 *
 * A module that resolves a device for you owes you ONE thing in return:
 * saying which one it picked. This logs it at boot, because `auto` is only
 * trustworthy when it is legible afterwards.
 */
export default defineModule({
    options: {
        /**
         * Which microphone.
         *   "auto"    — the system default, then the first card that opens
         *   "default" — the system default, and nothing else
         *   "hw:1,0"  — a specific ALSA device
         */
        device: {
            type: "string" as const,
            default: "auto",
            required: false,
            description: "Microphone to open: \"auto\", \"default\", or an ALSA device like \"hw:1,0\".",
        },
        /**
         * Sample rate. 16kHz is what speech models want and what every mic
         * provides cheaply; raising it costs ring bytes for detail no
         * speech pipeline uses.
         */
        rate: {
            type: "number" as const,
            default: 16_000,
            required: false,
            description: "Samples per second. 16000 is what speech models expect.",
        },
        /**
         * Frame length. 32ms is a common analysis window and small enough
         * that a mind hears a sound while it is still happening.
         */
        frameMs: {
            type: "number" as const,
            default: 32,
            required: false,
            description: "Milliseconds of audio per emitted frame.",
        },
        /** Channel this feed arrives on. Give each instance its own when listing several. */
        channel: {
            type: "string" as const,
            default: "mic0",
            required: false,
            description: "Channel for this microphone.",
        },
    },
})
