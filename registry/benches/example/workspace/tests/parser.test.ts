import { expect, it } from "bun:test"
import { parseLine } from "../src/parser"

it("parses a simple pair", () => {
    expect(parseLine("a=1")).toEqual({ key: "a", value: "1" })
})

it("keeps '=' inside the value", () => {
    // Fails today: split("=") drops everything after the second "=".
    expect(parseLine("url=http://x/?a=1")).toEqual({ key: "url", value: "http://x/?a=1" })
})

it("trims surrounding whitespace", () => {
    expect(parseLine("  a = 1  ")).toEqual({ key: "a", value: "1" })
})
