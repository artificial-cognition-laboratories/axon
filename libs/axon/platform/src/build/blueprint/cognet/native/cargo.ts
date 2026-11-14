import { err } from "@arcforge/err"
import type { RustSource } from "./crate"

/** Running cargo — private to Crate. */
export const cargo = {
    /** A release build of the workspace, into `target`. Shows the first compiler error or names a missing cargo. */
    async build(manifestPath: string, target: string, sources: readonly RustSource[]): Promise<void> {
        const spawned = (() => {
            try {
                return Bun.spawn(["cargo", "build", "--release", "--manifest-path", manifestPath], { env: { ...process.env, CARGO_TARGET_DIR: target }, stdout: "pipe", stderr: "pipe" })
            } catch (cause) {
                const systems = sources.flatMap(source => (source.system ? [source.system] : []))
                throw err("COGNET_NATIVE_FAILED", { detail: `this cognet has Rust systems (${systems.join(", ")}) and cargo could not be run — install Rust (rustup.rs) and prepare again`, cause: cause })
            }
        })()
        const [stderr, stdout, exitCode] = await Promise.all([new Response(spawned.stderr).text(), new Response(spawned.stdout).text(), spawned.exited])
        if (exitCode !== 0) {
            throw err("COGNET_NATIVE_FAILED", { detail: cargo.diagnostic(stderr || stdout, exitCode) })
        }
    },

    diagnostic(output: string, exitCode: number): string {
        const lines = output.trim().split("\n")
        const errors = lines.flatMap((line, at) => /^error(?:\[[^\]]+\])?:/.test(line) ? [at] : [])
        const first = errors.length > 0 ? lines.slice(errors[0], errors[1] ?? lines.length) : lines
        const shown = first.slice(0, 80).join("\n").trim()
        const rest = errors.length > 1 ? `\n${errors.length - 1} further Cargo errors; fix the first and prepare again.` : ""
        const clipped = first.length > 80 ? `\n... ${first.length - 80} more lines in this diagnostic` : ""
        return shown ? `${shown}${clipped}${rest}` : `cargo exited with code ${exitCode} and no diagnostic output`
    },
}
