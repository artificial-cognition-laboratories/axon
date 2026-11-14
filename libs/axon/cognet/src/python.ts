import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import { join } from "node:path"
import { err } from "@arcforge/err"
import { definitions, type Component, type Definition } from "./ecs"
import { Conversation, type Told } from "./conversation"
import { PROTOCOL, type AsyncNativeModule, type Session } from "./native"

export type PythonSystem = {
    name: string
    file: string
    function: string
    declaration: { on?: string[]; reads: string[]; recalls: string[]; streams: string[]; writes: string[]; once: boolean; lag?: number }
}

/** Python — one long-lived process serving this cognet's Python systems. */
export function Python(opts: { project: string; executable: string; systems: PythonSystem[] }): AsyncNativeModule & { close(): Promise<void> } {
    let current: ChildProcessWithoutNullStreams | null = null
    /** Counts the processes started: a new one has been sent no kernel state yet. */
    let epoch = 0
    let stderr = ""
    // Every run in flight, whichever process it was sent to; what is said to them goes to the current one.
    const conversation = Conversation({ send: told => send(told), failing: "COGNET_PYTHON_FAILED" })
    let declared: Array<[string, PythonSystem["declaration"]]> | null = null
    let served: PythonSystem[] | null = null

    function fail(cause: Error): void {
        conversation.fail(cause)
        current = null
    }

    function resolveName(name: string): string {
        if (name === "clock" || name === "stimuli") return name
        return definitions.resolve(name).name
    }

    function members(name: string): string[] {
        if (name === "stimuli") return []
        const definition: Definition = definitions.resolve(name)
        if (definition.kind === "component") return [definition.name]
        const shape: Record<string, Component<unknown>> = definition.shape
        return Object.values(shape).map(handle => handle.name)
    }

    function prepare(): void {
        if (declared) return
        const scheduler: Array<[string, PythonSystem["declaration"]]> = []
        const runtime: PythonSystem[] = []
        for (const one of opts.systems) {
            const spec = one.declaration
            const resolved = {
                ...spec,
                ...(spec.on ? { on: spec.on.map(resolveName) } : {}),
                reads: spec.reads.map(resolveName),
                recalls: spec.recalls.map(resolveName),
                streams: spec.streams.map(resolveName),
                writes: spec.writes.map(resolveName),
            }
            scheduler.push([one.name, resolved])
            runtime.push({ ...one, declaration: {
                ...resolved,
                reads: spec.reads.flatMap(members),
                recalls: spec.recalls.flatMap(members),
            } })
        }
        declared = scheduler
        served = runtime
    }

    function spawnProcess(): ChildProcessWithoutNullStreams {
        if (current) return current
        prepare()
        const executable = opts.executable === "python3" ? "python3" : join(opts.project, opts.executable)
        const script = Bun.resolveSync("@arcforge/cognet/python/serve.py", opts.project)
        const child = spawn(executable, ["-u", script, join(opts.project, "source"), JSON.stringify(served)], {
            cwd: opts.project,
            env: { ...process.env, PYTHONPATH: [join(opts.project, "generated"), join(opts.project, "source"), process.env.PYTHONPATH].filter(Boolean).join(process.platform === "win32" ? ";" : ":") },
            stdio: ["pipe", "pipe", "pipe"],
        })
        current = child
        epoch += 1
        stderr = ""
        child.stderr.on("data", chunk => { stderr = `${stderr}${String(chunk)}`.slice(-8_000) })
        child.on("error", cause => fail(err("COGNET_PYTHON_FAILED", { detail: `Python process failed: ${cause.message}`, cause: cause })))
        child.on("exit", (code, signal) => {
            if (current === child) fail(err("COGNET_PYTHON_FAILED", { detail: `Python process exited (${signal ?? code})${stderr ? `: ${stderr}` : ""}` }))
        })
        createInterface({ input: child.stdout }).on("line", line => {
            try {
                conversation.heard(line)
            } catch (cause) {
                // A process that breaks the protocol cannot be trusted with the runs still in it.
                fail(cause instanceof Error ? cause : new Error(String(cause)))
                child.kill()
            }
        })
        return child
    }

    /** One message to the current process. A write that fails fails the process — every run in it with it. */
    function send(told: Told): void {
        const child = spawnProcess()
        child.stdin.write(`${JSON.stringify(told)}\n`, cause => {
            if (cause) fail(err("COGNET_PYTHON_FAILED", { detail: `could not write to the Python process: ${cause.message}`, cause: cause }))
        })
    }

    return {
        /** `serve.py` ships in this package beside this file, so it always speaks this runtime's protocol. */
        protocol(): number {
            return PROTOCOL
        },

        /** The process a run's snapshot is built for — started first, so a restarted one is never sent a run without state. */
        epoch(): number {
            spawnProcess()
            return epoch
        },

        declarations(): unknown {
            prepare()
            return declared
        },

        run(name: string, snapshot: string, kinds: string[], arrays: Uint8Array[], session: Session): Promise<unknown> {
            return conversation.begin(name, snapshot, kinds, arrays, session)
        },

        async close(): Promise<void> {
            const child = current
            if (!child) return
            child.stdin.end()
            await new Promise<void>((resolve, reject) => {
                child.once("exit", code => code === 0 ? resolve() : reject(err("COGNET_PYTHON_FAILED", { detail: `Python process exited during shutdown (${code})${stderr ? `: ${stderr}` : ""}` })))
            })
        },
    }
}

