import { describe, expect, test } from "bun:test"
import { Renderer, stripAnsi } from "../core/index.ts"
import { Live } from "./live.ts"

function interactiveRenderer() {
    const capture = Renderer.capture()
    return {
        ...capture,
        interactive: true,
    }
}

describe("Live", () => {
    test("keeps renderer output written while animating above later frames", () => {
        const r = interactiveRenderer()
        const live = Live({
            renderer: r,
            initial: "working",
            view: (_r, state, frame) => `${frame} ${state}`,
        })

        r.line("network: retrying")
        live.stop("done")
        r.line("afterwards")

        const output = stripAnsi(r.output())
        expect(output).toContain("network: retrying")
        expect(output.indexOf("network: retrying")).toBeLessThan(output.lastIndexOf("done"))
        expect(output).toEndWith("afterwards\n")
    })

    test("keeps messages written through write() while animating", () => {
        const r = interactiveRenderer()
        const live = Live({
            renderer: r,
            initial: "working",
            view: (_r, state) => state,
        })

        r.write("warning from child process\n")
        live.stop()

        expect(stripAnsi(r.output())).toContain("warning from child process\n")
    })
})
