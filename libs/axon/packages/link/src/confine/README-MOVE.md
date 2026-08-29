# confine — moved from @arcforge/capsule (commit 1 of the agent-process reshuffle)

This is now the SOURCE OF TRUTH for OS confinement.

`libs/axon/packages/capsule/platform/confine/` still holds a copy, and that is
deliberate and temporary: `platform` depends on `@arcforge/capsule`, so the capsule
cannot import from here without a dependency cycle. The capsule's copy dies with
the capsule subprocess in commit 4, at which point this is the only one.

The one real change made during the move: `ENTRYPOINT` — a module constant that
resolved the capsule subprocess's own entrypoint from `import.meta.dir` — became
`entrypoint(candidates)` and a required `Confinement({ entrypoint })` option.
Confinement now knows how to build a box and nothing about what goes in it,
which is what lets the same builder confine the capsule subprocess today and the
whole agent process after the reshuffle.

## Where OS confinement actually works (probed 2026-08-25)

Measured, not assumed. bwrap needs THREE things a standard container does not
give it, and removing any one breaks it:

| Environment | userns | bwrap box | net isolation |
|---|---|---|---|
| Linux host (rootless) | ✅ | ✅ | ✅ |
| Docker, default | ❌ | ❌ | ❌ |
| Docker + `seccomp=unconfined` | ✅ | ❌ | ❌ |
| Docker + seccomp + `CAP_SYS_ADMIN` | ✅ | ❌ (AppArmor) | ❌ |
| Docker + seccomp + apparmor + SYS_ADMIN | ✅ | ✅ | ❌ |

**Cloud Run offers none of them** — no `--cap-add`, no seccomp profile control,
no AppArmor control, and gen-2 runs under gVisor, which implements user
namespaces but not the mount operations bwrap needs. There is no configuration
that makes this work.

This does not weaken the deployed posture: gVisor is a stronger sandbox than
bwrap. What is lost is that the USER'S declared policy stops getting OS
enforcement in the cloud — the container is the boundary, and the mediator is
the only per-agent layer. The tier a deployed agent is actually running under
must therefore be reported, never assumed, and the docs must say which
environments give OS enforcement. `Confinement.build()` already has the right
instinct (`if (!tierReady(tier, status)) throw` — fail loud, never degrade);
the cloud path needs the same honesty, with "the container is the box" as a
named tier rather than a silent downgrade.

Even in the most-permissive container, `--unshare-net` still failed
(`RTM_NEWADDR: No child processes`) — network isolation is the weakest
primitive of the set, failing where the mount box succeeds.
