import { err } from "@arcforge/err"
import type { CognetConfig, EngineRequirement, Modality, ModelRef, ServiceRequirement, ServiceUse } from "@arcforge/types"
import type { Literal } from "./literal"

type Field<K extends keyof CognetConfig> = (value: Literal, path: string) => NonNullable<CognetConfig[K]>

/**
 * Every field a cognet config may hold, and the shape its value must have.
 * One table: a field is valid because it is here, and a field not here is a
 * mistake — a typo, or a field that moved — never something to skip.
 */
const FIELDS: { [K in keyof Required<CognetConfig>]: Field<K> } = {
    abi: (value, path) => is.string(value, path),
    mode: (value, path) => {
        const mode = is.object(value, path)
        if (mode.kind === "invocation") return { kind: "invocation" }
        if (mode.kind === "continuous") return { kind: "continuous", hz: is.positive(mode.hz, `${path}.hz`) }
        return wrong(`${path}.kind`, `"continuous" or "invocation"`)
    },
    wakeOn: (value, path) => is.array(value, path).map((one, i) => is.string(one, `${path}[${i}]`)) as CognetConfig["wakeOn"] & {},
    stimuli: (value, path) => is.object(value, path) as CognetConfig["stimuli"] & {},
    maxTicksPerWake: (value, path) => is.positive(value, path),
    threads: (value, path) => value === "auto" ? "auto" : is.count(value, path),
    engines: (value, path) => record(value, path, (one, at) => engine(one, at)),
    models: (value, path) => record(value, path, (one, at) => model(one, at)),
    uses: (value, path) => record(value, path, (one, at) => use(one, at)),
    suggests: (value, path) => record(value, path, (one, at) => is.string(one, at)),
}

/** `value`, read from `file`, as a CognetConfig — or COGNET_CONFIG_INVALID naming the first field that isn't. */
export function shape(value: Literal, file: string): CognetConfig {
    try {
        return fields(value)
    } catch (error) {
        if (!(error instanceof Invalid)) throw error
        throw err("COGNET_CONFIG_INVALID", { detail: `${file}: \`${error.path || "the config"}\` must be ${error.must}`, context: { file: file, field: error.path } })
    }
}

function fields(value: Literal): CognetConfig {
    const fields = is.object(value, "")
    const config: Record<string, unknown> = {}
    for (const [key, field] of Object.entries(fields)) {
        if (!(key in FIELDS)) wrong(key, `a field of cognet.config.ts — it has ${Object.keys(FIELDS).join(", ")}`)
        config[key] = FIELDS[key as keyof CognetConfig](field, key)
    }
    if (!("mode" in config)) wrong("mode", "present — every cognet says how it wakes")
    const primaries = [
        ...Object.entries((config.engines ?? {}) as Record<string, EngineRequirement>).filter(([, one]) => one.primary).map(([name]) => `engines.${name}`),
        ...Object.entries((config.uses ?? {}) as Record<string, ServiceUse>).filter(([, one]) => one.primary).map(([name]) => `uses.${name}`),
    ]
    if (primaries.length > 1) wrong(primaries[1]!, `the only primary — ${primaries[0]} already is; the user's model picker changes one`)
    for (const name of Object.keys(config.suggests ?? {})) {
        if (!(config.uses as Record<string, unknown> | undefined)?.[name]) wrong(`suggests.${name}`, "a use declared in `uses`")
    }
    return config as CognetConfig
}

function use(value: Literal, path: string): ServiceUse {
    const declared = is.object(value, path)
    const allowed = ["interface", "optional", "requires", "model", "primary", "parallel"]
    for (const key of Object.keys(declared)) {
        if (!allowed.includes(key)) wrong(`${path}.${key}`, `one of ${allowed.join(", ")}`)
    }
    const interfaceName = is.string(declared.interface, `${path}.interface`)
    if (!/^(\.\/interfaces\/|@[\w-]+\/[\w-]+\/)?[a-z][\w-]*@\d+$/.test(interfaceName)) {
        wrong(`${path}.interface`, "an interface and its major version — `depth-metric@1`, or `./interfaces/scene@1`")
    }
    return {
        interface: interfaceName,
        ...(declared.optional !== undefined ? { optional: is.boolean(declared.optional, `${path}.optional`) } : {}),
        ...(declared.requires !== undefined ? { requires: record(declared.requires, `${path}.requires`, requirement) } : {}),
        ...(declared.model !== undefined ? { model: models(declared.model, `${path}.model`) } : {}),
        ...(declared.primary !== undefined ? { primary: is.boolean(declared.primary, `${path}.primary`) } : {}),
        ...(declared.parallel !== undefined ? { parallel: is.whole(declared.parallel, `${path}.parallel`) } : {}),
    }
}

/** A model by the registry's id, or candidates in order. An id names a model, never a route: `anthropic/claude-haiku-4.5`, not `axon:…`. */
function models(value: Literal, path: string): string | string[] {
    const ids = typeof value === "string" ? [value] : is.array(value, path).map((one, i) => is.string(one, `${path}[${i}]`))
    if (ids.length === 0) wrong(path, "a model id, or a list of them")
    ids.forEach((id, i) => {
        const at = typeof value === "string" ? path : `${path}[${i}]`
        if (id.trim() !== id || id === "") wrong(at, "a model id, with no spaces around it")
        if (ids.indexOf(id) !== i) wrong(at, `named once — ${id} is already in the list`)
    })
    return typeof value === "string" ? ids[0]! : ids
}

function requirement(value: Literal, path: string): ServiceRequirement {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
    const bound = is.object(value, path)
    if ("includes" in bound) {
        if (Object.keys(bound).length !== 1) wrong(path, "`{ includes }` alone")
        return { includes: is.array(bound.includes, `${path}.includes`).map((one, i) => typeof one === "string" ? one : is.number(one, `${path}.includes[${i}]`)) }
    }
    const keys = Object.keys(bound)
    if (keys.length === 0 || keys.some(key => key !== "min" && key !== "max")) wrong(path, "a value, `{ min, max }`, or `{ includes }`")
    return {
        ...(bound.min !== undefined ? { min: is.number(bound.min, `${path}.min`) } : {}),
        ...(bound.max !== undefined ? { max: is.number(bound.max, `${path}.max`) } : {}),
    }
}

/** A provider's `engines:`, read from `file` — or SERVICE_INVALID naming the first field that is not an engine requirement. */
export function engines(value: Literal, file: string): Record<string, EngineRequirement> {
    try {
        return record(value, "engines", engine)
    } catch (error) {
        if (!(error instanceof Invalid)) throw error
        throw err("SERVICE_INVALID", { detail: `${file}: \`${error.path}\` must be ${error.must}`, context: { provider: file } })
    }
}

function engine(value: Literal, path: string): EngineRequirement {
    const declared = is.object(value, path)
    if (!["generate", "transform", "stream"].includes(declared.type as string)) wrong(`${path}.type`, `"generate", "transform" or "stream"`)
    const modalities = (one: Literal | undefined, at: string): Modality[] => {
        const list = typeof one === "string" ? [one] : is.array(one, at).map((each, i) => is.string(each, `${at}[${i}]`))
        if (list.length === 0) wrong(at, "a modality, or a list of them")
        return list as Modality[]
    }
    const prefer = declared.prefer === undefined ? undefined : is.object(declared.prefer, `${path}.prefer`)
    return {
        ...(declared as object),
        type: declared.type as EngineRequirement["type"],
        in: modalities(declared.in, `${path}.in`),
        out: modalities(declared.out, `${path}.out`),
        ...(prefer ? { prefer: {
            ...(prefer.in !== undefined ? { in: modalities(prefer.in, `${path}.prefer.in`) } : {}),
            ...(prefer.out !== undefined ? { out: modalities(prefer.out, `${path}.prefer.out`) } : {}),
        } } : {}),
    }
}

function model(value: Literal, path: string): ModelRef {
    if (typeof value === "string") return value
    const declared = is.object(value, path)
    is.string(declared.hf, `${path}.hf`)
    return declared as ModelRef
}

function record<T>(value: Literal, path: string, each: (value: Literal, path: string) => T): Record<string, T> {
    return Object.fromEntries(Object.entries(is.object(value, path)).map(([key, one]) => [key, each(one, `${path}.${key}`)]))
}

const is = {
    object(value: Literal | undefined, path: string): { [key: string]: Literal } {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return wrong(path, "an object")
        return value
    },
    array(value: Literal | undefined, path: string): Literal[] {
        return Array.isArray(value) ? value : wrong(path, "a list")
    },
    string(value: Literal | undefined, path: string): string {
        return typeof value === "string" ? value : wrong(path, "a string")
    },
    boolean(value: Literal | undefined, path: string): boolean {
        return typeof value === "boolean" ? value : wrong(path, "true or false")
    },
    number(value: Literal | undefined, path: string): number {
        return typeof value === "number" ? value : wrong(path, "a number")
    },
    positive(value: Literal | undefined, path: string): number {
        return typeof value === "number" && value > 0 ? value : wrong(path, "a number above 0")
    },
    whole(value: Literal | undefined, path: string): number {
        return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : wrong(path, "a whole number above 0")
    },
    count(value: Literal | undefined, path: string): number {
        return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : wrong(path, `"auto", or a whole number`)
    },
}

/** A field of the wrong shape: where, and what it must be. Becomes COGNET_CONFIG_INVALID, with the file, in `shape`. */
class Invalid {
    constructor(readonly path: string, readonly must: string) {}
}

function wrong(path: string, must: string): never {
    throw new Invalid(path, must)
}
