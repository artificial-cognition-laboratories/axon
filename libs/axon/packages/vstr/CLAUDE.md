# @arcforge/vstr

## What This Is
The standard `.prompt` / `.vue` SFC renderer for agent prompt templates. Compiles and renders Vue 3 Single File Components to strings (markdown, html, or plain text) without a browser or DOM. This is the canonical implementation — it supersedes `@cognos/sfc`.

Used by Axon agent runtime to render dynamic prompts, and by Cognos for `$prompt()`. The pattern: Vue SFC syntax as a composable, typed, data-fetching template language for LLM context.

## The Design
- Single render pipeline: parse SFC → compile script+template → SSR → convert to target format
- `context` injection: host injects globals (`axon`, `cognos`, etc.) into script setup scope — not through props
- File extension agnostic: accepts `.vue`, `.prompt`, or any extension — parser reads the content
- Relative imports resolved recursively, both `.vue` and `.prompt`
- Cache keyed by absolute path — opt-out with `noCache: true`

## Key Interfaces
- `render(source, props?, options?)` — render a source string directly
- `renderFile(filePath, props?, options?)` — load from disk and render
- `introspect(filePath)` — extract prop definitions without compiling
- `Vstr` class — load once, render many times

## What It Is NOT
Not a web framework. Not a build tool. Not a bundler plugin. The Vue SSR machinery is an implementation detail — consumers should not depend on Vue being the underlying renderer.

## Known Debt
- Import resolution uses regex, not a proper AST — works for standard cases but brittle on complex import syntax
- `introspect()` manually parses `defineProps<{}>()` — fragile on edge cases (union types, nested generics)
