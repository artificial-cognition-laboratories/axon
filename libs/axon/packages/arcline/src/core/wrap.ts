/**
 * wrap — break text to a printable width.
 *
 * Prose is the one thing in this package that has to reflow. Every other
 * component is built from short cells that either fit or are the caller's
 * problem; an error description is a paragraph written once and read in
 * whatever terminal happens to be open, so it is wrapped rather than truncated
 * — truncating an explanation removes the part that explains.
 */

import { width } from "./ansi.ts"

/**
 * Wrap on whitespace to `max` printable columns.
 *
 * A word longer than the limit (a URL, a long identifier) is emitted on its own
 * line intact rather than broken mid-token: a split URL is not clickable and a
 * split identifier is not greppable, and both are worse than one long line.
 *
 * Existing newlines are preserved as paragraph breaks — the author put them
 * there.
 */
export function wrap(text: string, max: number): string[] {
    if (max <= 0) return [text]

    return text.split("\n").flatMap(paragraph => {
        if (paragraph === "") return [""]

        const lines: string[] = []
        let current = ""

        for (const word of paragraph.split(/\s+/).filter(Boolean)) {
            if (current === "") {
                current = word
                continue
            }
            if (width(current) + 1 + width(word) <= max) {
                current += " " + word
                continue
            }
            lines.push(current)
            current = word
        }

        if (current !== "") lines.push(current)
        return lines
    })
}
