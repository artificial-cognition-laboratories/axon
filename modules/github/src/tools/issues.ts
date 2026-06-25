import { octokit, call } from "../github/client"

/**
 * A GitHub issue.
 */
export type Issue = {
    number: number
    title: string
    body: string | null
    state: "open" | "closed"
    author: string
    assignees: string[]
    labels: string[]
    commentCount: number
    createdAt: string
    updatedAt: string
    url: string
}

/**
 * A comment on an issue or pull request.
 */
export type IssueComment = {
    id: number
    author: string
    body: string
    createdAt: string
    url: string
}

/**
 * Full issue with all comments.
 */
export type IssueDetail = Issue & {
    comments: IssueComment[]
}

/**
 * Filters for listing issues.
 */
export type IssueFilters = {
    state?: "open" | "closed" | "all"
    labels?: string[]
    assignee?: string
    /** Maximum number of issues to return. Default 30. */
    maxResults?: number
}

export const issues = {
    /**
     * List issues in a repository.
     *
     * Returns open issues by default. Filter by state, label, or assignee.
     * Use `issues.get()` to read a specific issue's full body and comments.
     *
     * @example
     * const open = await issues.list("owner", "repo")
     * const bugs = await issues.list("owner", "repo", { labels: ["bug"], maxResults: 10 })
     */
    async list(owner: string, repo: string, filters: IssueFilters = {}): Promise<Issue[]> {
        const { state = "open", labels, assignee, maxResults = 30 } = filters

        const { data } = await call(() =>
            octokit().issues.listForRepo({
                owner,
                repo,
                state,
                labels: labels?.join(","),
                assignee,
                per_page: maxResults,
                // Exclude pull requests from issue list
            })
        )

        return data
            .filter(item => !item.pull_request)
            .map(mapIssue)
    },

    /**
     * Get a single issue with its full body and all comments.
     *
     * Always call this before commenting or updating — read the full context
     * first to avoid duplicate or contradictory responses.
     *
     * @example
     * const issue = await issues.get("owner", "repo", 42)
     * // → { number: 42, title: "...", body: "...", comments: [...] }
     */
    async get(owner: string, repo: string, number: number): Promise<IssueDetail> {
        const [{ data: issue }, { data: comments }] = await Promise.all([
            call(() => octokit().issues.get({ owner, repo, issue_number: number })),
            call(() => octokit().issues.listComments({ owner, repo, issue_number: number, per_page: 100 })),
        ])

        return {
            ...mapIssue(issue),
            comments: comments.map(c => ({
                id: c.id,
                author: c.user?.login ?? "unknown",
                body: c.body ?? "",
                createdAt: c.created_at,
                url: c.html_url,
            })),
        }
    },

    /**
     * Create a new issue.
     *
     * @example
     * const issue = await issues.create("owner", "repo", {
     *     title: "Login fails for SSO users",
     *     body: "Steps to reproduce...",
     *     labels: ["bug"],
     * })
     * // → { number: 43, url: "https://github.com/..." }
     */
    async create(
        owner: string,
        repo: string,
        params: { title: string; body?: string; labels?: string[]; assignees?: string[] }
    ): Promise<{ number: number; url: string }> {
        const { data } = await call(() =>
            octokit().issues.create({
                owner,
                repo,
                title: params.title,
                body: params.body,
                labels: params.labels,
                assignees: params.assignees,
            })
        )
        return { number: data.number, url: data.html_url }
    },

    /**
     * Post a comment on an issue.
     *
     * Read the issue first with `issues.get()` to check existing comments
     * before posting — avoid duplicating what's already been said.
     *
     * @example
     * await issues.comment("owner", "repo", 42, "Reproduced on v1.2.3. Looking into it.")
     */
    async comment(owner: string, repo: string, number: number, body: string): Promise<{ id: number; url: string }> {
        const { data } = await call(() =>
            octokit().issues.createComment({ owner, repo, issue_number: number, body })
        )
        return { id: data.id, url: data.html_url }
    },

    /**
     * Update an issue — change state, labels, or assignees.
     *
     * @example
     * // Close and label
     * await issues.update("owner", "repo", 42, { state: "closed", labels: ["wontfix"] })
     *
     * // Assign
     * await issues.update("owner", "repo", 42, { assignees: ["cody"] })
     */
    async update(
        owner: string,
        repo: string,
        number: number,
        patch: { state?: "open" | "closed"; labels?: string[]; assignees?: string[]; title?: string; body?: string }
    ): Promise<void> {
        await call(() =>
            octokit().issues.update({ owner, repo, issue_number: number, ...patch })
        )
    },

    /**
     * Search issues and pull requests across GitHub.
     *
     * Uses GitHub's search syntax. Scope to a repo with `repo:owner/name`.
     * Returns up to `maxResults` results (default 20).
     *
     * @example
     * const dupes = await issues.search("repo:owner/repo is:issue is:open login SSO")
     * const myIssues = await issues.search("is:issue is:open assignee:cody")
     */
    async search(query: string, maxResults = 20): Promise<Issue[]> {
        const { data } = await call(() =>
            octokit().search.issuesAndPullRequests({ q: `${query} is:issue`, per_page: maxResults })
        )

        return data.items.map(item => ({
            number: item.number,
            title: item.title,
            body: item.body ?? null,
            state: item.state as "open" | "closed",
            author: item.user?.login ?? "unknown",
            assignees: item.assignees?.map(a => a.login) ?? [],
            labels: item.labels?.map(l => typeof l === "string" ? l : l.name ?? "") ?? [],
            commentCount: item.comments,
            createdAt: item.created_at,
            updatedAt: item.updated_at,
            url: item.html_url,
        }))
    },
}

function mapIssue(data: any): Issue {
    return {
        number: data.number,
        title: data.title,
        body: data.body ?? null,
        state: data.state as "open" | "closed",
        author: data.user?.login ?? "unknown",
        assignees: data.assignees?.map((a: any) => a.login) ?? [],
        labels: data.labels?.map((l: any) => typeof l === "string" ? l : l.name ?? "") ?? [],
        commentCount: data.comments,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
        url: data.html_url,
    }
}
