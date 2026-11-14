import { readFileSync } from "node:fs"
import { join } from "node:path"
import { err } from "@arcforge/err"
import type { CognetUse, ServiceProvider } from "@arcforge/types"

/**
 * One case: a method, what it is given, and what a correct provider answers.
 * `call` names a call; `stream` a stream, whose answers are checked as
 * `{ events, last }`.
 */
export type Case = {
    name: string
    call?: string
    stream?: string
    given: Record<string, unknown>
    expect: unknown
    /** The tolerance on each number checked exactly, by field name. */
    within?: Record<string, number>
}

/** How one case went: passed, or every way it did not. */
export type Outcome = { name: string; passed: boolean; problems: string[] }

/**
 * Conformance — the cases an interface ships, run against one provider of it.
 *
 * A strict interface is only strict if something checks: the cases are what
 * a provider would most likely get wrong — conventions, units, ranges — and
 * every provider of the interface is held to the same ones. Inputs are
 * written in the cases (`$picture`, typed arrays, another call's answer), so
 * running them needs nothing but the provider.
 */
export function Conformance(opts: { use: CognetUse; provider: ServiceProvider; dir: string }) {
    return {
        /** Every case in the interface's `cases.json`, in order. */
        async run(): Promise<Outcome[]> {
            const outcomes: Outcome[] = []
            for (const one of cases(opts.dir)) outcomes.push(await run(one))
            return outcomes
        },
    }

    async function run(one: Case): Promise<Outcome> {
        try {
            const given = await inputs(one.given)
            const answer = one.stream ? await streamed(one.stream, given) : await opts.provider.call(called(one), given)
            const problems: string[] = []
            check(answer, one.expect, "", one.within ?? {}, answer, problems)
            return { name: one.name, passed: problems.length === 0, problems: problems }
        } catch (cause) {
            return { name: one.name, passed: false, problems: [`it failed: ${cause instanceof Error ? cause.message : String(cause)}`] }
        }
    }

    function called(one: Case): string {
        const method = one.call
        if (!method || !opts.use.methods[method]) throw err("SERVICE_INVALID", { detail: `case "${one.name}" calls ${method ?? "nothing"}, which ${opts.use.named} has not got` })
        return method
    }

    async function streamed(method: string, given: Record<string, unknown>): Promise<{ events: unknown[]; last: unknown }> {
        const events: unknown[] = []
        for await (const event of opts.provider.stream(method, given)) events.push(event)
        return { events: events, last: events.at(-1) ?? null }
    }

    /** What a case is given, with every `$…` written as the value it stands for. */
    async function inputs(value: unknown): Promise<Record<string, unknown>> {
        return await input(value) as Record<string, unknown>
    }

    async function input(value: unknown): Promise<unknown> {
        if (Array.isArray(value)) return Promise.all(value.map(input))
        if (value === null || typeof value !== "object") return value
        const record = value as Record<string, unknown>
        if ("$picture" in record) return picture(record.$picture as Picture)
        if ("$u8" in record) return Uint8Array.from(record.$u8 as number[])
        if ("$f32" in record) return Float32Array.from(record.$f32 as number[])
        if ("$call" in record) return opts.provider.call(record.$call as string, await inputs(record.given ?? {}))
        return Object.fromEntries(await Promise.all(Object.entries(record).map(async ([key, item]) => [key, await input(item)])))
    }

    /** A picture written in a case: one colour all over, or the raw RGB bytes of a file beside the cases. */
    function picture(spec: Picture): { width: number; height: number; rgb: Uint8Array } {
        const rgb = spec.file
            ? new Uint8Array(readFileSync(join(opts.dir, spec.file)))
            : Uint8Array.from({ length: spec.width * spec.height * 3 }, (_, index) => spec.fill![index % 3]!)
        if (rgb.length !== spec.width * spec.height * 3) throw err("SERVICE_INVALID", { detail: `a ${spec.width}×${spec.height} picture holds ${spec.width * spec.height * 3} bytes, not ${rgb.length}` })
        return { width: spec.width, height: spec.height, rgb: rgb }
    }
}

type Picture = { width: number; height: number; fill?: [number, number, number]; file?: string }

/** The cases beside an interface. */
function cases(dir: string): Case[] {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8"))
    if (!Array.isArray(parsed) || parsed.some(one => typeof one !== "object" || one === null || typeof one.name !== "string" || typeof one.given !== "object" || !("expect" in one) || (typeof one.call !== "string" && typeof one.stream !== "string"))) {
        throw err("SERVICE_INVALID", { detail: `${dir}/cases.json is a list of { name, call | stream, given, expect, within? }` })
    }
    return parsed as Case[]
}

/**
 * Whether `value` is what `expected` says, every way it is not added to
 * `problems`. An object of fields checks each; `{ min, max }`, `{ oneOf }`,
 * `{ type }`, `{ length }` and `{ each }` check what they name; anything else
 * must be equal — a number within its field's tolerance.
 */
function check(value: unknown, expected: unknown, path: string, within: Record<string, number>, answer: unknown, problems: string[]): void {
    const at = path || "the answer"
    if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
        const rule = expected as Record<string, unknown>
        const keys = Object.keys(rule)
        const rules = ["min", "max", "oneOf", "type", "length", "each"]
        if (keys.length > 0 && keys.every(key => rules.includes(key))) {
            if (rule.type !== undefined && typeof value !== rule.type) problems.push(`${at} is ${typeof value}, not ${rule.type}`)
            if (rule.min !== undefined && !(typeof value === "number" && value >= (rule.min as number))) problems.push(`${at} is ${JSON.stringify(value)}, below ${rule.min}`)
            if (rule.max !== undefined && !(typeof value === "number" && value <= (rule.max as number))) problems.push(`${at} is ${JSON.stringify(value)}, above ${rule.max}`)
            if (rule.oneOf !== undefined && !(rule.oneOf as unknown[]).includes(value)) problems.push(`${at} is ${JSON.stringify(value)}, not one of ${JSON.stringify(rule.oneOf)}`)
            if (rule.length !== undefined) {
                const length = lengthOf(value)
                if (length === null) problems.push(`${at} has no length`)
                else check(length, typeof rule.length === "string" ? product(rule.length, answer) : rule.length, `${at}.length`, within, answer, problems)
            }
            if (rule.each !== undefined) {
                const items = listed(value)
                if (items === null) problems.push(`${at} is not a list`)
                else {
                    // One problem per kind is enough: a mask of a million wrong values says so once.
                    const seen: string[] = []
                    items.forEach((item, index) => check(item, rule.each, `${at}[${index}]`, within, answer, seen))
                    if (seen.length > 0) problems.push(`${seen[0]}${seen.length > 1 ? ` (and ${seen.length - 1} more)` : ""}`)
                }
            }
            return
        }
        if (value === null || typeof value !== "object") {
            problems.push(`${at} is ${JSON.stringify(value)}, not an object`)
            return
        }
        for (const [key, inner] of Object.entries(rule)) check((value as Record<string, unknown>)[key], inner, path ? `${path}.${key}` : key, within, answer, problems)
        return
    }
    if (typeof expected === "number" && typeof value === "number") {
        const tolerance = within[path.split(".").at(-1) ?? ""] ?? 0
        if (Math.abs(value - expected) > tolerance) problems.push(`${at} is ${value}, not ${expected}${tolerance ? ` within ${tolerance}` : ""}`)
        return
    }
    if (Array.isArray(expected)) {
        const items = listed(value)
        if (!items || items.length !== expected.length) problems.push(`${at} is ${JSON.stringify(value)}, not ${expected.length} long`)
        else expected.forEach((item, index) => check(items[index], item, path, within, answer, problems))
        return
    }
    if (value !== expected) problems.push(`${at} is ${JSON.stringify(value)}, not ${JSON.stringify(expected)}`)
}

function lengthOf(value: unknown): number | null {
    if (typeof value === "string" || Array.isArray(value)) return value.length
    if (ArrayBuffer.isView(value)) return (value as unknown as { length: number }).length
    return null
}

function listed(value: unknown): unknown[] | null {
    if (Array.isArray(value)) return value
    if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>)
    return null
}

/** `"width*height"` — the product of the answer's own fields, for a length that depends on them. */
function product(expression: string, answer: unknown): number {
    return expression.split("*").reduce((total, field) => {
        const value = (answer as Record<string, unknown>)[field.trim()]
        if (typeof value !== "number") throw err("SERVICE_INVALID", { detail: `a length of "${expression}" needs the answer's ${field.trim()}, which is ${JSON.stringify(value)}` })
        return total * value
    }, 1)
}
