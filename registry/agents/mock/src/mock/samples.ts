/**
 * Fixed content the rendering commands speak.
 *
 * Kept apart from the commands so the command file stays a readable list of
 * behaviours rather than a wall of sample prose. Nothing here is generated —
 * a mock whose output changed between runs would defeat its own purpose.
 */

export const LOREM =
    "The runtime assembled the context, called the engine, and committed the result to the session log. " +
    "Nothing here came from a model: every word was written into the agent, which is what makes it repeatable."

export const MARKDOWN_SAMPLE = `# Heading one

Body text with **bold**, *italic*, ~~struck~~, \`inline code\`, and a [link](https://axon.arclabs.it).

## Heading two

- A list item
- Another, with \`code\` inside it
    - A nested item

1. First
2. Second
3. Third

> A blockquote, which some surfaces indent and some tint.
>
> With a second paragraph inside it.

| Column | Meaning | Notes |
| --- | --- | --- |
| \`left\` | aligned left | default |
| \`mid\` | middle | — |
| \`right\` | aligned right | trailing |

### Heading three

A horizontal rule follows.

---

And a task list:

- [x] Something done
- [ ] Something outstanding
`

export const CODE_SAMPLE = `Three fenced blocks, for syntax highlighting:

\`\`\`ts
export function greet(name: string): string {
    return \`hello \${name}\`
}
\`\`\`

\`\`\`python
def greet(name: str) -> str:
    return f"hello {name}"
\`\`\`

\`\`\`bash
axon dev --agent mock
\`\`\`

And a block with no language tag:

\`\`\`
plain preformatted text
    with indentation preserved
\`\`\`
`

export const WIDE_SAMPLE = `A line far wider than any terminal pane, written to find out whether the surface wraps it, truncates it, or scrolls it sideways — none of which is wrong, but only one of which is what you expected.

| Identifier | Description | Path | Status |
| --- | --- | --- | --- |
| \`cognet:stimulus:text\` | Input arriving at the agent from a channel or a script | /home/user/.axon/agents/mock/data/sessions/current.jsonl | committed |
| \`cognet:action:typescript\` | Code the agent chose to run inside its capsule | /home/user/.axon/agents/mock/.agent/cognet/cognet.mjs | committed |

\`\`\`
an unwrappable preformatted line ─────────────────────────────────────────────────────────────── that must scroll
\`\`\`
`

export const UNICODE_SAMPLE = `Emoji: 🚀 🧠 ✅ ❌ 🔬 — including a family sequence 👩‍👩‍👧‍👦 and a flag 🇬🇧.

CJK: 日本語のテキスト · 简体中文 · 한국어

RTL: مرحبا بالعالم — and Hebrew שלום עולם mixed into a left-to-right line.

Combining marks: é ä õ ñ — and a stack: á̈̃

Box drawing:

\`\`\`
┌────────────┬────────────┐
│ left       │ right      │
├────────────┼────────────┤
│ ▁▂▃▄▅▆▇█   │ ░▒▓█       │
└────────────┴────────────┘
\`\`\`
`

/** One line per tick for `/think`, then the last repeats. */
export const THOUGHTS = [
    "Working through what the request actually asks for.",
    "Two readings are possible here, so I am ruling one out.",
    "Checking that against what the earlier ticks established.",
    "That holds up.",
]
