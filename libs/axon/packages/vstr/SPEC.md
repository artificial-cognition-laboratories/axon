# @arcforge/vstr — Specification

## What This Is

A renderer for `.prompt` and `.vue` Single File Components that outputs a string.
No browser. No DOM. No build step. Vue SFC syntax is the template language;
the output is markdown, HTML, or plain text for consumption by LLMs or other text pipelines.

The file format is intentionally identical to Vue 3 SFCs so existing tooling
(Volar, Prettier, syntax highlighting) works without configuration.

---

## File Format

Standard Vue 3 SFC blocks. All blocks are optional except `<template>`.

```vue
<template>
    <!-- Required. Standard Vue template syntax. -->
    <h1>Hello {{ name }}</h1>
    <p v-if="verbose">Details: {{ detail }}</p>
</template>

<script setup lang="ts">
// Optional. Runs before render. Top-level await is supported.
// defineProps<{}> is the typed interface between caller and template.
const { name, verbose = false, detail } = defineProps<{
    name: string
    verbose?: boolean
    detail?: string
}>()
</script>
```

### Supported blocks

| Block | Behaviour |
|-------|-----------|
| `<template>` | Required. Rendered to output string. |
| `<script setup lang="ts">` | Optional. Executes before render. Supports top-level `await`. |
| `<script lang="ts">` | Optional. Same semantics as `<script setup>`. |
| `<style>` | Silently ignored. CSS has no meaning in text output. |

---

## Invariants

### MUST

1. **Render `.vue` and `.prompt` files identically** — file extension is irrelevant to the parser.
2. **Follow component import chains** — relative `.vue` and `.prompt` imports in `<script setup>` are resolved, compiled, and injected recursively. Import depth is unbounded.
3. **Execute `<script setup>` including top-level `await`** — async data fetching in setup is first-class.
4. **Support v-if, v-else, v-else-if, v-for, v-bind, v-show** — all standard Vue template directives work as in a browser Vue app.
5. **Support `<slot>` and named slots** — components that wrap content via `<slot />` or `<slot name="x" />` work correctly.
6. **Support globally registered components** — via `options.components: { Name: absPath }`.
7. **Support context injection** — host injects globals (`axon`, `cognos`, etc.) into script scope via `options.context`. These are available as bare identifiers in `<script setup>` without imports.
8. **Isolate context between renders** — injected context from one render must not be visible in another, even when the component cache is shared.
9. **Introspect `defineProps<{}>` without executing the file** — `introspect()` reads prop names, types, required flag, and defaults from the AST only.
10. **Render to markdown, HTML, or plain text** — controlled by `options.format`.

### MUST NOT

1. **Expose DOM globals** — `window`, `document`, `localStorage` etc. do not exist. Vstrs that reference them will throw.
2. **Require a build step** — the renderer runs directly in Bun/Node. No Vite, no webpack, no bundler.
3. **Execute npm imports** — imports of npm packages in `<script setup>` are stripped before evaluation. Only relative `.vue`/`.prompt` imports are resolved. npm packages must be consumed in the host and passed via `context`.
4. **Leak render state between calls** — each `render()` call produces an independent output with no shared mutable state.

### EXPLICITLY NOT SUPPORTED

| Feature | Status |
|---------|--------|
| `<style>` blocks | Silently ignored |
| CSS scoping | Not applicable |
| `ref()`, `reactive()` reactivity | Works syntactically (one-time value) but does not react |
| `provide` / `inject` across component boundaries | Not supported |
| `defineEmits` | No-op — there is no event system |
| `defineExpose` | No-op |
| `onMounted`, `onUnmounted` lifecycle hooks | No-op in SSR context |
| HMR / hot reload | Not supported |
| Browser-specific APIs | Will throw if referenced |

---

## API

### `Vstr` class — load once, render many

```typescript
const tpl = await Vstr.load("./system.prompt", {
    context: { axon },           // globals injected into script scope
    components: { Nav: "./nav.prompt" }, // globally registered components
    format: "markdown",          // "markdown" | "html" | "text"
    noCache: false,              // skip compile cache
})

const md = await tpl.render({ messages, cwd })  // render with props
const props = tpl.props()                        // introspect without re-render
```

### `renderFile` — convenience

```typescript
const md = await renderFile("./system.prompt", { messages, cwd }, { context: { axon } })
```

### `render` — inline source string

```typescript
const md = await render(`
    <template><h1>Hello {{ name }}</h1></template>
    <script setup lang="ts">
    const { name } = defineProps<{ name: string }>()
    </script>
`, { name: "world" })
```

### `introspect` / `introspectSource` — prop extraction without compile

```typescript
const props = introspect("./system.prompt")
// → [{ name: "messages", type: "Message[]", required: true, default: undefined }, ...]

const props = introspectSource(sourceString)
```

### `PropInfo` type

```typescript
type PropInfo = {
    name: string       // prop name
    type: string       // TypeScript type string as written
    required: boolean  // false if marked optional with ?
    default: unknown   // value from destructure default, or null/undefined
}
```

---

## Context Injection

The primary mechanism for making host runtime APIs available to templates.

```typescript
// Host side
const tpl = await Vstr.load("./prompt.prompt", {
    context: {
        axon: axonHandle,
        db: database,
        env: process.env,
    }
})
```

```vue
<!-- In the template — no import needed -->
<script setup lang="ts">
const prs = await axon.tools.github.openPRs()
const user = await db.users.findById(userId)
</script>
```

**Invariant:** Context is injected per-compile. The cache key includes a fingerprint of
the context shape (key names + types). Two loads with different context objects but the
same file will produce independent compiled components.

**Context values are never serialised** — functions, class instances, and non-JSON values
are all valid.

---

## Component Resolution

### Relative imports (auto-resolved)

```vue
<script setup lang="ts">
import Header from "./components/header.prompt"
import Footer from "../../shared/footer.vue"
</script>
```

- Both `.prompt` and `.vue` extensions are resolved
- Recursive — sub-components can import their own sub-components
- Cached by absolute path (shared with parent cache)

### Global components (via options)

```typescript
Vstr.load("./prompt.prompt", {
    components: {
        Header: "/abs/path/to/header.prompt",
        Footer: "/abs/path/to/footer.vue",
    }
})
```

Global components are registered on the Vue SSR app before rendering.
They do not need to be imported in `<script setup>`.

### npm packages

npm imports in `<script setup>` are **stripped** before evaluation.
To use an npm package in a template, consume it in the host and pass the result
(or a wrapper function) via `context`.

---

## Output Formats

| Format | Description |
|--------|-------------|
| `"markdown"` | Default. HTML from Vue SSR converted to Markdown via Turndown. Headings, lists, code blocks, and inline code are preserved. `<section>` elements become `---` separators. `<pre data-lang="ts">` becomes ` ```ts ` fenced blocks. |
| `"html"` | Raw HTML string from Vue SSR `renderToString`. |
| `"text"` | All HTML tags stripped. Whitespace collapsed. |

---

## Slots

Components that wrap content use `<slot />` as in standard Vue:

```vue
<!-- layout.prompt -->
<template>
    <div>
        <slot name="header" />
        <section>
            <slot />
        </section>
    </div>
</template>
```

```vue
<!-- page.prompt -->
<script setup lang="ts">
import Layout from "./layout.prompt"
</script>
<template>
    <Layout>
        <template #header><h1>Title</h1></template>
        <p>Body content</p>
    </Layout>
</template>
```

---

## Caching

- Compile results are cached globally by absolute path + context fingerprint
- `noCache: true` bypasses the cache for a specific load
- `Vstr.clearCache()` clears the global cache entirely
- Caching is an optimisation only — correctness must not depend on cache state

---

## What This Is Not

- Not a web framework
- Not a build tool or bundler plugin
- Not a replacement for a templating engine like Handlebars or Nunjucks — it is more powerful and more opinionated
- The Vue SSR machinery is an implementation detail — do not depend on Vue being the underlying renderer in perpetuity
