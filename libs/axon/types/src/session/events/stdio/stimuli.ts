/**
 * Stimuli — the sense protocol. Every environment event that can trigger
 * cognition enters through this vocabulary and no other path.
 *
 * DESIGN RULES (what keeps this file from growing forever):
 *
 * 1. Top-level types are INFORMATION KINDS, not sensors. Symbolic language,
 *    sound, light, measured fields — new hardware maps into an existing
 *    kind (ROS sensor_msgs discipline: the core set outlives every vendor).
 *    A new top-level type here is a once-per-epoch event, like a syscall.
 *
 * 2. Heavy payloads NEVER enter the log. A stimulus is a small, durable,
 *    replayable fact: a `ref` into content-addressed storage / a device
 *    buffer, plus a symbolic `digest` cognition can fold without fetching
 *    bytes (perception delivers percepts, not pixels). MB/s sense streams
 *    live below this protocol as devices; ATTENTION MODULES convert dense
 *    streams into sparse salient stimuli (event-camera model) — the log
 *    only ever sees the sparse side.
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

    /** A salient audio segment, cut from a stream by an attention module. */
    "cognet:stimulus:audio": {
        source: StimulusSource
        ref: StimulusRef
        /** symbolic digest — what cognition folds without fetching audio */
        transcript?: string
        durationMs?: number
    }

    /** A salient frame or clip, cut from a stream by an attention module. */
    "cognet:stimulus:visual": {
        source: StimulusSource
        ref: StimulusRef
        /** symbolic digest — caption / detected percepts */
        caption?: string
        kind: "image" | "video"
    }

    /**
     * A salient reading from a measured field — threshold crossed, state
     * changed, anomaly detected. The reading is inline (small by nature);
     * `ref` optionally points at the surrounding raw window.
     */
    "cognet:stimulus:field": {
        source: StimulusSource
        /** the measurement, unit-tagged, e.g. { value: 87, unit: "%" } */
        reading: { value: number | string | boolean; unit?: string }
        /** why this reading surfaced — the attention module's verdict */
        salience?: string
        ref?: StimulusRef
    }
}

export type AxonStimulusType = keyof AxonStimulusEvent

/**
 * One enveloped stimulus — the shape CognetWake.stimuli actually delivers.
 * Narrower than AxonEntry on purpose: a cognet's input contract is
 * stimulus:* only, the mirror of output() being its only unmediated write —
 * it never has to switch over every entry family that exists, only
 * the ones it can actually receive.
 */
export type AxonStimulusEntry = AxonEventUnion<AxonStimulusEvent>
