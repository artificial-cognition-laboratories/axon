/**
 * @axon/mouse — the pointer, as a sense.
 *
 * The first HARDWARE module: it contributes no tools and no prompts, only a
 * plugin that opens a device and streams what it measures into the agent's
 * cognet. That is the shape every sensor module takes, and the reason it
 * works is that a module's `server/plugins/` is merged into the agent's own
 * — so a module plugin receives the full `axon` handle, including `stim()`,
 * exactly as an agent-local plugin does.
 *
 * WHY A PLUGIN AND NOT `setup()`. A module's `setup()` gets a narrow
 * boot-time handle (hooks, env, policy, routes) with no way to deliver a
 * sensation, and rightly so — setup is for wiring, not for streaming. A
 * sense is a long-lived process attached to a device, which is precisely
 * what a plugin already is.
 *
 * This makes hardware PORTABLE: any agent that lists this module gains a
 * pointer sense with no code of its own, and the channels appear on its I/O
 * timeline like any other.
 */
export default defineModule({
    options: {
        /**
         * X display to read. Absent uses $DISPLAY, which is right on a
         * desktop; a headless host or a second seat sets it explicitly.
         */
        display: {
            type: "string" as const,
            required: false,
            description: "X display to read the pointer from, e.g. \":0\". Defaults to $DISPLAY.",
        },
        /**
         * Sample rate. The pointer is SAMPLED rather than event-driven — a
         * still mouse still has a position, and a stream that reports only
         * motion cannot distinguish "not moving" from "not looking".
         */
        hz: {
            type: "number" as const,
            default: 20,
            required: false,
            description: "Samples per second. 20 reads as a curve rather than a series of jumps.",
        },
        /**
         * Channel prefix, so two pointers (two seats, two machines bridged
         * into one agent) can coexist without colliding. The address is the
         * agent's to choose; the module only guarantees what it means.
         */
        channel: {
            type: "string" as const,
            default: "/pointer",
            required: false,
            description: "Channel prefix. Emits <prefix>/position and <prefix>/buttons.",
        },
    },
})
