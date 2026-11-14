import type { SpaceHandle } from "../space"
import { DEQUANT, type ColumnsHandle } from "./columns"

/** One axis's health. The first place to look when a query returns nonsense. */
export type AxisStats = {
    name: string
    domain: string
    /** Fraction of live rows that measured it. Zero means nothing produces it; one is normal for a mechanical axis. */
    fill: number
    /** Mean value across rows that measured it. */
    mean: number
    variance: number
    min: number
    max: number
}

/**
 * How completely a domain is measured across the store.
 *
 * `partial` is the number to watch, and it is the one this package learned the
 * hard way. A domain that is either FULLY measured or FULLY absent on a given
 * record is safe: comparisons within it use every axis, and records lacking it are
 * dropped rather than competing. A *partially* measured domain produces distances
 * estimated from a handful of lucky axes — and `near()` takes a minimum, so those
 * estimates win rankings they have not earned.
 *
 * Lab e4: at the same ~12-axis budget, coverage scattered across four domains gave
 * `recall@1` 0.165, while one whole domain gave 0.390. Shape beats amount.
 */
export type CoverageStats = {
    domain: string
    axes: number
    /** Mean fraction of this domain's axes measured, over live records. */
    mean: number
    /** Fraction of records measuring ALL of it. Safe. */
    complete: number
    /** Fraction measuring NONE of it. Also safe — they simply do not compete here. */
    absent: number
    /** Fraction measuring SOME of it. The dangerous middle. */
    partial: number
}

/** A correlated pair. `|r|` near 1 means one concept is being counted twice. */
export type AxisCorrelation = {
    a: string
    b: string
    r: number
    /** Rows where both were measured. A high r over four rows means nothing. */
    overlap: number
}

/**
 * Axis health.
 *
 * These are not nice-to-have metrics. Hand-authored axes fail in exactly two
 * ways, and both are invisible from reading the axis table:
 *
 *   a DEAD axis      fill near 0, or variance near 0 — it never fires, or fires
 *                    on everything, and contributes nothing but noise to distance
 *   a DUPLICATE axis  |r| near 1 with another — one concept counted twice, which
 *                    silently doubles its pull on every ranking
 *
 * Cheap because the layout is columnar: an axis's statistics are a scan of one
 * contiguous array.
 */
export function Stats(opts: { space: SpaceHandle; columns: ColumnsHandle }) {
    const space = opts.space
    const columns = opts.columns

    return {
        axes(): AxisStats[] {
            const live = columns.count
            const out: AxisStats[] = []

            for (let index = 0; index < space.axes.length; index++) {
                const axis = space.axes.at(index)
                const column = columns.column(index)

                let sum = 0
                let measured = 0
                let min = Number.POSITIVE_INFINITY
                let max = Number.NEGATIVE_INFINITY

                for (const slot of columns.slotsLive()) {
                    if (column.conf[slot]! === 0) continue
                    const value = DEQUANT[column.values[slot]!]!
                    sum += value
                    measured++
                    if (value < min) min = value
                    if (value > max) max = value
                }

                const mean = measured === 0 ? 0 : sum / measured
                let square = 0
                if (measured > 0) {
                    for (const slot of columns.slotsLive()) {
                        if (column.conf[slot]! === 0) continue
                        const delta = DEQUANT[column.values[slot]!]! - mean
                        square += delta * delta
                    }
                }

                out.push({
                    name: axis.name,
                    domain: axis.domain,
                    fill: live === 0 ? 0 : measured / live,
                    mean: mean,
                    variance: measured === 0 ? 0 : square / measured,
                    min: measured === 0 ? 0 : min,
                    max: measured === 0 ? 0 : max,
                })
            }

            return out
        },

        /**
         * Per-domain coverage. The diagnostic for whether rankings can be trusted.
         *
         * A store whose domains are complete-or-absent ranks reliably. One with a
         * large `partial` fraction does not, and nothing in a query result would
         * otherwise say so — the distances all look like ordinary numbers.
         */
        coverage(): CoverageStats[] {
            const live = columns.count
            const out: CoverageStats[] = []

            for (const name of space.domains.names()) {
                const indices = space.domains.axesOf(name)
                let measuredSum = 0
                let complete = 0
                let absent = 0

                for (const slot of columns.slotsLive()) {
                    let measured = 0
                    for (const axis of indices) {
                        if (columns.column(axis).conf[slot]! > 0) measured++
                    }
                    measuredSum += measured / indices.length
                    if (measured === indices.length) complete++
                    else if (measured === 0) absent++
                }

                out.push({
                    domain: name,
                    axes: indices.length,
                    mean: live === 0 ? 0 : measuredSum / live,
                    complete: live === 0 ? 0 : complete / live,
                    absent: live === 0 ? 0 : absent / live,
                    partial: live === 0 ? 0 : (live - complete - absent) / live,
                })
            }

            return out
        },

        /**
         * Correlated pairs, strongest first.
         *
         * `minOverlap` exists because a perfect correlation over three rows is an
         * artefact, and reporting it would train you to ignore this view.
         */
        correlations(opts: { minOverlap?: number; threshold?: number } = {}): AxisCorrelation[] {
            const minOverlap = opts.minOverlap ?? 8
            const threshold = opts.threshold ?? 0.8
            const slots = [...columns.slotsLive()]
            const out: AxisCorrelation[] = []

            for (let a = 0; a < space.axes.length; a++) {
                for (let b = a + 1; b < space.axes.length; b++) {
                    const pair = pearson(columns, slots, a, b)
                    if (pair.overlap < minOverlap) continue
                    if (Math.abs(pair.r) < threshold) continue
                    out.push({ a: space.axes.at(a).name, b: space.axes.at(b).name, r: pair.r, overlap: pair.overlap })
                }
            }

            return out.sort((x, y) => Math.abs(y.r) - Math.abs(x.r))
        },
    }
}

export type StatsHandle = ReturnType<typeof Stats>

/** Pearson r over the rows where both axes were measured — the same intersection rule the metric uses. */
function pearson(
    columns: ColumnsHandle,
    slots: readonly number[],
    a: number,
    b: number
): { r: number; overlap: number } {
    const columnA = columns.column(a)
    const columnB = columns.column(b)

    let n = 0
    let sumA = 0
    let sumB = 0
    for (const slot of slots) {
        if (columnA.conf[slot]! === 0 || columnB.conf[slot]! === 0) continue
        sumA += DEQUANT[columnA.values[slot]!]!
        sumB += DEQUANT[columnB.values[slot]!]!
        n++
    }
    if (n < 2) return { r: 0, overlap: n }

    const meanA = sumA / n
    const meanB = sumB / n
    let cov = 0
    let varA = 0
    let varB = 0

    for (const slot of slots) {
        if (columnA.conf[slot]! === 0 || columnB.conf[slot]! === 0) continue
        const da = DEQUANT[columnA.values[slot]!]! - meanA
        const db = DEQUANT[columnB.values[slot]!]! - meanB
        cov += da * db
        varA += da * da
        varB += db * db
    }

    const denom = Math.sqrt(varA) * Math.sqrt(varB)
    return { r: denom === 0 ? 0 : cov / denom, overlap: n }
}
