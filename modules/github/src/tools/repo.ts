import { octokit, call } from "../github/client"

/**
 * Repository metadata.
 */
export type Repo = {
    owner: string
    name: string
    fullName: string
    description: string | null
    defaultBranch: string
    visibility: "public" | "private" | "internal"
    stars: number
    openIssues: number
    url: string
}

/**
 * A file or directory entry in the repository tree.
 */
export type FileEntry = {
    name: string
    path: string
    type: "file" | "dir" | "symlink"
    size: number | null
}

/**
 * A repository search result.
 */
export type RepoResult = {
    owner: string
    name: string
    fullName: string
    description: string | null
    stars: number
    url: string
}

export const repo = {
    /**
     * Get metadata for a repository.
     *
     * Use to understand a repo before diving into its issues or PRs — visibility,
     * default branch, open issue count, and description give quick orientation.
     *
     * @example
     * const r = await repo.get("octocat", "Hello-World")
     * // → { owner: "octocat", name: "Hello-World", defaultBranch: "main", ... }
     */
    async get(owner: string, name: string): Promise<Repo> {
        const { data } = await call(() => octokit().repos.get({ owner, repo: name }))
        return {
            owner: data.owner.login,
            name: data.name,
            fullName: data.full_name,
            description: data.description ?? null,
            defaultBranch: data.default_branch,
            visibility: (data.visibility ?? "public") as Repo["visibility"],
            stars: data.stargazers_count,
            openIssues: data.open_issues_count,
            url: data.html_url,
        }
    },

    /**
     * List files and directories at a path in the repository.
     *
     * Defaults to the root of the default branch. Use to orient yourself in an
     * unfamiliar repo before reading specific files.
     *
     * @example
     * const entries = await repo.files("octocat", "Hello-World")
     * // → [{ name: "src", path: "src", type: "dir", size: null }, ...]
     *
     * const entries = await repo.files("octocat", "Hello-World", "src")
     * // → [{ name: "index.ts", path: "src/index.ts", type: "file", size: 1024 }, ...]
     */
    async files(owner: string, name: string, path = ""): Promise<FileEntry[]> {
        const { data } = await call(() =>
            octokit().repos.getContent({ owner, repo: name, path })
        )

        if (!Array.isArray(data)) {
            throw new Error(`Path "${path}" is a file, not a directory. Use repo.file() to read its content.`)
        }

        return data.map(entry => ({
            name: entry.name,
            path: entry.path,
            type: entry.type as FileEntry["type"],
            size: entry.size ?? null,
        }))
    },

    /**
     * Get the raw text content of a file in the repository.
     *
     * Reads from the default branch HEAD. Use to inspect source files,
     * configuration, or documentation without cloning the repo.
     *
     * Throws if the path is a directory — use `repo.files()` to list directories.
     *
     * @example
     * const content = await repo.file("octocat", "Hello-World", "README.md")
     * // → "# Hello World\n..."
     */
    async file(owner: string, name: string, path: string): Promise<string> {
        const { data } = await call(() =>
            octokit().repos.getContent({ owner, repo: name, path })
        )

        if (Array.isArray(data)) {
            throw new Error(`Path "${path}" is a directory. Use repo.files() to list its contents.`)
        }

        if (data.type !== "file" || !("content" in data)) {
            throw new Error(`Cannot read content of "${path}" (type: ${data.type})`)
        }

        return Buffer.from(data.content, "base64").toString("utf-8")
    },

    /**
     * Search GitHub repositories.
     *
     * Uses GitHub's search syntax — e.g. `"language:typescript stars:>100"`.
     * Returns up to `maxResults` repositories (default 10).
     *
     * @example
     * const results = await repo.search("axon agent framework language:typescript")
     * // → [{ owner: "...", name: "...", stars: 42, ... }, ...]
     */
    async search(query: string, maxResults = 10): Promise<RepoResult[]> {
        const { data } = await call(() =>
            octokit().search.repos({ q: query, per_page: maxResults })
        )

        return data.items.map(item => ({
            owner: item.owner?.login ?? "",
            name: item.name,
            fullName: item.full_name,
            description: item.description ?? null,
            stars: item.stargazers_count ?? 0,
            url: item.html_url,
        }))
    },
}
