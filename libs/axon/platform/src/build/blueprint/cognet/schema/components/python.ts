import { fail, parseShapes, type Shape } from "./model"
import { fileURLToPath } from "node:url"

/** Python's own AST reads annotations without importing or executing source code. */
export function PythonSource(_opts: {}) {
    return {
        read(path: string): Shape[] {
            let run: ReturnType<typeof Bun.spawnSync>
            try { run = Bun.spawnSync(["python3", "-I", fileURLToPath(new URL("./python_source.py", import.meta.url)), path], { stdout: "pipe", stderr: "pipe" }) }
            catch (cause) { fail(path, `cannot start Python component parser: ${String(cause)}`) }
            if (run.exitCode !== 0) fail(path, new TextDecoder().decode(run.stderr).trim() || "Python component parser failed")
            return parseShapes(path, new TextDecoder().decode(run.stdout))
        },
    }
}
