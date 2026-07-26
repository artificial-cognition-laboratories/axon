import { formatBytes } from "./text"

/**
 * Capsule output projection — how raw capsule REPL output looks to the model.
 *
 * The capsule REPL emits a JSONL op-record envelope for every module function
 * call, followed by the raw auto-logged return value. This detects that
 * envelope, extracts the meaningful content per op type, and discards the
 * noise.
 *
 * For content-returning ops (fs.read, fs.list, ...) — show the content.
 * For mutation ops (fs.write, fs.mkdir, ...) — show a compact tick line.
 * For anything else — pass through unchanged.
 *
 * The silent catch fall-throughs here are correct, not masked failures:
 * this is a best-effort display projection where "show the raw string"
 * is the honest fallback for anything that doesn't parse.
 */
export function formatCapsuleOutput(content: string): string {
    const raw = content.trim()

    // Plain JSON array — e.g. fs.list() return value serialised directly
    if (raw.startsWith("[")) {
        try {
            const arr = JSON.parse(raw)
            if (Array.isArray(arr)) {
                if (arr.length === 0) return "(empty)"
                // DirEntry[] — render as a compact directory listing
                if (
                    arr.length > 0 &&
                    typeof arr[0] === "object" &&
                    arr[0] !== null &&
                    "name" in arr[0]
                ) {
                    return arr
                        .map((e: any) => `${e.type === "directory" ? "d" : "-"}  ${e.name}`)
                        .join("\n")
                }
                // Generic array of primitives or unknown objects
                return arr
                    .map((e: any) => (typeof e === "object" ? JSON.stringify(e) : String(e)))
                    .join("\n")
            }
        } catch {
            /* not JSON — fall through to raw */
        }
        return raw
    }

    if (!raw.startsWith("{")) return raw

    // Extract all leading JSON op-record objects.
    // Everything after the last op record (the raw auto-logged return value)
    // is discarded — the meaningful content comes from the op record's data field.
    const opRecords: any[] = []
    let i = 0
    while (i < raw.length && raw[i] === "{") {
        let depth = 0
        let j = i
        while (j < raw.length) {
            const ch = raw[j]
            if (ch === '"') {
                // skip over string contents, respecting escape sequences
                j++
                while (j < raw.length) {
                    if (raw[j] === "\\") {
                        j += 2
                        continue
                    }
                    if (raw[j] === '"') {
                        j++
                        break
                    }
                    j++
                }
                continue
            }
            if (ch === "{") depth++
            else if (ch === "}") {
                depth--
                if (depth === 0) {
                    j++
                    break
                }
            }
            j++
        }
        try {
            const obj = JSON.parse(raw.slice(i, j))
            if ("op" in obj) opRecords.push(obj)
            else if ("procId" in obj && "command" in obj) {
                const tail = obj.tail ? `\n${obj.tail}` : ""
                return `spawned  ${obj.command}  procId=${obj.procId}  pid=${obj.pid ?? "?"}  status=${obj.status ?? "running"}${tail}`
            } else break
        } catch {
            break
        }
        i = j
        while (i < raw.length && (raw[i] === "\n" || raw[i] === "\r")) i++
    }

    if (opRecords.length === 0) return raw

    return opRecords
        .map(obj => {
            const op: string = obj.op ?? ""
            const d = obj.data ?? {}

            if (!obj.ok) {
                return `${op}  ${d.path ?? ""}  ✗ ${obj.error ?? d.message ?? "failed"}`
            }

            switch (op) {
                case "fs.read":
                case "fs.readLines":
                    return `read  ${d.path}  ${formatBytes(d.bytes ?? 0)}\n${d.content ?? ""}`
                case "fs.list": {
                    const entries: any[] = d.entries ?? []
                    const lines = entries
                        .map((e: any) => {
                            const prefix = e.type === "directory" ? "d" : "-"
                            return `${prefix}  ${e.name}`
                        })
                        .join("\n")
                    return `list  ${d.path}  ${entries.length} entries\n${lines}`
                }
                case "fs.write":
                    return `write  ${d.path}  ${formatBytes(d.bytes ?? 0)}  ✓`
                case "fs.mkdir":
                    return `mkdir  ${d.path}  ✓`
                case "fs.delete":
                    return `rm     ${d.path}  ✓`
                case "fs.move":
                    return `mv     ${d.src} → ${d.dest}  ✓`
                case "fs.copy":
                    return `cp     ${d.src} → ${d.dest}  ✓`
                case "fs.cd":
                    return `cd     ${d.path}  ✓`
                default:
                    return `${op}  ${JSON.stringify(d)}  ✓`
            }
        })
        .join("\n")
}
