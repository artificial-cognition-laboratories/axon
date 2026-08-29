#!/usr/bin/env bun
/**
 * arcline — the view gallery.
 *
 * Not a product CLI. Its only job is to play each built-in view with fixture
 * data so the real interaction can be eyeballed during development:
 *
 *   arcline                      list every registered view
 *   arcline publish              play that view
 *   arcline publish-fail --fail auth
 *   arcline dev --no-color --columns 60
 *
 * The gallery it dispatches over is the same registry consumers import, so
 * anything visible here is a real, shipped view.
 */

import { Renderer, padEnd, width, type RendererHandle } from "../src/core/index.ts"
import { gallery } from "../src/views/index.ts"
import { header, status } from "../src/components/index.ts"

function index(r: RendererHandle): string {
    const names = Object.keys(gallery).sort()
    const nameWidth = Math.max(...names.map(width))

    return [
        "",
        header(r, { title: "@arcforge/arcline", subtitle: "— view gallery" }),
        "",
        ...names.map(name =>
            `${r.c.primary(padEnd(name, nameWidth))}   ${r.c.dim(gallery[name]!.summary)}`,
        ),
        "",
        r.c.dim("arcline <view>   play one"),
        "",
    ].join("\n")
}

/**
 * Split argv into flags and positionals.
 *
 * `--flag value` and `--flag=value` both work, and a bare `--flag` is "true",
 * so a view can read `args.fail` without knowing which spelling was used. The
 * value of a `--flag value` pair is consumed here so it never reaches the
 * positional list and gets mistaken for a view name.
 */
function parse(argv: string[]): { name?: string; args: Record<string, string> } {
    const args: Record<string, string> = {}
    const positional: string[] = []

    for (let i = 0; i < argv.length; i++) {
        const token = argv[i]!
        if (!token.startsWith("-")) {
            positional.push(token)
            continue
        }

        const key = token.replace(/^-+/, "")
        if (key.includes("=")) {
            const [k, ...rest] = key.split("=")
            args[k!] = rest.join("=")
            continue
        }

        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith("-")) {
            args[key] = next
            i++
        } else {
            args[key] = "true"
        }
    }

    return { ...(positional[0] !== undefined ? { name: positional[0] } : {}), args }
}

async function main(argv: string[]): Promise<number> {
    const { name, args } = parse(argv)

    const columns = args.columns !== undefined ? Number(args.columns) : undefined
    if (columns !== undefined && !Number.isFinite(columns)) {
        throw new Error("--columns requires a number")
    }

    const r = Renderer({
        ...(args["no-color"] ? { color: false } : {}),
        ...(columns !== undefined ? { columns } : {}),
    })

    if (!name || args.help || args.h) {
        r.line(index(r))
        return 0
    }

    const entry = gallery[name]
    if (!entry) {
        r.line("")
        r.line(status(r, "fail", `unknown view ${name}`))
        r.line(r.c.dim("run `arcline` to list them"))
        r.line("")
        return 1
    }

    try {
        await entry.run(r, args)
        return 0
    } catch (error) {
        // The gallery for a rendering package must not answer a bad flag with
        // a raw stack trace. A fixture that does not exist is a typo, so it is
        // reported as one.
        r.line("")
        r.line(status(r, "fail", error instanceof Error ? error.message : String(error)))
        r.line("")
        return 1
    }
}

process.exit(await main(process.argv.slice(2)))
