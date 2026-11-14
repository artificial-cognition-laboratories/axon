import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import type { ProcessesT } from "../processes"

export type DisplayOpts = {
    /** This body's slot in the pool. Displays are numbered from it, so two bodies never share a screen. */
    slot: number
    processes: ProcessesT
    /** Where the screen's own log goes. */
    dir: string
    /** `WIDTHxHEIGHT`. */
    resolution: string
}

/** Where shared memory is a filesystem. A screen kept here is RAM both the display and its reader map; it never reaches a disk. */
const MEMORY = "/dev/shm"

/**
 * Display — the virtual screen one body renders to, and the memory it is.
 *
 * Engine-neutral: a game that draws needs somewhere to draw, and nothing about
 * allocating that is Terraria's or Minecraft's. The number comes from the slot
 * rather than a search for a free one, so a restarted body reclaims its own
 * screen instead of drifting up the range every boot.
 *
 * The screen's pixels ARE the body's sight. The display keeps its framebuffer
 * as a file in shared memory (`-fbdir`), so whoever occupies the body looks at
 * the present frame by reading memory: no capture process, no encoder, no
 * folder of frames to poll. It replaced an ffmpeg grab writing numbered jpegs
 * to disk, whose reader had to leave the newest file alone in case it was
 * half-written — so sight was always a frame behind, plus a poll.
 *
 * The file is an X window dump: a header, a colour table, then rows of
 * pixels. Nothing synchronises a reader with the display drawing, so a read
 * can land mid-frame and see part of two; that is the price of looking
 * without asking.
 *
 * Returns the process rather than supervising it. Whether a dead screen means
 * the body failed is the BODY's state machine, not this leaf's.
 */
export function Display(opts: DisplayOpts) {
    const name = `:${100 + opts.slot}`
    const memory = join(MEMORY, `axon-display-${100 + opts.slot}`)

    return {
        /** The `DISPLAY` value a client is pinned to. */
        name: name,

        /** The screen's pixels, as the display keeps them — what an occupant reads to see. */
        screen: join(memory, "Xvfb_screen0"),

        /** An empty place in memory for the screen. Whatever an earlier display left there is gone. */
        async prepare(): Promise<void> {
            await rm(memory, { recursive: true, force: true })
            await mkdir(memory, { recursive: true })
        },

        start(): ReturnType<ProcessesT["spawn"]> {
            return opts.processes.spawn({
                label: `display${name}`,
                cmd: ["Xvfb", name, "-screen", "0", `${opts.resolution}x24`, "-nolisten", "tcp", "-fbdir", memory],
                stdout: `${opts.dir}/xvfb.log`,
            })
        },

        /** Give the memory back. After the display has stopped. */
        async release(): Promise<void> {
            await rm(memory, { recursive: true, force: true })
        },
    }
}

export type DisplayT = ReturnType<typeof Display>
