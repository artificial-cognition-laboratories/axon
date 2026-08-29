/**
 * A model specifier, parsed into what a person means by it.
 *
 * ── Why this is one function ────────────────────────────────────────────────
 *
 * The same split existed in three places — the daemon's records, its
 * catalogue, and Fleet's hold grouping — and had already begun to disagree:
 * one of them reported `model.onnx` as the name because it took the last path
 * segment. Three copies of a parse is the shape that drifts, and the drift is
 * silent because each looks locally correct.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * `hf:onnx-community/silero-vad@main/onnx/model.onnx`
 *      scheme   owner          repo    pin  path inside the repo
 *
 * A specifier names a REPOSITORY and then a file inside it. So the last
 * segment is a filename — `model.onnx` identifies nothing — while the first
 * two segments after the scheme are what a person calls the model. The pin and
 * the inner path are real and neither is the name.
 */
export type ParsedSpecifier = {
    /** The whole specifier, unchanged. */
    id: string
    /** What a person calls it: the repository. */
    name: string
    /** Who publishes it. Empty for an unscoped name. */
    owner: string
    /** `hf` / `ollama` — what fetches it, never what runs it. */
    scheme: string
}

export function parseSpecifier(specifier: string): ParsedSpecifier {
    const colon = specifier.indexOf(":")
    const scheme = colon > 0 ? specifier.slice(0, colon) : "hf"
    // An ollama tag is `qwen2.5-coder:7b` — the colon separates a VERSION, not
    // a scheme, so a bare name keeps its tag rather than losing it to a split.
    const rest = colon > 0 && (scheme === "hf" || scheme === "ollama") ? specifier.slice(colon + 1) : specifier

    // The pin (`@main`) and everything after it is location, not identity.
    const bare = rest.split("@")[0] ?? rest
    const [first, second] = bare.split("/")

    return {
        id: specifier,
        name: second ?? first ?? bare,
        owner: second ? first ?? "" : "",
        scheme: scheme,
    }
}
