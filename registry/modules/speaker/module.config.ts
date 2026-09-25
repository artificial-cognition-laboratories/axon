/**
 * @axon/speaker — hearing's counterpart: the body's audio output.
 *
 * The module owns hardware only. It receives audio emitted by a cognet,
 * resolves the system output, and renders the bytes. Speech policy,
 * interruption, queueing, and TTS remain in the cognet.
 */
export default defineModule({
    options: {
        device: {
            type: "string" as const,
            default: "auto",
            required: false,
            description: "Output device: \"auto\", \"default\", or a platform-specific identifier.",
        },
    },
})
