export type BenchDimensionValue = string | number | boolean

export type BenchDimensionDefinition = {
    id: string
    label: string
    description?: string
    /** High-cardinality dimensions are excluded from default groupings. */
    cardinality?: "low" | "high"
    value:
        | { kind: "string" }
        | { kind: "number" }
        | { kind: "boolean" }
        | { kind: "category"; values: string[]; open?: boolean }
}

