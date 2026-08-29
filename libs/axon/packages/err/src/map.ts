/**
 * The single source of truth for every failure Axon can name. One flat map,
 * one entry per unique failure — codes are never reused and never change
 * once shipped (a code is a stable identity a user or a support thread can
 * reference). New failures get an entry here before their call site exists;
 * `err()` refuses to compile against a code this map doesn't declare.
 *
 * `title`/`description` are the rendering contract: title is a short,
 * user-facing headline ("Agent failed to start"), description is one or two
 * sentences of plain-language context — not the message, not the stack.
 * Both are written for someone who has never read this codebase.
 *
 * `severity` replaces a bare recoverable boolean — a degrading-but-handled
 * failure and a fatal one both need to reach the log, just not with the
 * same weight:
 *   - "fatal"      — the operation this belongs to did not complete. Always logged, always rendered loud.
 *   - "recovered"  — failed, but a fallback/retry made it survivable. Logged for visibility, not alarmed.
 *   - "degraded"   — the system continues in a lesser state (a feature disabled, a cache miss that will retry). Logged, low urgency.
 */

// AxonErrorSource / AxonErrorSeverity are the wire contract — they live in
// @arcforge/types and are re-exported here so this map's entries and existing
// importers resolve them from the same place.
export type { AxonErrorSource, AxonErrorSeverity } from "@arcforge/types"
import type { AxonErrorSource, AxonErrorSeverity } from "@arcforge/types"

export type AxonErrorMapEntry = {
    /** Stable short code, e.g. "AX-BOOT-001". Never reused, never renumbered. */
    code: string
    /** Short, user-facing headline. */
    title: string
    /** One or two plain-language sentences — what happened and why it matters, not a stack dump. */
    description: string
    source: AxonErrorSource
    severity: AxonErrorSeverity
    /**
     * Is this a failure the USER caused and can fix, rather than a fault in
     * our code?
     *
     * `axon publish` outside a project directory is a typo, not a bug — the
     * title and description already say everything actionable, so a renderer
     * showing eighty lines of our internals underneath is telling the user to
     * debug software they did not write. Marking it `expected` renders the
     * headline alone.
     *
     * Deliberately NOT `severity`, which answers a different question:
     * PROJECT_NOT_FOUND is genuinely `fatal` (the command cannot continue) AND
     * genuinely expected. Recoverability and blame are independent axes.
     *
     * Absent means unexpected — the safe default. An unclassified failure gets
     * the full trace, which is what makes it debuggable; the only cost of
     * forgetting this flag is a noisier message, never a hidden bug.
     */
    expected?: true
}

/**
 * This map must be updated for every unique failure case.
 */
export const errorMap = {
    UNKNOWN: {
        code: "AX-UNKNOWN-001",
        title: "Unclassified Error",
        description: "An error occurred that hasn't been given a proper code yet. This is itself worth fixing — see the err(cause) call site that produced it.",
        source: "runtime",
        severity: "fatal",
    },
    PROMPT_NOT_FOUND: {
        code: "AX-PROMPT-001",
        title: "Prompt Not Found",
        description: "The requested prompt could not be resolved — it is not declared by the agent, or the published package it names ships no prompt by that name.",
        source: "runtime",
        severity: "fatal",
        expected: true,
    },
    PROMPT_FILE_NOT_FOUND: {
        code: "AX-PROMPT-002",
        title: "Prompt File Missing",
        description: "The prompt is declared but its source file no longer exists on disk.",
        source: "runtime",
        severity: "fatal",
        expected: true,
    },
    PROMPT_RENDER_FAILED: {
        code: "AX-PROMPT-003",
        title: "Prompt Render Failed",
        description: "The prompt's source file failed to compile or render — likely a malformed SFC (content outside <template>/<script>/<style>) or an error thrown while rendering. See the cause for the underlying parser/render error.",
        source: "runtime",
        severity: "fatal",
    },
    OUTPUT_INVALID: {
        code: "AX-OUTPUT-001",
        title: "Invalid Output Type",
        description: "The `output` type passed to request() is not valid TypeScript, or references a type that does not exist. Checked before the model is called, so no inference was spent — fix the type string at the call site.",
        source: "runtime",
        severity: "fatal",
    },
    OUTPUT_UNSATISFIED: {
        code: "AX-OUTPUT-002",
        title: "Output Type Not Satisfied",
        description: "The model could not produce a response matching the declared `output` type within its retry budget. The accumulated TypeScript diagnostics describe what it got wrong on each attempt.",
        source: "runtime",
        severity: "fatal",
    },
    OUTPUT_EMPTY: {
        code: "AX-OUTPUT-003",
        title: "Model Produced No Output Block",
        description: "Every reply must wrap its content in a <text> or <script> block — text outside a block is discarded by the parser. The model replied with none, on every attempt in its retry budget, so there was nothing to render or run. Usually means the model is not following the block protocol rather than that anything is misconfigured: the reply itself is often correct, just unwrapped. Try a different model, or check that the protocol the cognet renders matches the one it parses with.",
        source: "runtime",
        severity: "fatal",
        expected: true,
    },
    SCRIPT_NOT_FOUND: {
        code: "AX-SCRIPT-001",
        title: "Script Not Found",
        description: "The requested script was not found in the agent's blueprint. It may not be declared, or the agent needs to be re-prepared.",
        source: "runtime",
        severity: "fatal",
        expected: true,
    },
    SCRIPT_FILE_NOT_FOUND: {
        code: "AX-SCRIPT-002",
        title: "Script File Missing",
        description: "The script is declared but its source file no longer exists on disk.",
        source: "runtime",
        severity: "fatal",
        expected: true,
    },
    SUBAGENT_LINK_UNSUPPORTED: {
        code: "AX-SCRIPT-004",
        title: "Subagent Not Supported Over The Link",
        description: "An agent asked to spawn a subagent whose child runs as a confined process. `axon.request()` returns a wake's collected entries, while the link's `stimulus` verb returns only admission — the supervisor needs a verb that collects a wake and answers when it settles. Until that exists this fails rather than returning an admission receipt the caller would read as a result.",
        source: "runtime",
        severity: "fatal",
    },
    AGENT_BOOT_FAILED: {
        code: "AX-AGENT-006",
        title: "Agent Failed To Boot",
        description: "The agent process exited before it connected to its supervisor. Its own stderr is carried as the detail — the agent usually knows exactly what went wrong (a missing cognet, a tool that would not compile), and without this that diagnosis died in a pipe while the supervisor reported only a closed socket.",
        source: "runtime",
        severity: "fatal",
    },
    CAPSULE_NOT_LOCAL: {
        code: "AX-AGENT-007",
        title: "No Capsule On This Machine",
        description: "A console eval was requested against an attached deployment. Its capsule runs wherever the deployment is hosted, so there is nothing here to execute in — and quietly resolving would read as \"it ran and did nothing\".",
        source: "runtime",
        severity: "fatal",
        expected: true,
    },
    LINK_NO_HANDLER: {
        code: "AX-LINK-001",
        title: "No Handler For Link Verb",
        description: "The peer sent a verb this side does not implement. Both ends speak a versioned contract, so this means they disagree about it — a wiring fault, not something a user did.",
        source: "runtime",
        severity: "fatal",
    },
    LINK_PEER_CLOSED: {
        code: "AX-LINK-002",
        title: "Agent Disconnected",
        description: "The agent process closed its side of the link. Every call still in flight is rejected rather than left hanging — a dead peer must be an error, never a wait that never ends.",
        source: "runtime",
        severity: "fatal",
    },
    LINK_CLOSED: {
        code: "AX-LINK-003",
        title: "Link Closed",
        description: "The link to the agent was torn down by this side — a shutdown, a dispose, or a failed boot. Outstanding calls are rejected with this rather than hanging.",
        source: "runtime",
        severity: "fatal",
    },
    LINK_FRAME_TOO_LARGE: {
        code: "AX-LINK-004",
        title: "Link Frame Too Large",
        description: "A message on the link exceeded the maximum frame size, or a length prefix declared one that did. The prefix is peer-controlled input, so an oversized declaration is refused rather than allocated — a desynchronised stream cannot be recovered by reading past it.",
        source: "runtime",
        severity: "fatal",
    },
    LINK_UNKNOWN_PROMPT_ACTION: {
        code: "AX-LINK-005",
        title: "Unknown Prompt Action",
        description: "The prompt verb was called with an action this side does not know. Loud rather than silent: an unrecognised action would otherwise return undefined, which a caller renders as an empty prompt list.",
        source: "runtime",
        severity: "fatal",
    },
    AGENT_LINK_MISSING: {
        code: "AX-AGENT-001",
        title: "Agent Started Without A Supervisor",
        description: "An agent process was started with no link paths in its environment, which means nothing is supervising it. It cannot guess a socket path — doing so risks connecting to a different agent's supervisor entirely.",
        source: "runtime",
        severity: "fatal",
    },
    AGENT_LINK_MALFORMED: {
        code: "AX-AGENT-002",
        title: "Malformed Agent Link",
        description: "The link carrier in the agent's environment is not valid JSON, or does not name both a control and a data socket. Both are required — an agent with only one connected can accept work it has no way to answer.",
        source: "runtime",
        severity: "fatal",
    },
    AGENT_BLUEPRINT_MISSING: {
        code: "AX-AGENT-003",
        title: "Agent Started Without A Blueprint",
        description: "An agent process was started with no blueprint path in its environment. The supervisor writes the blueprint beside the sockets before spawning; its absence means the spawn path is broken.",
        source: "runtime",
        severity: "fatal",
    },
    AGENT_NOT_READY: {
        code: "AX-AGENT-004",
        title: "Agent Still Booting",
        description: "A verb arrived before the agent's runtime finished booting. The link connects first so that boot failures are reportable, which leaves a brief window where the agent can be addressed but cannot answer.",
        source: "runtime",
        severity: "fatal",
    },
    CLI_AGENT_NOT_LOCAL: {
        code: "AX-AGENT-005",
        title: "Command Needs An In-Process Agent",
        description: "A headless CLI command booted an agent that runs as a separate process, but the command reaches into the runtime directly. This is a wiring fault: the command needs either an in-process agent or a link verb.",
        source: "runtime",
        severity: "fatal",
    },
    ENGINE_ROLE_UNBOUND_LINK: {
        code: "AX-ENGINE-010",
        title: "No Engine For Role",
        description: "A confined agent asked for inference on a role the supervisor has no engine bound to. Roles are resolved on the supervisor's side before the agent starts, so an unbound one here means resolution and the cognet's declaration disagree.",
        source: "runtime",
        severity: "fatal",
    },
    ENGINE_KIND_MISMATCH_LINK: {
        code: "AX-ENGINE-011",
        title: "Engine Kind Mismatch",
        description: "A role bound to a transform or session engine was asked to serve a generate call. Resolution already matched the declared type, so reaching here means a provider's create() disagreed with the capability it was handed.",
        source: "runtime",
        severity: "fatal",
    },
    ENGINE_MISSING: {
        code: "AX-ENGINE-001",
        title: "No Engine Configured",
        description: "The agent's blueprint has no engine — it cannot dispatch to a model. Set `engine` in axon.config.ts.",
        source: "runtime",
        severity: "fatal",
    },
    ENGINE_ROLE_UNBOUND: {
        code: "AX-ENGINE-002",
        title: "Engine Role Not Bound",
        description: "The cognet asked for an engine role that resolution did not fill. A required role stops the boot, so reaching this means an OPTIONAL role was used without checking `kernel.engine.has()` first — or the role was never declared in the cognet's `engines:` block.",
        source: "runtime",
        severity: "fatal",
    },
    RESOURCES_EXHAUSTED: {
        code: "AX-RES-001",
        title: "Not Enough Memory",
        description: "A local model does not fit in what is left of this machine's video memory. Nothing was evicted: another agent is using it, and taking memory out from under a running agent would slow it down invisibly. Stop an agent that is holding a model, or raise the ceiling in your profile's `resources`.",
        source: "runtime",
        severity: "degraded",
        expected: true,
    },
    ENGINE_PIN_UNAVAILABLE: {
        code: "AX-ENGINE-004",
        title: "Model Not Available",
        description: "The agent pins a model no declared provider can supply. The agent still runs — resolution picked the best available model instead — but it is NOT the one that was asked for. Declare the provider that supplies it in your profile, or pick a model from a provider you have.",
        source: "runtime",
        severity: "degraded",
        expected: true,
    },
    ENGINE_REQUIREMENTS_UNMET: {
        code: "AX-ENGINE-003",
        title: "Inference Requirements Unmet",
        description: "This cognet declares engine roles that nothing among the user's providers can fill. Add a provider that supplies what is missing, or run a cognet whose requirements this machine meets.",
        source: "runtime",
        severity: "fatal",
        expected: true,
    },
    INJECT_OUTSIDE_RUNTIME: {
        code: "AX-RUNTIME-001",
        title: "Runtime Accessed Before Boot",
        description: "A runtime global (axon, args) was read before the runtime finished booting.",
        source: "runtime",
        severity: "fatal",
    },
    BOOT_FAILED: {
        code: "AX-BOOT-001",
        title: "Agent Failed To Start",
        description: "The agent's runtime crashed while starting, before it could accept requests.",
        source: "runtime",
        severity: "fatal",
    },
    BOOT_SCRIPT_FAILED: {
        code: "AX-BOOT-002",
        title: "Boot Script Failed",
        description: "The agent's boot.vue threw while rendering — check the script setup block for the error.",
        source: "runtime",
        severity: "fatal",
    },
    BOOT_SCRIPT_INVALID: {
        code: "AX-BOOT-003",
        title: "Boot Script Malformed",
        description: "The agent's boot.vue has content outside its recognized <script>/<template> blocks, or otherwise failed to parse as a valid SFC.",
        source: "runtime",
        severity: "fatal",
    },

    // ── Cognet (host.ts / cognet.ts) ────────────────────────────────────────
    COGNET_ACCESSED_BEFORE_LOAD: {
        code: "AX-COGNET-001",
        title: "Cognet Accessed Before Load",
        description: "A cognet global (kernel, phase, system, blueprint) was read before the brain finished loading, or outside the loop body that owns it.",
        source: "cognet",
        severity: "fatal",
    },
    COGNET_LOOP_ALREADY_DECLARED: {
        code: "AX-COGNET-002",
        title: "Loop Already Declared",
        description: "A cognet's main() called loop() more than once — the loop is the program's entire main body and can only be declared once.",
        source: "cognet",
        severity: "fatal",
    },
    COGNET_ALREADY_LOADED: {
        code: "AX-COGNET-003",
        title: "Cognet Bound To A Different Kernel",
        description: "This cognet instance already loaded against a different kernel ABI — a reload produced a conflicting bind instead of a clean swap.",
        source: "cognet",
        severity: "fatal",
    },
    COGNET_NO_LOOP: {
        code: "AX-COGNET-004",
        title: "Cognet Declared No Loop",
        description: "The cognet's main() ran (or was woken) without ever declaring loop() — there is no program to run.",
        source: "cognet",
        severity: "fatal",
    },
    COGNET_LOAD_FAILED: {
        code: "AX-COGNET-016",
        title: "Cognet Failed To Load",
        description: "The cognet's own main() threw while running at load(). The brain never finished booting, so the agent has nothing to think with. The cause below is the error the cognet's code raised — it comes from the brain's source, not from Axon.",
        source: "cognet",
        severity: "fatal",
    },
    COGNET_MAX_TICKS: {
        code: "AX-COGNET-005",
        title: "Cognet Exceeded Max Ticks",
        description: "The cognet's loop ran more ticks in one wake than its configured limit allows — likely a runaway loop that never calls stop().",
        source: "cognet",
        severity: "fatal",
    },
    COGNET_ABI_MISMATCH: {
        code: "AX-COGNET-006",
        title: "Cognet ABI Mismatch",
        description: "The compiled cognet targets a kernel ABI version the running kernel doesn't provide — rebuild the cognet against the current framework version.",
        source: "cognet",
        severity: "fatal",
    },
    COGNET_MISSING: {
        code: "AX-COGNET-007",
        title: "No Compiled Cognet",
        description: "The blueprint points at a compiled cognet bundle that doesn't exist on disk yet — run `axon prepare` before booting.",
        source: "cognet",
        severity: "fatal",
    },
    COGNET_HASH_MISMATCH: {
        code: "AX-COGNET-008",
        title: "Cognet Bundle Hash Mismatch",
        description: "The compiled cognet bundle on disk doesn't match the hash the blueprint expects — it's stale or was tampered with. Run `axon prepare` again.",
        source: "cognet",
        severity: "fatal",
    },
    COGNET_INVALID: {
        code: "AX-COGNET-009",
        title: "Invalid Cognet Bundle",
        description: "The compiled cognet's default export isn't a real cognet definition — the compile step produced something malformed.",
        source: "cognet",
        severity: "fatal",
    },
    COGNET_IDENTITY_MISMATCH: {
        code: "AX-COGNET-010",
        title: "Cognet Identity Mismatch",
        description: "The compiled cognet artifact's own name doesn't match what the blueprint declared — the wrong bundle may be at this path.",
        source: "cognet",
        severity: "fatal",
    },
    COGNET_CONFIG_MISSING: {
        code: "AX-COGNET-011",
        title: "Cognet Config Missing",
        description: "No cognet.config.ts was found in the cognet's source directory — every cognet needs one to declare its identity.",
        source: "cognet",
        severity: "fatal",
    },
    COGNET_BUILD_FAILED: {
        code: "AX-COGNET-012",
        title: "Cognet Failed To Compile",
        description: "Bundling the cognet's source into a runnable artifact failed — check the build log for the underlying syntax or import error.",
        source: "cognet",
        severity: "fatal",
    },
    COGNET_RUNTIME_UNAVAILABLE: {
        code: "AX-COGNET-014",
        title: "Cognet Runtime Temporarily Unavailable",
        description: "The cognet runtime is declared but not present on disk — the dependency tree is mid-rewrite. Transient: the reload keeps the previous blueprint and picks the change up on the next watch event.",
        source: "cognet",
        severity: "recovered",
    },
    COGNET_AMBIGUOUS: {
        code: "AX-COGNET-015",
        title: "Two Cognets Declared",
        description: "The agent both declares `cognet:` in axon.config.ts and holds an inline cognet at `cognet/`. An agent has exactly one brain, and choosing between them silently would either ignore a directory of source or overrule what the author wrote. Keep one.",
        source: "cognet",
        severity: "fatal",
    },
    COGNET_NOT_FOUND: {
        code: "AX-COGNET-013",
        title: "Cognet Not Found",
        description: "The cognet named by `cognet:` in axon.config.ts could not be located. The detail says where it was looked for — a registry that answered 404, or a node_modules tree it was missing from. Check the specifier for a typo, and check which registry the CLI is pointed at (AXON_API_BASE).",
        source: "cognet",
        severity: "fatal",
        expected: true,
    },

    // ── Project (build/project/) ────────────────────────────────────────────
    MODULE_SPECIFIER_INVALID: {
        code: "AX-PROJECT-005",
        title: "Invalid Module Specifier",
        description: "Module names must be scoped as @scope/name. The registry does not accept unscoped packages, so an unscoped specifier can never resolve.",
        source: "manifest",
        severity: "fatal",
    },
    CONFIG_MODULES_UNPARSEABLE: {
        code: "AX-PROJECT-006",
        title: "Could Not Edit axon.config.ts",
        description: "The install succeeded but the module entry could not be written into the config's modules array automatically — add or remove it by hand.",
        source: "manifest",
        severity: "fatal",
    },
    /**
     * Replaced CONFIG_ENGINE_UNPARSEABLE, which described AST-editing an
     * `engine: X({ ... })` call — a field that no longer exists. Warning
     * rather than fatal for the deprecation window: an agent carrying
     * `engine:` still boots (on the profile pool, which is what it was
     * silently doing already), and the author gets told once per load what
     * to write instead. It becomes fatal when the field is removed.
     */
    CONFIG_ENGINE_DEPRECATED: {
        code: "AX-PROJECT-033",
        title: "`engine:` Is Deprecated And Ignored",
        description: "This agent's axon.config.ts declares `engine:`, which the runtime no longer reads — inference is resolving against the profile's providers instead. Use `model: \"codex:gpt-5.6-terra\"` for a cortex pin, and `providers: [...]` for a source the user would not otherwise have.",
        source: "manifest",
        // DEGRADED, not fatal: the agent boots and runs, but not on the
        // inference its config names. That is exactly what degraded means,
        // and it is the honest label for the deprecation window.
        severity: "degraded",
    },
    MODULE_DEPENDENCY_INSTALL_FAILED: {
        code: "AX-PROJECT-004",
        title: "Module Dependencies Failed To Install",
        description: "The module source was downloaded, but its npm dependencies could not be materialized for the agent. Resolve the package-manager error and run the install again.",
        source: "manifest",
        severity: "fatal",
    },

    // ── Blueprint (build/blueprint/blueprint.ts) ────────────────────────────
    BLUEPRINT_NOT_LOADED: {
        code: "AX-PROJECT-002",
        title: "Blueprint Accessed Before Load",
        description: "Something read the blueprint's current value before load() had ever run.",
        source: "manifest",
        severity: "fatal",
    },
    AGENT_INVALID: {
        code: "AX-PROJECT-003",
        title: "Invalid Agent Directory",
        description: "The agent root has no package.json — every agent is a real package, this one isn't.",
        source: "manifest",
        severity: "fatal",
    },
    CORRUPT_JSON: {
        code: "AX-PROJECT-016",
        title: "Corrupt JSON File",
        description: "A stored JSON file failed to parse — it may have been hand-edited into an invalid state, or a write was interrupted mid-flight.",
        source: "manifest",
        severity: "fatal",
    },
    FILE_UNREADABLE: {
        code: "AX-PROJECT-032",
        title: "File Could Not Be Read",
        description: "A file exists but could not be read — most often a permissions problem, a directory where a file was expected, or a disk error. Distinct from a missing file, which is an ordinary absent-surface state.",
        source: "manifest",
        severity: "fatal",
    },
    PROVIDER_NOT_CONNECTED: {
        code: "AX-TUI-011",
        title: "Provider Not Connected",
        description: "The selected model routes through a provider (OpenRouter, Codex) that isn't connected yet — connect it before picking a model on that route.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    PALETTE_INPUT_REQUIRED: {
        code: "AX-TUI-012",
        title: "Required Input Missing",
        description: "A palette command needs a value for this field before it can run.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    BENCH_NO_CASES: {
        code: "AX-TUI-013",
        title: "Bench Declared No Cases",
        description: "The bench's test file ran to completion under Bun but never declared a single benchmark case.",
        source: "tui",
        severity: "fatal",
    },

    /**
     * A flattened tool export would have replaced a host global. Refused at
     * install rather than silently skipped: skipping made the generated
     * tool-globals.d.ts assert a binding the runtime never made, so the
     * editor typechecked a call that threw (or worse, silently read the
     * builtin) at run time.
     */
    TOOL_GLOBAL_COLLISION: {
        code: "AX-TOOL-409",
        title: "Tool Global Collides With A Builtin",
        description: "A flattened tool export has the same name as something that already exists in the agent's global scope, and replacing it would break the code around it. Reach this member through `axon.tools.<namespace>.<member>`, rename the export, or drop `flat` so the module lands under its own namespace instead.",
        source: "manifest",
        severity: "fatal",
        expected: true,
    },

    /**
     * A script the agent declares ran and failed. The agent's own error is
     * carried in `detail` — this code says WHERE it failed, not what went
     * wrong, which is the script's own business.
     */
    SCRIPT_FAILED: {
        code: "AX-SCRIPT-500",
        title: "Script Failed",
        description: "A script declared by this agent was invoked and threw. The agent's own error follows — this is the script's failure, not the runtime's.",
        source: "runtime",
        severity: "fatal",
        expected: true,
    },

    /**
     * The agent could not bind an HTTP port. Walking forward from the
     * requested one is deliberate (a second agent should come up beside the
     * first), so reaching the end of the range means the whole span is taken
     * — a real environment problem rather than a retry.
     */
    AGENT_SERVE_NO_PORT: {
        code: "AX-AGENT-503",
        title: "No Free Port",
        description: "The agent tried to bind its HTTP surface and every port in the range it walked was already in use. Free one, or pass a different port with --port.",
        source: "runtime",
        severity: "fatal",
        expected: true,
    },

    // ── Agent resolution (build/runtime/resolve.ts) ─────────────────────────
    /**
     * A named reference matched no agent in any local pool. Distinct from
     * PROJECT_NOT_FOUND, which means "this path is not a project": here the
     * caller named an agent and the answer is that it is not installed
     * anywhere, which has a different fix (`axon install`).
     */
    AGENT_NOT_FOUND: {
        code: "AX-AGENT-404",
        title: "Agent Not Found",
        description: "No local agent goes by this name. Agent references resolve against your local pools only — watched paths first, then installed agents — and never fetch from the registry. Install it first with `axon install`.",
        source: "manifest",
        severity: "fatal",
        expected: true,
    },
    /**
     * Two pools both hold an agent with this identity. Never resolved by
     * picking one: running the wrong agent silently is the failure this
     * exists to prevent.
     */
    AGENT_AMBIGUOUS: {
        code: "AX-AGENT-409",
        title: "Ambiguous Agent Name",
        description: "More than one local pool holds an agent with this name, and there is no correct way to guess which was meant — pass an explicit path, or unwatch one of the roots.",
        source: "manifest",
        severity: "fatal",
        expected: true,
    },

    // ── Project (build/project/*.ts) ────────────────────────────────────────
    PROJECT_NOT_FOUND: {
        code: "AX-PROJECT-017",
        title: "Project Not Found",
        description: "No axon.config.ts, module.config.ts, cognet.config.ts, bench.config.ts, or prompt.config.ts was found at this path — it isn't a recognized project directory.",
        source: "manifest",
        severity: "fatal",
        expected: true,
    },
    PROJECT_WRONG_KIND: {
        code: "AX-PROJECT-011",
        title: "Wrong Project Kind",
        description: "This command targets one project kind, and the directory holds another — run the command that matches what is actually here.",
        source: "manifest",
        severity: "fatal",
        expected: true,
    },
    PROJECT_EXISTS: {
        code: "AX-PROJECT-018",
        title: "Project Already Exists",
        description: "Scaffolding refused to overwrite a directory that already exists — remove it or pick a different name first.",
        source: "manifest",
        severity: "fatal",
    },
    TYPEGEN_NO_BLUEPRINT: {
        code: "AX-PROJECT-007",
        title: "Typegen Needs A Loaded Blueprint",
        description: "Agent-kind typegen was called without a blueprint — its declared surfaces are the source of the generated types.",
        source: "manifest",
        severity: "fatal",
    },
    DEPLOY_AGENTS_ONLY: {
        code: "AX-PROJECT-008",
        title: "Only Agents Can Deploy",
        description: "A module was asked to deploy on its own — modules only run installed inside an agent, deploy the agent instead.",
        source: "manifest",
        severity: "fatal",
    },
    BUNDLE_IMAGE_FAILED: {
        code: "AX-PROJECT-039",
        title: "Image Build Failed",
        description: "`docker build` did not succeed. Its own output is above — that is the real diagnostic. Check that a Docker daemon is running, and that the base image can be pulled.",
        source: "manifest",
        severity: "fatal",
        expected: true,
    },
    CONFIG_IMPORT_ESCAPES_ROOT: {
        code: "AX-PROJECT-038",
        title: "Config Imports Outside The Project",
        description: "axon.config.ts imports a file from outside this project's directory. A bundle contains the project and nothing above it, so that file is not published with it — the agent loads locally and then fails at boot in the cloud, after provisioning has already been paid for. Move what it needs inside the project, or publish it and import it by name.",
        source: "manifest",
        severity: "fatal",
        expected: true,
    },
    PUBLISH_NAMESPACE_DENIED: {
        code: "AX-PROJECT-036",
        title: "That Namespace Is Not Yours",
        description: "Publishing writes to a scope you own. This package is named for a scope owned by someone else, or by an org you are not a member of — rename it in package.json to a scope you own, or switch to the account that owns this one.",
        source: "cloud",
        severity: "fatal",
        expected: true,
    },
    PUBLISH_USERNAME_REQUIRED: {
        code: "AX-PROJECT-037",
        title: "A Username Is Required",
        description: "A username owns your registry namespace, and nothing can be published until one is set. It is set once, on the account, and every package you publish is scoped under it.",
        source: "cloud",
        severity: "fatal",
        expected: true,
    },
    PUBLISH_UNSUPPORTED_KIND: {
        code: "AX-PROJECT-009",
        title: "This Project Kind Cannot Publish",
        description: "The registry accepts agents, modules, cognets, benches and prompts. Extensions are not accepted yet — the `registry_artifact_kind` enum needs the value first, and publishing before then would register under the wrong kind and claim the name in the shared namespace. A profile is never publishable: it holds one person's credentials, history and agents. See KINDS[kind].publishable.",
        source: "manifest",
        severity: "fatal",
    },
    MODEL_SPECIFIER_INVALID: {
        code: "AX-MODEL-001",
        title: "Malformed Model Specifier",
        description: "A `models:` entry in cognet.config.ts could not be parsed. The short form is `hf:owner/repo/path/to/file` — a repo alone is ambiguous, since one repo holds many weights.",
        source: "manifest",
        severity: "fatal",
    },
    MODEL_FETCH_FAILED: {
        code: "AX-MODEL-002",
        title: "Model Weights Could Not Be Fetched",
        description: "A declared model could not be downloaded. Check the repo, file path and revision, and that the machine can reach the registry. A brain without its weights is broken rather than degraded, so this fails at prepare instead of at first inference.",
        source: "manifest",
        severity: "fatal",
    },
    MODEL_HASH_MISMATCH: {
        code: "AX-MODEL-003",
        title: "Model Weights Failed Verification",
        description: "Downloaded bytes did not hash to the expected value — the upstream file changed, or the download was corrupted. Nothing is cached: storing unverified weights would make every later run trust them.",
        source: "manifest",
        severity: "fatal",
    },
    MODEL_NOT_CACHED: {
        code: "AX-MODEL-004",
        title: "Declared Model Is Not Cached",
        description: "`--frozen` asserts the machine is already provisioned, so it will not fetch. Run `axon prepare` without --frozen to populate the model cache.",
        source: "manifest",
        severity: "fatal",
    },
    PREPARE_FROZEN_DRIFT: {
        code: "AX-PROJECT-014",
        title: "Dependencies Drifted From The Lockfile",
        description: "`--frozen` asserts that package.json, the lockfile and node_modules already agree. Something did not: a dependency is missing, at a version outside its declared range, or declared but no longer selected. Run `axon prepare` without --frozen to reconcile, and commit the result.",
        source: "manifest",
        severity: "fatal",
    },
    PUBLISH_VERIFY_FAILED: {
        code: "AX-PROJECT-013",
        title: "Artifact Does Not Compile",
        description: "The package was built, but compiling it the way a consumer would failed — so publishing it would ship something nobody can install. Usually a file the source imports was left out of the package. Published versions are immutable, so this is caught before upload rather than after.",
        source: "manifest",
        severity: "fatal",
    },
    DEPLOY_PROVISION_FAILED: {
        code: "AX-PROJECT-012",
        title: "Deployment Provisioning Failed",
        description: "The agent was published, but the cloud control plane could not provision its runtime. The request ID identifies the server-side failure.",
        source: "manifest",
        severity: "fatal",
    },
    DEPLOY_RUNTIME_FAILED: {
        code: "AX-PROJECT-035",
        title: "Agent Failed To Start",
        description: "Cloud infrastructure was provisioned, but the agent process failed during boot. The reported runtime diagnostic identifies the immediate cause.",
        source: "runtime",
        severity: "fatal",
    },
    DEPLOY_ENV_RESERVED: {
        code: "AX-PROJECT-043",
        title: "Reserved Deployment Variable",
        description: "The production .env file attempts to override a variable owned by the Axon runtime or Cloud Run.",
        source: "manifest",
        severity: "fatal",
    },
    DEPLOY_ENV_INVALID: {
        code: "AX-PROJECT-015",
        title: "Invalid Deployment Variable",
        description: "The production .env file contains a key that is not a valid environment variable name.",
        source: "manifest",
        severity: "fatal",
    },
    BUNDLE_MODULE_COLLISION: {
        code: "AX-PROJECT-019",
        title: "Module Name Collision",
        description: "A hard-imported source module's name collides with an already-installed registry module of the same name.",
        source: "manifest",
        severity: "fatal",
    },
    BUNDLE_INVALID: {
        code: "AX-PROJECT-010",
        title: "Invalid Bundle Source",
        description: "The directory being bundled has no package.json, or its package.json has no name — every bundle needs a real package identity.",
        source: "manifest",
        severity: "fatal",
    },
    BUNDLE_TAR_MISSING: {
        code: "AX-PROJECT-020",
        title: "tar Not Found",
        description: "Bundling shells out to the system's tar binary, which isn't on PATH — install Git for Windows or use WSL on that platform.",
        source: "manifest",
        severity: "fatal",
    },
    BUNDLE_TAR_FAILED: {
        code: "AX-PROJECT-021",
        title: "tar Failed",
        description: "The tar subprocess exited non-zero while building a bundle archive.",
        source: "manifest",
        severity: "fatal",
    },

    // ── Bench (build/bench/*.ts) ────────────────────────────────────────────
    BENCH_RUN_NOT_FOUND: {
        code: "AX-BENCH-001",
        title: "Bench Run Not Found",
        description: "No recorded bench run exists with this id.",
        source: "bench",
        severity: "fatal",
        expected: true,
    },
    BENCH_NOT_FOUND: {
        code: "AX-BENCH-002",
        title: "Bench Not Found",
        description: "No bench.config.ts was found at this path — it isn't a recognized bench project.",
        source: "bench",
        severity: "fatal",
        expected: true,
    },
    BENCH_TESTS_NOT_FOUND: {
        code: "AX-BENCH-003",
        title: "Bench Test Files Not Found",
        description: "The bench config declares test files that don't exist on disk.",
        source: "bench",
        severity: "fatal",
        expected: true,
    },
    BENCH_LOCAL_REF_NOT_FOUND: {
        code: "AX-BENCH-004",
        title: "Bench Local Reference Not Found",
        description: "A factor variable references a local file/directory that doesn't exist.",
        source: "bench",
        severity: "fatal",
        expected: true,
    },
    BENCH_CONFIG_INVALID: {
        code: "AX-BENCH-005",
        title: "Bench Config Invalid",
        description: "bench.config.ts failed to evaluate or didn't produce a valid bench definition.",
        source: "bench",
        severity: "fatal",
    },
    BENCH_PACKAGE_NOT_FOUND: {
        code: "AX-BENCH-006",
        title: "Bench Package Not Found",
        description: "No package.json exists at the bench root — every bench project needs one for identity.",
        source: "bench",
        severity: "fatal",
        expected: true,
    },
    BENCH_PACKAGE_NAME_REQUIRED: {
        code: "AX-BENCH-007",
        title: "Bench Package Name Required",
        description: "The bench's package.json has no name field.",
        source: "bench",
        severity: "fatal",
        expected: true,
    },
    BENCH_PACKAGE_VERSION_REQUIRED: {
        code: "AX-BENCH-008",
        title: "Bench Package Version Required",
        description: "The bench's package.json has no version field.",
        source: "bench",
        severity: "fatal",
        expected: true,
    },
    BENCH_CONTEXT_MISSING: {
        code: "AX-BENCH-009",
        title: "Bench Context Missing",
        description: "The benchmark preload needs AXON_BENCH_CONTEXT set — it was run outside the bench harness.",
        source: "bench",
        severity: "fatal",
    },
    BENCH_NO_ACTIVE_CASE: {
        code: "AX-BENCH-010",
        title: "No Active Bench Case",
        description: "A bench emission (measurement, artifact) happened outside any running Bun test — these calls must occur inside a test case.",
        source: "bench",
        severity: "fatal",
    },
    BENCH_WORKSPACE_UNAVAILABLE: {
        code: "AX-BENCH-011",
        title: "Bench Workspace Unavailable",
        description: "The bench's workspace directory hasn't been materialized yet for this run.",
        source: "bench",
        severity: "fatal",
    },
    BENCH_AGENT_UNRESOLVED: {
        code: "AX-BENCH-012",
        title: "Bench Agent Unresolved",
        description: "The bench's declared subject agent isn't a prepared local agent — run `axon prepare` on it first.",
        source: "bench",
        severity: "fatal",
    },
    BENCH_MEASUREMENT_UNKNOWN: {
        code: "AX-BENCH-013",
        title: "Unknown Bench Measurement",
        description: "A measurement was emitted under an id the bench config never declared.",
        source: "bench",
        severity: "fatal",
    },
    BENCH_MEASUREMENT_TYPE: {
        code: "AX-BENCH-014",
        title: "Bench Measurement Type Mismatch",
        description: "A measurement's emitted value doesn't match the type its bench config declaration expects.",
        source: "bench",
        severity: "fatal",
    },
    BENCH_MEASUREMENT_DOMAIN: {
        code: "AX-BENCH-015",
        title: "Bench Measurement Out Of Domain",
        description: "A measurement's emitted value falls outside the range or category the bench config declares for it.",
        source: "bench",
        severity: "fatal",
    },
    BENCH_DIMENSION_UNKNOWN: {
        code: "AX-BENCH-016",
        title: "Unknown Bench Dimension",
        description: "A dimension value was set under an id the bench config never declared.",
        source: "bench",
        severity: "fatal",
    },
    BENCH_DIMENSION_DOMAIN: {
        code: "AX-BENCH-017",
        title: "Bench Dimension Out Of Domain",
        description: "A dimension's set value isn't one of the categories its bench config declares.",
        source: "bench",
        severity: "fatal",
    },
    BENCH_AXIS_UNKNOWN: {
        code: "AX-BENCH-018",
        title: "Unknown Bench Factor",
        description: "Something referenced a factor id the running bench's coordinate never assigned a value to.",
        source: "bench",
        severity: "fatal",
    },
    BENCH_ARTIFACT_UNKNOWN: {
        code: "AX-BENCH-019",
        title: "Unknown Bench Artifact",
        description: "An artifact was emitted under an id the bench config never declared.",
        source: "bench",
        severity: "fatal",
    },
    BENCH_ARTIFACT_MEDIA_TYPE: {
        code: "AX-BENCH-020",
        title: "Bench Artifact Media Type Not Allowed",
        description: "An artifact was emitted with a media type its bench config declaration doesn't allow.",
        source: "bench",
        severity: "fatal",
    },
    BENCH_SCHEMA_UNREADABLE: {
        code: "AX-BENCH-030",
        title: "Bench Schema Unreadable",
        description: "bench.config.ts could not be parsed while extracting the measurement schema.",
        source: "bench",
        severity: "fatal",
    },
    BENCH_SCHEMA_EMPTY: {
        code: "AX-BENCH-031",
        title: "Bench Schema Empty",
        description: "defineBench<Schema> was given a type with no properties — an empty schema and a failed extraction must never look alike.",
        source: "bench",
        severity: "fatal",
    },
    BENCH_SCHEMA_UNSUPPORTED_TYPE: {
        code: "AX-BENCH-032",
        title: "Bench Measurement Type Unsupported",
        description: "A measurement is not a boolean, number, union of string literals, or string.",
        source: "bench",
        severity: "fatal",
    },
    BENCH_SCHEMA_EXTRACTION_FAILED: {
        code: "AX-BENCH-033",
        title: "Bench Schema Extraction Failed",
        description: "The schema worker did not return a schema. Prepare fails rather than continuing with an empty one, which would silently make every measurement undeclared.",
        source: "bench",
        severity: "fatal",
    },
    BENCH_AXIS_NOT_FOUND: {
        code: "AX-BENCH-021",
        title: "Bench Axis Not Found",
        description: "The bench config's matrix has no axis with this key.",
        source: "bench",
        severity: "fatal",
        expected: true,
    },
    BENCH_AXIS_VALUE_NOT_FOUND: {
        code: "AX-BENCH-022",
        title: "Bench Axis Value Not Found",
        description: "The bench config's matrix axis has no declared value with this id.",
        source: "bench",
        severity: "fatal",
        expected: true,
    },
    BENCH_WORKSPACE_ESCAPE: {
        code: "AX-BENCH-023",
        title: "Bench Workspace Path Escapes Root",
        description: "A workspace source entry resolved to a path outside the workspace directory — refused rather than materialized.",
        source: "bench",
        severity: "fatal",
    },
    BENCH_WORKSPACE_SYMLINK_UNSUPPORTED: {
        code: "AX-BENCH-024",
        title: "Bench Workspace Symlinks Unsupported",
        description: "A workspace source contains a symlink — not supported when materializing a bench workspace.",
        source: "bench",
        severity: "fatal",
    },
    BENCH_WORKSPACE_OUTSIDE_ROOT: {
        code: "AX-BENCH-025",
        title: "Bench Template Outside Root",
        description: "A workspace template's declared source path resolves outside the bench project root.",
        source: "bench",
        severity: "fatal",
    },
    BENCH_WORKSPACE_SOURCE_NOT_FOUND: {
        code: "AX-BENCH-026",
        title: "Bench Template Not Found",
        description: "A workspace template's declared source path isn't a real directory.",
        source: "bench",
        severity: "fatal",
        expected: true,
    },
    BENCH_LOG_INVALID: {
        code: "AX-BENCH-027",
        title: "Bench Log Invalid",
        description: "A bench run's event log is missing an entry its projection requires — the log is incomplete or was written out of order.",
        source: "bench",
        severity: "fatal",
    },

    // ── Blueprint scan (scan/tools.ts, scan/config.ts) ──────────────────────
    TOOL_DECLARE_FAILED: {
        code: "AX-BLUEPRINT-002",
        title: "Tool Declaration Failed",
        description: "Compiling a src/tools/*.ts file's TypeScript declarations failed — the worker subprocess reported a compile error.",
        source: "manifest",
        severity: "fatal",
    },
    TOOL_BUNDLE_FAILED: {
        code: "AX-BLUEPRINT-006",
        title: "Tool Bundle Failed",
        description: "Bundling a src/tools/*.ts file to self-contained source failed — the bundler subprocess reported an error. Tools are bundled so the sandbox loads them without mounting the project; a bundle failure means the tool cannot enter the box.",
        source: "manifest",
        severity: "fatal",
    },
    ROUTE_LOAD_FAILED: {
        code: "AX-BLUEPRINT-007",
        title: "Route Load Failed",
        description: "A file in server/api/ could not be imported. The agent would serve an endpoint set that is not the declared one — a caller gets a 404 for a route whose file exists.",
        source: "manifest",
        severity: "fatal",
    },
    SCRIPT_LOAD_FAILED: {
        code: "AX-BLUEPRINT-008",
        title: "Script Load Failed",
        description: "A file in src/scripts/ could not be processed. `axon run <name>` would report the script as not found while its file sits in the project.",
        source: "manifest",
        severity: "fatal",
    },
    PLUGIN_LOAD_FAILED: {
        code: "AX-BLUEPRINT-009",
        title: "Plugin Load Failed",
        description: "A plugin could not be imported. Plugins wire server behaviour at boot; one silently missing means the agent runs without behaviour its author declared.",
        source: "manifest",
        severity: "fatal",
    },
    MIDDLEWARE_LOAD_FAILED: {
        code: "AX-BLUEPRINT-010",
        title: "Middleware Load Failed",
        description: "A middleware file could not be imported. Middleware commonly carries auth and validation, so a silently skipped one is a request path running without the checks its author wrote.",
        source: "manifest",
        severity: "fatal",
    },
    PROMPT_INTROSPECT_FAILED: {
        code: "AX-BLUEPRINT-011",
        title: "Prompt Introspection Failed",
        description: "A .vue prompt could not be introspected for its props. The prompt would render without the inputs it declares, or not at all.",
        source: "manifest",
        severity: "fatal",
    },
    CONFIG_NOT_FOUND: {
        code: "AX-BLUEPRINT-003",
        title: "Config Not Found",
        description: "No axon.config.ts exists at this path.",
        source: "manifest",
        severity: "fatal",
        expected: true,
    },
    CONFIG_LOAD_FAILED: {
        code: "AX-BLUEPRINT-004",
        title: "Config Failed To Load",
        description: "axon.config.ts threw or failed to evaluate — check the file for a syntax or runtime error.",
        source: "manifest",
        severity: "fatal",
    },
    CONFIG_INVALID: {
        code: "AX-BLUEPRINT-005",
        title: "Config Invalid",
        description: "axon.config.ts evaluated but never called defineAgent() — every agent config must produce one.",
        source: "manifest",
        severity: "fatal",
    },

    // ── Kernel (engine.ts / executor.ts) ─────────────────────────────────────
    ENGINE_NO_DONE: {
        code: "AX-KERNEL-001",
        title: "Engine Stream Ended Without Completing",
        description: "The model driver's stream ended without ever emitting a completion event — the engine likely disconnected or crashed mid-response.",
        source: "kernel",
        severity: "fatal",
    },
    /**
     * ── Engine failures the USER can act on ─────────────────────────────────
     *
     * Every one of these was previously a single `ENGINE_STREAM_FAILED`, which
     * put an internal code and a stack trace in front of someone whose real
     * problem was an expired key or a spent subscription. The drivers already
     * classify the fault precisely (AxonEngineFaultCode) and already write a
     * provider-specific sentence about it — that work was being thrown away one
     * layer up.
     *
     * These are `expected: true`, so they render as headline + description with
     * no frames: the user did not write the code that failed, and eighty lines
     * of our stack tells them to debug software they do not own. The driver's
     * own message rides in as `detail` and is the most specific thing on
     * screen ("Codex: usage limit reached. Check your ChatGPT subscription.").
     *
     * The split is one question: CAN THE USER FIX IT? If yes it belongs here.
     * If the model or the driver misbehaved, it stays ENGINE_STREAM_FAILED and
     * keeps the full report, because that one is ours to debug.
     */
    ENGINE_NOT_CONNECTED: {
        code: "AX-KERNEL-015",
        title: "Provider Not Connected",
        description: "This model's route is not connected to your account yet — run `:provider <name> connect` for the provider named below, or pick a model on a route you are already signed in to.",
        source: "kernel",
        severity: "fatal",
        expected: true,
    },
    ENGINE_AUTH_FAILED: {
        code: "AX-KERNEL-016",
        title: "Provider Rejected Your Credentials",
        description: "The provider refused the credential this agent is using — it has expired, been revoked, or is for a different account. Reconnect the provider, or pick a model on a route you are signed in to.",
        source: "kernel",
        severity: "fatal",
        expected: true,
    },
    ENGINE_RATE_LIMITED: {
        code: "AX-KERNEL-017",
        title: "Provider Rate Limit Reached",
        description: "The provider is refusing further calls right now — either too many requests in a short window, or a subscription whose allowance is spent. Waiting usually clears the first; the second needs a plan change or a different model.",
        source: "kernel",
        severity: "fatal",
        expected: true,
    },
    ENGINE_QUOTA_EXHAUSTED: {
        code: "AX-KERNEL-018",
        title: "Provider Credits Exhausted",
        description: "This route has no credit left to spend. Top it up, or switch to a model on a route that does — the conversation is intact either way.",
        source: "kernel",
        severity: "fatal",
        expected: true,
    },
    ENGINE_REQUEST_REJECTED: {
        code: "AX-KERNEL-019",
        title: "Provider Rejected The Request",
        description: "The provider refused this call as malformed or unsupported — commonly a model id it does not serve, a context window this conversation has outgrown, or a parameter that route does not accept.",
        source: "kernel",
        severity: "fatal",
        expected: true,
    },
    ENGINE_UNREACHABLE: {
        code: "AX-KERNEL-020",
        title: "Could Not Reach The Provider",
        description: "The provider could not be reached, or kept failing, across every retry — usually a network problem on this machine or an outage on their side. Nothing about this agent needs changing; try again.",
        source: "kernel",
        severity: "fatal",
        expected: true,
    },

    /**
     * The engine failure that is OURS.
     *
     * Deliberately NOT `expected`: what is left here after the classified
     * failures above is a model that returned nothing, a driver that broke the
     * wire protocol, or a fault nothing recognised. The user cannot act on any
     * of those, and the full report — frames, snippets, cause chain — is what
     * makes it debuggable from a pasted log.
     */
    ENGINE_STREAM_FAILED: {
        code: "AX-KERNEL-008",
        title: "Engine Stream Failed",
        description: "The model driver's stream failed and exhausted its retries (or the failure wasn't retryable) — see context for the provider's fault code.",
        source: "kernel",
        severity: "fatal",
    },
    /**
     * RETIRED — superseded by ENGINE_NOT_CONNECTED (AX-KERNEL-015).
     *
     * This was the one hand-written special case in the kernel's failure path:
     * `AUTH_NOT_CONNECTED` AND `provider === "codex"`. Every other provider hit
     * the generic internal error for the identical condition, and each new
     * route would have needed its own branch and its own code.
     *
     * ENGINE_NOT_CONNECTED says the same thing for any provider, with the
     * driver's own message naming which one. Kept as a definition rather than
     * deleted so AX-KERNEL-012 is never handed to a different failure — a code
     * that appears in an old session log, a support thread or a screenshot must
     * keep meaning what it meant when it was written.
     */
    CODEX_NOT_CONNECTED: {
        code: "AX-KERNEL-012",
        title: "Codex Subscription Not Connected",
        description: "This agent uses a Codex model, but your Axon account is not connected to ChatGPT — run :provider codex connect and try again.",
        source: "kernel",
        severity: "fatal",
        expected: true,
    },
    RUN_IN_PROGRESS: {
        code: "AX-KERNEL-002",
        title: "A Wake Is Already Running",
        description: "The kernel only executes one wake at a time — a new run was requested while the previous one was still active.",
        source: "kernel",
        severity: "recovered",
    },
    RUN_RESERVATION_EXPIRED: {
        code: "AX-KERNEL-003",
        title: "Wake Reservation Expired",
        description: "The reserved execution slot for this wake is no longer active — it was released before the run could start.",
        source: "kernel",
        severity: "fatal",
    },
    NO_COGNET_LOADED: {
        code: "AX-KERNEL-004",
        title: "No Cognet Loaded",
        description: "The kernel tried to execute a wake, but the blueprint carried no cognet definition to run it against.",
        source: "kernel",
        severity: "fatal",
    },
    SYSCALL_OUTSIDE_RUN: {
        code: "AX-KERNEL-005",
        title: "Syscall Outside An Active Run",
        description: "A kernel syscall (engine.stream and similar) was made with no active wake to attribute it to.",
        source: "kernel",
        severity: "fatal",
    },
    CAPSULE_ACCESSED_BEFORE_BOOT: {
        code: "AX-KERNEL-007",
        title: "Capsule Accessed Before Boot",
        description: "Something reached for the live capsule instance before boot() had run — there is no sandbox yet to hand back.",
        source: "kernel",
        severity: "fatal",
    },
    COGNET_EMIT_FORBIDDEN: {
        code: "AX-KERNEL-009",
        title: "Cognet Emit Forbidden",
        description: "A cognet tried to emit an event outside the cognet:* namespace — the ABI only lets a cognet narrate its own telemetry, never forge kernel machinery events.",
        source: "kernel",
        severity: "fatal",
    },
    KNOWLEDGE_NOT_FOUND: {
        code: "AX-KERNEL-011",
        title: "Knowledge Entry Not Found",
        description: "A cognet read a knowledge entry that does not exist. The knowledge store is not a cache — a brain reading something the catalogue advertised has hit a real inconsistency, so this is loud rather than an empty result.",
        source: "kernel",
        severity: "fatal",
        expected: true,
    },
    KNOWLEDGE_READONLY: {
        code: "AX-KERNEL-013",
        title: "Knowledge Entry Is Read-Only",
        description: "A cognet tried to write or remove knowledge contributed by a module. Module material lives inside its own package and the next install would destroy any change — so this fails loudly rather than succeeding and vanishing later. An agent's own data/knowledge/ is writable.",
        source: "kernel",
        severity: "fatal",
        expected: true,
    },
    KNOWLEDGE_RECORD_FAILED: {
        code: "AX-KERNEL-014",
        title: "Knowledge Mutation Went Unrecorded",
        description: "A knowledge write or remove succeeded on disk, but the session record of it could not be committed. The mutation is real and already visible to the agent; only its audit trail is missing, so this is reported rather than thrown — the caller cannot undo a completed write. It matters because 'the agent rewrote its own memory' is the fact you want weeks later when behaviour drifts, and here the ledger and the filesystem disagree.",
        source: "kernel",
        severity: "degraded",
    },
    KNOWLEDGE_ESCAPE: {
        // Was AX-KERNEL-012, which CODEX_NOT_CONNECTED already holds and which
        // is deliberately retained retired so that code keeps its original
        // meaning. Two entries sharing a code is exactly what that comment
        // warns against — a support thread quoting AX-KERNEL-012 could have
        // meant either a disconnected provider or a path traversal.
        code: "AX-KERNEL-021",
        title: "Knowledge Path Escapes Store",
        description: "A knowledge name resolved outside the store root. Names are identifiers, not paths — traversal is refused at the boundary rather than trusted not to happen.",
        source: "kernel",
        severity: "fatal",
    },
    SCHEDULER_MODE_MISMATCH: {
        code: "AX-KERNEL-010",
        title: "Scheduler Mode Mismatch",
        description: "A caller used the wrong wake verb for the cognet's mode: continuous cognets advance via tick(), driven by the body's clock; invocation cognets wake on a stimulus via request()/stream().",
        source: "kernel",
        severity: "fatal",
    },

    // ── Session (session.ts) ─────────────────────────────────────────────────
    THREAD_UNKNOWN_PARENT: {
        code: "AX-SESSION-001",
        title: "Thread Branched From Unknown Parent",
        description: "A thread's recorded lineage points at a parent thread id that isn't registered in this session — the session index is inconsistent.",
        source: "thread",
        severity: "fatal",
    },
    THREAD_NOT_FOUND: {
        code: "AX-SESSION-002",
        title: "Thread Not Found",
        description: "The requested thread id isn't registered in this session.",
        source: "thread",
        severity: "fatal",
        expected: true,
    },
    THREAD_BRANCH_UNKNOWN: {
        code: "AX-SESSION-003",
        title: "Cannot Branch Unknown Thread",
        description: "A branch was requested from a parent thread id that isn't registered in this session.",
        source: "thread",
        severity: "fatal",
    },
    SENSORY_WRITE_FAILED: {
        code: "AX-SESSION-004",
        title: "Sensory Ring Write Failed",
        description: "A dense sense entry (audio or visual) could not be written to the session's sensory ring — usually a full or read-only data directory. Delivery to the cognet is unaffected; the debug window for this session will have a gap.",
        source: "runtime",
        severity: "degraded",
    },

    // ── Blueprint ─────────────────────────────────────────────────────────────
    NO_COGNET: {
        code: "AX-BLUEPRINT-001",
        title: "No Cognet Declared",
        description: "The blueprint carries no cognet definition — an agent cannot run without a brain. The CLI or test harness must construct and pass one.",
        source: "runtime",
        severity: "fatal",
    },

    // ── Control channel ───────────────────────────────────────────────────────
    // The local socket between a running TUI and the Fleet extension. Both
    // ends dispatch by walking a property path against the handle the peer
    // exposed, so a bad path is the channel's characteristic failure.
    CONTROL_PATH_NOT_FOUND: {
        code: "AX-CONTROL-001",
        title: "Control Path Not Found",
        description: "A control-channel call named a method the peer does not expose. The two ends disagree about the surface — usually a TUI and an extension built from different versions.",
        source: "server",
        severity: "fatal",
        expected: true,
    },
    CONTROL_PATH_NOT_CALLABLE: {
        code: "AX-CONTROL-002",
        title: "Control Path Not Callable",
        description: "A control-channel call resolved to a value on the peer's handle that is not a function.",
        source: "server",
        severity: "fatal",
    },
    CONTROL_CALL_FAILED: {
        code: "AX-CONTROL-003",
        title: "Control Call Failed",
        description: "The peer served a control-channel call and it threw. The remote message is carried here — the failure surfaces at the local call site rather than being returned as a falsy value.",
        source: "server",
        severity: "fatal",
    },
    CONTROL_CLOSED: {
        code: "AX-CONTROL-004",
        title: "Control Channel Closed",
        description: "A control-channel call was made, or was still in flight, when the channel closed. In-flight calls reject on close rather than hanging forever on an answer that is no longer coming.",
        source: "server",
        severity: "fatal",
    },
    CONTROL_UNAUTHORIZED: {
        code: "AX-CONTROL-005",
        title: "Control Handshake Rejected",
        description: "A connection to the control socket presented a missing or incorrect token. The token lives in the instance record, which is readable only by the owning user — a mismatch means the caller is not the local Fleet extension.",
        source: "server",
        severity: "fatal",
    },

    // ── Server ────────────────────────────────────────────────────────────────
    PLUGIN_BOOT_FAILED: {
        code: "AX-SERVER-001",
        title: "Plugin Failed During Boot",
        description: "A server plugin threw while running at boot — plugins are the one place in server startup where a failure must abort the boot rather than being warned and skipped.",
        source: "server",
        severity: "fatal",
    },
    HANDLE_SHUTDOWN_FAILED: {
        code: "AX-RUNTIME-002",
        title: "Handle Failed To Shut Down",
        description: "One of the runtime's owned handles (kernel, etc.) threw during shutdown — teardown is error-isolated, so the others still ran, but this one didn't close cleanly.",
        source: "runtime",
        severity: "fatal",
    },
    BUS_HANDLER_FAILED: {
        code: "AX-RUNTIME-004",
        title: "Bus Handler Failed",
        description: "A handler subscribed to a runtime bus event threw. Handler failures are non-fatal by design — the remaining handlers still run — but they are recorded rather than swallowed, since plugins and modules register handlers and a silently-broken one is invisible rot.",
        source: "runtime",
        severity: "degraded",
    },
    TOOL_CALL_FAILED: {
        code: "AX-RUNTIME-003",
        title: "Tool Call Failed",
        description: "An axon.tools.<namespace>.<fn>() call from script-land completed with a non-ok result from the capsule — unwrapped here into a normal throw, since script-land expects the ordinary call/throw contract, not the kernel's own stable-result shape.",
        source: "runtime",
        severity: "fatal",
    },

    // ── Capsule (build/tools.ts) ─────────────────────────────────────────────
    CAPSULE_TOOL_TIMEOUT: {
        code: "AX-CAPSULE-001",
        title: "Tool Load Timed Out",
        description: "The sandbox never confirmed loading a declared tool within the timeout — it may be stuck on a slow import or the subprocess is unresponsive.",
        source: "capsule",
        severity: "fatal",
    },
    CAPSULE_TOOL_SCOPE_MISMATCH: {
        code: "AX-CAPSULE-002",
        title: "Tool Scope Mismatch",
        description: "A tool's declared exports don't match what it actually exported once loaded in the sandbox — the bundled source and its declaration have drifted apart.",
        source: "capsule",
        severity: "fatal",
    },
    CAPSULE_TOOL_FAILED: {
        code: "AX-CAPSULE-003",
        title: "Tool Failed To Load",
        description: "A declared tool failed to load into the sandbox — its source may be malformed, too large to import, or the subprocess exited before confirming.",
        source: "capsule",
        severity: "fatal",
    },
    AGENT_ENV_RESERVED: {
        code: "AX-CAPSULE-012",
        title: "Reserved Environment Variable",
        description: "An agent's .env sets a framework-owned variable the runtime controls (AGENT_ID, AXON_API_BASE and similar). These identify the agent to the platform, so overriding one locally would make the agent report itself as something it is not. The deploy path has always refused this; the local path now refuses it identically.",
        source: "capsule",
        severity: "fatal",
    },

    CAPSULE_NET_UNRESOLVED: {
        code: "AX-CAPSULE-010",
        title: "Network Policy Did Not Resolve",
        description: "A `net.allow` entry names a hostname that did not resolve to any address. Egress rules are installed as addresses, so an unresolvable name becomes no rule at all — a grant you believe you made and did not. The box refuses to boot rather than run with an allowlist quietly smaller than the one you wrote. Check the hostname, or use a literal address if the name is resolvable only from inside the box.",
        source: "capsule",
        severity: "fatal",
    },

    CAPSULE_NET_UNAVAILABLE: {
        code: "AX-CAPSULE-011",
        title: "Network Confinement Unavailable",
        description: "The policy declares a `net` allowlist, which needs a userspace network stack (slirp4netns) and nftables inside the box's namespace. One of them is missing on this host. Install slirp4netns and nftables, or drop the `net` block to run with no network at all — the box will not fall back to unfiltered egress.",
        source: "capsule",
        severity: "fatal",
    },

    CAPSULE_CONFINE_UNAVAILABLE: {
        code: "AX-CAPSULE-004",
        title: "OS Confinement Unavailable",
        description: "The policy requested OS confinement (isolation: auto) but the host is missing a required primitive (bubblewrap, systemd, nft, or the axon-agent user). Run `axon install`, or set isolation: none to opt out explicitly. The capsule refuses to boot rather than silently run unconfined.",
        source: "capsule",
        severity: "fatal",
    },
    CAPSULE_CONFINE_USER_UNRESOLVED: {
        code: "AX-CAPSULE-005",
        title: "Confinement User Unresolved",
        description: "The confinement user exists but its numeric uid/gid could not be read — the box cannot drop privileges without them. The host user database may be inconsistent.",
        source: "capsule",
        severity: "fatal",
    },
    CAPSULE_BOOT_FAILED: {
        code: "AX-CAPSULE-006",
        title: "Capsule Failed To Boot",
        description: "The sandbox subprocess exited or reported failure before completing the boot handshake. The captured stderr in the error context is the real cause — most often a confinement mount that could not be satisfied (a declared fs path that does not exist) or a runtime that could not start.",
        source: "capsule",
        severity: "fatal",
    },
    CAPSULE_BOOT_TIMEOUT: {
        code: "AX-CAPSULE-007",
        title: "Capsule Boot Timed Out",
        description: "The sandbox subprocess did not report ready within the boot timeout. Its captured stderr is in the error context; if empty, the subprocess may be hung rather than crashed.",
        source: "capsule",
        severity: "fatal",
    },
    CAPSULE_SPAWN_FAILED: {
        code: "AX-CAPSULE-008",
        title: "Capsule Spawn Failed",
        description: "The capsule subprocess command could not be spawned at all — the interpreter or confinement wrapper was not found, or PATH is unset. Check that bun (and, under confinement, bwrap/systemd-run) are on PATH.",
        source: "capsule",
        severity: "fatal",
    },
    CAPSULE_WIRE_CLOSED: {
        code: "AX-CAPSULE-009",
        title: "Capsule Wire Closed",
        description: "A command was sent to the sandbox after its stdin pipe was gone — the subprocess has exited or is mid-teardown. The caller is racing the capsule lifecycle.",
        source: "capsule",
        severity: "fatal",
    },
    CAPSULE_DOWN: {
        code: "AX-CAPSULE-023",
        title: "No Live Capsule",
        description: "An operation needed a running sandbox subprocess, but none is live — it is booting, restarting after a crash, or has been declared dead.",
        source: "capsule",
        severity: "fatal",
    },
    CAPSULE_ALREADY_BOOTED: {
        code: "AX-CAPSULE-024",
        title: "Capsule Already Booted",
        description: "boot() was called on a capsule that already has a live subprocess. Boot is once per lifetime; use update()/reload() to replace a running incarnation.",
        source: "capsule",
        severity: "fatal",
    },
    CAPSULE_INSTALL_FAILED: {
        code: "AX-CAPSULE-013",
        title: "Confinement Install Failed",
        description: "Provisioning the host for the hardened confinement tier failed — most often because creating the dedicated system user needs root. Re-run `axon install` with sufficient privilege.",
        source: "capsule",
        severity: "fatal",
    },
    CAPSULE_HOST_UNAVAILABLE: {
        code: "AX-CAPSULE-014",
        title: "Host Bridge Unavailable",
        description: "Sandboxed code called a host service, but this capsule was built with no host provider. Host calls require a wired host bridge on the manager side.",
        source: "capsule",
        severity: "fatal",
    },
    CAPSULE_CRASHED: {
        code: "AX-CAPSULE-015",
        title: "Capsule Crashed",
        description: "An unhandled error escaped inside the sandbox subprocess. The capsule reports it on the wire and exits immediately — after an unhandled throw the sandbox's state is unknown, and a capsule that keeps serving is worse than one that dies loudly.",
        source: "capsule",
        severity: "fatal",
    },
    CAPSULE_DEAD: {
        code: "AX-CAPSULE-016",
        title: "Capsule Dead",
        description: "The capsule subprocess is gone and supervision gave up restarting it. Every subsequent execution request fails until a new capsule is booted.",
        source: "capsule",
        severity: "fatal",
    },
    CAPSULE_PARSE_ERROR: {
        code: "AX-CAPSULE-017",
        title: "Capsule Wire Parse Error",
        description: "A line arriving from the sandbox was not a valid protocol event. The sandbox is speaking garbage — a protocol mismatch or corrupted output — and the line is dropped rather than acted on, never silently.",
        source: "capsule",
        severity: "degraded",
    },
    CAPSULE_CMD_FAILED: {
        code: "AX-CAPSULE-018",
        title: "Capsule Command Failed",
        description: "Code executed in the sandbox threw. This is the ordinary failure path for an agent-emitted block or a script-land run() — the error is the sandboxed code's own, surfaced verbatim.",
        source: "capsule",
        severity: "degraded",
    },
    CAPSULE_FN_FAILED: {
        code: "AX-CAPSULE-019",
        title: "Tool Call Threw",
        description: "A mediated tool function threw inside the sandbox. The failure is the tool's own; it propagates to the calling code unchanged and is recorded as the closing half of the call's span.",
        source: "capsule",
        severity: "degraded",
    },
    CAPSULE_PROC_DENIED: {
        code: "AX-CAPSULE-020",
        title: "Process Spawn Denied",
        description: "A process the sandbox tried to start was refused — denied by policy, killed before it could spawn, or the spawn itself failed. No process was created.",
        source: "capsule",
        severity: "degraded",
    },
    CAPSULE_PROC_FAILED: {
        code: "AX-CAPSULE-022",
        title: "Managed Process Failed",
        description: "A spawned child process errored without ever producing an exit code — an exec failure or a broken IPC channel. Distinct from a non-zero exit, which is the process running correctly and reporting a result.",
        source: "capsule",
        severity: "degraded",
    },
    CAPSULE_PROC_STDIN_FAILED: {
        code: "AX-CAPSULE-021",
        title: "Process Stdin Write Failed",
        description: "Writing to a managed child process's stdin failed — the process is no longer running, or its stdin has already closed.",
        source: "capsule",
        severity: "degraded",
    },

    // ── TUI (useAgents.ts / platform/build/runtime / platform/store / platform/services/cloud) ──
    NOT_BOOTED: {
        code: "AX-TUI-001",
        title: "No Agent Running",
        description: "A message was sent, or an action requiring a live agent was taken, before any agent finished booting.",
        source: "tui",
        severity: "fatal",
    },
    NOT_AUTHENTICATED: {
        code: "AX-TUI-002",
        title: "Not Logged In",
        description: "The action needs an active profile, but none is logged in yet.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    PROFILE_NOT_AUTHENTICATED: {
        code: "AX-TUI-003",
        title: "Profile Has No Session",
        description: "The target profile exists but has no stored session — it has never logged in, or its session was cleared.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    BACKEND_UNREACHABLE: {
        code: "AX-TUI-044",
        title: "Backend Unreachable",
        description: "A stored credential could not be verified because the backend could not be reached. The credential is NOT discarded — it may be perfectly valid — but it cannot be trusted until it is checked, so the action is refused rather than proceeding unverified.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    PROFILE_UNKNOWN: {
        code: "AX-TUI-004",
        title: "Unknown Profile",
        description: "The requested profile id isn't one of the profiles stored on this machine.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    SESSION_NOT_FOUND: {
        code: "AX-SESSION-005",
        title: "Session Not Found",
        description: "No session log exists at that path. A session is a .jsonl file under the agent's frame (`.agent/data/sessions/`); it may have been deleted, or belong to an agent that has since been removed.",
        source: "runtime",
        severity: "fatal",
        expected: true,
    },
    SESSION_UNREADABLE: {
        code: "AX-SESSION-006",
        title: "Session Log Unreadable",
        description: "The session log does not begin with a `session:header` line, so it cannot be forked or renamed. Either the file is truncated, or it was written by a version predating the header — an older log can still be read and resumed, just not copied.",
        source: "runtime",
        severity: "fatal",
        expected: true,
    },
    SESSION_ALREADY_RUNNING: {
        code: "AX-TUI-005",
        title: "Session Is Already Running",
        description: "spawn() was asked to resume a session that already has a live instance. Focus the running instance instead of booting a second runtime over the same log.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    SESSION_NOT_RUNNING: {
        code: "AX-TUI-016",
        title: "Session Is Not Running",
        description: "focus() was pointed at a sessionId with no live instance behind it. Spawn (or resume) it first — focus is pure selection over running instances.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    NO_ACTIVE_AGENT: {
        code: "AX-TUI-045",
        title: "No Active Agent",
        description: "The action needs a running agent, but none is active — start one first.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    NO_LOCAL_PROJECT: {
        code: "AX-TUI-050",
        title: "No Local Project",
        description: "This agent has no project directory on this machine — it was attached over the network, so its source lives wherever it is running. Opening its config, or any other file verb, has to happen there. Focus a local agent instead.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    NO_FOCUSED_INSTANCE: {
        code: "AX-TUI-017",
        title: "No Focused Agent Instance",
        description: "A module install/uninstall was requested with no running agent instance focused — spawn or focus one first.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    MODEL_UNAVAILABLE: {
        code: "AX-TUI-051",
        title: "Model Not Available From Any Declared Provider",
        description: "The picked model was saved to the agent's config, but no provider this profile declares can supply it — so the running agent still uses its previous model. Connect the provider that serves it, or pick a model from the offered list.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    MODEL_IMMUTABLE_DEPLOYED: {
        code: "AX-TUI-006",
        title: "Cannot Change A Deployment's Model",
        description: "A deployed agent's config lives in the cloud, not on this machine — its model is fixed at deploy time. Change it in the local project and deploy again.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    MODULE_INSTALL_FAILED: {
        code: "AX-TUI-018",
        title: "Module Install Failed",
        description: "The registry installer returned an error for this module specifier — check the specifier and registry connectivity.",
        source: "tui",
        severity: "fatal",
    },
    NO_MODULES_INSTALLED: {
        code: "AX-TUI-019",
        title: "No Modules Installed",
        description: "The `:module uninstall` command was opened with no modules resolved into the focused instance's blueprint.",
        source: "tui",
        severity: "fatal",
    },
    SETTINGS_NOT_WRITABLE: {
        code: "AX-EXT-027",
        title: "Settings Cannot Be Written",
        description: "A settings change was requested on a store with no profile config behind it — nobody is logged in, or this Store was built without one (tests). Settings live in `profile.config.ts`, so there is nowhere to write them; the change was refused rather than saved somewhere nothing reads back.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    REGISTRY_EMPTY: {
        code: "AX-TUI-047",
        title: "Nothing To Install",
        description: "The install palette was opened with no rows to show — the catalogue is still loading, the registry could not be reached, or everything published for that kind is already installed. The row itself says which.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    NO_EXTENSIONS_INSTALLED: {
        code: "AX-TUI-046",
        title: "No Extensions Installed",
        description: "The `:ext uninstall` command was opened with no extensions declared in the active profile's profile.config.ts.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    ATTACH_URL_REQUIRED: {
        code: "AX-TUI-048",
        title: "Attach URL Required",
        description: "`:attach` needs the address of a running agent — e.g. `:attach http://localhost:3010`. The agent must already be serving; attach binds to it and never boots anything.",
        source: "tui",
        severity: "fatal",
    },
    AGENT_NAME_REQUIRED: {
        code: "AX-CLI-001",
        title: "A Name Is Required",
        description: "Scaffolding a project needs a name — it becomes the directory and the package name.",
        source: "cli",
        severity: "fatal",
        expected: true,
    },
    MODULE_SPECIFIER_REQUIRED: {
        code: "AX-CLI-002",
        title: "A Module Name Is Required",
        description: "The command needs at least one module to act on, named as a scoped registry package.",
        source: "cli",
        severity: "fatal",
        expected: true,
    },
    FLAG_VALUE_REQUIRED: {
        code: "AX-CLI-007",
        title: "A Flag Is Missing Its Value",
        description: "The flag takes a value and none followed it. Quote the value if it contains spaces, and check it was not consumed as another flag.",
        source: "cli",
        severity: "fatal",
        expected: true,
    },
    RUN_INSTRUCTION_REQUIRED: {
        code: "AX-CLI-006",
        title: "Nothing To Run",
        description: "The agent was named but not told what to do. A reference on its own opens the terminal on that agent; giving it work needs an instruction, a declared prompt, or a script.",
        source: "cli",
        severity: "fatal",
        expected: true,
    },
    BENCH_RUN_ID_REQUIRED: {
        code: "AX-CLI-003",
        title: "A Run Id Is Required",
        description: "Reading a benchmark result needs the id of the run to read.",
        source: "cli",
        severity: "fatal",
        expected: true,
    },
    PROFILE_INCOMPLETE: {
        code: "AX-CLI-004",
        title: "Profile Is Missing Its Identity",
        description: "Credentials are stored for this profile but no identity is, so there is nothing to report. Logging out and back in rewrites both.",
        source: "cli",
        severity: "fatal",
        expected: true,
    },
    BUNDLE_KIND_MISMATCH: {
        code: "AX-CLI-005",
        title: "Wrong Bundle Kind",
        description: "The bundler produced an artifact of a different kind than the command expected. This is a wiring fault in our own code, not something a project can cause.",
        source: "cli",
        severity: "fatal",
    },
    ATTACH_UNREACHABLE: {
        code: "AX-TUI-052",
        title: "Agent Not Reachable",
        description: "Nothing answered at that address. The agent may not be running, may be on a different port, or may be behind something that refused the connection. `axon dev` prints the address it bound to.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    ATTACH_URL_INVALID: {
        code: "AX-TUI-049",
        title: "Attach URL Invalid",
        description: "The address is not a usable agent URL. An agent is reached over http or https and the scheme is required — `localhost:3010` is a path, `http://localhost:3010` is an address. Checked before anything connects, so a typo fails immediately rather than as a transport error.",
        source: "tui",
        severity: "fatal",
    },
    DEPLOYMENT_NOT_CONNECTABLE: {
        code: "AX-TUI-028",
        title: "Deployment Not Connectable",
        description: "The deployment is not in the connectable list — it may have stopped, errored, or never finished provisioning. Refresh the deployment list and try again.",
        source: "tui",
        severity: "fatal",
    },
    SUBAGENT_REMOTE_PARENT: {
        code: "AX-TUI-027",
        title: "Cannot Spawn A Subagent From A Deployment",
        description: "A subagent is forked from its parent's local project, and an attached deployment has no local project here — the deployed agent runs its own subagents inside its own capsule.",
        source: "tui",
        severity: "fatal",
    },
    BASE_MODEL_INSTANCE_CONFLICT: {
        code: "AX-TUI-026",
        title: "Managed Model Instance Already Running",
        description: "A managed base instance is already running on a different engine. The base workspace holds one shared config, so spawning a second naked model would rewrite it underneath the live instance — close the running one first.",
        source: "tui",
        severity: "fatal",
    },
    NOT_WIRED: {
        code: "AX-TUI-008",
        title: "Not Wired Yet",
        description: "This surface is a declared stub — the real implementation hasn't been built yet.",
        source: "tui",
        severity: "fatal",
    },
    MIC_ALREADY_CAPTURING: {
        code: "AX-TUI-009",
        title: "Mic Already Capturing",
        description: "capture.start() was called while a capture was already in progress — stop the current one first.",
        source: "tui",
        severity: "fatal",
    },
    MIC_CAPTURE_UNAVAILABLE: {
        code: "AX-TUI-010",
        title: "No Audio Capture Tool Found",
        description: "Voice input needs one of arecord, sox, or ffmpeg installed and on PATH.",
        source: "tui",
        severity: "fatal",
    },
    MIC_FFT_SIZE_MISMATCH: {
        code: "AX-TUI-014",
        title: "FFT Sample Size Mismatch",
        description: "computeBuckets() was called with a sample buffer that isn't exactly config.fftSize long — an internal invariant, callers must pad/trim first.",
        source: "tui",
        severity: "fatal",
    },
    MIC_CAPTURE_FAILED: {
        code: "AX-TUI-015",
        title: "Mic Capture Failed",
        description: "The audio capture subprocess produced no output or exited immediately — check that a microphone is available.",
        source: "tui",
        severity: "fatal",
    },
    WATCH_PATH_REQUIRED: {
        code: "AX-TUI-021",
        title: "Watch Path Required",
        description: "`axon watch`/`axon unwatch` need a directory argument.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    WATCH_PATH_NOT_FOUND: {
        code: "AX-TUI-022",
        title: "Watch Path Not Found",
        description: "`axon watch` was given a directory that doesn't exist on disk.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    EDITOR_NOT_SET: {
        code: "AX-TUI-023",
        title: "No Editor Configured",
        description: "`axon settings` needs the $EDITOR environment variable set to know which editor to open.",
        source: "tui",
        severity: "fatal",
    },
    EDITOR_LAUNCH_FAILED: {
        code: "AX-TUI-024",
        title: "Editor Failed To Launch",
        description: "The command in $EDITOR could not be spawned — check that it's installed and on PATH.",
        source: "tui",
        severity: "fatal",
    },
    WATCH_AND_INIT_ARGS_REQUIRED: {
        code: "AX-TUI-025",
        title: "Directory And Name Required",
        description: "The init palette's \"watch a new directory\" entry needs both a directory path and an agent name, space-separated.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },

    // ── Module boot-time execution (core runs defineModule setup) ────────────
    MODULE_CONFIG_LOAD_FAILED: {
        code: "AX-MODULE-001",
        title: "Module Config Failed To Load",
        description: "The runtime could not import a module's module.config.ts at boot — the file is missing at its resolved path, or importing it threw. A module that cannot load contributes nothing, so boot fails rather than run a partially-wired agent.",
        source: "runtime",
        severity: "fatal",
    },
    MODULE_SOURCE_DECLARED: {
        code: "AX-MODULE-008",
        title: "Module Declared As Source",
        description: "Uninstall was asked to remove a module that axon.config.ts declares as an IMPORT rather than by registry name. The import statement is the author's own code, so uninstall does not rewrite it — and removing the dependency alone would leave the config importing a package that is no longer declared, with the agent still loading it. Nothing was changed: delete the import and its entry in modules: [...] by hand.",
        source: "cli",
        severity: "fatal",
    },
    MODULE_NOT_INSTALLED: {
        code: "AX-MODULE-003",
        title: "Module Not Installed",
        description: "A plugin asked for the options of a module this agent does not have installed — almost always a name mismatch between the plugin and the module that ships it. Reported rather than defaulted: handing back an empty options bag would let a hardware module open the wrong device and never say so.",
        source: "runtime",
        severity: "fatal",
    },
    MODULE_OPTIONS_INVALID: {
        code: "AX-MODULE-002",
        title: "Invalid Module Options",
        description: "The options declared for a module under modules.<name> in axon.config.ts do not satisfy the module's options schema — a required option is missing or a value has the wrong type.",
        source: "runtime",
        severity: "fatal",
    },
    MODULE_SETUP_FAILED: {
        code: "AX-MODULE-007",
        title: "Module Setup Failed",
        description: "A module's setup() threw during agent boot. Setup runs sequentially in blueprint order and a failure is total — no later module is wired, and the agent does not boot half-configured.",
        source: "runtime",
        severity: "fatal",
    },
    MODULE_SERVER_NOT_WIRED: {
        code: "AX-MODULE-004",
        title: "Module Server API Not Wired",
        description: "A module's setup() called ctx.server.addRoute/addMiddleware or ctx.tools.get, but that surface is not implemented yet. Declare routes as server/api/ files in the module instead.",
        source: "runtime",
        severity: "fatal",
    },
    MODULE_ENV_REQUIRED: {
        code: "AX-MODULE-005",
        title: "Module Env Var Missing",
        description: "A module's setup() called ctx.env.require() for a variable the agent's resolved environment does not provide. The module declares required env in module.config.ts; the agent must supply it (e.g. in .env).",
        source: "runtime",
        severity: "fatal",
        expected: true,
    },
    MODULE_POLICY_IMMUTABLE: {
        code: "AX-MODULE-006",
        title: "Module Policy Is Immutable At Boot",
        description: "A module's setup() called ctx.policy.update(). The resolved agent policy is authoritative and cannot be mutated at boot — declare policy needs statically in module.config.ts so the CLI reconciles them at install.",
        source: "runtime",
        severity: "fatal",
        expected: true,
    },

    // ── Registry retrieval (build/registry.ts) ──────────────────────────────
    CLONE_REF_REQUIRED: {
        code: "AX-PROJECT-022",
        title: "No Artifact Named",
        description: "`axon clone` was run without an artifact to clone. Name one, for example: axon clone @axon/arxiv",
        source: "cli",
        severity: "fatal",
        expected: true,
    },
    FORK_REF_REQUIRED: {
        code: "AX-PROJECT-023",
        title: "No Artifact Named",
        description: "`axon fork` was run without an artifact to fork. Name one, for example: axon fork @axon/arxiv --as @you/arxiv",
        source: "cli",
        severity: "fatal",
    },
    FORK_NAME_REQUIRED: {
        code: "AX-PROJECT-024",
        title: "Fork Needs A New Name",
        description: "A fork is published under your own namespace, so it needs a name: pass --as <package-name>, for example: axon fork @axon/arxiv --as @you/arxiv",
        source: "cli",
        severity: "fatal",
    },
    CLONE_TARGET_EXISTS: {
        code: "AX-PROJECT-025",
        title: "Clone Target Not Empty",
        description: "The directory the artifact would be cloned into already has files in it. Clone into a new directory, or clear this one first.",
        source: "cli",
        severity: "fatal",
    },
    ARTIFACT_DOWNLOAD_FAILED: {
        code: "AX-PROJECT-026",
        title: "Artifact Download Failed",
        description: "The registry did not serve the artifact's source archive. The version may have been unpublished, or the network request failed.",
        source: "cli",
        severity: "fatal",
    },
    ARTIFACT_EXTRACT_FAILED: {
        code: "AX-PROJECT-027",
        title: "Artifact Extract Failed",
        description: "The downloaded archive could not be unpacked. It may be truncated, or `tar` is unavailable on this machine.",
        source: "cli",
        severity: "fatal",
    },

    // ── Project frame (build/project/) ──────────────────────────────────────
    VERSION_INVALID: {
        code: "AX-PROJECT-028",
        title: "Invalid Version",
        description: "The project's package.json version is not valid semver, so the next version cannot be derived from it. Fix the version field by hand.",
        source: "cli",
        severity: "fatal",
    },
    FRAMEWORK_NOT_INSTALLED: {
        code: "AX-PROJECT-029",
        title: "Framework Packages Not Installed",
        description: "The generated type frame references @arcforge/types, @arcforge/engines and h3, none of which resolve from this project. Run `bun install` before `axon prepare`.",
        source: "cli",
        severity: "fatal",
    },
    FRAME_MIGRATION_CONFLICT: {
        code: "AX-PROJECT-034",
        title: "Frame Migration Cannot Proceed Safely",
        description: "Runtime output exists in BOTH the old location and the new one, so migrating would have to merge or overwrite two sets of session history. Nothing was moved. Inspect both directories and remove or merge them by hand.",
        source: "cli",
        severity: "fatal",
    },
    CONFIG_EVALUATION_ESCAPED: {
        code: "AX-PROJECT-030",
        title: "defineAgent() Called Outside Config Evaluation",
        description: "defineAgent() ran outside the loader that evaluates axon.config.ts — it is a declaration helper, not a runtime function, and cannot be called from application code.",
        source: "cli",
        severity: "fatal",
    },
    PROMPT_NOT_INSTALLABLE: {
        code: "AX-PROJECT-044",
        title: "Prompts Are Not Installed Into Agents",
        description: "A prompt is content, not a capability: it resolves from the global cache and renders on demand, so every agent can already use it without declaring anything. Installing one into an agent would put content through the code path — an ABI check, a node_modules link, an agent reload — for something that needs none of it.",
        source: "manifest",
        severity: "fatal",
    },
    // ── README assets (build/project/bundle/assets.ts) ──────────────────────
    ASSET_TYPE_REFUSED: {
        code: "AX-PROJECT-045",
        title: "Unsupported Asset Type",
        description: "A file in assets/ is not a type the registry serves. Images (png, jpg, jpeg, webp, gif) and video (mp4, webm, mov) are accepted. SVG is deliberately refused: it is an executable document that would be served from our own storage origin, so a published SVG is a script-injection surface for every visitor reading that README.",
        source: "manifest",
        severity: "fatal",
        expected: true,
    },
    ASSET_TOO_LARGE: {
        code: "AX-PROJECT-046",
        title: "Asset Exceeds Size Limit",
        description: "A single file in assets/ is over the per-asset limit. Assets exist to illustrate a README, not to distribute media — compress the file or link to it externally.",
        source: "manifest",
        severity: "fatal",
        expected: true,
    },
    ASSETS_BUDGET_EXCEEDED: {
        code: "AX-PROJECT-040",
        title: "Assets Exceed Total Budget",
        description: "The assets/ folder as a whole is over budget for one published version. Every version stores its own copy of every asset, so the total is what determines how much a package costs to host forever.",
        source: "manifest",
        severity: "fatal",
        expected: true,
    },
    ASSET_PATH_INVALID: {
        code: "AX-PROJECT-041",
        title: "Unsafe Asset Path",
        description: "An entry under assets/ is a symlink, or its name escapes the assets directory. Both are refused: a published asset must be a real file that lands where its name says it does, or extraction on the server could write outside the target directory.",
        source: "manifest",
        severity: "fatal",
        expected: true,
    },
    ASSET_UNREADABLE: {
        code: "AX-PROJECT-042",
        title: "Asset Could Not Be Processed",
        description: "A file in assets/ has an image extension but could not be decoded, so it is either corrupt or not the format its name claims. Publishing it would ship a broken image into a README.",
        source: "manifest",
        severity: "fatal",
        expected: true,
    },
    PORT_UNAVAILABLE: {
        code: "AX-PROJECT-031",
        title: "No Free Port",
        description: "Every port in the range the agent scanned is already in use. Stop whatever is holding them, or start the agent on a different port.",
        source: "cli",
        severity: "fatal",
    },

    // ── Subagents (build/agent/agents.ts) ───────────────────────────────────
    PARENT_INSTANCE_NOT_RUNNING: {
        code: "AX-RUNTIME-005",
        title: "Parent Agent Not Running",
        description: "A subagent was requested against a parent session that is no longer live — the parent shut down, crashed, or was never booted by this process.",
        source: "runtime",
        severity: "fatal",
    },
    SUBAGENT_DEPTH_EXCEEDED: {
        code: "AX-RUNTIME-006",
        title: "Subagent Depth Limit Reached",
        description: "An agent tried to spawn a subagent beyond the maximum nesting depth. The limit exists so a recursive delegation cannot spawn processes without bound.",
        source: "runtime",
        severity: "fatal",
    },
    SUBAGENT_CHILD_LIMIT_EXCEEDED: {
        code: "AX-RUNTIME-007",
        title: "Subagent Child Limit Reached",
        description: "One agent tried to hold more live children than the limit allows. Existing children must finish before more can be spawned.",
        source: "runtime",
        severity: "fatal",
    },
    SUBAGENT_DESCENDANT_LIMIT_EXCEEDED: {
        code: "AX-RUNTIME-008",
        title: "Subagent Descendant Limit Reached",
        description: "The whole subagent tree beneath one root exceeded its live-descendant budget. The limit bounds total concurrent processes, not just direct children.",
        source: "runtime",
        severity: "fatal",
    },
    SUBAGENT_REQUEST_INVALID: {
        code: "AX-RUNTIME-009",
        title: "Malformed Subagent Request",
        description: "A subagent request did not carry a usable prompt. It must be an object with `prompt` as a string or an array of strings.",
        source: "runtime",
        severity: "fatal",
    },
    INSTANCE_NOT_LOCAL: {
        code: "AX-RUNTIME-010",
        title: "Agent Instance Is Not Local",
        description: "An operation that only works against a locally booted agent was given a remote one. Subagent spawning and the managed base workspace both require a local process.",
        source: "runtime",
        severity: "fatal",
    },
    HOST_METHOD_UNKNOWN: {
        code: "AX-RUNTIME-011",
        title: "Unknown Host Method",
        description: "A booted agent called a host method this platform does not implement. The agent's framework version is likely newer than the CLI running it.",
        source: "runtime",
        severity: "fatal",
    },

    // ── Self-update (update/) ───────────────────────────────────────────────
    UPDATE_CURRENT_VERSION_INVALID: {
        code: "AX-TUI-029",
        title: "Running Version Is Not Semver",
        description: "The version this app reports for itself is not valid semver, so it cannot be compared against the latest release.",
        source: "cli",
        severity: "fatal",
    },
    UPDATE_RELEASE_INVALID: {
        code: "AX-TUI-030",
        title: "Malformed Release Record",
        description: "The backend's release record did not describe a valid @arcforge/axon `latest` version, so there is nothing safe to update to.",
        source: "cli",
        severity: "fatal",
    },
    UPDATE_UNAVAILABLE_IN_DEVELOPMENT: {
        code: "AX-TUI-031",
        title: "Update Not Available Here",
        description: "Self-update needs the packaged update helper and a supervisor request path, neither of which exists in a source checkout. Update the installed app instead.",
        source: "cli",
        severity: "fatal",
    },
    UPDATE_SUPERVISOR_UNAVAILABLE: {
        code: "AX-TUI-032",
        title: "Update Supervisor Unavailable",
        description: "The running app has no supervisor request path, so it cannot hand an update off to be applied after exit.",
        source: "cli",
        severity: "fatal",
    },
    UPDATE_HELPER_ARGS_INVALID: {
        code: "AX-TUI-033",
        title: "Malformed Update Helper Arguments",
        description: "The update helper was invoked without the --from/--to/--bun/--axon/--state arguments it requires. It is spawned by the app, not run by hand.",
        source: "cli",
        severity: "fatal",
    },
    UPDATE_HELPER_VERSION_INVALID: {
        code: "AX-TUI-034",
        title: "Update Helper Given Bad Versions",
        description: "The update helper received a --from or --to value that is not valid semver, so it refused to install anything.",
        source: "cli",
        severity: "fatal",
    },

    // ── Test runner (test/) ─────────────────────────────────────────────────
    TEST_FILES_NOT_FOUND: {
        code: "AX-TUI-035",
        title: "No Test Files Matched",
        description: "No files matched the requested test patterns, so there was nothing to run. Check the pattern, or the directory it was resolved against.",
        source: "cli",
        severity: "fatal",
    },
    // ── Ollama (services/ollama/) ───────────────────────────────────────────
    OLLAMA_UNAVAILABLE: {
        code: "AX-TUI-037",
        title: "Ollama Is Not Running",
        description: "No Ollama daemon answered on this machine. Start it with `ollama serve`, or install Ollama from https://ollama.com to run models locally.",
        source: "cli",
        severity: "fatal",
    },
    OLLAMA_REQUEST_FAILED: {
        code: "AX-TUI-038",
        title: "Ollama Request Failed",
        description: "The local Ollama daemon is running but refused a request — most often an unknown model name. The daemon's own message is included.",
        source: "cli",
        severity: "fatal",
    },
    OLLAMA_REGISTRY_UNREACHABLE: {
        code: "AX-TUI-039",
        title: "Ollama Registry Unreachable",
        description: "Could not reach the Ollama model registry to look a model up. Downloading needs a network connection; models already on disk still work offline.",
        source: "cli",
        severity: "fatal",
    },
    NO_EDITOR_ATTACHED: {
        code: "AX-TUI-042",
        title: "No Editor Attached",
        description: "Opening a pane hands it to a connected editor, and none is listening. Open this project in an editor running the Axon Fleet extension — it dials each running TUI itself, so the connection appears on its own once the window is up.",
        source: "tui",
        severity: "fatal",
    },
    NO_SESSION_TO_OPEN: {
        code: "AX-TUI-043",
        title: "No Session To Open",
        description: "A runtime pane is a view of one conversation, and no agent is focused yet — so there is nothing to point it at. Start or focus an agent first.",
        source: "tui",
        severity: "fatal",
    },
    CLEAR_IMMUTABLE_DEPLOYED: {
        code: "AX-TUI-041",
        title: "Cannot Clear A Deployment's Conversation",
        description: "A deployed agent owns its own session in the cloud — the TUI attaches to whatever session it is already running, so there is no fresh one to start from here. Use `:close` to detach, or clear it on a local instance of the same agent.",
        source: "tui",
        severity: "fatal",
    },
    OLLAMA_PULL_FAILED: {
        code: "AX-TUI-040",
        title: "Model Download Failed",
        description: "Ollama could not finish downloading the model. The name may not exist in the registry, or the transfer was interrupted — a retry resumes from whatever was already fetched.",
        source: "cli",
        severity: "fatal",
    },

    TEST_PRELOAD_MISSING: {
        code: "AX-TUI-036",
        title: "Test API Loaded Without Its Preload",
        description: "The instrumented test API was imported without the preload that installs it. Tests must run through `axon test`, which wires the preload.",
        source: "cli",
        severity: "fatal",
    },

    // ── Extensions ──────────────────────────────────────────────────────────
    //
    // The TUI config surface: a profile's main.ts and plugins/, and the
    // extensions it loads. Almost every entry here is `expected` and
    // `degraded`, and both flags are deliberate.
    //
    // EXPECTED, because this is code the USER wrote. A stack trace through our
    // loader tells someone to debug software they did not write; the file and
    // the reason are the entire actionable content.
    //
    // DEGRADED, because a broken config must never cost someone their
    // terminal. One bad file disables itself and everything else still loads —
    // a user whose plugin has a typo needs a working Axon to go fix it in.
    // The one FATAL entry is PROFILE_CONFIG_INVALID, and only because it is
    // thrown by the CLI verbs that edit that file, where continuing would mean
    // writing over a config we could not read.

    PROFILE_CONFIG_INVALID: {
        code: "AX-EXT-001",
        title: "profile.config.ts Did Not Call defineProfile()",
        description: "A profile's config must default-export defineProfile({ ... }). Without it there is no extension list to read, so nothing can be installed, enabled or disabled. The rest of the profile — main.ts and plugins/ — still loads.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    PROFILE_CONFIG_FAILED: {
        code: "AX-EXT-002",
        title: "profile.config.ts Failed to Load",
        description: "The file threw while being evaluated, so its extension list could not be read and no extensions were loaded. The profile's own main.ts and plugins/ are unaffected — a typo in an extension list must not cost you the config you already had working.",
        source: "tui",
        severity: "degraded",
        expected: true,
    },
    EXTENSION_ENTRY_INVALID: {
        code: "AX-EXT-003",
        title: "Malformed Extension Entry",
        description: "An entry in profile.config.ts's `extensions` array is neither a string nor an object with a `source`. Accepted forms are \"@scope/name\" for a registry extension and \"./extensions/name\" for a local one.",
        source: "tui",
        severity: "degraded",
        expected: true,
    },
    EXTENSION_NOT_FOUND: {
        code: "AX-EXT-004",
        title: "Extension Not Found",
        description: "An extension listed in profile.config.ts is not on disk. A local path may have moved or been deleted; a registry name may never have been installed. Everything else in the list still loads.",
        source: "tui",
        severity: "degraded",
        expected: true,
    },
    EXTENSION_INSTALL_FAILED: {
        code: "AX-EXT-005",
        title: "Extension Install Failed",
        description: "A registry extension could not be fetched or prepared — most often no network, or a name that does not exist in the registry. It is skipped for this session and retried on the next launch.",
        source: "tui",
        severity: "degraded",
        expected: true,
    },
    EXTENSION_UNINSTALL_FAILED: {
        code: "AX-EXT-028",
        title: "Extension Uninstall Failed",
        description: "An extension could not be removed from profile.config.ts — most often the file is unreadable or has been edited into a shape the editor cannot find the extensions list in. The extension is still declared and will load on the next launch.",
        source: "tui",
        severity: "degraded",
        expected: true,
    },
    EXTENSION_NOT_AN_EXTENSION: {
        code: "AX-EXT-006",
        title: "Not an Extension",
        description: "The directory has no extension.config.ts, which is the file that marks a directory as an extension. A path pointing at an agent, a module, or an ordinary folder is not loadable as one.",
        source: "tui",
        severity: "degraded",
        expected: true,
    },
    EXTENSION_LOAD_FAILED: {
        code: "AX-EXT-007",
        title: "Extension Failed to Load",
        description: "An extension's main.ts threw while it was being loaded, so whatever it had not yet registered is missing. Its commands, keys and palettes are removed and the rest of your config loads normally.",
        source: "tui",
        severity: "degraded",
        expected: true,
    },
    PROFILE_MAIN_FAILED: {
        code: "AX-EXT-008",
        title: "main.ts Failed to Load",
        description: "Your profile's main.ts threw while being evaluated. Anything it registered before the error survives; everything after it did not run. Plugins and extensions still load.",
        source: "tui",
        severity: "degraded",
        expected: true,
    },
    // ── Daemon (axond) ──────────────────────────────────────────────────────
    //
    // The daemon owns machine-wide state, so its failures are about REACHING
    // it or about it refusing something — never about the work itself, which
    // reports through the domain's own codes.
    AGENT_NO_SUPERVISOR: {
        code: "AX-AGENT-030",
        title: "No Supervisor to Boot This Agent",
        description: "Something asked a platform to spawn an agent, but that platform was built without a supervisor. Supervision holds the provider credential and the session log, so it lives in the daemon rather than in whichever process happened to ask — a platform used only to read the store or publish a project does not need one, and this is where the difference surfaces.",
        source: "runtime",
        severity: "fatal",
        expected: true,
    },
    MODEL_RUNTIME_MISSING: {
        code: "AX-MODEL-031",
        title: "That Runtime Is Not Installed",
        description: "An adapter recognised the model and the library that executes it is not on this machine. Local inference runtimes are optional because they are large — ONNX Runtime alone is around 300MB of native binaries — so they are installed when first wanted rather than shipped with the CLI.",
        source: "daemon",
        severity: "fatal",
        expected: true,
    },
    MODEL_LOAD_FAILED: {
        code: "AX-MODEL-032",
        title: "The Model Could Not Be Loaded",
        description: "A runtime recognised the file and failed to read it. Distinct from an unsupported format: this weight is one this machine can execute in principle, so the file itself is the problem — truncated, corrupt, or not the model its name claims.",
        source: "daemon",
        severity: "fatal",
    },
    MODEL_WILL_NOT_FIT: {
        code: "AX-MODEL-033",
        title: "Not Enough Memory for This Model",
        description: "The weight loaded and did not fit within this machine's ceiling, so it was unloaded again. The refusal names what is holding the memory — a model already resident, or another process entirely, since the check measures the whole card rather than Axon's share. Nothing is evicted automatically: a silent eviction is another agent mysteriously slowing down.",
        source: "daemon",
        severity: "degraded",
        expected: true,
    },
    MODEL_NOT_RESIDENT: {
        code: "AX-MODEL-034",
        title: "That Model Is Not Loaded",
        description: "Inference was asked of a weight that is not in memory. Loading is never implicit: it is a claim on the machine's memory, and taking one a caller did not ask for would make admission invisible at the moment it matters.",
        source: "daemon",
        severity: "degraded",
        expected: true,
    },
    MODEL_NOT_CACHED: {
        code: "AX-MODEL-035",
        title: "That Model Is Not On This Machine",
        description: "A weight was asked for that has not been fetched. The daemon caches models content-addressed and machine-wide, so one download serves every agent — but it only serves what has actually been downloaded.",
        source: "daemon",
        severity: "degraded",
        expected: true,
    },
    MODEL_NO_SINGLE_WEIGHT: {
        code: "AX-MODEL-036",
        title: "That Repository Has No Single Weight",
        description: "A repository was asked for by name and publishes several weights with no obvious one to take — an encoder-decoder export ships both halves and needs both, and a quantised set is a choice about quality rather than a default. Name the file to fetch. Guessing would download half a model that fails at load with something obscure.",
        source: "daemon",
        severity: "degraded",
        expected: true,
    },
    MODEL_NO_RUNTIME: {
        code: "AX-MODEL-030",
        title: "No Runtime Can Execute This Model",
        description: "The weight is on this machine and no adapter claims it. Runtimes are registered per format — ONNX, llama.cpp — and a file none of them recognises can be fetched and cached but not loaded. Either the format needs an adapter, or the file is not the model it appears to be.",
        source: "daemon",
        severity: "fatal",
        expected: true,
    },
    DAEMON_NOT_RUNNING: {
        code: "AX-DAEMON-001",
        title: "The Axon Daemon Is Not Running",
        description: "Something asked axond for machine-wide state — what is loaded on the GPU, which agents are running — and no daemon is listening. Start it with `axon daemon up`. Every agent is supervised by the daemon, so this is not a degraded mode: nothing that boots an agent can proceed without one.",
        source: "daemon",
        severity: "fatal",
    },
    DAEMON_ALREADY_RUNNING: {
        code: "AX-DAEMON-002",
        title: "A Daemon Is Already Running",
        description: "A second axond was asked to start while one is already listening on this socket. One daemon per user per machine is the whole point — two would each believe they owned the GPU. Nothing was started; the existing one is untouched.",
        source: "daemon",
        severity: "degraded",
        expected: true,
    },
    DAEMON_SOCKET_UNAVAILABLE: {
        code: "AX-DAEMON-003",
        title: "Could Not Bind the Daemon Socket",
        description: "axond could not listen on its unix socket. Usually a stale socket file left by a process killed with -9, which the daemon removes on start; if it persists, the path may be unwritable or on a filesystem that does not support unix sockets.",
        source: "daemon",
        severity: "fatal",
    },
    DAEMON_START_FAILED: {
        code: "AX-DAEMON-004",
        title: "The Daemon Failed to Start",
        description: "axond was spawned but never reported itself ready. Every agent runs under the daemon's supervision, so a machine without one cannot boot an agent at all — this fails loudly rather than falling back, because a silent fallback is how a broken daemon went unnoticed in a published release. Its output is in the daemon log named by the detail; the usual causes are a port or socket conflict and a broken profile config.",
        source: "daemon",
        severity: "fatal",
    },
    DAEMON_NOT_WIRED: {
        code: "AX-DAEMON-005",
        title: "That Part of the Daemon Is Not Built Yet",
        description: "A domain the daemon declares exists but is not implemented. It throws rather than answering, because a stub returning an empty list is indistinguishable from a real answer and gets built on top of.",
        source: "daemon",
        severity: "degraded",
        expected: true,
    },
    EXTENSION_LOAD_TIMEOUT: {
        code: "AX-EXT-034",
        title: "Extension Took Too Long to Load",
        description: "A config file did not finish evaluating within the load budget — usually a blocking loop or a synchronous wait at module scope. Loading continued without it, so its commands, keys and palettes are missing; everything else in your config still loaded. The file itself keeps running until it finishes, because there is no safe way to interrupt code mid-execution.",
        source: "tui",
        severity: "degraded",
        expected: true,
    },
    PLUGIN_FAILED: {
        code: "AX-EXT-009",
        title: "Plugin Failed to Load",
        description: "A file in plugins/ threw while being imported, so its hooks were not registered. Other plugins in the same folder are unaffected — each file is loaded independently.",
        source: "tui",
        severity: "degraded",
        expected: true,
    },
    HOOK_FAILED: {
        code: "AX-EXT-010",
        title: "Lifecycle Hook Failed",
        description: "A tui.hook() handler threw while the event it listens for was firing. For a notification hook nothing else is affected; for a gating hook (tui:boot, tui:shutdown) the operation continues anyway rather than leaving the terminal stuck.",
        source: "tui",
        severity: "degraded",
        expected: true,
    },
    HOOK_TIMED_OUT: {
        code: "AX-EXT-011",
        title: "Hook Blocked Too Long",
        description: "A gating hook (tui:boot or tui:shutdown) did not finish within its budget, so the TUI continued without waiting. A config must never be able to hang the terminal silently — whatever the handler was doing may not have completed.",
        source: "tui",
        severity: "degraded",
        expected: true,
    },
    COMMAND_NOT_FOUND: {
        code: "AX-EXT-012",
        title: "No Such Command",
        description: "commands.run() was given a path that resolves to nothing in the command tree. The path must name a leaf, spelled exactly as it appears in the `:` palette.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    PALETTE_NOT_FOUND: {
        code: "AX-EXT-013",
        title: "No Such Palette",
        description: "palette.open() was given a name no palette was registered under. Palettes are created with palette.create(name, ...) — a name is only openable once its registration has run.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    PALETTE_NAME_TAKEN: {
        code: "AX-EXT-014",
        title: "Palette Name Already Registered",
        description: "Two palettes tried to claim the same name. Names are how palette.open() addresses one, so they have to be unique — silently replacing the first would make whichever loaded last win, invisibly.",
        source: "tui",
        severity: "degraded",
        expected: true,
    },
    PALETTE_ALREADY_OPEN: {
        code: "AX-EXT-015",
        title: "A Palette Is Already Open",
        description: "Something tried to open a palette, or ask a question, while the user was already navigating one. Stealing it mid-navigation would drop whatever they were doing, so the call fails instead — check palette.isOpen first.",
        source: "tui",
        severity: "degraded",
        expected: true,
    },
    KEY_CHORD_UNBOUND: {
        code: "AX-EXT-022",
        title: "No Such Key Binding",
        description: "keys.send() was given a chord nothing is bound to — neither a mode key nor a registered binding. Sending it would do nothing at all, which is indistinguishable from a binding that ran and had no effect.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    AGENT_SPAWN_NO_INSTANCE: {
        code: "AX-EXT-023",
        title: "Agent Started but No Instance Appeared",
        description: "A spawn reported success without producing a focused instance, so there is no id to hand back. This is a fault in Axon rather than in your config — the agent may or may not be running.",
        source: "tui",
        severity: "fatal",
    },
    PROFILE_CONFIG_MISSING: {
        code: "AX-EXT-025",
        title: "No profile.config.ts",
        description: "The profile has no config file to record the extension in. It is normally created on first launch — starting Axon once will scaffold it.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    PROFILE_CONFIG_UNEDITABLE: {
        code: "AX-EXT-026",
        title: "profile.config.ts Could Not Be Edited",
        description: "The `defineProfile({ ... })` call could not be located, or editing it would have produced invalid TypeScript. Nothing was written — this file is yours, and a botched edit costs your whole TUI config. Add or remove the entry by hand.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    COMMAND_INVALID: {
        code: "AX-EXT-029",
        title: "Command Is Not Registerable",
        description: "A command was registered with no path, or with no `run` to call. Both are caught here rather than when someone presses Enter on it — a command that registers cleanly and then does nothing reads as a broken terminal instead of a config mistake, and gives no clue which file to open. Use `commands.register(path, fn)` or `commands.register(path, { run })`.",
        source: "tui",
        severity: "degraded",
        expected: true,
    },
    COMPONENT_NAME_TAKEN: {
        code: "AX-EXT-030",
        title: "Component Already Registered",
        description: "Two sources registered the same line component name. The first one loaded keeps it — your own config beats any extension. A silently shadowed component would render someone else's value under your name, so the second registration fails instead. Component names are `provider:name`; pick a prefix of your own.",
        source: "tui",
        severity: "degraded",
        expected: true,
    },
    COMPONENT_UNKNOWN: {
        code: "AX-EXT-031",
        title: "No Such Component",
        description: "A line named a component that is not registered. Caught when the line is created rather than when it paints, because a missing component renders as an empty gap — which reads as a layout bug instead of a typo, and gives no clue which name was wrong. components.list() returns everything available.",
        source: "tui",
        severity: "degraded",
        expected: true,
    },
    LINE_NAME_TAKEN: {
        code: "AX-EXT-032",
        title: "Line Already Registered",
        description: "Two sources registered the same line name. The first one loaded keeps it, the same rule commands and key chords follow.",
        source: "tui",
        severity: "degraded",
        expected: true,
    },
    LINE_UNKNOWN: {
        code: "AX-EXT-033",
        title: "No Such Line",
        description: "lines.set(), move(), show(), hide() or toggle() named a line that is not registered. Doing nothing would be indistinguishable from a line that registered and then rendered empty, so this fails instead. lines.list() returns what exists.",
        source: "tui",
        severity: "degraded",
        expected: true,
    },
    COMMAND_PATH_TAKEN: {
        code: "AX-EXT-020",
        title: "Command Already Registered",
        description: "Two sources registered the same command path. The first one loaded keeps it — your own config beats any extension, and between extensions the one listed earlier in profile.config.ts wins. Rename one of them.",
        source: "tui",
        severity: "degraded",
        expected: true,
    },
    KEY_CHORD_TAKEN: {
        code: "AX-EXT-021",
        title: "Key Chord Already Bound",
        description: "Two sources bound the same key chord. The first one loaded keeps it. A silently shadowed binding is unbearable to debug in someone else's config, so the second registration fails instead of replacing it.",
        source: "tui",
        severity: "degraded",
        expected: true,
    },
    MODE_KEY_TAKEN: {
        code: "AX-EXT-016",
        title: "Mode Key Already Bound",
        description: "A palette asked for a mode key that is already in use — either by a built-in mode or by another extension. A silently shadowed key is unbearable to debug in someone else's config, so the registration fails loudly instead.",
        source: "tui",
        severity: "degraded",
        expected: true,
    },
    MODE_UNKNOWN: {
        code: "AX-EXT-017",
        title: "No Such Mode",
        description: "mode.set() was given a name that is neither a built-in mode nor a registered palette. Doing nothing would look identical to a mode that simply does not render, so this fails instead.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    NO_FOCUSED_AGENT: {
        code: "AX-EXT-018",
        title: "No Agent Focused",
        description: "A verb that acts on the focused agent — send, stop, reboot — was called while nothing was running. Start one with agents.spawn(name) or tui.nav(name) first.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    INSTANCE_NOT_RUNNING: {
        code: "AX-EXT-019",
        title: "Instance Not Running",
        description: "An instance id was given for a conversation that is not live — it may already have been stopped, or it belongs to an earlier session. agents.list() returns what is currently running.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
    CONNECT_REJECTED: {
        code: "AX-EXT-035",
        title: "Connector Credential Rejected",
        description: "The platform refused the credential pasted during `:connect`. Verification runs before the value is written, so nothing was stored — the detail carries the platform's own reason, and the most common cause is copying the wrong secret from the developer portal.",
        source: "tui",
        severity: "fatal",
        expected: true,
    },
} as const satisfies Record<string, AxonErrorMapEntry>

export type AxonErrorMap = typeof errorMap
export type AxonErrorCode = keyof AxonErrorMap
