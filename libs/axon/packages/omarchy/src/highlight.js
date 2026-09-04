.pragma library

/**
 * Syntax highlighting for fenced code, as rich text.
 *
 * ── Why not Shiki ───────────────────────────────────────────────────────────
 *
 * Shiki resolves TextMate grammars with an Oniguruma regex engine compiled to
 * WASM. Quickshell's JS engine loads neither npm modules nor WASM, so it cannot
 * run here at all. Doing it daemon-side is genuinely possible — the daemon has
 * bun, and detail is already cached on disk so the cost would be paid once per
 * model — but it means shipping megabytes of grammars to colour the code blocks
 * in a bar widget's model cards. That trade is recorded in debt.md rather than
 * taken quietly.
 *
 * This is the honest middle: a token pass over the handful of languages model
 * cards actually contain. It knows comments, strings, numbers, keywords and
 * call sites, which is most of what makes code scannable, and it knows nothing
 * about scope, types or semantics — so it will occasionally colour a word that
 * happens to match. That is the cost of eighty lines instead of a toolchain.
 */

var KEYWORDS = {
    python: "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield print self",
    bash: "if then else elif fi for while do done case esac function return export local source echo cd exit set unset trap read",
    js: "await async break case catch class const continue default delete do else export extends finally for from function if import in instanceof let new of return super switch this throw try typeof var void while yield null undefined true false",
    json: "true false null",
    yaml: "true false null yes no on off",
}

/** Language aliases as they are actually written in fences. */
function normalise(language) {
    var l = String(language || "").toLowerCase()
    if (l === "py" || l === "python3") return "python"
    if (l === "sh" || l === "shell" || l === "console" || l === "zsh") return "bash"
    if (l === "ts" || l === "typescript" || l === "javascript" || l === "jsx" || l === "tsx") return "js"
    if (l === "yml") return "yaml"
    return l
}

/**
 * Code as rich text, wrapped in `<pre>` so whitespace survives.
 *
 * Rich text collapses runs of spaces; a `<pre>` is the only thing that stops
 * indentation being flattened, which for code is the difference between
 * readable and meaningless.
 */
function render(code, language, palette) {
    var p = palette || {}
    var text = String(code || "")
    var lang = normalise(language)
    var words = KEYWORDS[lang]

    var plain = p.plain || "#cacccc"
    var comment = p.comment || "#6b7378"
    var string = p.string || "#9ac8a0"
    var number = p.number || "#d8a657"
    var keyword = p.keyword || "#0094d2"
    var call = p.call || "#8ab4d8"

    // One pass, alternating between "outside a token" and "inside one", so a
    // keyword inside a string is never coloured as a keyword. A regex-replace
    // chain cannot promise that and this is the entire reason for a scanner.
    var out = ""
    var i = 0
    var line = lang === "bash" ? "#" : (lang === "python" || lang === "yaml" ? "#" : "//")

    function span(colour, body) {
        return '<span style="color:' + colour + ';">' + body + "</span>"
    }

    while (i < text.length) {
        var rest = text.slice(i)

        var lineComment = rest.indexOf(line) === 0
        if (lineComment) {
            var stop = rest.indexOf("\n")
            var chunk = stop === -1 ? rest : rest.slice(0, stop)
            out += span(comment, escape(chunk))
            i += chunk.length
            continue
        }

        var quote = rest[0]
        if (quote === '"' || quote === "'" || quote === "`") {
            var closed = 1
            while (closed < rest.length && rest[closed] !== quote) {
                if (rest[closed] === "\\") closed++
                closed++
            }
            var literal = rest.slice(0, Math.min(closed + 1, rest.length))
            out += span(string, escape(literal))
            i += literal.length
            continue
        }

        var digits = /^\d+(\.\d+)?/.exec(rest)
        if (digits && !/[A-Za-z_]/.test(text[i - 1] || "")) {
            out += span(number, digits[0])
            i += digits[0].length
            continue
        }

        var word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)
        if (word) {
            var w = word[0]
            var following = rest.slice(w.length)
            if (words && (" " + words + " ").indexOf(" " + w + " ") !== -1) {
                out += span(keyword, w)
            } else if (/^\s*\(/.test(following)) {
                out += span(call, w)
            } else {
                out += escape(w)
            }
            i += w.length
            continue
        }

        out += escape(text[i])
        i++
    }

    return '<pre style="margin:0; color:' + plain + ';">' + out + "</pre>"
}

function escape(text) {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
}
