import { isAbsolute, relative, resolve } from "node:path"

function isGlob(value: string): boolean {
    return /[*?[]/.test(value)
}

/** Resolve direct paths and Bun globs into stable, cwd-relative test paths. */
export async function resolveTestFiles(patterns: string | string[], cwd: string): Promise<string[]> {
    const requested = Array.isArray(patterns) ? patterns : [patterns]
    const found = new Set<string>()

    for (const pattern of requested) {
        if (!isGlob(pattern)) {
            const absolute = isAbsolute(pattern) ? pattern : resolve(cwd, pattern)
            if (await Bun.file(absolute).exists()) found.add(relative(cwd, absolute))
            continue
        }

        const glob = new Bun.Glob(pattern)
        for await (const match of glob.scan({ cwd, onlyFiles: true, dot: false })) {
            found.add(match)
        }
    }

    return [...found].sort()
}
