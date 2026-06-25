<template>
    <section>
        <h2>Kanban Protocol</h2>
        <p>
            Your work queue lives at <code>{{ kanbanRoot }}</code>. Three stages: proposals → accepted → done.
            You write proposals. A human (or orchestrator) moves them to accepted. You execute accepted
            work and move it to done.
        </p>
    </section>

    <section>
        <h2>Directory Layout</h2>
        <pre>{{ kanbanRoot }}/
  proposals/   — you write here (gaps you found, fixes you want to make)
  accepted/    — human-approved work queued for execution
  done/        — completed work (move here after successful execution)</pre>
    </section>

    <section>
        <h2>Proposal Format</h2>
        <p>
            Every file in <code>proposals/</code> or <code>accepted/</code> must follow this structure.
            Filename: short kebab-case description, e.g. <code>fix-missing-return-type.md</code>.
        </p>
        <pre>## Gap
One sentence. What is missing or wrong right now?

## Evidence
Specific file paths, line numbers, error output, or test failures that confirm the gap.

## Proposed Fix
Exact steps to resolve. Be specific — file names, function names, what to write.

## Verification
The command or check that confirms the gap is closed after the fix is applied.</pre>
    </section>

    <section>
        <h2>fs Operations</h2>
        <p>Use <code>fs</code> directly. No abstraction layer.</p>
        <pre>import fs from "fs/promises"
import path from "path"

const kanbanRoot = `${process.env.AGENT_HOME}/data/workspace/kanban`

// Write a proposal
await fs.writeFile(
    path.join(kanbanRoot, "proposals", "my-proposal.md"),
    content,
    "utf8"
)

// Read accepted queue
const files = await fs.readdir(path.join(kanbanRoot, "accepted"))
const content = await fs.readFile(path.join(kanbanRoot, "accepted", files[0]), "utf8")

// Move to done (execute + mark complete)
await fs.rename(
    path.join(kanbanRoot, "accepted", filename),
    path.join(kanbanRoot, "done", filename)
)</pre>
    </section>

    <section>
        <h2>Rules</h2>
        <ol>
            <li>Never execute from proposals/ — only from accepted/.</li>
            <li>One proposal per gap. Don't bundle unrelated fixes.</li>
            <li>If a fix fails verification, write a new proposal explaining what went wrong — do not retry silently.</li>
            <li>Move to done/ only after verification passes.</li>
            <li>Keep proposals small and precise. Reviewers approve faster when the scope is clear.</li>
        </ol>
    </section>
</template>

<script setup lang="ts">
defineProps<{
    kanbanRoot?: string
}>()

const kanbanRoot = $props.kanbanRoot ?? `${process.env.AGENT_HOME}/data/workspace/kanban`
</script>
