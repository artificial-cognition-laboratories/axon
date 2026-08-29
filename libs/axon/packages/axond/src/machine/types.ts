/**
 * What the machine domain answers about.
 *
 * Three questions kept deliberately distinct, because conflating them is the
 * usual failure of a resource manager:
 *
 *   capacity     what this box HAS      — totals, probed once
 *   utilisation  what is in use NOW     — including things Axon did not load
 *   residency    what WE hold, and who  — the tenancy half
 *
 * An admission check that reads only the third accepts a load that then OOMs,
 * because the browser holding 3GB of video memory is real.
 */

/** How a video-memory figure was learned. Absent readings say so rather than guessing. */
export type VramSource = "nvidia" | "apple" | "unknown"

/** Who this machine is. */
export type MachineIdentity = {
    /**
     * A stable, hashed host identifier — or null where none can be read.
     *
     * Derived from `/etc/machine-id` on Linux and `IOPlatformUUID` on macOS,
     * HASHED before use: both are real host identifiers, and carrying one raw
     * across a wire is a fingerprint nothing here needs. The hash keeps it
     * stable and comparable without being the machine's own id.
     *
     * NULL rather than a generated fallback. A random per-boot value would
     * look stable and silently fragment every record that correlates on it —
     * a caller that must have one can refuse, which a lie prevents.
     */
    id: string | null
    hostname: string
    platform: NodeJS.Platform
    arch: string
}

/** What the box has. Totals; these move only when hardware or drivers do. */
export type MachineCapacity = {
    /** Logical cores. */
    cores: number
    /** Total system memory, bytes. */
    ram: number
    /**
     * Total video memory in bytes, or null when unmeasurable.
     *
     * NULL IS NOT ZERO. There is no portable VRAM API, and a machine we cannot
     * measure has no KNOWN ceiling — reporting zero would refuse every local
     * model on most machines, which is the opposite of the honest answer.
     */
    vram: number | null
    vramSource: VramSource
    /** GPU model, when one can be named. */
    gpu: string | null
}

/**
 * What is in use right now.
 *
 * Every field is nullable and every null means UNREADABLE, never zero. A
 * machine with no GPU and a machine whose GPU cannot be probed are different
 * facts, and an admission check treating the second as "nothing is using it"
 * would hand out memory that is already gone.
 */
export type MachineUsage = {
    /** Video memory in use across the whole machine, bytes. */
    vramUsed: number | null
    /** GPU compute utilisation, 0-100. A card can be full and idle, or empty and pinned. */
    gpuUtil: number | null
    /**
     * System memory AVAILABLE, bytes — not free.
     *
     * Free excludes reclaimable page cache and reads as a machine in trouble
     * when it is merely warm. Available is what a new allocation can actually
     * expect.
     */
    ramAvailable: number
    /** 1-minute load average. Cheap, needs no sampling state, and answers "is this box busy". */
    load: number
    /** When this reading was taken, epoch ms. */
    at: number
}

/** One agent's hold on video memory. */
export type Hold = {
    /** Opaque id, returned by `take` and required to release. */
    id: string
    /** The holder — probed for liveness, so a dead one is self-clearing. */
    pid: number
    /** Which agent, for a surface that lists what is loaded. */
    agent: string
    /** The cognet role this serves — "asr", "vad", "main". */
    role: string
    /** What is loaded, e.g. "hf:onnx-community/whisper-base.en". */
    model: string
    /** Bytes held. */
    bytes: number
    /** When it was taken, epoch ms. */
    at: number
}

/** Whether a load fits, and why not when it does not. */
export type Admission =
    | { ok: true; headroom: number | null }
    | {
        ok: false
        /** Bytes asked for. */
        wanted: number
        /** Bytes a new load may take, or null when nothing bounds it. */
        available: number
        /** What is holding the memory — so a refusal names something actionable. */
        holders: Hold[]
    }

/** Everything the machine domain reports in one read. */
export type MachineState = {
    identity: MachineIdentity
    capacity: MachineCapacity
    usage: MachineUsage
    /**
     * The declared ceiling in bytes, or null when none was declared.
     *
     * A declared budget WINS over measured hardware — a user who says 4GB on a
     * 24GB card means it, which is what makes local inference usable on a box
     * that is also running a game.
     */
    budget: number | null
    /** Bytes held by live holders, across every Axon process on this machine. */
    held: number
    holds: Hold[]
    /** Recent usage readings, oldest first — what a sparkline draws. */
    samples: MachineUsage[]
}
