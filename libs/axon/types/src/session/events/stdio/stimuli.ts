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
import type { StimulusRef } from "./shared"

// ── Shared shapes ─────────────────────────────────────────────────────────────

/**
 * Where a stimulus came from. `channel` identifies the concrete source
 * ("user", "email:inbox", "mic0", "cam:front", "telemetry:battery") —
 * open vocabulary, agent-defined. The TYPE says what kind of information
 * it is; the source says where it entered.
 */
export type StimulusSource = {
    channel: string
    /** stable id when the source is a session participant (user id, device id) */
    id?: string
}

// ── The sense set ─────────────────────────────────────────────────────────────

/**
 * The stimulus registry — log entries, wake-capable by default.
 *
 * Four kinds, chosen to generalize:
 *   text    — symbolic language (native modality of an LLM)
 *   audio   — sound over time (speech, ambient) — digest is the transcript
 *   visual  — light: frames and clips — digest is the caption/percept
 *   field   — measured quantities over time: touch, heat, pose, battery,
 *             GPS, market prices, autopilot telemetry. One type, open
 *             channel vocabulary — this is what stops sense-set sprawl.
 */
export type AxonStimulusEvent = {
    /** Symbolic language input. Inline — text IS its own digest. */
    "cognet:stimulus:text": {
        source: StimulusSource
        content: string
    }

    /** An audio segment. Bytes stay behind `ref`; `transcript` is an optional inline digest. */
    "cognet:stimulus:audio": {
        source: StimulusSource
        ref: StimulusRef
        /** inline digest, when the producer already had one — never a summary it computed */
        transcript?: string
        durationMs?: number
    }

    /** A frame or clip. Bytes stay behind `ref`; `caption` is an optional inline digest. */
    "cognet:stimulus:visual": {
        source: StimulusSource
        ref: StimulusRef
        /** inline digest, when the producer already had one — never a summary it computed */
        caption?: string
        kind: "image" | "video"
    }

    /**
     * A reading from a measured field — touch, heat, pose, battery, light,
     * price. The reading is inline (small by nature); `ref` optionally points
     * at a surrounding raw window.
     *
     * Deliberately carries no judgment about why the reading was sent. A
     * producer emits what it measured; deciding which readings matter is the
     * cognet's, and only the cognet's.
     */
    "cognet:stimulus:field": {
        source: StimulusSource
        /** the measurement, unit-tagged, e.g. { value: 87, unit: "%" } */
        reading: { value: number | string | boolean; unit?: string }
        ref?: StimulusRef
    }
}

export type AxonStimulusType = keyof AxonStimulusEvent

/**
 * Dense sense streams — delivered to the cognet, never written to the log.
 * Everything not in this set is durable.
 *
 * A stimulus is a SENSATION, and the protocol has always described it as one:
 * delivered once, then gone, with no second chance to attend to it. The
 * delivery queue was already built that way (drain-and-forget, no history) —
 * but ingest() committed every stimulus first, so the runtime kept a
 * permanent record of exactly the thing it told cognets was transient.
 *
 * That is affordable for text and sparse field readings, and impossible for
 * a live sensor. A 30Hz microphone commits ~2.6M entries a day whose bytes
 * nobody will ever replay; the useful record is what the mind DID with them
 * — its outputs and actions — which stays durable and is unaffected.
 *
 * Durability is a property of the KIND, not a runtime mode, for the same
 * reason CAPSULE_TRANSIENT_EVENTS is: whether a sensation is worth
 * remembering follows from what it is. Text is what someone said and belongs
 * in the record. Frames are what a retina saw.
 *
 * A cognet that needs a frame beyond the tick it arrived in keeps it in its
 * own resident state — which is what an organism does, and what the runtime
 * must not do on its behalf.
 */
export const STIMULUS_TRANSIENT_EVENTS = new Set<AxonStimulusType>([
    "cognet:stimulus:audio",
    "cognet:stimulus:visual",
])

/**
 * One enveloped stimulus — the shape CognetWake.stimuli actually delivers.
 * Narrower than AxonEntry on purpose: a cognet's input contract is
 * stimulus:* only, the mirror of output() being its only unmediated write —
 * it never has to switch over every entry family that exists, only
 * the ones it can actually receive.
 */
export type AxonStimulusEntry = AxonEventUnion<AxonStimulusEvent>
