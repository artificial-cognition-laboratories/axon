import { join } from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { err } from "@arcforge/err"
import { fsx } from "../../../utils/fs"
import { bareName, type ScaffoldOpts } from "../kinds"

const CONFIG_TEMPLATE = (name: string) => `// ${name} — a prompt package: one or more units of work, shareable on their own.
//
// Every top-level .vue/.md file in this folder is an invokable prompt.
// components/ holds fragments they compose and is never invokable itself.
//
// Empty by design — name, version and description live in package.json.
export default definePrompt({})
`

const PROMPT_TEMPLATE = (name: string) => `<template>
    <h1>${name}</h1>

    <p>
        Describe the task here. This is what the agent is told to do — be
        specific about the goal, where to look, and what to produce.
    </p>

    <h2>Rules</h2>
    <p>
        State the constraints. What must not change, what to skip, when to
        stop.
    </p>
</template>
`

const PACKAGE_TEMPLATE = (name: string) => JSON.stringify({
    name,
    version: "0.1.0",
    description: "",
    type: "module",
    private: false,
    files: ["prompt.config.ts", "*.vue", "*.md", "components"],
}, null, 4) + "\n"

/**
 * Scaffold a prompt package at <dir>/<name>/.
 *
 * Deliberately the smallest project kind there is: a manifest, a config for
 * identity, and one prompt file. There is nothing to install and nothing to
 * compile — a prompt is text an agent is handed, so `axon prepare` on one
 * has nothing to do, and publishing is the whole lifecycle.
 *
 * The folder is the package and every top-level .vue/.md in it is a prompt,
 * so a single-prompt package and a pack are the same shape — a pack is just
 * one with more files, not a different kind of thing.
 */
export async function scaffoldPrompt(input: ScaffoldOpts): Promise<string> {
    const root = join(input.dir, bareName(input.name))
    if (fsx.exists(root)) throw err("PROJECT_EXISTS", { context: { path: root } })

    await mkdir(join(root, "components"), { recursive: true })
    await Promise.all([
        writeFile(join(root, "package.json"), PACKAGE_TEMPLATE(input.name)),
        writeFile(join(root, "prompt.config.ts"), CONFIG_TEMPLATE(input.name)),
        writeFile(join(root, `${bareName(input.name)}.vue`), PROMPT_TEMPLATE(bareName(input.name))),
        // components/ is meaningless empty and git drops empty dirs, so it
        // ships with the note that explains why it exists.
        writeFile(join(root, "components", "README.md"), "Fragments composed by the prompts in this package. Never invokable on their own.\n"),
    ])

    return root
}
