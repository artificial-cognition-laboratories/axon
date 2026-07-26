export type BenchMeasurementValueDefinition =
    | { kind: "number"; unit?: string; integer?: boolean; domain?: { min?: number; max?: number } }
    | { kind: "boolean" }
    | { kind: "category"; values?: string[]; open?: boolean }
    | { kind: "text" }

export type BenchMeasurementObjective =
    | "maximize"
    | "minimize"
    | { target: number }
    | { range: { min: number; max: number } }

export type BenchMeasurementReducer =
    | "mean"
    | "median"
    | "min"
    | "max"
    | "sum"
    | "rate"
    | "count"
    | "last"
    | "auc"

export type BenchMeasurementWeighting = "observation" | "case" | "trial" | "run" | "contributor"
export type BenchMeasurementGrain = "run" | "case" | "trial" | "step" | "session"
export type BenchMissingPolicy = "exclude" | "fail" | "zero"

/** Semantic measurement contract. Presentation is derived from this schema. */
export type BenchMeasurementDefinition = {
    id: string
    label: string
    description: string
    value: BenchMeasurementValueDefinition
    objective?: BenchMeasurementObjective
    aggregate?: BenchMeasurementReducer
    weighting?: BenchMeasurementWeighting
    grain?: BenchMeasurementGrain
    required?: boolean
    missing?: BenchMissingPolicy
}

