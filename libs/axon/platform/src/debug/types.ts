import type { CognetEventMap } from "@arcforge/types"

/** The graph a mind declares at boot: its systems in run order, and every component they touch. */
export type Declaration = CognetEventMap["cognet:schedule:declare"]

/** A session as it is found on disk. */
export type Found = {
    id: string
    /** The log file. */
    file: string
    /** When the log was last written, epoch ms. */
    modifiedAt: number
}

/** Bytes a session holds, by where they are kept. */
export type Sizes = { log: number; telemetry: number; sensory: number; media: number; total: number }

/** Something that went wrong, wherever it was recorded. */
export type Fault = {
    at: number
    seq: number
    type: string
    tick?: number
    system?: string
    code?: string
    message?: string
}

/**
 * How long something took, over many runs. `hist` counts runs by duration,
 * one bucket per entry of `BOUNDS` — enough to give a percentile without
 * keeping every run.
 */
export type Tally = { count: number; totalMs: number; maxMs: number; hist: number[] }

export type SystemTally = Tally & { failed: number; async: boolean; threads: number[] }

/** One opening or closing of a trouble: a component named `trouble`, set when it begins and removed when it ends. */
export type Trouble = { at: number; tick: number; entity: string; opened: boolean; what?: string; detail?: string }

/** What one telemetry segment holds, summed. A segment that has rolled closed never changes, so neither does this. */
export type Segment = {
    bytes: number
    events: number
    firstMs: number
    lastMs: number
    firstTick: number
    lastTick: number
    /**
     * Each tick, start to end, wall time: its own systems, the workers it
     * waited for, and any lagged run it had to wait to land. What a tick
     * that runs over the deadline ran over in. (A runtime from before the
     * schedule owned its ticks timed each WAKE instead, merged ones and all.)
     */
    ticks: Tally
    /** Ticks whose wall time was over the mind's own deadline. Nothing for a mind that declares no rate. */
    late: number
    /** By system: the ticks that waited on it — a worker the rest needed, or a lagged run landing late — and for how long. */
    held: Record<string, Tally>
    /**
     * Each tick's time on the main thread: its systems that ran neither
     * beside the tick nor on a worker. This is what a deadline is held to.
     * A tick cut by the end of a segment is counted in both halves.
     */
    main: Tally
    /** Ticks whose main-thread time was over the mind's own deadline. Nothing for a mind that declares no rate. */
    over: number
    systems: Record<string, SystemTally>
    faults: Fault[]
    faultsTotal: number
    troubles: Trouble[]
}

/** One part's readings, one per sample of `Usage.at`; null where the part was absent or the reading unmeasured. */
export type PartSeries = { /** Shared with other agents — a daemon's models — so not this agent's alone. */ shared: boolean; ram: Array<number | null>; cpu: Array<number | null>; gpu: Array<number | null>; vram: Array<number | null> }

/** A group of threads' CPU over the samples: how many threads, and the cores the group kept busy. */
export type ThreadTally = { threads: number; samples: number; totalCores: number; maxCores: number }

/**
 * What the agent's processes used, as sampled every couple of seconds
 * (`axon:usage`). Kept whole: a session is hours at most, and growth over
 * time is only visible as a series.
 */
export type Usage = {
    /** When each sample was taken, epoch ms. */
    at: number[]
    /** By part: `brain` (the agent's own processes), and whatever supervises it. */
    parts: Record<string, PartSeries>
    /** By thread group: `main`, `worker 0`…, and the runtime's own by name. */
    threads: Record<string, ThreadTally>
    /** Which worker each OS thread id is, from `cognet:thread:start`. */
    workers: Record<string, number>
    /** The whole machine beside the parts: how busy it was at each sample, and which processes — the agent's or not — kept it busy. */
    machine: { cores: number; ramTotal: number; cpu: Array<number | null>; busiest: Record<string, ThreadTally> } | null
}

/** What the index knows of a session — everything the summary commands answer from, without reading the session again. */
export type Summary = {
    version: number
    id: string
    agentId: string | null
    startedAt: string | null
    log: {
        /** Bytes of the log this covers; the log only grows, so the rest is read from here. */
        covered: number
        events: number
        /** Lines that did not parse. */
        torn: number
        firstMs: number | null
        lastMs: number | null
        /** Events by type. */
        types: Record<string, number>
        /** The first `FAULTS_KEPT` of them; `faultsTotal` is how many there were. */
        faults: Fault[]
        faultsTotal: number
        declared: Declaration | null
        usage: Usage
        inference: Inference
        /** What each stimulus channel the log carries delivered, and when it was first and last heard. */
        channels: Record<string, Channel>
    }
    /** By segment file name. Only the segments still on disk: the ring is a window. */
    segments: Record<string, Segment>
}

/**
 * Calls to the model worker (`kernel:transform`), counted as they are read.
 * `open` is the calls begun and not yet ended where the reading stopped —
 * carried, so the next reading closes them.
 */
export type Inference = {
    /** By engine role. A call that failed or was interrupted is counted in `failed`, and timed like any other. */
    roles: Record<string, Tally & { failed: number }>
    /** Calls that began with this many others already begun and not ended, by that number; the last is "that many or more". */
    behind: number[]
    open: Record<string, string>
    firstMs: number | null
    lastMs: number | null
}

/** One stimulus channel, as heard: how often, and between when. */
export type Channel = { count: number; firstMs: number; lastMs: number }

/** One event as a command returns it. */
export type Event = { type: string; time: { ms: number; seq: number }; data?: unknown; [more: string]: unknown }
