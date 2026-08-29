import { dirname, join, sep } from "node:path"
import { cp, mkdir, rm } from "node:fs/promises"
import { err } from "@arcforge/err"
import { fsx } from "../../../utils/fs"

type StageOpts = {
    root: string
}

/**
 * Stage — assembling a tree and packaging it into a tarball.
 *
 * Owns the npm `package/` staging form used by every source-published kind
 * (module, cognet, bench, prompt): npm tarballs put everything under a
 * "package/" directory, and every package manager strips exactly that one
 * leading component on extract. Staging with that prefix is what makes the
 * published artifact installable by `bun add` rather than only by our own
 * extractor.
 *
 * Agents stage differently — their tree is assembled in place with rebased
 * imports and no prefix — so Agent() builds its own tree and uses tar()
 * directly. That is the one real difference between the two staging forms,
 * and it is why this leaf exposes both.
 */
export function Stage(opts: StageOpts) {
    const root = opts.root

    return {
        /**
         * Copy `entries` into a scratch `package/` tree and tar it.
         * The scratch dir is always removed, success or failure.
         *
         * A missing entry is skipped rather than an error: callers build the
         * list from a fixed layout and let the parts a project does not have
         * fall away (`if (exists(src)) entries.unshift("src")`).
         *
         * README assets are NOT staged here — they are a separate artifact with
         * their own tarball (see assets.ts), because shipping docs media inside
         * source.tar.gz puts it on the install path for every consumer.
         */
        async npm(bundleDir: string, tarball: string, entries: string[]): Promise<void> {
            const stageDir = join(bundleDir, ".stage")
            try {
                const packageDir = join(stageDir, "package")
                await rm(stageDir, { recursive: true, force: true })
                await mkdir(packageDir, { recursive: true })

                for (const entry of entries) {
                    const source = join(root, entry)
                    if (!fsx.exists(source)) continue
                    const destination = join(packageDir, entry)
                    await mkdir(dirname(destination), { recursive: true })
                    await cp(source, destination, { recursive: true })
                }

                await tar(stageDir, tarball, ["package"])
            } finally {
                await rm(stageDir, { recursive: true, force: true })
            }
        },

        /** Package an already-assembled tree. Agents build their own stage, then call this. */
        tar,
    }
}

export type StageT = ReturnType<typeof Stage>

/**
 * Package entries into a gzipped tar.
 *
 * `--format=posix` (PAX) rather than tar's GNU default, because a path over
 * 100 bytes does not fit the original tar header. GNU tar encodes those by
 * emitting a `@LongLink` PSEUDO-ENTRY carrying the real name, followed by the
 * actual entry — so any reader listing the archive naively sees phantom files
 * literally called `@LongLink`. That is what appeared in the registry's source
 * tree, and nested `node_modules/@axon/zero/node_modules/@arcforge/...` paths
 * cross 100 bytes routinely, so it was not rare.
 *
 * PAX stores long names in a proper extended header instead. Every modern
 * reader — bun, npm, GNU tar, BSD tar, Python tarfile — handles it, and the
 * archive lists as exactly the files it contains.
 */
async function tar(cwd: string, out: string, entries: string[]): Promise<void> {
    const normalized = entries.map(entry => entry.split(sep).join("/"))
    const result = await Bun.$`tar --format=posix -czf ${out} ${normalized}`.cwd(cwd).quiet().nothrow()
    if (result.exitCode !== 0) {
        const stderr = result.stderr.toString()
        if (result.exitCode === 127 || stderr.includes("not found")) {
            throw err("BUNDLE_TAR_MISSING", { detail: stderr })
        }
        throw err("BUNDLE_TAR_FAILED", {
            detail: `exit ${result.exitCode}: ${stderr}`,
            context: { exitCode: result.exitCode },
        })
    }
}
