import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { fail, parseShapes, type Shape } from "./model"

const MANIFEST = fileURLToPath(new URL("./rust_source/Cargo.toml", import.meta.url))
const PARSER = fileURLToPath(new URL("./rust_source/src/main.rs", import.meta.url))
const LOCK = fileURLToPath(new URL("./rust_source/Cargo.lock", import.meta.url))

/** `syn` parses Rust's syntax; an unsupported declaration fails at prepare. */
export function RustSource(_opts: {}) {
    let binary: string | null = null
    return {
        read(path: string): Shape[] {
            if (!binary) {
                const version = createHash("sha256").update(readFileSync(MANIFEST)).update(readFileSync(PARSER)).update(readFileSync(LOCK)).digest("hex").slice(0, 16)
                const target = join(tmpdir(), `axon-component-rust-parser-${version}`)
                let build: ReturnType<typeof Bun.spawnSync>
                try { build = Bun.spawnSync(["cargo", "build", "--locked", "--quiet", "--manifest-path", MANIFEST, "--target-dir", target], { stderr: "pipe", stdout: "pipe" }) }
                catch (cause) { fail(path, `cannot start Cargo for Rust component parsing: ${String(cause)}`) }
                if (build.exitCode !== 0) fail(path, `Rust component parser could not build: ${new TextDecoder().decode(build.stderr).trim()}`)
                binary = join(target, "debug", "cognet-component-source")
            }
            let run: ReturnType<typeof Bun.spawnSync>
            try { run = Bun.spawnSync([binary, path], { stderr: "pipe", stdout: "pipe" }) }
            catch (cause) { fail(path, `cannot start Rust component parser: ${String(cause)}`) }
            if (run.exitCode !== 0) fail(path, new TextDecoder().decode(run.stderr).trim() || "Rust component parser failed")
            return parseShapes(path, new TextDecoder().decode(run.stdout))
        },
    }
}
