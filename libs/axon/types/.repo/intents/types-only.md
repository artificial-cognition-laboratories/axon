---
scope: "src/**"
mode: observe
---

# Exports types, never values

No file under `src/` may export a runtime value — no functions, no
constants, no classes.

A value export makes this package a runtime dependency of everything that
imports it, which defeats the point of a types package.

## Measure

Read every file under `src/`. Report any `export` that is not `export type`,
`export interface`, or a type-only re-export.
