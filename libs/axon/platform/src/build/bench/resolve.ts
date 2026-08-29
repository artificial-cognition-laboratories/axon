import type { BenchAxis, BenchCell, BenchCoordinate, BenchHash, BenchValue } from "@arcforge/types"
import { err } from "@arcforge/err"

function canonical(value: BenchValue): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`
}

function pin(value: unknown): BenchHash {
    const hash = new Bun.CryptoHasher("sha256").update(canonical(value as BenchValue)).digest("hex")
    return `sha256:${hash}`
}

function findAxis(axes: BenchAxis[], key: string): BenchAxis {
    const axis = axes.find(item => item.key === key)
    if (!axis) throw err("BENCH_AXIS_NOT_FOUND", { context: { axis: key } })
    return axis
}

export function Resolver() {
    return {
        /**
         * @param agentPins resolved identities keyed by the ref as written, so
         *   an `agent` axis pins `@axon/coding-base@1.2.0` rather than a hash of
         *   the string "./fixtures/subject" — which says nothing anyone else
         *   could compare against.
         */
        async resolve(axes: BenchAxis[], coordinate: BenchCoordinate, agentPins?: Map<string, string>): Promise<BenchCell> {
            const resolved = coordinate.axes.map(selection => {
                const axis = findAxis(axes, selection.key)
                const selected = axis.values.find(item => item.id === selection.valueId)
                if (!selected) {
                    throw err("BENCH_AXIS_VALUE_NOT_FOUND", {
                        detail: `${selection.key}/${selection.valueId}`,
                        context: { axis: selection.key, valueId: selection.valueId },
                    })
                }
                const resolvedPin = selection.key === "agent" && typeof selected.value === "string"
                    ? agentPins?.get(selected.value)
                    : undefined

                return {
                    ...selection,
                    label: selected.label || selected.id,
                    pin: resolvedPin ?? pin(selected.value),
                }
            })
            return { id: coordinate.id, axes: resolved }
        },
    }
}

export type ResolverT = ReturnType<typeof Resolver>
