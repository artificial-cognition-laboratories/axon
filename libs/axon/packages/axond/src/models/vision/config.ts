import { readFileSync } from "node:fs"
import { join } from "node:path"
import { err } from "@arcforge/err"
import type { Normalization } from "./tensor"

/**
 * What a vision repository says about itself — read from its own files,
 * never assumed. A model trained on different statistics fed ImageNet's
 * would run, and answer about a picture nobody showed it.
 */
export const config = {
    /** The repository's `config.json`. */
    model(path: string): Record<string, unknown> {
        return read(join(path, "config.json"))
    },

    /** How the repository's preprocessor scales pixels. Throws when it does not say. */
    normalization(path: string): Normalization {
        const pre = read(join(path, "preprocessor_config.json"))
        const mean = pre.image_mean
        const std = pre.image_std
        const rescale = pre.do_rescale === false ? 1 : pre.rescale_factor
        if (!triple(mean) || !triple(std) || typeof rescale !== "number") {
            throw err("MODEL_LOAD_FAILED", { detail: `${path} does not state image_mean, image_std and rescale_factor — its pixels cannot be prepared without guessing` })
        }
        return { rescale: rescale, mean: mean, std: std }
    },

    /**
     * The size the repository's preprocessor works at: the longer side it
     * resizes to, and what each side must be a multiple of. Throws when it
     * does not say — a guessed size runs, and answers worse with no error.
     */
    working(path: string): { side: number; multiple: number } {
        const pre = read(join(path, "preprocessor_config.json"))
        const size = pre.size as { height?: unknown; width?: unknown } | undefined
        const multiple = pre.ensure_multiple_of
        if (typeof size?.height !== "number" || typeof size.width !== "number" || typeof multiple !== "number" || multiple < 1) {
            throw err("MODEL_LOAD_FAILED", { detail: `${path} does not state size { height, width } and ensure_multiple_of — the size it works at cannot be known without guessing` })
        }
        return { side: Math.max(size.height, size.width), multiple: multiple }
    },
}

function read(path: string): Record<string, unknown> {
    try {
        return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>
    } catch (cause) {
        throw err("MODEL_LOAD_FAILED", { detail: `could not read ${path}`, cause: cause })
    }
}

function triple(value: unknown): value is [number, number, number] {
    return Array.isArray(value) && value.length === 3 && value.every(entry => typeof entry === "number")
}
