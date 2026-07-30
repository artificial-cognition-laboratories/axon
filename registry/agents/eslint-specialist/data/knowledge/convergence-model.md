# Convergence Model

This agent operates as a control system. The goal is not to make lint pass —
it is to drive the codebase toward an ideal ESLint configuration and hold it there.

## The Three Components

### Setpoint
The ideal ESLint configuration for this project type. Computed at setup time
from project shape detection. Represents what the config *should* look like
when fully converged. Stored in `data/eslint-state.json` under `setpoint`.

The setpoint is not static — it is reviewed and updated periodically as the
project matures or new rules become relevant.

### Error Signal
The gap between setpoint and current state. Computed per rule:
- Rule is `off` but setpoint is `warn` or `error` → error signal: rule is absent
- Rule is `warn` but setpoint is `error` → error signal: violations count
- Rule is `error` and violations > 0 → error signal: regressions (highest priority)
- Rule is `error` and violations = 0 → converged ✓

### Actuators
- **fix** — reduces violation count for a specific rule in a specific path
- **tighten** — promotes a rule toward setpoint (off → warn → error)

## Convergence Phases

Every rule tracked in state moves through phases:

**Phase 0 — Absent**
Rule not in config. If in setpoint, needs to be added at `warn` first.
Never jump directly to `error` on an unknown violation count.

**Phase 1 — Measuring**
Rule is in config at `warn`. Violation count is being tracked. The rule has
been introduced but not yet enforced. New violations are visible but not blocking.

**Phase 2 — Fixing**
Active fix campaigns are underway. Violation count is decreasing. The tighten
actuator is blocked until violations reach zero.

**Phase 3 — Ready**
Violation count is zero. Rule can be promoted to `error`. Tighten will propose this.

**Phase 4 — Converged**
Rule is at `error` with zero violations. Any regression triggers immediate alert.
This is the stable state for correctness and safety rules.

## Trend Analysis

Each audit records the violation count. The agent tracks trend over time:
- **Decreasing** — fix campaigns are working, convergence in progress
- **Stable** — violations are neither growing nor shrinking, fix campaign needed
- **Increasing** — regression, new violations being introduced faster than fixed
- **Zero** — ready for promotion or already converged

A rule that is increasing is a higher priority than a rule that is stable,
regardless of absolute violation count. Divergence must be stopped before fixing.

## Setpoint Derivation

At setup, the agent detects:
- Language: TypeScript, JavaScript, or mixed
- Frameworks: Vue, React, Node, browser
- Project type: app, library, monorepo, CLI
- Existing config: what's already configured and at what level

From this, it selects the appropriate setpoint profile:

**TypeScript App** — full correctness + safety rules at error, style rules at warn
**TypeScript Library** — stricter than app; explicit return types, no-console errors
**Mixed JS/TS** — conservative; JS files get lighter ruleset
**Monorepo** — per-package setpoints derived from each package's shape

The setpoint is written to `data/eslint-state.json` and can be inspected and
adjusted by the engineer. It is not a black box.

## What the Agent Never Does

- Never suppresses a violation with `// eslint-disable` without leaving a comment explaining why
- Never promotes a rule to `error` before violations reach zero
- Never modifies the setpoint without explaining the reason
- Never fixes a file and leaves it in a worse state than it started
- Never silently ignores a diverging rule
