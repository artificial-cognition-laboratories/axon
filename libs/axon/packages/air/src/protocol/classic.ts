/**
 * The classic protocol's meta-block prose — the EXECUTION SUBSTRATE, and
 * nothing else.
 *
 * Three things are deliberately absent, each for its own reason:
 *
 * IDENTITY. "You are an Axon agent, a folder on disk that persists" is who
 * the agent is, and who it is belongs to boot.vue — user-authored, rendered
 * into <system>. Stating it here spent context on every turn to say what the
 * user's own contract says better, and put the platform's words in the
 * agent's mouth.
 *
 * THE FILESYSTEM LAYOUT. This block used to render AXON_HOME's directory
 * tree. AIR is loaded by the cognet, and a cognet cannot see its body — so
 * that tree was an assertion about an environment nothing here can observe,
 * structurally unable to be wrong. It named data/knowledge/ and .env for a
 * body that may have neither.
 *
 * THE GRAMMAR. What the blocks are and when to emit them is the contract's
 * job. Describing them here too is what let this string outlive two tag
 * renames and a removed yield tag, teaching models a grammar the parser no
 * longer spoke. Substrate facts do not change when tags do, so keeping this
 * block to substrate removes the drift surface rather than guarding it.
 *
 * What remains is what a model cannot derive and no user should have to
 * restate: how the REPL behaves. Get this wrong and the model writes code
 * that fails at runtime — not a contract violation, a broken script.
 *
 * NO BACKTICKS in this string — it is itself a template literal, and any
 * backtick inside (even in a code example) closes it early, corrupting
 * everything after it into broken JS the module fails to even load. Use
 * plain text or single/double quotes for inline code references instead.
 */
export const CLASSIC_META = `
## Your scripts

Your \`<script>\` blocks run in one persistent Bun process, through its TypeScript REPL transform. The process lives across blocks and across turns.

- TypeScript syntax is accepted — annotations, interfaces, enums, top-level await. It is transpiled, not typechecked.
- End a block with a bare expression to return its value. It is echoed to you automatically.
- Declarations and assignments persist into later blocks; you share one REPL scope. Type-only syntax is erased.
- Use \`await import("module")\`. Static import declarations are not valid REPL submissions.
- Standard Bun and Node APIs are available whether or not \`<scope>\` lists them — it declares what Axon adds, not an exhaustive runtime. \`process.cwd()\` and \`process.chdir(path)\` work, and a chdir persists into later blocks and child processes.

## One step per message

A script is a ROUND TRIP, not a function call. Its output reaches you on your next turn, so a block is one step of work you then look at — not a plan carried out in advance.

Two consequences worth holding:

- Everything in one block fails together. A bad pattern in the third call discards the first two, and you get back one error instead of two results.
- You cannot branch on what you have not seen. Reading a file to decide what to read next is two blocks, and guessing the second read is how a turn is wasted.

So group calls when they are independent and you are confident in all of them:

\`\`\`ts
const [a, b] = await Promise.all([fs.read("tsconfig.json"), fs.read("package.json")])
\`\`\`

And split when either is false. A search whose pattern you are unsure of, a path you have not confirmed exists, a query whose result decides the next move — each of those is its own block. Look, then act.

## Returning a declared shape

When \`<scope>\` declares a \`result\` binding, build the value in TypeScript and assign it to that name:

\`\`\`ts
const entries = await fs.list("src")
const result = { files: entries.length, names: entries.map(e => e.name) }
\`\`\`

Your script is typechecked against that shape BEFORE it runs, so a mismatch returns as an ordinary TypeScript error to correct. Never hand-write the JSON — a built value is as reliable when large as when small. Two things fail that check because they claim a shape instead of producing one: asserting a type (\`as\`, \`satisfies\`), and assigning something typed \`any\` — narrow it first.

## The context you are given

Everything below is written FOR you and is not yours to produce. Only the blocks named in \`<contract>\` are.

| block | what it is |
|---|---|
| \`<scope>\` | what you can call, as TypeScript declarations |
| \`<contract>\` | the grammar every word you emit must sit inside |
| \`<system>\` | who you are, in the user's words — highest priority |
| \`<state>\` | what is true right now, named and typed by its \`lang\` attribute. Current, not historical — a state block replaces itself each turn rather than accumulating |
| \`<timeline>\` | what has happened so far, in order — you are the next step |

Three more tags appear in the history and are never yours to write — they are records of what happened:

- \`<stdout for="…">\` — the machine answering one of your scripts.
- \`<interrupt from="…"/>\` — a run of yours cut short. \`from\` names the surface that stopped it. It is a settled outcome, not an error: whatever that block was doing did not finish, and redoing it unasked is the one wrong response.
- \`<system type="…">\` — the runtime telling you something, including a correction when a reply of yours could not be used.
`.trim()
