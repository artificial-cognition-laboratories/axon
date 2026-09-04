import { renderBraille } from "@arcforge/platform/services/mic/visualizer"
import { describe, it, expect } from "bun:test"

describe("visualizer.renderBraille", () => {
    it("renders one character per two levels", () => {
        expect(renderBraille([0, 0, 0, 0])).toHaveLength(2)
        expect(renderBraille([0, 0, 0, 0, 0, 0])).toHaveLength(3)
    })

    it("silence (all zero levels) renders the empty braille glyph", () => {
        expect(renderBraille([0, 0])).toBe("⠀")
    })

    it("full levels render the fully-filled braille glyph", () => {
        expect(renderBraille([1, 1])).toBe("⣿")
    })

    it("left and right dot columns are independent — a loud left + quiet right bucket doesn't bleed into each other", () => {
        // left=full, right=silent -> only the left-column dots are set
        const leftOnly = renderBraille([1, 0])
        // left=silent, right=full -> only the right-column dots are set
        const rightOnly = renderBraille([0, 1])

        expect(leftOnly).not.toBe(rightOnly)
        expect(leftOnly).toBe("⡇") // dots 7,3,2,1
        expect(rightOnly).toBe("⢸") // dots 8,6,5,4
    })

    it("an odd-length input still renders — the trailing unpaired bucket's right half reads as silent", () => {
        const result = renderBraille([1, 1, 1]) // 3rd level has no partner
        expect(result).toHaveLength(2)
        expect(result[1]).toBe("⡇") // full left, empty right — third value never lost/misread
    })

    it("clamps out-of-range levels instead of producing a garbage glyph", () => {
        // >1 clamps to full (left), <0 clamps to silent (right) — same result as [1, 0]
        expect(renderBraille([2, -1])).toBe("⡇")
        expect(() => renderBraille([2, -1])).not.toThrow()
    })

    it("intermediate levels produce a bottom-anchored partial fill, not an arbitrary glyph", () => {
        // level 0.5 on a 4-dot column should fill exactly 2 of 4 dots (bottom two)
        const half = renderBraille([0.5, 0])
        expect(half).toBe("⡄") // dots 7,3 filled (bottom two), dots 2,1 empty
    })
})
