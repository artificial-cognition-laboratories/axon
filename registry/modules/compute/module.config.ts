/**
 * @axon/compute — the machine sensing itself.
 *
 * Interoception. Every other sense module points at the world: a camera
 * sees a room, a microphone hears a person. This one reports the body the
 * agent is actually running in — how hard it is working, how hot it is
 * getting, how much room it has left, and what it is moving in and out.
 *
 * ONE MODULE, NOT SIX. CPU, memory, disk, network, thermal and GPU are all
 * the same kind of thing: cheap, sparse, discovered rather than configured,
 * and always wanted together. Nobody installs "CPU but not RAM". That is
 * the opposite of camera and microphone, which are separate organs with
 * separate devices and separate failure modes, and which people genuinely
 * want one of without the other.
 *
 * IT REPORTS WHAT IT FINDS. No GPU means no GPU lanes; no swap means no
 * swap lane; a machine with one disk gets one disk lane. Nothing here is
 * required to exist, and nothing fails when it does not — the same "a body
 * has whatever it has" rule the device modules follow, applied to a body
 * nobody plugged in.
 *
 * THE AGENT'S OWN FOOTPRINT is a channel too (`/compute/self`). The other
 * readings describe the machine an agent happens to run on; that one
 * describes the process it IS. A mind that can watch its own memory climb
 * has the raw material to notice it is leaking, which is as close to
 * feeling unwell as a program gets.
 */
export default defineModule({
    options: {
        /**
         * Sample rate for the fast group — CPU load and clocks.
         *
         * 2Hz catches a spike that a 1Hz sample would average away, and
         * costs almost nothing: these are a few reads of /proc.
         */
        hz: {
            type: "number" as const,
            default: 2,
            required: false,
            description: "Samples per second for CPU load and clock.",
        },
        /**
         * Sample rate for the slow group — memory, disk, network, thermal,
         * GPU.
         *
         * Separate because thermal mass and disk throughput move in
         * seconds, and because the GPU reader shells a command. One rate
         * for everything would either oversample the slow things or
         * undersample the fast ones.
         */
        slowHz: {
            type: "number" as const,
            default: 1,
            required: false,
            description: "Samples per second for memory, disk, network, thermal and GPU.",
        },
        /** Channel prefix. Every reading arrives under this. */
        channel: {
            type: "string" as const,
            default: "/compute",
            required: false,
            description: "Channel prefix for all machine readings.",
        },
    },
})
