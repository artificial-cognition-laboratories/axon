/**
 * Stimuli — the sense protocol. Every environment event that can trigger
 * cognition enters through this vocabulary and no other path.
 *
 * ZERO COGNITION HAPPENS BEFORE THE COGNET. This is the invariant the whole
 * namespace exists to protect. A stimulus is raw sense data, and nothing
 * upstream of the brain may judge, rank, filter, or interpret it — those are
 * brain functions, and a runtime that performs them has moved part of the
 * mind outside the mind. Selective attention, salience, novelty detection,
 * sensor fusion: all real, all cognition, all implemented INSIDE a cognet by
 * whoever wants them. The kernel's job is delivery, not perception.
 *
 * DESIGN RULES (what keeps this file from growing forever):
 *
 * 1. Top-level types are INFORMATION KINDS, not sensors. Symbolic language,
 *    sound, light, measured fields — new hardware maps into an existing
 *    kind (ROS sensor_msgs discipline: the core set outlives every vendor).
 *    "Measured quantity" is one kind however many components it has — a
 *    thermometer and a nine-axis IMU differ in array length, not in type.
 *    A new top-level type here is a once-per-epoch event, like a syscall.
 *
 * 2. Heavy payloads NEVER cross this protocol. A stimulus is a small fact: a
 *    `ref` into content-addressed storage / a device buffer, plus an optional
 *    inline digest the cognet may fold without fetching bytes. MB/s sense
 *    streams live below this protocol as devices, and what a cognet does with
 *    a `ref` — fetch it, ignore it, sample one in ten — is a cognet decision.
 *
 *    NO CULLING HAPPENS HERE. A producer delivers what its sensor produced;
 *    it does not decide what was worth delivering. If a dense stream needs
 *    thinning, the thing doing the thinning is cognition and belongs inside a
 *    cognet, not upstream of one.
 *
 * 3. Stimuli are EXTEROCEPTION — the world reaching the agent. Internal
 *    news (timers, process exits) also wakes a cognet but is interoception:
 *    machine-body vocabulary, defined with the machine, not here. The wake
 *    mask spans both; this namespace stays senses-only.
 *
 * 4. Stimulushood is a DELIVERY ROLE, not a type property. These are log
 *    entries like any other; the scheduler wakes a cognet when an entry is
 *    (a) in its wake mask and (b) foreign to its own execution (provenance
 *    check via context.runId — a brain never wakes to its own echo).
 */

import type { AxonEventUnion } from "../../envelope"
import { SENSORY_EVENTS } from "./shared"
import type { AxonChannel, AxonTextFormat, StimulusRef } from "./shared"

// ── The sense set ─────────────────────────────────────────────────────────────

/**
 * The stimulus registry — log entries, wake-capable by default.
 *
 * Four kinds, chosen to generalize:
 *   text    — symbolic language (native modality of an LLM)
 *   audio   — sound over time (speech, ambient) — digest is the transcript
 *   visual  — light: frames and clips — digest is the caption/percept
 *   vector  — measured quantities: touch, heat, pose, battery, joint
 *             angles, an IMU, a lidar scan. One kind, always an array,
 *             open channel vocabulary — this is what stops sense-set
 *             sprawl, because a new sensor is new NUMBERS, never a new
 *             kind.
 */
export type AxonStimulusEvent = {
    /** Symbolic language input. Inline — text IS its own digest. */
    "cognet:stimulus:text": {
        channel: AxonChannel
        content: string
        /** how to read it — "json", "markdown"; absent = plain prose */
        format?: AxonTextFormat
    }

    /** An audio segment. Bytes stay behind `ref`; `transcript` is an optional inline digest. */
    "cognet:stimulus:audio": {
        channel: AxonChannel
        ref: StimulusRef
        /** inline digest, when the producer already had one — never a summary it computed */
        transcript?: string
        durationMs?: number
    }

    /** A frame or clip. Bytes stay behind `ref`; `caption` is an optional inline digest. */
    "cognet:stimulus:visual": {
        channel: AxonChannel
        ref: StimulusRef
        /** inline digest, when the producer already had one — never a summary it computed */
        caption?: string
        kind: "image" | "video"
    }

    /**
     * A measurement — one instrument, one instant, one to many numbers.
     *
     * Touch, heat, pose, battery, joint angles, an IMU, a mouse position, a
     * lidar scan. Everything the world reports as quantity rather than as
     * sound, light, or language.
     *
     * ALWAYS AN ARRAY, even for a thermometer. A scalar is a vector of
     * length one, and admitting both shapes would put
     * `Array.isArray(v) ? v : [v]` at the top of every renderer, every fold,
     * and every bridge forever. The boundary is also unstable in the
     * direction real systems travel: one GPU's temperature is one number
     * until a second GPU arrives, and under a union that is a silent shape
     * change nobody validated. One shape, always.
     *
     * THE VALUES ARE ONE SAMPLE. Nine core temperatures read at one instant
     * belong together, and nine separate stimuli could never say so — the
     * mind would be left to guess which readings were simultaneous. This is
     * the whole reason the kind is a vector rather than a scalar: atomicity
     * is a property of the measurement, and only the instrument knows it.
     *
     * Deliberately carries no judgment about why the reading was sent. A
     * producer emits what it measured; deciding which readings matter is the
     * cognet's, and only the cognet's.
     */
    "cognet:stimulus:vector": {
        channel: AxonChannel
        /** the measurement — one sample, one or more components */
        values: number[]
        /** what the numbers are in when every component shares one, e.g. "°C", "m/s²", "px" */
        unit?: string
        /**
         * Per-component units, same length as `values` — for readings whose
         * components genuinely differ.
         *
         * Not an edge case: it is the norm the moment you leave a
         * single-quantity instrument. A joint reports position in rad,
         * velocity in rad/s, and effort in Nm. An IMU is m/s² and rad/s. A
         * force/torque sensor is N and Nm. A GPS is degrees and metres.
         *
         * The alternative — one channel per unit — would split a
         * measurement that the instrument took as one sample, which is the
         * atomicity this kind exists to preserve. Folding the unit into the
         * label ("position (rad)") makes labels unparseable and mixes
         * presentation into data.
         *
         * `unit` stays for the common uniform case; a reading uses one or
         * the other, never both.
         */
        units?: string[]
        /**
         * What each component is, same length as `values` —
         * ["Package","Core 0",…] or ["x","y"] or ["roll","pitch","yaw"].
         *
         * Carried because the instrument already knows it. Without it a
         * nine-vector is nine anonymous numbers and every consumer
         * re-derives the meaning from the channel name, which is the
         * second-source-of-truth pattern this protocol refuses everywhere
         * else.
         */
        labels?: string[]
        /**
         * The convention these values follow — "imu", "pose2d",
         * "mouse.position". Advisory: the runtime never validates or reads
         * it. It is a JOIN KEY, so a cognet written against `imu` works with
         * any body that declares one, and a ROS bridge can carry
         * `sensor_msgs/Imu` across without the meaning being lost.
         *
         * Optional because `unit` and `labels` are usually enough. A new
         * sensor convention is a new string, never a protocol change — which
         * is what keeps this kind set closed.
         */
        profile?: string
        /**
         * For readings too large to inline — a point cloud is 50,000 × 3
         * numbers. Same size rule audio and visual already use, so a reading
         * outgrowing JSON is never a change of kind.
         */
        ref?: StimulusRef
    }
}

export type AxonStimulusType = keyof AxonStimulusEvent

/**
 * The inbound half of SENSORY_EVENTS (shared.ts), which is the one
 * definition — sensory-tier is a property of the KIND and does not differ
 * by direction.
 *
 * Kept as a named export because the delivery path is stimulus-only: the
 * scheduler asks "is this sensation transient" about things it is handing
 * to a cognet, and can never be handed an output.
 *
 * A cognet that needs a frame beyond the tick it arrived in keeps it in its
 * own resident state — which is what an organism does, and what the runtime
 * must not do on its behalf.
 */
export const STIMULUS_TRANSIENT_EVENTS = new Set<AxonStimulusType>(
    [...SENSORY_EVENTS].filter((type): type is AxonStimulusType => type.startsWith("cognet:stimulus:")),
)

/**
 * One enveloped stimulus — the shape CognetWake.stimuli actually delivers.
 * Narrower than AxonEntry on purpose: a cognet's input contract is
 * stimulus:* only, the mirror of output() being its only unmediated write —
 * it never has to switch over every entry family that exists, only
 * the ones it can actually receive.
 */
export type AxonStimulusEntry = AxonEventUnion<AxonStimulusEvent>
