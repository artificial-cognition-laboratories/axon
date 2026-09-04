.pragma library

/** Bytes as a human figure. Null is unreadable and says so — never "0 B". */
function bytes(n) {
    if (n === null || n === undefined || !isFinite(n)) return "—"
    var units = ["B", "KB", "MB", "GB", "TB"]
    var value = Math.abs(n)
    var i = 0
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024
        i++
    }
    return (i === 0 ? value.toFixed(0) : value.toFixed(value < 10 ? 1 : 0)) + " " + units[i]
}

/** "8.1 GB / 24 GB", or "—" when either half is unreadable. */
function ratio(used, total) {
    if (used === null || used === undefined || total === null || total === undefined) return "—"
    return bytes(used) + " / " + bytes(total)
}

/** A 0-100 reading as a percentage. */
function percent(n) {
    if (n === null || n === undefined || !isFinite(n)) return "—"
    return Math.round(n) + "%"
}

/** How long ago an ISO timestamp was, coarsely. */
function since(iso) {
    if (!iso) return ""
    var then = Date.parse(iso)
    if (isNaN(then)) return ""
    var secs = Math.max(0, Math.floor((Date.now() - then) / 1000))
    if (secs < 60) return secs + "s"
    if (secs < 3600) return Math.floor(secs / 60) + "m"
    if (secs < 86400) return Math.floor(secs / 3600) + "h"
    return Math.floor(secs / 86400) + "d"
}

/**
 * A count of seconds as a clock.
 *
 * Distinct from `since`, which is deliberately coarse because nobody needs the
 * second an agent last spoke. This one is watched while it runs, so it keeps
 * seconds all the way up — a duration that sticks on "3m" for sixty seconds
 * reads as frozen, which is the one thing a progress clock must never do.
 */
function duration(seconds) {
    if (seconds === null || seconds === undefined || !isFinite(seconds)) return ""
    var secs = Math.max(0, Math.floor(seconds))
    if (secs < 60) return secs + "s"
    var mins = Math.floor(secs / 60)
    var rest = secs % 60
    return mins + "m " + (rest < 10 ? "0" : "") + rest + "s"
}

/** The last path segment — a project root reads as its directory name. */
function basename(path) {
    if (!path) return ""
    var parts = String(path).split("/").filter(function (p) { return p !== "" })
    return parts.length ? parts[parts.length - 1] : String(path)
}

/**
 * A string with every occurrence of `term` tinted, as rich text.
 *
 * Answers "why did this match" without the reader having to work it out — a
 * search for "hey" returning `heyAidi`, `heylobc` and `heyanzhuo` looks
 * arbitrary until the matching part is coloured, at which point it is obvious.
 *
 * Case-insensitive on the match, but the ORIGINAL casing is preserved in the
 * output: replacing the text with the query would quietly rewrite `HeyH` as
 * `heyH`, which is a different name.
 */
function highlight(text, term, colour) {
    var source = String(text || "")
    var needle = String(term || "").trim()
    if (needle === "") return escapeHtml(source)

    var out = ""
    var lowerSource = source.toLowerCase()
    var lowerNeedle = needle.toLowerCase()
    var at = 0

    for (;;) {
        var found = lowerSource.indexOf(lowerNeedle, at)
        if (found === -1) break
        out += escapeHtml(source.slice(at, found))
        out += '<span style="color:' + colour + ';">'
            + escapeHtml(source.slice(found, found + needle.length)) + "</span>"
        at = found + needle.length
    }

    return out + escapeHtml(source.slice(at))
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
}
