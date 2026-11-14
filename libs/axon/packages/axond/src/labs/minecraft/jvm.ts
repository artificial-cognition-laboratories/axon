import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { err } from "@arcforge/err"

export type JvmOpts = {
    /** Prism's data directory: its `java/` holds the runtimes it downloaded per version. */
    prism: string
    /** An explicit JDK to prefer over anything discovered. */
    java?: string
}

/**
 * Jvm — which Java on this machine can run a given Minecraft.
 *
 * One owner, because the answer is version-specific and two leaves were about
 * to disagree about it. Minecraft names the majors it accepts (1.21.11 accepts
 * 21; 26.3 accepts 25), and a mismatch is not a soft failure — an old game on a
 * new JDK dies somewhere inside startup with a message about something else.
 *
 * Prism's own `java/` is searched first, and deliberately: those runtimes were
 * downloaded BECAUSE a version needed them, and the one this lab wants is the
 * one that already launched the template successfully. The machine's `java` is
 * the fallback, used only when its major actually fits.
 */
export function Jvm(opts: JvmOpts) {
    /**
     * The major version a `java` binary reports, or null when it cannot be asked.
     *
     * Spawned ASYNCHRONOUSLY, which this package requires of every external
     * probe: a synchronous spawn makes the calling thread hostage to a third
     * party binary, and one already cost this codebase a test worker alive for
     * 4h57m holding a defunct child (see the package's notes on `ask()`).
     *
     * A binary that cannot be run is not an error to propagate — "this is not a
     * usable Java" is exactly the answer this function exists to give, and every
     * caller already handles null. Bun THROWS rather than returning a code when
     * the path does not exist, which is the ordinary case for a mistyped
     * AXON_MINECRAFT_JAVA.
     */
    async function majorOf(binary: string): Promise<number | null> {
        try {
            const proc = Bun.spawn([binary, "-version"], { stdout: "pipe", stderr: "pipe" })
            const [out, said, code] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
                proc.exited,
            ])
            if (code !== 0) return null
            // `-version` goes to stderr, and has done for twenty years.
            const version = /version "(\d+)/.exec(`${said}${out}`)?.[1]
            return version ? Number(version) : null
        } catch {
            return null
        }
    }

    /** Every JDK this machine offers, Prism's own first. */
    function candidates(): string[] {
        const found: string[] = []
        const configured = opts.java ?? process.env.AXON_MINECRAFT_JAVA
        if (configured) found.push(configured)

        const runtimes = join(opts.prism, "java")
        if (existsSync(runtimes)) {
            for (const entry of readdirSync(runtimes)) {
                const binary = join(runtimes, entry, "bin", "java")
                if (existsSync(binary)) found.push(binary)
            }
        }

        const onPath = Bun.which("java")
        if (onPath) found.push(onPath)
        return found
    }

    return {
        /**
         * A JDK that satisfies `majors`, or null when this machine has none.
         *
         * An empty `majors` means the version named no requirement, in which
         * case any JDK will do and the first one found is used.
         */
        async forMajors(majors: readonly number[]): Promise<string | null> {
            for (const binary of candidates()) {
                const major = await majorOf(binary)
                if (major === null) continue
                if (majors.length === 0 || majors.includes(major)) return binary
            }
            return null
        },

        /** Why no JDK fits, said in terms of what is installed. */
        async problem(majors: readonly number[]): Promise<string | null> {
            if (await this.forMajors(majors)) return null
            const seen = await Promise.all(candidates().map(async binary => `${binary} (${await majorOf(binary) ?? "unreadable"})`))
            const wanted = majors.length === 0 ? "any Java" : `Java ${majors.join(" or ")}`
            return seen.length === 0
                ? `no Java is installed — Minecraft needs ${wanted} (set AXON_MINECRAFT_JAVA)`
                : `no installed Java satisfies ${wanted}; found ${seen.join(", ")} — set AXON_MINECRAFT_JAVA`
        },

        async require(majors: readonly number[]): Promise<string> {
            const binary = await this.forMajors(majors)
            if (!binary) throw err("WORLD_INSTALL_MISSING", { detail: (await this.problem(majors))! })
            return binary
        },
    }
}

export type JvmT = ReturnType<typeof Jvm>
