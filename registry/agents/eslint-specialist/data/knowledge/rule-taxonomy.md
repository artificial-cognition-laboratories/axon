# ESLint Rule Taxonomy

Rules fall into four categories. Understanding which category a rule belongs to
determines how aggressively to enforce it and how to fix violations.

## Category 1: Correctness Rules
These catch real bugs. They should always be `error`. There is no legitimate reason
to suppress them without fixing the underlying issue.

- `no-undef` — using variables that don't exist
- `no-unreachable` — code after return/throw/break
- `no-duplicate-case` — duplicate switch cases
- `no-self-assign` — assigning a variable to itself
- `use-isnan` — comparisons with NaN (always false)
- `@typescript-eslint/no-unsafe-assignment` — any-typed values spreading into typed code
- `@typescript-eslint/no-floating-promises` — fire-and-forget on promises that can reject

**Convergence target:** `error`. No exceptions. If a violation exists, it is a bug.

## Category 2: Safety Rules
These don't always indicate bugs but represent patterns that frequently cause them.
Should be `error` in mature codebases, `warn` while actively fixing.

- `@typescript-eslint/no-explicit-any` — erases type safety; often a sign of deferred work
- `@typescript-eslint/no-non-null-assertion` — `!` operator bypasses null checks
- `no-var` — `var` has function scope, not block scope; causes subtle bugs
- `prefer-const` — mutable bindings when immutable would do; signals unclear ownership
- `@typescript-eslint/ban-ts-comment` — suppresses the type checker entirely
- `no-empty` — empty catch blocks swallow errors silently (Hard Invariant violation)
- `eqeqeq` — `==` with type coercion causes unexpected comparisons

**Convergence target:** `error`. Fix violations before promoting. Never suppress without a comment explaining why.

## Category 3: Style/Consistency Rules
These enforce a consistent style across the codebase. Lower priority than correctness
and safety, but worth enforcing once the codebase is stable.

- `no-duplicate-imports` — consolidate imports from the same module
- `@typescript-eslint/consistent-type-imports` — `import type` vs `import`
- `@typescript-eslint/no-unused-vars` — dead code; safe to auto-fix by deletion
- `no-console` — often appropriate in library code; not appropriate in production app code
- `curly` — braces around control flow bodies

**Convergence target:** `warn` → `error` once correctness and safety rules are clean.

## Category 4: Pedantic Rules
These are matters of opinion. Enable only if the team has agreed on them explicitly.
Never enable by default in a general-purpose config.

- `@typescript-eslint/explicit-function-return-type` — forces explicit return types everywhere
- `@typescript-eslint/naming-convention` — enforces specific naming patterns
- `max-lines` — file length limits
- `complexity` — cyclomatic complexity limits

**Convergence target:** Project-specific. Do not include in setpoint unless team has opted in.

---

# Fix Strategies by Category

## Auto-fixable (ESLint --fix handles it)
- `no-var` → rewrites to `let`/`const`
- `prefer-const` → promotes `let` to `const`
- `no-duplicate-imports` → merges import statements
- `@typescript-eslint/consistent-type-imports` → adds/removes `type` keyword
- `no-unused-vars` → removes unused imports (with --fix-type suggestion)

## Requires model reasoning to fix
- `@typescript-eslint/no-explicit-any` — must infer the correct type from context
- `@typescript-eslint/no-non-null-assertion` — must prove the value is non-null or add a guard
- `@typescript-eslint/ban-ts-comment` — must fix the underlying type error being suppressed
- `no-empty` — must determine whether the catch block should throw, log, or genuinely ignore
- `@typescript-eslint/no-floating-promises` — must add `void`, `await`, or `.catch()`

## Requires config change (not a code fix)
- Rules disabled globally that should be enabled
- Rules at `warn` that should be `error` once violations reach zero
- Rules with incorrect options (wrong ignore patterns, etc.)
