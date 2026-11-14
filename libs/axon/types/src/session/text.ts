/**
 * A place in the session's text: an entry, named by the seq the mind received
 * it at, and an offset into `entryText(entry)` in UTF-16 code units. A
 * streamed reply is ONE entry: its chunks folded together (`foldChunks`),
 * named by the seq of its first chunk. A place never addresses a chunk.
 */
export type TextPoint = { seq: number; at: number }

/**
 * A stretch of the session's text — where a piece of text perception sits,
 * as a pose is where a thing sits in space. `to` is exclusive.
 *
 * Its ends may lie in different entries: a sentence starts and ends in one,
 * a topic runs across many. Equal ends are a boundary — a place, not a stretch.
 */
export type TextSpan = { from: TextPoint; to: TextPoint }

/**
 * The text of an entry, as a span indexes it — or null for an entry that has
 * none (a picture, a sound).
 *
 * The ONE definition: the mind computes spans against it and every viewer
 * draws them against it. Two that disagreed by a character would shift every
 * overlay by it — plausibly, and with nothing to say so.
 */
export function entryText(entry: { type: string; data: unknown }): string | null {
    switch (entry.type) {
        case "cognet:stimulus:text":
        case "cognet:output:text":
        case "cognet:action:typescript":
        case "cognet:action:result":
            return (entry.data as { content: string }).content
        default:
            return null
    }
}
