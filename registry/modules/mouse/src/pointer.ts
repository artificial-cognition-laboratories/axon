import { dlopen, FFIType, suffix } from "bun:ffi"

/**
 * capture/pointer — the mouse, as a position and a button state.
 *
 * The closest thing a desktop has to ODOMETRY: a pose in a bounded space
 * that moves continuously, sampled rather than event-driven. That makes it
 * the cheapest honest rehearsal for a robot's own pose feed, on hardware
 * everyone already has.
 *
 * Read through libX11's XQueryPointer rather than evdev. evdev
 * (/dev/input/event*) delivers raw movement DELTAS and requires membership
 * of the `input` group — a permission most machines do not grant and a
 * shape that is not what a mind wants anyway. XQueryPointer answers the
 * question actually being asked: where is the pointer now.
 *
 * SAMPLED, NOT EVENT-DRIVEN, and deliberately so. An event stream reports
 * only motion, which means a still mouse reports nothing and a reader
 * cannot distinguish "not moving" from "not looking". A pose feed reports
 * where it is, every tick, whether or not it changed — which is what
 * proprioception does.
 *
 * Knows nothing about Axon: it returns numbers.
 */

/** Button bits in XQueryPointer's mask — X11's Button1Mask..Button5Mask. */
const BUTTON_MASKS = [0x0100, 0x0200, 0x0400, 0x0800, 0x1000]

export type PointerT = {
    /** Screen bounds, so a position can be read as a fraction if wanted. */
    readonly size: { width: number; height: number }
    /** Position and button state now, or null if the display went away. */
    read(): { x: number; y: number; buttons: number[] } | null
    close(): void
}

export function Pointer(display?: string): PointerT {
    // The library name differs by platform; `suffix` is Bun's own answer.
    const lib = dlopen(`libX11.${suffix}`, {
        XOpenDisplay: { args: [FFIType.cstring], returns: FFIType.ptr },
        XCloseDisplay: { args: [FFIType.ptr], returns: FFIType.int },
        XDefaultRootWindow: { args: [FFIType.ptr], returns: FFIType.u64 },
        XDisplayWidth: { args: [FFIType.ptr, FFIType.int], returns: FFIType.int },
        XDisplayHeight: { args: [FFIType.ptr, FFIType.int], returns: FFIType.int },
        XQueryPointer: {
            args: [
                FFIType.ptr, FFIType.u64,
                FFIType.ptr, FFIType.ptr,   // root, child window (ignored)
                FFIType.ptr, FFIType.ptr,   // root x, y — what we want
                FFIType.ptr, FFIType.ptr,   // window-relative x, y (ignored)
                FFIType.ptr,                // button/modifier mask
            ],
            returns: FFIType.int,
        },
    })

    const name = display ?? process.env.DISPLAY ?? ":0"
    const handle = lib.symbols.XOpenDisplay(Buffer.from(`${name}\0`, "utf-8"))
    if (!handle) {
        lib.close()
        throw new Error(`no X display at ${name}`)
    }

    const root = lib.symbols.XDefaultRootWindow(handle)
    const size = {
        width: lib.symbols.XDisplayWidth(handle, 0),
        height: lib.symbols.XDisplayHeight(handle, 0),
    }

    // Out-params, allocated ONCE. XQueryPointer is called at sample rate and
    // allocating nine buffers per read would cost more than the read.
    const rootWin = new BigUint64Array(1)
    const childWin = new BigUint64Array(1)
    const rootX = new Int32Array(1)
    const rootY = new Int32Array(1)
    const winX = new Int32Array(1)
    const winY = new Int32Array(1)
    const mask = new Uint32Array(1)

    let open = true

    return {
        size,

        read() {
            if (!open) return null

            const ok = lib.symbols.XQueryPointer(
                handle, root,
                rootWin, childWin,
                rootX, rootY,
                winX, winY,
                mask,
            )
            // False means the pointer is on a different screen — a real
            // state on a multi-head setup, not a failure.
            if (!ok) return null

            return {
                x: rootX[0]!,
                y: rootY[0]!,
                // Buttons as 0/1 rather than booleans: a reading is
                // `number[]`, and a pressed button is genuinely a
                // measurement of a physical state. Bit-testing a mask is
                // the body's job; a mind should never have to know X11's
                // bit layout.
                buttons: BUTTON_MASKS.map(bit => ((mask[0]! & bit) !== 0 ? 1 : 0)),
            }
        },

        close() {
            if (!open) return
            open = false
            lib.symbols.XCloseDisplay(handle)
            lib.close()
        },
    }
}
