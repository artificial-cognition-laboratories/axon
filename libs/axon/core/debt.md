# @arcforge/core — debt

## [x] The generated types described a scope the runtime did not have
**Severity:** critical
**Description:**
Tool placement followed ORIGIN: an agent's own tools flat, an installed
module's wrapped under its own name. Both scope renderers spelled that wrap —
the model's `<scope>` and the editor's `tool-globals.d.ts` — so a registry
module exporting one object named after its own file declared
`subagents.subagents.request()`. A model read its own types, called exactly
what they promised, and got `undefined is not an object`; an editor typechecked
the same broken path. Fixed by placing every tool flat, unconditionally: a tool
exporting an object is already its own namespace, and conditional placement
made a call site depend on provenance — moving a tool into a module silently
rewrote every caller. The `flat` field is deleted rather than defaulted, since
carrying the decision is what let three surfaces drift.
**References:**
- libs/axon/core/src/tools/tools.ts — globals()
- libs/axon/packages/air/src/scope-dts.ts, render/blocks.ts
- libs/axon/kernel/src/scope.ts — toScopeModule
- libs/axon/core/tests/unit/tools/scope-declarations.test.ts

## [x] A name two tools both export is last-write-wins
**Severity:** low
**Description:**
Flat placement means two tools exporting `read` collide, and the second wins.
Reported through `Tools.onClash` rather than refused — bricking an agent over a
collision it can still mostly serve is worse. **Resolved:** `Axon()` now supplies
that callback and commits `build:warning`, whose own doc names "a tool shadowed
by one of the same name" as its case. The message names both tools, the shared
export and which one won, because a warning that only says "a clash occurred"
leaves the reader to go and find it. An explicit remap in config remains the
fuller answer if collisions turn out to be common, which they should not be.
**References:**
- libs/axon/core/src/tools/tools.ts — the onClash seam

