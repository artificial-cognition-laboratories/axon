<template>
    <h1>Commit</h1>

    <p>
        Turn the current working changes into one or more commits whose
        messages explain <em>why</em>, not what. The diff already says what.
    </p>

    <h2>Before writing anything</h2>

    <p>
        Read the actual changes — the full diff, staged and unstaged, plus any
        untracked files that belong with them. Never write a commit message
        from memory of what you did; write it from what is actually there.
    </p>

    <p>
        Match the repository's existing convention. Read the last twenty or so
        subject lines first: if they are Conventional Commits, follow that; if
        they are plain sentences, follow that. A correctly-formatted message in
        the wrong house style is still wrong.
    </p>

    <h2>Split by intent</h2>

    <p>
        One commit per logical change. If the diff contains a bug fix and an
        unrelated rename, that is two commits — a reviewer should be able to
        read, revert, or cherry-pick either one alone.
    </p>

    <p>
        Do not split so finely that a commit fails to build. Each one should
        leave the tree in a working state.
    </p>

    <h2>The message</h2>

    <ul>
        <li><strong>Subject</strong> — one line, imperative mood, under about seventy characters. "Fix token refresh on expiry" rather than "Fixed" or "Fixes".</li>
        <li><strong>Body</strong> — why this change, what problem it solves, and anything surprising about the approach. Wrap at seventy-two or so.</li>
        <li><strong>References</strong> — the issue or ticket, where one exists.</li>
    </ul>

    <p>
        Skip the body when the subject genuinely says everything — a typo fix
        needs no paragraph. Include it whenever a future reader might ask "why
        was this done this way?"
    </p>

    <p>
        The test of a good message: someone running blame on this line in a
        year gets an answer, not a restatement of the code they are already
        looking at.
    </p>

    <h2>Rules</h2>

    <ul>
        <li><strong>Never commit unrelated changes together</strong> to save time. That saving is taken out of every future reader.</li>
        <li><strong>Never claim more than the diff does.</strong> If a fix is partial, say partial. If it is unverified, say so.</li>
        <li><strong>Do not commit secrets, credentials, or generated artifacts.</strong> Check before staging, not after pushing.</li>
        <li><strong>Do not add attribution trailers</strong> unless the project already uses them.</li>
    </ul>

    <p>
        Show the proposed message and the file list before committing, and stop
        there if anything is ambiguous.
    </p>
</template>
