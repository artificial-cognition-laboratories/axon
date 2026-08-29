import * as bun from "bun:test"
import { err } from "@arcforge/err"
export * from "bun:test"

type InstrumentedApi = Pick<typeof bun,
    "describe" | "test" | "it" | "beforeAll" | "beforeEach" | "afterEach" | "afterAll"
>

const api = (globalThis as typeof globalThis & { __axon_test_api__?: InstrumentedApi }).__axon_test_api__
if (!api) throw err("TEST_PRELOAD_MISSING")

export const describe = api.describe
export const test = api.test
export const it = api.it
export const beforeAll = api.beforeAll
export const beforeEach = api.beforeEach
export const afterEach = api.afterEach
export const afterAll = api.afterAll
export const xdescribe = api.describe.skip
export const xtest = api.test.skip
export const xit = api.it.skip

// Assertions, mocks, timers, and every non-lifecycle API remain Bun-native.
export const expect = bun.expect
export const mock = bun.mock
export const spyOn = bun.spyOn
export const jest = bun.jest
export const setSystemTime = bun.setSystemTime
export const setDefaultTimeout = bun.setDefaultTimeout
export const onTestFinished = bun.onTestFinished
