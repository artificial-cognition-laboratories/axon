import type { body } from "@arcforge/types"
import { REAL, STILL } from "./parts"

/**
 * A container's shell — a coding agent's body. It has no place in any space:
 * its base alone, nothing that moves, one text sense. What it can do, it does
 * as skills, through `run()` and the policy check. Today's TypeScript and bash
 * tools are these, described.
 */
export const SHELL = {
    contract: "axon.body/1",
    kind: "docker.shell",
    clock: { unit: "ms", pace: REAL },
    world: { space: { dimensions: 0 }, places: [] },
    frames: [{ name: "base", parent: null, axes: "flu", at: [0, 0, 0], turn: STILL }],
    senses: [{ channel: "/terminal", kind: "text" }],
    controls: [],
    skills: [
        {
            name: "exec", describe: "Run a command in the container's shell", cancellable: true, within: 600_000,
            args: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } }, required: ["command"] },
            result: { type: "object", properties: { stdout: { type: "string" }, stderr: { type: "string" }, code: { type: "integer" } } },
        },
        {
            name: "write", describe: "Write a file", cancellable: false, within: 10_000,
            args: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
            result: { type: "object", properties: { bytes: { type: "integer" } } },
        },
    ],
} as const satisfies body.Manifest
