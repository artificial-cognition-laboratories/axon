import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

/** A project in the repo: a package, app, agent, module or prompt — keyed by where it lives. */
export type Project = { key: string; name: string; description: string }

/**
 * Projects — the repo's projects as entities, found mechanically, and how an
 * atom names one outright.
 *
 * A project is a directory with a named `package.json` that is not inside
 * another project. Its key is its path from the repo root.
 *
 * `mention` is the free ground truth: an atom that names a project's path or
 * package says which project it concerns, exactly. `mask` hides every such
 * name, so whether a model can link the atom from what it SAYS — not from the
 * name it carries — can be measured without labelling anything by hand.
 */
export function Projects(opts: { root: string }) {
    const all = discover()
    /** Longest first, so `libs/axon/packages/locus` wins over `libs/axon`. */
    const byPath = [...all].sort((a, b) => b.key.length - a.key.length)

    return {
        all: all,

        /** The one project an atom names outright, or null when it names none — or several, which is no ground truth. */
        mention(text: string): string | null {
            const found = new Set<string>()
            for (const path of text.match(PATH) ?? []) {
                const project = byPath.find(one => path.includes(`${one.key}/`) || path.endsWith(one.key))
                if (project) found.add(project.key)
            }
            for (const project of all) {
                if (project.name.startsWith("@") && text.includes(project.name)) found.add(project.key)
            }
            return found.size === 1 ? [...found][0]! : null
        },

        /** The atom with every path and scoped package name hidden. */
        mask(text: string): string {
            return text.replace(PATH, "[path]").replace(/@[\w.-]+\/[\w.-]+/g, "[package]")
        },
    }

    function discover(): Project[] {
        const projects: Project[] = []
        for (const path of new Bun.Glob("{libs,apps,registry}/**/package.json").scanSync({ cwd: opts.root })) {
            if (/node_modules|\/\.|\/tests\/|\/fixtures\/|\/target\//.test(path)) continue
            const manifest = JSON.parse(readFileSync(join(opts.root, path), "utf8")) as { name?: string; description?: string }
            if (!manifest.name) continue
            projects.push({ key: dirname(path), name: manifest.name, description: manifest.description ?? "" })
        }
        // Inside another project is part of it, not a project of its own.
        return projects.filter(one => !projects.some(other => other !== one && one.key.startsWith(`${other.key}/`) && existsSync(join(opts.root, other.key, "package.json"))))
    }
}

/** A path: anything with a slash between word characters, absolute or not. */
const PATH = /[\w.~-]*(?:\/[\w.@~-]+)+\/?/g
