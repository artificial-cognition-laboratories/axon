import { octokit, call } from "../github/client"

/**
 * A pull request.
 */
export type PullRequest = {
    number: number
    title: string
    body: string | null
    state: "open" | "closed" | "merged"
    author: string
    headBranch: string
    baseBranch: string
    assignees: string[]
    labels: string[]
    reviewers: string[]
    /** Current review decision: approved, changes_requested, review_required, or null */
    reviewDecision: "approved" | "changes_requested" | "review_required" | null
    /** Whether all CI checks have passed */
    checksState: "success" | "failure" | "pending" | "unknown"
    isDraft: boolean
    commentCount: number
    commitCount: number
    changedFiles: number
    additions: number
    deletions: number
    createdAt: string
    updatedAt: string
    url: string
}

/**
 * A file changed in a pull request, with its patch.
 */
export type PullRequestFile = {
    path: string
    status: "added" | "removed" | "modified" | "renamed" | "copied"
    additions: number
    deletions: number
    /** Unified diff patch for this file. May be absent for binary files or very large diffs. */
    patch: string | null
    /** Previous path if the file was renamed. */
    previousPath: string | null
}

/**
 * A commit in a pull request.
 */
export type PullRequestCommit = {
    sha: string
    message: string
    author: string
    date: string
}

/**
 * A comment on a pull request.
 */
export type PullRequestComment = {
    id: number
    author: string
    body: string
    /** File path if this is a review comment on a specific line. Null for general PR comments. */
    path: string | null
    line: number | null
    createdAt: string
    url: string
}

/**
 * Full pull request detail with comments.
 */
export type PullRequestDetail = PullRequest & {
    comments: PullRequestComment[]
}

/**
 * Filters for listing pull requests.
 */
export type PrFilters = {
    state?: "open" | "closed" | "all"
    labels?: string[]
    assignee?: string
    /** Maximum number of PRs to return. Default 30. */
    maxResults?: number
}

export const prs = {
    /**
     * List pull requests in a repository.
     *
     * Returns open PRs by default. Check `reviewDecision` and `checksState`
     * to identify PRs that are ready to review or blocked.
     *
     * @example
     * const open = await prs.list("owner", "repo")
     * const approved = open.filter(pr => pr.reviewDecision === "approved")
     */
    async list(owner: string, repo: string, filters: PrFilters = {}): Promise<PullRequest[]> {
        const { state = "open", assignee, maxResults = 30 } = filters

        const { data } = await call(() =>
            octokit().pulls.list({
                owner,
                repo,
                state,
                per_page: maxResults,
            })
        )

        return data
            .filter(pr => !assignee || pr.assignees?.some(a => a.login === assignee))
            .map(mapPr)
    },

    /**
     * Get a single pull request with its full body and all comments.
     *
     * Always read the PR in full before reviewing — body, review decision, CI
     * status, and existing comments give the context needed for a useful review.
     *
     * @example
     * const pr = await prs.get("owner", "repo", 99)
     * // → { title: "...", body: "...", reviewDecision: "review_required", checksState: "success", comments: [...] }
     */
    async get(owner: string, repo: string, number: number): Promise<PullRequestDetail> {
        const [{ data: pr }, { data: reviewComments }, { data: issueComments }] = await Promise.all([
            call(() => octokit().pulls.get({ owner, repo, pull_number: number })),
            call(() => octokit().pulls.listReviewComments({ owner, repo, pull_number: number, per_page: 100 })),
            call(() => octokit().issues.listComments({ owner, repo, issue_number: number, per_page: 100 })),
        ])

        const comments: PullRequestComment[] = [
            ...reviewComments.map(c => ({
                id: c.id,
                author: c.user?.login ?? "unknown",
                body: c.body,
                path: c.path,
                line: c.line ?? c.original_line ?? null,
                createdAt: c.created_at,
                url: c.html_url,
            })),
            ...issueComments.map(c => ({
                id: c.id,
                author: c.user?.login ?? "unknown",
                body: c.body ?? "",
                path: null,
                line: null,
                createdAt: c.created_at,
                url: c.html_url,
            })),
        ].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

        return { ...mapPr(pr), comments }
    },

    /**
     * Get the raw unified diff for a pull request.
     *
     * This is the primary tool for code review — the full diff of every changed
     * file in standard unified diff format, the same as `git diff`. Read this
     * before forming a review opinion.
     *
     * Large PRs (1000+ lines changed) will return a large string. Check
     * `pr.changedFiles` and `pr.additions + pr.deletions` first to gauge size.
     *
     * @example
     * const diff = await prs.diff("owner", "repo", 99)
     * // → "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n..."
     */
    async diff(owner: string, repo: string, number: number): Promise<string> {
        const response = await call(() =>
            octokit().pulls.get({
                owner,
                repo,
                pull_number: number,
                mediaType: { format: "diff" },
            })
        )
        // Octokit returns the raw diff as the response data when format is "diff"
        return response.data as unknown as string
    },

    /**
     * List the files changed in a pull request, each with its patch.
     *
     * Use when you want per-file patches rather than the full unified diff.
     * Useful for reviewing specific files or understanding which areas of the
     * codebase a PR touches without reading the entire diff.
     *
     * @example
     * const files = await prs.files("owner", "repo", 99)
     * // → [{ path: "src/auth.ts", status: "modified", additions: 12, deletions: 3, patch: "@@..." }, ...]
     */
    async files(owner: string, repo: string, number: number): Promise<PullRequestFile[]> {
        const { data } = await call(() =>
            octokit().pulls.listFiles({ owner, repo, pull_number: number, per_page: 100 })
        )

        return data.map(f => ({
            path: f.filename,
            status: f.status as PullRequestFile["status"],
            additions: f.additions,
            deletions: f.deletions,
            patch: f.patch ?? null,
            previousPath: f.previous_filename ?? null,
        }))
    },

    /**
     * List the commits in a pull request.
     *
     * Use to check commit hygiene — message quality, commit count, atomic
     * vs. tangled changes. A PR with 40 commits and messages like "fix" or
     * "wip" is a signal worth calling out in review.
     *
     * @example
     * const commits = await prs.commits("owner", "repo", 99)
     * // → [{ sha: "abc123", message: "feat: add SSO login", author: "cody", date: "..." }, ...]
     */
    async commits(owner: string, repo: string, number: number): Promise<PullRequestCommit[]> {
        const { data } = await call(() =>
            octokit().pulls.listCommits({ owner, repo, pull_number: number, per_page: 100 })
        )

        return data.map(c => ({
            sha: c.sha.slice(0, 7),
            message: c.commit.message.split("\n")[0],  // first line only
            author: c.author?.login ?? c.commit.author?.name ?? "unknown",
            date: c.commit.author?.date ?? "",
        }))
    },

    /**
     * Submit a review on a pull request.
     *
     * Always read the PR and its diff first. `APPROVE` and `REQUEST_CHANGES`
     * are binding — they affect merge eligibility. Use `COMMENT` for non-binding
     * feedback when you have observations but no clear verdict.
     *
     * @example
     * await prs.review("owner", "repo", 99, {
     *     body: "LGTM — one minor nit on the error handling in auth.ts",
     *     event: "APPROVE",
     * })
     *
     * await prs.review("owner", "repo", 99, {
     *     body: "Auth token is logged on line 42 — must fix before merge.",
     *     event: "REQUEST_CHANGES",
     * })
     */
    async review(
        owner: string,
        repo: string,
        number: number,
        params: { body: string; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" }
    ): Promise<{ id: number; url: string }> {
        const { data } = await call(() =>
            octokit().pulls.createReview({
                owner,
                repo,
                pull_number: number,
                body: params.body,
                event: params.event,
            })
        )
        return { id: data.id, url: data.html_url }
    },

    /**
     * Post a general comment on a pull request (not tied to a specific line).
     *
     * For line-level comments, use `prs.review()` with inline comments instead.
     * Read existing comments with `prs.get()` first to avoid duplication.
     *
     * @example
     * await prs.comment("owner", "repo", 99, "Could you add a test for the error path?")
     */
    async comment(owner: string, repo: string, number: number, body: string): Promise<{ id: number; url: string }> {
        const { data } = await call(() =>
            octokit().issues.createComment({ owner, repo, issue_number: number, body })
        )
        return { id: data.id, url: data.html_url }
    },
}

function mapPr(data: any): PullRequest {
    const merged = data.merged_at !== null && data.merged_at !== undefined
    return {
        number: data.number,
        title: data.title,
        body: data.body ?? null,
        state: merged ? "merged" : data.state as "open" | "closed",
        author: data.user?.login ?? "unknown",
        headBranch: data.head?.ref ?? "",
        baseBranch: data.base?.ref ?? "",
        assignees: data.assignees?.map((a: any) => a.login) ?? [],
        labels: data.labels?.map((l: any) => typeof l === "string" ? l : l.name ?? "") ?? [],
        reviewers: data.requested_reviewers?.map((r: any) => r.login) ?? [],
        reviewDecision: mapReviewDecision(data.mergeable_state),
        checksState: mapChecksState(data.mergeable_state),
        isDraft: data.draft ?? false,
        commentCount: data.comments + (data.review_comments ?? 0),
        commitCount: data.commits ?? 0,
        changedFiles: data.changed_files ?? 0,
        additions: data.additions ?? 0,
        deletions: data.deletions ?? 0,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
        url: data.html_url,
    }
}

function mapReviewDecision(mergeableState: string | undefined): PullRequest["reviewDecision"] {
    switch (mergeableState) {
        case "clean": return "approved"
        case "blocked": return "changes_requested"
        case "unstable":
        case "behind": return "review_required"
        default: return null
    }
}

function mapChecksState(mergeableState: string | undefined): PullRequest["checksState"] {
    switch (mergeableState) {
        case "clean": return "success"
        case "unstable": return "failure"
        case "blocked": return "pending"
        default: return "unknown"
    }
}
