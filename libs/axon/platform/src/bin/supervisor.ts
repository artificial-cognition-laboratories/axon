#!/usr/bin/env bun
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
    UPDATE_REQUEST_ENV,
    UPDATE_REQUEST_EXIT_CODE,
    toArgv,
    type UpdateRequest,
} from "../services/update/contract"

/**
 * What axon's processes call themselves in ps/top/htop.
 *
 * One constant because the names have to stay related: the app is
 * `APP_PROCESS_NAME`, the updater is that plus a suffix, and someone scanning a
 * process list should see them as obviously the same product.
 */
const APP_PROCESS_NAME = "axon"

type SuperviseOpts = {
    argv?: string[]
    execPath?: string
    root?: string
    requestPath?: string
    spawn?: typeof Bun.spawn
}

/**
 * supervisor — the real CLI entrypoint.
 *
 * Bundled to index.js (the app itself becomes app.js — see vterm.config.ts), so
 * every `axon` invocation is really this process spawning the app as a child.
 * It exists for exactly one reason: an update cannot replace the binary of a
 * running program, so something has to outlive the app and run the installer
 * after it exits.
 *
 * The app signals that by exiting with UPDATE_REQUEST_EXIT_CODE after writing a
 * request to the path in UPDATE_REQUEST_ENV. Any other exit code is passed
 * straight through — this is transparent in the normal case.
 */
export async function supervise(opts: SuperviseOpts = {}): Promise<number> {
    const argv = opts.argv ?? process.argv.slice(2)
    const execPath = opts.execPath ?? process.execPath
    const root = opts.root ?? import.meta.dir
    const requestPath = opts.requestPath ?? join(tmpdir(), `axon-update-${process.pid}.json`)
    const spawn = opts.spawn ?? Bun.spawn

    // The app shares our foreground process group and owns interactive signal
    // handling. Keep the supervisor alive until that child has actually exited.
    const holdSignal = () => {}
    process.on("SIGINT", holdSignal)
    process.on("SIGTERM", holdSignal)

    try {
        // ── Why argv0 and not process.title ─────────────────────────────────
        //
        // Every axon process showed up as `bun` in ps/top/htop, which is
        // useless the moment a machine runs more than one Bun program — "which
        // bun is eating my CPU" could only be answered by matching on the
        // script path.
        //
        // `process.title = "axon"` is the obvious fix and does NOT work here:
        // Bun accepts the assignment and reads it back, but never propagates it
        // to the OS, so neither `comm` nor the args column changes. Verified
        // directly rather than assumed.
        //
        // argv0 does work. The kernel shows argv[0] as the command line, so the
        // child renders as `axon app.js …` instead of `bun app.js …`. The
        // executable is still `execPath` — only the name it reports changes.
        const app = spawn({
            cmd: [execPath, join(root, "app.js"), ...argv],
            argv0: APP_PROCESS_NAME,
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
            env: { ...process.env, [UPDATE_REQUEST_ENV]: requestPath },
        })
        const appCode = await app.exited
        if (appCode !== UPDATE_REQUEST_EXIT_CODE) return appCode

        const request = JSON.parse(await readFile(requestPath, "utf-8")) as UpdateRequest
        // Named distinctly from the app: an update running after the TUI has
        // exited is a different thing doing different work, and two rows called
        // `axon` would not say which one is still alive.
        const updater = spawn({
            cmd: [execPath, join(root, "update-helper.js"), ...toArgv(request)],
            argv0: `${APP_PROCESS_NAME}-update`,
            stdin: "ignore",
            stdout: "inherit",
            stderr: "inherit",
            env: process.env,
        })
        return await updater.exited
    } finally {
        process.off("SIGINT", holdSignal)
        process.off("SIGTERM", holdSignal)
        await rm(requestPath, { force: true }).catch(() => {})
    }
}

if (import.meta.main) process.exit(await supervise())
