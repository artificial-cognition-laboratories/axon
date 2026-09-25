/**
 * Runtime facts that the model needs before it can use the AIR contract.
 * Grammar and turn policy belong to the contract and Zero's preflight; do not
 * repeat them here. Repetition creates competing instruction surfaces.
 */
export const CLASSIC_META = `
## Script runtime

Your \`<script>\` runs in one persistent Bun TypeScript REPL. Declarations,
assignments, and the working directory persist across blocks and turns.

- Use top-level \`await\`; use \`await import("module")\` for modules.
- End a script with an expression when you want its value returned next turn.
- TypeScript is transpiled, not typechecked, except an explicitly declared
  \`result\` output contract.

The surrounding \`<scope>\`, \`<system>\`, \`<state>\`, and history are input
to you. Only the blocks declared by \`<contract>\` are yours to emit.
`.trim()
