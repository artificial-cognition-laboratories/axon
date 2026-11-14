import type { ProcessesT } from "../processes"

type Owned = ReturnType<ProcessesT["spawn"]>

/**
 * Rest — freezing a warm body while nobody is in it.
 *
 * A warm body exists so the next agent never waits for a boot. Warm used to
 * mean RUNNING: an unleased client rendering its menu at full speed and two
 * captures writing ~1MB a second that nobody read — a core, and the GPU,
 * busy for an empty room long after the agent had gone.
 *
 * Resting stops the processes that do that work (SIGSTOP to each group): no
 * CPU, no GPU, nothing lost — the process keeps its memory, its window and
 * its sockets, and waking it (SIGCONT) is instant. The display is left
 * running: an idle X server costs nothing, and a client whose display
 * vanished would not survive the wake.
 *
 * A stopped process cannot act on SIGTERM, so a resting body is woken before
 * it is stopped — otherwise every stop would wait out its grace period and
 * end in SIGKILL.
 */
export function Rest() {
    const held: Owned[] = []
    let resting = false

    return {
        get resting(): boolean { return resting },

        /** A process that freezes with the body. Register the ones that WORK — the client and the captures. */
        hold(proc: Owned): Owned {
            held.push(proc)
            return proc
        },

        rest(): void {
            if (resting) return
            for (const proc of held) proc.kill("SIGSTOP")
            resting = true
        },

        wake(): void {
            if (!resting) return
            for (const proc of held) proc.kill("SIGCONT")
            resting = false
        },
    }
}

export type RestT = ReturnType<typeof Rest>
