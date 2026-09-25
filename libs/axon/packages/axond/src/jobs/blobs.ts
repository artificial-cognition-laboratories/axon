import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, extname, join } from "node:path"
import { err } from "@arcforge/err"
import type { Attachment } from "./types"

type BlobsOpts = {
    /** Where blobs live. Sits beside the logs, under `.agents/work`. */
    root: string
}

/**
 * The extensions worth naming.
 *
 * Deliberately short. An attachment is evidence a person will look at — a
 * screenshot, a recording, a log, a diff — and everything else is served as an
 * opaque download rather than guessed at. A wrong media type renders as a
 * broken image, which reads as a broken system.
 */
const MEDIA: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".log": "text/plain",
    ".diff": "text/x-diff",
    ".patch": "text/x-diff",
    ".csv": "text/csv",
    ".html": "text/html",
}

/**
 * The ceiling on one attachment.
 *
 * These are committed alongside the code — that is what makes a job portable
 * with its checkout — so every byte is permanent in the repository's history.
 * A limit that refuses loudly at the boundary is far kinder than a repository
 * nobody can clone, discovered six months later.
 */
const MAX_BYTES = 25 * 1024 * 1024

/**
 * Blobs — content-addressed storage for job attachments.
 *
 * ── Why content addressing ──────────────────────────────────────────────────
 *
 * The log is append-only, so a reference recorded in an event must mean the
 * same bytes forever. Naming a blob by the hash of its content is the only
 * scheme where that is true by construction rather than by everyone agreeing
 * not to overwrite things. It also dedupes for free: the same screenshot
 * attached to three jobs is stored once.
 *
 * ── Why these live in the repository ────────────────────────────────────────
 *
 * Same reason the logs do. A job, its history and its evidence are project
 * context, and context that does not travel with the checkout is context the
 * next person does not have. The cost is repository size, which is what
 * `MAX_BYTES` exists to bound.
 */
export function Blobs(opts: BlobsOpts) {
    const root = opts.root

    function pathFor(id: string): string {
        return join(root, id)
    }

    return {
        get root(): string {
            return root
        },

        /** Where a blob is on disk, whether or not it exists. */
        path(id: string): string {
            return pathFor(id)
        },

        /**
         * Take a file into the store and describe it.
         *
         * Copies rather than moves: the path handed in belongs to the caller,
         * and a CLI that silently removed the screenshot you pointed it at
         * would be a surprising thing to have done.
         *
         * Writing is skipped when the hash is already present — the content is
         * identical by definition, so rewriting it would only risk truncating
         * a good blob to replace it with the same bytes.
         */
        add(file: string): Attachment {
            if (!existsSync(file)) {
                throw err("JOB_ATTACHMENT_MISSING", {
                    detail: `no file at ${file}`,
                    context: { file: file },
                })
            }

            const stat = statSync(file)
            if (stat.isDirectory()) {
                throw err("JOB_ATTACHMENT_INVALID", {
                    detail: `${file} is a directory — attach a file`,
                    context: { file: file },
                })
            }
            if (stat.size > MAX_BYTES) {
                throw err("JOB_ATTACHMENT_TOO_LARGE", {
                    detail: `${file} is ${Math.round(stat.size / 1024 / 1024)}MB; the limit is ${MAX_BYTES / 1024 / 1024}MB`,
                    context: { file: file, bytes: stat.size, limit: MAX_BYTES },
                })
            }

            const name = basename(file)
            const id = createHash("sha256").update(readFileSync(file)).digest("hex")

            mkdirSync(root, { recursive: true })
            const target = pathFor(id)
            if (!existsSync(target)) copyFileSync(file, target)

            return {
                id: id,
                name: name,
                media: MEDIA[extname(name).toLowerCase()] ?? "application/octet-stream",
                bytes: stat.size,
            }
        },

        /**
         * Store bytes directly — what a pasted image arrives as.
         *
         * The same path as `add` once the content is in hand, so a file from
         * disk and a paste from a webview cannot diverge in how they are
         * stored or addressed.
         */
        write(name: string, content: Uint8Array): Attachment {
            if (content.byteLength > MAX_BYTES) {
                throw err("JOB_ATTACHMENT_TOO_LARGE", {
                    detail: `${name} is ${Math.round(content.byteLength / 1024 / 1024)}MB; the limit is ${MAX_BYTES / 1024 / 1024}MB`,
                    context: { name: name, bytes: content.byteLength, limit: MAX_BYTES },
                })
            }

            const id = createHash("sha256").update(content).digest("hex")
            mkdirSync(root, { recursive: true })
            const target = pathFor(id)
            if (!existsSync(target)) writeFileSync(target, content)

            return {
                id: id,
                name: name,
                media: MEDIA[extname(name).toLowerCase()] ?? "application/octet-stream",
                bytes: content.byteLength,
            }
        },

        /** The bytes, or null when the blob is not here. */
        read(id: string): Buffer | null {
            const path = pathFor(id)
            if (!existsSync(path)) return null
            return readFileSync(path)
        },

        /**
         * Whether the content behind a reference is present.
         *
         * A missing blob is a real case — a log synced from another machine
         * arrives before its content does — so callers render the reference
         * and say the file is not here, rather than treating it as corruption.
         */
        has(id: string): boolean {
            return existsSync(pathFor(id))
        },
    }
}

export type BlobsT = ReturnType<typeof Blobs>
export { MAX_BYTES }
