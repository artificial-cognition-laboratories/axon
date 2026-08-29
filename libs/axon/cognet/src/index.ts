// @arcforge/cognet — the cognet runtime.
//
// Everything that executes INSIDE a compiled brain. The kernel that loads the
// brain lives in @arcforge/core and is private; this is the public half, and it is
// what the generated entry imports.
//
// Root export is deliberately minimal: a cognet cannot exist without the host,
// but the world (./ecs) and the grammar (./air) are opt-in, so a control loop
// bundles neither.

// Importing ./host INSTALLS the ambient globals (loop, kernel, phase, system,
// defineCognet, definePlugin) as a side effect — that is why the generated
// entry imports it first, before config and main evaluate.
//
// definePlugin is deliberately global-only: it registers lifecycle hooks when
// called, so it is a side-effecting declaration rather than an identity
// function, and exporting it would invite calling it outside a brain.
export { CognetHost } from "./host"
export { defineCognet } from "./define"

export { Clock, type ClockT, type ClockOpts, type ClockEmit } from "./clock"
