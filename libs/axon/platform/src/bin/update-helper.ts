#!/usr/bin/env bun
import { err, isAxonError } from "@arcforge/err"
import { fromArgv } from "../services/update/contract"
import { Installer, type InstallerIo } from "../services/update/installer"

/**
 * update-helper — the process that replaces the installed Axon.
 *
 * Spawned by the supervisor AFTER the app has exited, because a package manager
 * cannot replace the binary of a running program. Bundled to update-helper.js
 * by the TUI's build (see vterm.config.ts) and never imported by the app.
 *
 * Deliberately thin: everything it does lives in Installer(), which is
 * ordinary library code with injectable IO. This file is the executable
 * boundary — argv in, exit code out.
 */
export async function main(argv: string[], io: InstallerIo & {
    exit?: (code: number) => void
} = {}): Promise<void> {
    const exit = io.exit ?? (code => process.exit(code))
    const report = io.err ?? (message => process.stderr.write(message))

    try {
        exit(await Installer(io).apply(fromArgv(argv)))
    } catch (cause) {
        const failure = isAxonError(cause) ? cause : err(cause)
        report(`Axon updater failed: ${failure.message}\n`)
        exit(1)
    }
}

if (import.meta.main) await main(process.argv.slice(2))
