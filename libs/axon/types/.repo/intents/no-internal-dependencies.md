---
scope: "src/**"
mode: propose
on: [commit]
---

# Depends on nothing inside the monorepo

No file under `src/` may import from another package in this repo.

This package sits at the bottom of the dependency graph. Everything may
depend on it, so anything it depends on becomes a transitive dependency of
the entire runtime — and any cycle through it is unbreakable.

## Measure

Run `grep -rn "from \"@a" src/ --include=*.ts` and report any import whose
specifier resolves inside this repo.

Relative imports within `src/` are fine. Node builtins are fine.

## Reconcile

Move the shared type into this package, or invert the dependency so the
other side imports from here. Never duplicate a definition to break the edge.
