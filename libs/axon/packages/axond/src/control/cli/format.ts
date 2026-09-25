import { err } from "@arcforge/err"

/** Byte and duration conversions used by the daemon's human views. */
export function Format(_opts: Record<string, never>) {
    function size(bytes: number | null): string {
        if (bytes === null || !Number.isFinite(bytes)) return "—"
        const units = ["B", "KB", "MB", "GB", "TB"]
        let value = bytes
        let index = 0
        while (value >= 1024 && index < units.length - 1) {
            value /= 1024
            index++
        }
        return `${index === 0 ? value.toFixed(0) : value.toFixed(value < 10 ? 1 : 0)}${units[index]}`
    }

    function bytesFrom(input: string): number {
        const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb|k|m|g|t)?\s*$/i.exec(input)
        if (!match) {
            throw err("MACHINE_BUDGET_INVALID", {
                detail: `could not read "${input}" as a size — try 12GB, 8192MB, or a plain number of bytes`,
                context: { input },
            })
        }
        const scale: Record<string, number> = {
            b: 1, kb: 1024, k: 1024, mb: 1024 ** 2, m: 1024 ** 2,
            gb: 1024 ** 3, g: 1024 ** 3, tb: 1024 ** 4, t: 1024 ** 4,
        }
        const suffix = (match[2] ?? "b").toLowerCase()
        const factor = scale[suffix]
        if (factor === undefined) throw err("MACHINE_BUDGET_INVALID", { detail: `unknown size suffix: ${suffix}` })
        return Math.floor(Number(match[1]) * factor)
    }

    function bytes(value: number): string {
        if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)}GB`
        if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)}MB`
        return `${value}B`
    }

    function duration(seconds: number): string {
        const hours = Math.floor(seconds / 3600)
        const minutes = Math.floor((seconds % 3600) / 60)
        if (hours > 0) return `${hours}h ${minutes}m`
        if (minutes > 0) return `${minutes}m`
        return `${seconds}s`
    }

    return { size: size, bytesFrom: bytesFrom, bytes: bytes, duration: duration }
}

export type FormatT = ReturnType<typeof Format>
