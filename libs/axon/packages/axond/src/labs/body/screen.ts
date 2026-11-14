import { closeSync, openSync, readSync } from "node:fs"

export type ScreenOpts = {
    /** The body's screen in shared memory — an X window dump the display keeps current. */
    path: string
}

/**
 * One look at the screen. `rgbx` is four bytes a pixel — red, green, blue,
 * and one unused — and is overwritten by the next look. `settled` is false
 * when the screen never held still long enough to be read whole: the
 * picture may then be part of two frames.
 */
export type Seen = { width: number; height: number; rgbx: Uint8Array; settled: boolean }

/** How many times a look reads again for a screen that was changing under it. */
const READS_MOST = 4

/**
 * Screen — the body's screen, read from the memory the display keeps it in.
 *
 * Looking is a read of shared memory: no capture process, no encoder, and
 * the frame is the one on the screen now. Nothing synchronises this with the
 * display drawing, so one read can land mid-frame and hold part of two — a
 * picture whose top has scrolled and whose bottom has not, which a mind
 * reads as the ground having moved. So a look reads until two reads running
 * are the same: a screen that did not change between them was not being
 * drawn.
 *
 * The file opens at the first look, not at construction, and its layout is
 * checked once: this reads exactly one — 32 bits a pixel, least byte first,
 * blue-green-red — and refuses any other rather than hand on wrong colours.
 */
export function Screen(opts: ScreenOpts) {
    let open: { fd: number; width: number; height: number; offset: number; rgbx: Uint8Array; words: Uint32Array; again: Buffer } | null = null

    function opened(): NonNullable<typeof open> {
        if (open) return open
        const fd = openSync(opts.path, "r")
        const head = Buffer.alloc(HEADER.bytes)
        if (readSync(fd, head, 0, head.length, 0) !== head.length) {
            closeSync(fd)
            throw new Error(`the screen at ${opts.path} is shorter than a window dump's header — the display has not drawn it yet`)
        }
        const field = (index: number): number => head.readUInt32BE(index * 4)
        const layout = {
            version: field(HEADER.version), format: field(HEADER.format), order: field(HEADER.order), bits: field(HEADER.bits),
            red: field(HEADER.red), green: field(HEADER.green), blue: field(HEADER.blue),
        }
        const width = field(HEADER.width)
        const height = field(HEADER.height)
        const expected = { version: 7, format: 2, order: 0, bits: 32, red: 0xff0000, green: 0x00ff00, blue: 0x0000ff }
        const wrong = (Object.keys(expected) as Array<keyof typeof expected>).filter(key => layout[key] !== expected[key])
        if (wrong.length > 0 || field(HEADER.line) !== width * 4) {
            closeSync(fd)
            throw new Error(`the screen at ${opts.path} is not laid out as this eye reads it (${wrong.map(key => `${key} ${layout[key]}, not ${expected[key]}`).join("; ") || `rows of ${field(HEADER.line)} bytes for ${width} pixels`})`)
        }
        const rgbx = new Uint8Array(width * height * 4)
        open = { fd: fd, width: width, height: height, offset: field(HEADER.size) + field(HEADER.colours) * COLOUR_BYTES, rgbx: rgbx, words: new Uint32Array(rgbx.buffer), again: Buffer.alloc(rgbx.length) }
        return open
    }

    return {
        /** The frame on the screen now. */
        look(): Seen {
            const screen = opened()
            const whole = (into: Uint8Array): void => {
                const read = readSync(screen.fd, into, 0, into.length, screen.offset)
                if (read !== into.length) throw new Error(`the screen at ${opts.path} gave ${read} of ${into.length} bytes — the display is gone`)
            }
            whole(screen.rgbx)
            let settled = false
            for (let reads = 1; reads < READS_MOST && !settled; reads++) {
                whole(screen.again)
                settled = screen.again.equals(screen.rgbx)
                if (!settled) screen.rgbx.set(screen.again)
            }
            // Blue and red change places, a pixel a word: the display keeps
            // blue first, and everything that looks at a picture wants red.
            const words = screen.words
            for (let index = 0; index < words.length; index++) {
                const pixel = words[index]!
                words[index] = (pixel & 0x0000ff00) | ((pixel >>> 16) & 0xff) | ((pixel & 0xff) << 16)
            }
            return { width: screen.width, height: screen.height, rgbx: screen.rgbx, settled: settled }
        },

        close(): void {
            if (open) closeSync(open.fd)
            open = null
        },
    }
}

export type ScreenT = ReturnType<typeof Screen>

/** Where a window dump's header keeps what this reads — each a big-endian 32-bit field, by index. */
const HEADER = { bytes: 100, size: 0, version: 1, format: 2, width: 4, height: 5, order: 7, bits: 11, line: 12, red: 14, green: 15, blue: 16, colours: 19 } as const
/** Bytes one entry of the dump's colour table takes; the pixels follow the table. */
const COLOUR_BYTES = 12
