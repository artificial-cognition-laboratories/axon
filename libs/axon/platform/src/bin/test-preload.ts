import { AsyncLocalStorage } from "node:async_hooks"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
    afterAll as bunAfterAll,
    afterEach as bunAfterEach,
    beforeAll as bunBeforeAll,
    beforeEach as bunBeforeEach,
    describe as bunDescribe,
    it as bunIt,
    test as bunTest,
} from "bun:test"
import type { AxonError } from "@arcforge/err"
import { err } from "@arcforge/err"
import type { AxonTestEventFrame, AxonTestHookKind } from "@arcforge/types"

type Context = { suiteId?: string; testId?: string; hookId?: string; attempt?: number; resources?: Record<string, unknown> }
type CaseOutcome = { status: "passed" } | { status: "failed"; error: unknown }
type BeforeCase = (context: Context) => void | Promise<void>
type AfterCase = (context: Context, outcome: CaseOutcome) => void | Promise<void>
type Mode = "run" | "only" | "skip" | "todo" | "failing"

const file = process.env.AXON_TEST_FILE ?? "unknown"
const context = new AsyncLocalStorage<Context>()
const suiteStack: Array<{ id: string; name: string }> = []
const occurrences = new Map<string, number>()
const beforeCase = new Set<BeforeCase>()
const afterCase = new Set<AfterCase>()

function send(frame: AxonTestEventFrame): void {
    const ipc = process as typeof process & { send?: (message: unknown) => void }
    ipc.send?.({ channel: "axon:test", frame })
}

/**
 * An Error's own fields are non-enumerable, so JSON.stringify() of one is
 * `{}` — and this crosses to the runner as JSON. Every failing test therefore
 * reported an empty error, which is worse than no error at all: it says
 * something went wrong and refuses to say what. Copy the parts that matter
 * onto a plain object so the message survives the boundary.
 */
function errorOf(value: unknown): AxonError {
    const error = err(value)

    // An Error's own fields are non-enumerable, so JSON.stringify() of one is
    // `{}` — and this crosses to the runner as JSON. Every failing test
    // therefore reported an empty error, which is worse than none: it says
    // something went wrong and refuses to say what.
    //
    // Redefined as enumerable ON the error rather than spread into a new
    // object: isAxonError() checks `value instanceof Error`, so a plain copy
    // stops being an AxonError to everything downstream.
    for (const key of ["message", "stack"] as const) {
        const current = error[key]
        if (current === undefined) continue
        Object.defineProperty(error, key, { value: current, enumerable: true, writable: true, configurable: true })
    }
    return error
}

function id(kind: "suite" | "test", name: string): string {
    const base = [file, ...suiteStack.map(suite => suite.name), name].join("::")
    const key = `${kind}:${base}`
    const occurrence = occurrences.get(key) ?? 0
    occurrences.set(key, occurrence + 1)
    return `${key}:${occurrence}`
}

function frameContext(extra: Partial<Context> = {}): Omit<Context & { file: string }, "testRunId"> {
    return { file, ...context.getStore(), ...extra }
}

function serialize(values: unknown[]): string[] {
    return values.map(value => {
        if (typeof value === "string") return value
        try {
            return JSON.stringify(value)
        } catch {
            return String(value)
        }
    })
}

function installConsole(): void {
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
        const original = console[level].bind(console)
        console[level] = ((...values: unknown[]) => {
            send({ type: "test:console", context: frameContext(), data: { level, values: serialize(values) } })
            original(...values)
        }) as typeof console[typeof level]
    }
}

function runCallback(fn: (...args: any[]) => unknown, args: unknown[], doneStyle = fn.length > 0): Promise<unknown> {
    if (!doneStyle) return Promise.resolve(fn(...args))
    return new Promise((resolve, reject) => {
        let settled = false
        const done = (error?: unknown) => {
            if (settled) return
            settled = true
            error === undefined ? resolve(undefined) : reject(error)
        }
        try {
            const result = fn(...args, done)
            if (result && typeof (result as PromiseLike<unknown>).then === "function") {
                Promise.resolve(result).then(resolve, reject)
            }
        } catch (error) {
            reject(error)
        }
    })
}

function wrapDescribe(base: typeof bunDescribe, mode: Exclude<Mode, "failing"> = "run"): typeof bunDescribe {
    function register(target: typeof bunDescribe, targetMode: Exclude<Mode, "failing">, name: string, fn: (...args: any[]) => void): void {
        const suiteId = id("suite", String(name))
        const parentSuiteId = suiteStack.at(-1)?.id
        send({ type: "test:suite:declare", context: frameContext({ suiteId }), data: { name: String(name), ...(parentSuiteId ? { parentSuiteId } : {}), mode: targetMode } })

        if (targetMode === "skip" || targetMode === "todo") return target(name, fn)

        return target(name, (...args: any[]) => {
            suiteStack.push({ id: suiteId, name: String(name) })
            const started = { value: 0 }
            bunBeforeAll(() => {
                started.value = performance.now()
                send({ type: "test:suite:start", context: frameContext({ suiteId }), data: { name: String(name) } })
            })
            fn(...args)
            bunAfterAll(() => {
                send({ type: "test:suite:complete", context: frameContext({ suiteId }), data: { name: String(name), durationMs: performance.now() - started.value } })
            })
            suiteStack.pop()
        })
    }

    const wrapped: any = (name: string, fn: () => void) => register(base, mode, name, fn)
    wrapped.only = (name: string, fn: () => void) => register(base.only, "only", name, fn)
    wrapped.skip = (name: string, fn: () => void) => register(base.skip, "skip", name, fn)
    wrapped.todo = (name: string, fn: () => void) => register(base.todo, "todo", name, fn)
    wrapped.concurrent = (name: string, fn: () => void) => register(base.concurrent, mode, name, fn)
    wrapped.serial = (name: string, fn: () => void) => register(base.serial, mode, name, fn)
    wrapped.if = (condition: boolean) => wrapDescribe(base.if(condition), condition ? mode : "skip")
    wrapped.skipIf = (condition: boolean) => wrapDescribe(base.skipIf(condition), condition ? "skip" : mode)
    wrapped.todoIf = (condition: boolean) => wrapDescribe(base.todoIf(condition), condition ? "todo" : mode)
    wrapped.each = (table: unknown[]) => {
        const target = base.each(table as never)
        return (name: string, fn: () => void) => register(target as typeof bunDescribe, mode, name, fn)
    }
    return wrapped as typeof bunDescribe
}

function wrapTest(base: typeof bunTest, mode: Mode = "run"): typeof bunTest {
    function register(target: typeof bunTest, targetMode: Mode, name: string, fn: (...args: any[]) => unknown, options?: unknown, fromEach = false): void {
        const testId = id("test", String(name))
        const suite = suiteStack.map(item => item.name)
        const suiteId = suiteStack.at(-1)?.id
        let attempt = 0
        send({ type: "test:case:declare", context: frameContext({ testId, suiteId }), data: { name: String(name), suite, mode: targetMode } })

        // bun:test's callback type is narrower than the variadic shape this
        // wrapper accepts (it also passes a `done` callback). The runtime
        // contract is identical — same reason `options` is cast below.
        if (targetMode === "skip") {
            send({ type: "test:case:skip", context: frameContext({ testId, suiteId }), data: {} })
            return target(name, fn as never, options as never)
        }
        if (targetMode === "todo") {
            send({ type: "test:case:todo", context: frameContext({ testId, suiteId }), data: {} })
            return target(name, fn as never, options as never)
        }

        return target(name, async (...args: unknown[]) => {
            const currentAttempt = attempt++
            const started = performance.now()
            send({ type: "test:case:start", context: frameContext({ testId, suiteId, attempt: currentAttempt }), data: { name: String(name), suite } })
            try {
                const active: Context = { testId, suiteId, attempt: currentAttempt, resources: {} }
                await context.run(active, async () => {
                    let outcome: CaseOutcome = { status: "passed" }
                    let failure: unknown
                    try {
                        for (const handler of beforeCase) await handler(active)
                        await runCallback(fn, args, !fromEach && fn.length > 0)
                    } catch (error) {
                        failure = error
                        outcome = { status: "failed", error }
                    }
                    try {
                        for (const handler of afterCase) await handler(active, outcome)
                    } catch (error) {
                        if (failure !== undefined) throw new AggregateError([failure, error], "test and after-case lifecycle both failed")
                        throw error
                    }
                    if (failure !== undefined) throw failure
                })
                if (targetMode === "failing") {
                    send({ type: "test:case:fail", context: frameContext({ testId, suiteId, attempt: currentAttempt }), data: { durationMs: performance.now() - started, error: errorOf(new Error("Expected failing test to throw")) } })
                    return
                }
                send({ type: "test:case:pass", context: frameContext({ testId, suiteId, attempt: currentAttempt }), data: { durationMs: performance.now() - started } })
            } catch (error) {
                if (targetMode === "failing") {
                    send({ type: "test:case:pass", context: frameContext({ testId, suiteId, attempt: currentAttempt }), data: { durationMs: performance.now() - started } })
                    throw error
                }
                send({ type: "test:case:fail", context: frameContext({ testId, suiteId, attempt: currentAttempt }), data: { durationMs: performance.now() - started, error: errorOf(error) } })
                throw error
            }
        }, options as never)
    }

    const wrapped: any = (name: string, fn: (...args: any[]) => unknown, options?: unknown) => register(base, mode, name, fn, options)
    wrapped.only = (name: string, fn: (...args: any[]) => unknown, options?: unknown) => register(base.only, "only", name, fn, options)
    wrapped.skip = (name: string, fn: (...args: any[]) => unknown, options?: unknown) => register(base.skip, "skip", name, fn, options)
    wrapped.todo = (name: string, fn: (...args: any[]) => unknown, options?: unknown) => register(base.todo, "todo", name, fn, options)
    wrapped.failing = (name: string, fn: (...args: any[]) => unknown, options?: unknown) => register(base.failing, "failing", name, fn, options)
    wrapped.concurrent = (name: string, fn: (...args: any[]) => unknown, options?: unknown) => register(base.concurrent, mode, name, fn, options)
    wrapped.serial = (name: string, fn: (...args: any[]) => unknown, options?: unknown) => register(base.serial, mode, name, fn, options)
    wrapped.if = (condition: boolean) => wrapTest(base.if(condition), condition ? mode : "skip")
    wrapped.skipIf = (condition: boolean) => wrapTest(base.skipIf(condition), condition ? "skip" : mode)
    wrapped.todoIf = (condition: boolean) => wrapTest(base.todoIf(condition), condition ? "todo" : mode)
    wrapped.failingIf = (condition: boolean) => wrapTest(base.failingIf(condition), condition ? "failing" : mode)
    wrapped.concurrentIf = (condition: boolean) => wrapTest(base.concurrentIf(condition), mode)
    wrapped.serialIf = (condition: boolean) => wrapTest(base.serialIf(condition), mode)
    wrapped.each = (table: unknown[]) => {
        const target = base.each(table as never)
        return (name: string, fn: (...args: any[]) => unknown, options?: unknown) => register(target as typeof bunTest, mode, name, fn, options, true)
    }
    return wrapped as typeof bunTest
}

function wrapHook(base: typeof bunBeforeAll, kind: AxonTestHookKind): typeof bunBeforeAll {
    return ((fn: (...args: any[]) => unknown, options?: unknown) => {
        const suiteId = suiteStack.at(-1)?.id
        const hookId = id("test", `$hook:${kind}`)
        return base(async (...args: unknown[]) => {
            const started = performance.now()
            send({ type: "test:hook:start", context: frameContext({ hookId, suiteId }), data: { kind } })
            try {
                await context.run({ hookId, suiteId }, () => runCallback(fn, args))
                send({ type: "test:hook:complete", context: frameContext({ hookId, suiteId }), data: { kind, durationMs: performance.now() - started } })
            } catch (error) {
                send({ type: "test:hook:fail", context: frameContext({ hookId, suiteId }), data: { kind, durationMs: performance.now() - started, error: errorOf(error) } })
                throw error
            }
        }, options as never)
    }) as typeof bunBeforeAll
}

installConsole()
// Monitor without installing uncaughtException/unhandledRejection handlers,
// which would change Bun's native crash semantics by marking them handled.
process.on("uncaughtExceptionMonitor", error => send({ type: "test:process:fault", context: frameContext(), data: { kind: "uncaught", error: errorOf(error) } }))

const test = wrapTest(bunTest)
const instrumented = {
    describe: wrapDescribe(bunDescribe),
    test,
    it: wrapTest(bunIt),
    beforeAll: wrapHook(bunBeforeAll, "beforeAll"),
    beforeEach: wrapHook(bunBeforeEach, "beforeEach"),
    afterEach: wrapHook(bunAfterEach, "afterEach"),
    afterAll: wrapHook(bunAfterAll, "afterAll"),
}

;(globalThis as any).__axon_test_api__ = instrumented
;(globalThis as any).__axon_test_context__ = {
    current: () => context.getStore(),
    beforeCase(handler: BeforeCase) {
        beforeCase.add(handler)
        return () => beforeCase.delete(handler)
    },
    afterCase(handler: AfterCase) {
        afterCase.add(handler)
        return () => afterCase.delete(handler)
    },
}
Object.assign(globalThis, instrumented)

// Bun's built-in test globals are lexical in current releases; assigning
// globalThis alone does not replace them. Transform only the explicitly
// selected test file in memory — user source is never rewritten on disk.
const target = resolve(process.cwd(), file)
const apiUrl = pathToFileURL(new URL("./test-api.ts", import.meta.url).pathname).href
const injected = `import { describe, test, it, xdescribe, xtest, xit, beforeAll, beforeEach, afterEach, afterAll } from ${JSON.stringify(apiUrl)};\n`
const targetFilter = new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)

Bun.plugin({
    name: "axon-test-events",
    setup(builder) {
        builder.onLoad({ filter: targetFilter }, async args => {
            let source = await Bun.file(args.path).text()
            const bindingImport = /import\s+(?!["'])[^;]+?from\s+["']bun:test["']/s.test(source)
            source = source.replace(/(["'])bun:test\1/g, JSON.stringify(apiUrl))
            if (!bindingImport) source = injected + source
            const extension = args.path.split(".").pop()
            const loader = extension === "tsx" ? "tsx" : extension === "jsx" ? "jsx" : extension === "js" || extension === "mjs" || extension === "cjs" ? "js" : "ts"
            return { contents: source, loader }
        })
    },
})

// Domain extensions load after test context/instrumentation is installed, but
// before Bun imports the selected test file. Bun only honors one --preload
// reliably, so TestRunner composes extensions here rather than stacking flags.
const extensionPreloads = JSON.parse(process.env.AXON_TEST_EXTENSION_PRELOADS ?? "[]") as string[]
for (const extension of extensionPreloads) await import(pathToFileURL(extension).href)
