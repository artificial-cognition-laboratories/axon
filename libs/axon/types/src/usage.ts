/**
 * What an agent costs the machine — measured by its supervisor, part by part.
 *
 * Every figure is nullable and null means UNMEASURED, never zero: a machine
 * with no NVIDIA driver cannot attribute GPU use to a process, and drawing
 * that as an idle GPU would claim a reading nobody took.
 */
export type UsagePart = {
    /** CPU in cores — 1 is one core fully busy, however many the machine has. */
    cpu: number | null
    /** Resident memory, bytes. */
    ram: number | null
    /** GPU busy, 0–100, as the driver attributes it to these processes. */
    gpu: number | null
    /** Video memory these processes hold, bytes. */
    vram: number | null
    /** How many processes were counted. 0 means the part has nothing running. */
    processes: number
    /** Shared with other agents — a daemon's models, a world's server — so not this agent's alone. */
    shared: boolean
}

/** One thread of the agent's processes, as the OS accounts for it. */
export type UsageThread = {
    /** The process it belongs to. */
    pid: number
    /** The OS thread id — what a worker reports itself as, so a reader can say which worker this is. */
    tid: number
    /** What the runtime named it: `bun` (the main thread), `Worker`, `HeapHelper`, `JITWorker`, … */
    name: string
    /** Cores busy since the previous sample; null on a thread's first sample. */
    cpu: number | null
}

export type AgentUsage = {
    /** When it was measured, epoch ms. */
    at: number
    /**
     * Named parts of what this agent is running: `brain` (its own process
     * tree), `body` (a lab body it is in), `world` (the server that body is
     * in), and the process supervising it — where its local models run —
     * named for what it is: `daemon`, or `terminal` when a terminal hosts
     * the supervisor itself. Absent when it has none.
     */
    parts: Record<string, UsagePart>
    /** Every thread of the brain's processes, busiest first — where inside the brain the CPU goes. */
    threads: UsageThread[]
    /** The whole machine at the same moment — what the parts are a share of. */
    machine: {
        cores: number
        /** CPU busy across the machine, 0–100. */
        cpu: number | null
        ram: { used: number; total: number }
        /** GPU busy, 0–100. */
        gpu: number | null
        vram: { used: number | null; total: number | null }
        /**
         * The processes keeping the most CPU busy on the whole machine,
         * busiest first — the agent's or not. What says whose a busy machine
         * is, when the parts above do not add up to it. Absent on a sample
         * from before this was measured.
         */
        busiest?: UsageProcess[]
    }
}

/** One process on the machine, as the OS accounts for it. */
export type UsageProcess = {
    pid: number
    /** The command name the kernel knows it by. */
    name: string
    /** Cores busy since the previous sample. */
    cpu: number
}

/**
 * Bun's options for writing a CPU profile into `dir` when the process exits:
 * the raw `.cpuprofile` for a profiler, and markdown a person or a model can
 * read. Handed to a Bun process as BUN_OPTIONS — what AXON_PROFILE turns on.
 */
export function profiling(dir: string): string {
    return `--cpu-prof --cpu-prof-md --cpu-prof-dir=${dir}`
}
