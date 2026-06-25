# @axon/github

GitHub integration for Axon agents. Repository navigation, issue triage, and pull request review — the operations a developer agent needs to do real work on a codebase.

The diff tool is the key one: an agent that can read the actual unified diff alongside the PR description can perform genuine code review, not just metadata summarisation.

---

## Install

```bash
axon install @axon/github
```

Add to your agent's `.env`:

```
GITHUB_TOKEN=ghp_...
```

Create a token at [github.com/settings/tokens](https://github.com/settings/tokens). Needs `repo` scope for private repositories, `public_repo` for public only.

---

## Tools

Three namespaces: `repo`, `issues`, `prs`.

---

### `repo` — repository navigation

#### `repo.get(owner, name)`

Repository metadata — description, default branch, visibility, open issue count.

```typescript
const r = await repo.get("octocat", "Hello-World")
// → { owner, name, fullName, description, defaultBranch, visibility, stars, openIssues, url }
```

#### `repo.files(owner, name, path?)`

List files and directories at a path. Defaults to repo root.

```typescript
const root = await repo.files("octocat", "Hello-World")
const src  = await repo.files("octocat", "Hello-World", "src")
// → [{ name, path, type: "file" | "dir" | "symlink", size }]
```

#### `repo.file(owner, name, path)`

Raw text content of a file at HEAD.

```typescript
const readme = await repo.file("octocat", "Hello-World", "README.md")
// → "# Hello World\n..."
```

#### `repo.search(query, maxResults?)`

Search GitHub repositories using [GitHub search syntax](https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories).

```typescript
const results = await repo.search("agent framework language:typescript stars:>100")
// → [{ owner, name, fullName, description, stars, url }]
```

---

### `issues` — triage and tracking

#### `issues.list(owner, repo, filters?)`

List issues. Open by default.

```typescript
const open = await issues.list("owner", "repo")
const bugs = await issues.list("owner", "repo", { labels: ["bug"], maxResults: 10 })
const mine = await issues.list("owner", "repo", { assignee: "cody", state: "all" })
```

Filters: `state` (`"open"` | `"closed"` | `"all"`), `labels`, `assignee`, `maxResults` (default 30).

#### `issues.get(owner, repo, number)`

Full issue with body and all comments. Always call this before commenting or updating.

```typescript
const issue = await issues.get("owner", "repo", 42)
// → { number, title, body, state, author, assignees, labels, comments: [...] }
```

#### `issues.create(owner, repo, params)`

Create a new issue.

```typescript
const issue = await issues.create("owner", "repo", {
    title: "Login fails for SSO users",
    body: "Steps to reproduce...",
    labels: ["bug"],
    assignees: ["cody"],
})
// → { number: 43, url: "https://github.com/..." }
```

#### `issues.comment(owner, repo, number, body)`

Post a comment. Read the issue first to avoid duplicating existing responses.

```typescript
await issues.comment("owner", "repo", 42, "Reproduced on v1.2.3. Investigating.")
// → { id, url }
```

#### `issues.update(owner, repo, number, patch)`

Update state, labels, assignees, or body.

```typescript
await issues.update("owner", "repo", 42, { state: "closed", labels: ["wontfix"] })
await issues.update("owner", "repo", 42, { assignees: ["cody"] })
```

#### `issues.search(query, maxResults?)`

Search issues across GitHub using [GitHub search syntax](https://docs.github.com/en/search-github/searching-on-github/searching-for-issues-and-pull-requests). Scope to a repo with `repo:owner/name`.

```typescript
const dupes  = await issues.search("repo:owner/repo is:open login SSO")
const recent = await issues.search("repo:owner/repo is:open created:>2024-01-01")
```

---

### `prs` — pull request review

#### `prs.list(owner, repo, filters?)`

List pull requests. Open by default. Check `reviewDecision` and `checksState` to find PRs ready to merge or blocked.

```typescript
const open     = await prs.list("owner", "repo")
const ready    = open.filter(pr => pr.reviewDecision === "approved" && pr.checksState === "success")
const drafts   = open.filter(pr => pr.isDraft)
```

Filters: `state`, `assignee`, `maxResults` (default 30).

#### `prs.get(owner, repo, number)`

Full PR with body, review status, CI state, and all comments. Call before forming a review opinion.

```typescript
const pr = await prs.get("owner", "repo", 99)
// → { title, body, reviewDecision, checksState, isDraft, additions, deletions, comments: [...] }
```

#### `prs.diff(owner, repo, number)`

Raw unified diff — every changed file in standard `git diff` format. The primary input for code review.

```typescript
const diff = await prs.diff("owner", "repo", 99)
// → "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ ..."
```

Check `pr.additions + pr.deletions` before calling on large PRs to gauge response size.

#### `prs.files(owner, repo, number)`

Per-file patches. Use when you want to review specific files rather than the full diff.

```typescript
const files = await prs.files("owner", "repo", 99)
// → [{ path, status: "added"|"modified"|..., additions, deletions, patch, previousPath }]
```

#### `prs.commits(owner, repo, number)`

Commits in the PR. Use to check message quality and whether changes are atomic.

```typescript
const commits = await prs.commits("owner", "repo", 99)
// → [{ sha, message, author, date }]
```

#### `prs.review(owner, repo, number, params)`

Submit a review. `APPROVE` and `REQUEST_CHANGES` are binding and affect merge eligibility. Always read the PR and its diff first.

```typescript
await prs.review("owner", "repo", 99, {
    body: "LGTM — minor nit on error handling in auth.ts",
    event: "APPROVE",
})

await prs.review("owner", "repo", 99, {
    body: "Auth token logged on line 42. Must fix before merge.",
    event: "REQUEST_CHANGES",
})
```

`event`: `"APPROVE"` | `"REQUEST_CHANGES"` | `"COMMENT"`

#### `prs.comment(owner, repo, number, body)`

General PR comment (not tied to a specific line). Read existing comments first.

```typescript
await prs.comment("owner", "repo", 99, "Could you add a test for the error path?")
// → { id, url }
```

---

## Return types

```typescript
type Repo = {
    owner: string; name: string; fullName: string
    description: string | null; defaultBranch: string
    visibility: "public" | "private" | "internal"
    stars: number; openIssues: number; url: string
}

type Issue = {
    number: number; title: string; body: string | null
    state: "open" | "closed"; author: string
    assignees: string[]; labels: string[]
    commentCount: number; createdAt: string; updatedAt: string; url: string
}

type PullRequest = {
    number: number; title: string; body: string | null
    state: "open" | "closed" | "merged"; author: string
    headBranch: string; baseBranch: string
    assignees: string[]; labels: string[]; reviewers: string[]
    reviewDecision: "approved" | "changes_requested" | "review_required" | null
    checksState: "success" | "failure" | "pending" | "unknown"
    isDraft: boolean; commentCount: number; commitCount: number
    changedFiles: number; additions: number; deletions: number
    createdAt: string; updatedAt: string; url: string
}
```

---

## Error behaviour

- **Missing token** — throws at first tool call with a message pointing to github.com/settings/tokens. Agent boot is not blocked.
- **Rate limit** — throws with the reset timestamp. Never silently retries.
- **Invalid token** — throws with a clear message to check `GITHUB_TOKEN`.
- **All other API errors** — propagated as-is from Octokit.
