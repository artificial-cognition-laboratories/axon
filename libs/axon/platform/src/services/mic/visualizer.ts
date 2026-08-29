/**
 * visualizer — pure rendering only. Takes bucket levels already resolved
 * to 0..1 (see mic/index.ts, which owns dB->level mapping against the
 * live adaptive noise floor) and returns the braille string to display.
 * Smoothing/decay/floor-tracking are NOT done here — they're
 * frame-to-frame state, owned by the ticker, not a stateless render fn.
 *
 * Freq = x-axis (one bucket per braille half-cell, left-to-right), amp =
 * y-axis (bottom-anchored dot fill within that half). A braille cell is a
 * 2x4 dot grid — treating its left and right columns as two INDEPENDENT
 * buckets (not one glyph picked from a "looks denser" list) doubles
 * horizontal resolution for the same character width and gives a real
 * bottom-anchored bar per bucket, 4 height levels each.
 *
 * Unicode braille bit layout (0x2800 base):
 *   dot1 dot4      bit0 bit3
 *   dot2 dot5      bit1 bit4
 *   dot3 dot6      bit2 bit5
 *   dot7 dot8      bit6 bit7
 * Bottom-anchored fill order, left column: dot7 -> dot3 -> dot2 -> dot1.
 * Right column: dot8 -> dot6 -> dot5 -> dot4.
 */
const BRAILLE_BASE = 0x2800
const LEFT_DOTS = [0b1000000, 0b0000100, 0b0000010, 0b0000001] // dot7, dot3, dot2, dot1 — bottom to top
const RIGHT_DOTS = [0b10000000, 0b00100000, 0b00010000, 0b00001000] // dot8, dot6, dot5, dot4 — bottom to top

/** 0..4 filled dots (bottom-up) for one column, from a clamped 0..1 amplitude level. */
function columnBits(level: number, dots: number[]): number {
    const filled = Math.round(Math.min(1, Math.max(0, level)) * dots.length)
    let bits = 0
    for (let i = 0; i < filled; i++) bits |= dots[i]!
    return bits
}

/** bucketLevels are already 0..1 (clamped), one entry per FFT bucket — see mic/index.ts's floor-relative mapping. */
export function renderBraille(bucketLevels: number[]): string {
    let out = ""
    for (let i = 0; i < bucketLevels.length; i += 2) {
        const leftLevel = bucketLevels[i]!
        const rightLevel = bucketLevels[i + 1] ?? 0

        const bits = columnBits(leftLevel, LEFT_DOTS) | columnBits(rightLevel, RIGHT_DOTS)
        out += String.fromCodePoint(BRAILLE_BASE + bits)
    }
    return out
}
