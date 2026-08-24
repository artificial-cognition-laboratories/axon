// @axon/docs — the Axon platform documentation, as installable knowledge.
//
// Contributes no tools, prompts or routes. Its entire surface is
// data/knowledge/, which the build scans and namespaces under the module's
// name, so an agent that installs it can read the docs without the corpus
// ever being copied into the agent.
//
// Read-only by construction: module knowledge lives inside this package, and
// the next install would destroy anything written here — so the kernel
// refuses writes addressed at it.
export default defineModule({})
