.pragma library

/*
 * Deliberately small, defensive Markdown parser for model cards.
 * It accepts useful presentation HTML but never forwards executable HTML to QML.
 */

function blocks(source) {
    if (!source) return []

    var lines = normaliseSource(source).split("\n")
    var out = []
    var i = 0

    while (i < lines.length) {
        var line = lines[i]
        var fence = /^\s*```\s*(\S*)/.exec(line)
        if (fence) {
            var code = []
            i++
            while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i++ }
            if (i < lines.length) i++
            out.push({ kind: "code", language: fence[1] || "", text: code.join("\n") })
            continue
        }

        if (/^\s*$/.test(line)) { i++; continue }

        var htmlImage = /^\s*<img\b([^>]*)\/?\s*>\s*$/i.exec(line)
        if (htmlImage) {
            var imageUrl = attribute(htmlImage[1], "src")
            if (safeUrl(imageUrl)) out.push({ kind: "image", alt: attribute(htmlImage[1], "alt"), url: imageUrl })
            i++
            continue
        }

        var media = /^\s*<(audio|video)\b([^>]*)>(?:[\s\S]*?<\/\1>)?\s*$/i.exec(line)
        if (media) {
            var src = attribute(media[2], "src") || sourceAttribute(media[0])
            if (safeUrl(src)) out.push({ kind: "media", media: media[1].toLowerCase(), url: src })
            i++
            continue
        }

        var figure = /^\s*!\[([^\]]*)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)\s*$/.exec(line)
        if (figure) {
            out.push({ kind: "image", alt: figure[1] || "", url: figure[2] })
            i++
            continue
        }

        var heading = /^(#{1,6})\s+(.*?)(?:\s+#+\s*)?$/.exec(line)
        if (heading) {
            out.push({ kind: "heading", depth: heading[1].length, text: heading[2] })
            i++
            continue
        }

        if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
            out.push({ kind: "rule" }); i++; continue
        }

        if (/^\s*>/.test(line)) {
            var quoted = []
            while (i < lines.length && /^\s*>/.test(lines[i])) {
                quoted.push(lines[i].replace(/^\s*>\s?/, "")); i++
            }
            out.push({ kind: "quote", text: quoted.join(" ") })
            continue
        }

        if (/^\s*\|/.test(line)) {
            var rows = []
            while (i < lines.length && /^\s*\|/.test(lines[i])) {
                var row = lines[i].replace(/^\s*\|/, "").replace(/\|\s*$/, "")
                if (!/^[\s|:-]+$/.test(row)) rows.push(row.split("|").map(function (cell) { return cell.trim() }))
                i++
            }
            if (rows.length) out.push({ kind: "table", headers: rows.shift(), rows: rows })
            continue
        }

        if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
            var items = []
            while (i < lines.length && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])) {
                var match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
                var task = /^\[([ xX])\]\s+/.exec(match[3])
                items.push({
                    depth: Math.floor(match[1].replace(/\t/g, "    ").length / 2),
                    marker: match[2],
                    ordered: /^\d/.test(match[2]),
                    checked: task ? task[1].toLowerCase() === "x" : null,
                    text: task ? match[3].slice(task[0].length) : match[3]
                })
                i++
            }
            out.push({ kind: "list", items: items })
            continue
        }

        var para = []
        while (i < lines.length && !/^\s*$/.test(lines[i])
            && !/^(#{1,6})\s/.test(lines[i]) && !/^\s*```/.test(lines[i])
            && !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i]) && !/^\s*\|/.test(lines[i])
            && !/^\s*>/.test(lines[i]) && !/^\s*<(audio|video)\b/i.test(lines[i])) {
            para.push(lines[i]); i++
        }
        if (para.length) {
            var text = para.join(" ")
            /*
             * A paragraph that renders to nothing does not become a blank line.
             *
             * Cards open with rows of shields.io badges — `<a><img/></a>` over
             * several lines, which the single-line `<img>` rule above does not
             * catch, so they arrived here as paragraphs. Their visible content
             * after stripping is an empty link label, so each one drew nothing
             * and still took a line's height: three of them left a hundred and
             * thirty pixels of dead space between a card's title and its first
             * sentence.
             *
             * Measured on what a reader would SEE, not on the source, so the
             * rule holds for any markup that reduces to nothing rather than
             * for the one shape that prompted it.
             */
            if (visible(text)) out.push({ kind: "paragraph", text: text })
        }
        else i++
    }
    return out
}

function inline(text, palette) {
    var p = palette || {}
    var s = escape(stripHtml(String(text)))
    var link = p.link || "#49b7ed"
    var codeBg = p.codeBg || "#20252b"
    var code = p.code || p.body || "#e5e7eb"
    var emphasis = p.emphasis || p.body || "#ffffff"

    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function (_m, alt) {
        return alt ? "<i>" + alt + "</i>" : ""
    })
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, function (_m, label, href) {
        return safeUrl(href) ? '<a href="' + escapeAttribute(href) + '" style="color:' + link + '; text-decoration:none;">' + label + "</a>" : label
    })
    s = s.replace(/\`([^\`]+)\`/g, function (_m, value) {
        return '<span style="font-family:monospace; background-color:' + codeBg + '; color:' + code + ';">\u00a0' + value + "\u00a0</span>"
    })

    /*
     * URLs are taken OUT before emphasis runs, and put back after.
     *
     * `_` is an emphasis marker in Markdown and an ordinary character in a
     * URL, and half the model IDs on Hugging Face contain one. Left in place,
     * `nvidia/parakeet_realtime_eou_120m-v1` became
     * `parakeet<i>realtime</i>eou_120m-v1` — the link visibly corrupted, and
     * its href along with it.
     *
     * Escaping every underscore would be the other way round and would break
     * emphasis in prose. Removing the URLs is exact: what is protected is
     * exactly what must not be interpreted.
     */
    var held = []
    function hold(html) {
        held.push(html)
        // A token with no Markdown-significant character in it. `\u0000` cannot
        // appear in the source — it was escaped or stripped long before here.
        return "\u0000" + (held.length - 1) + "\u0000"
    }

    // Anchors built above, and bare URLs that are about to become anchors.
    s = s.replace(/<a\b[^>]*>[\s\S]*?<\/a>/g, hold)
    s = s.replace(/(^|[\s(>])((?:https?:\/\/)[^\s<)\]]+)/g, function (_whole, lead, url) {
        var trimmed = url.replace(/[.,;:!?]+$/, "")
        return lead + hold('<a href="' + escapeAttribute(trimmed) + '" style="color:' + link
            + '; text-decoration:none;">' + trimmed + "</a>") + url.slice(trimmed.length)
    })

    s = s.replace(/\*\*([^*]+)\*\*/g, '<b style="color:' + emphasis + ';">$1</b>')
    s = s.replace(/__([^_]+)__/g, '<b style="color:' + emphasis + ';">$1</b>')
    s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<i>$2</i>")
    s = s.replace(/(^|[^_])_([^_]+)_/g, "$1<i>$2</i>")
    s = s.replace(/~~([^~]+)~~/g, "<s>$1</s>")

    return s.replace(/\u0000(\d+)\u0000/g, function (_m, at) { return held[Number(at)] })
}

function normaliseSource(source) {
    return decodeEntities(String(source)).replace(/\r\n?/g, "\n")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<\/?(?:div|section|article|header|footer|p|br|details|summary|center|figure|figcaption)\b[^>]*>/gi, "\n")
        .replace(/<\/?(?:h[1-6])\b[^>]*>/gi, "\n")
        .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
        .replace(/<style\b[\s\S]*?<\/style\s*>/gi, "")
        .replace(/<iframe\b[\s\S]*?<\/iframe\s*>/gi, "")
}

/**
 * HTML entities, as the characters they stand for.
 *
 * Model cards are written for a browser and use `&nbsp;` for layout, `&amp;`
 * in URLs, `&lt;` around type parameters. Everything downstream escapes `&`
 * before handing text to RichText, so an entity that survives to that point is
 * re-escaped and rendered as its own source — `&nbsp;` appearing literally on
 * the page, which is what a reader saw.
 *
 * Decoded HERE, at the top of the parser, so the rest of the pipeline only
 * ever sees characters. `&nbsp;` becomes a normal space rather than U+00A0:
 * the non-breaking behaviour was a browser-layout decision that means nothing
 * in a wrapped Text, and keeping it produces words that will not break where
 * they should.
 *
 * Numeric forms are included because cards use them for arrows and dashes, and
 * a card that renders `&#8212;` reads as broken however few of them there are.
 */
/** Whether this block would put any glyph on screen. */
function visible(text) {
    return stripHtml(String(text))
        // A link with no label — what a badge image reduces to.
        .replace(/\[\s*\]\([^)]*\)/g, "")
        .replace(/[\s\u00a0]+/g, "")
        .length > 0
}

function decodeEntities(text) {
    return text
        .replace(/&nbsp;/gi, " ")
        .replace(/&(?:quot|#34);/gi, "\"")
        .replace(/&(?:apos|#39);/gi, "'")
        .replace(/&(?:lt|#60);/gi, "<")
        .replace(/&(?:gt|#62);/gi, ">")
        .replace(/&(?:mdash|#8212);/gi, "\u2014")
        .replace(/&(?:ndash|#8211);/gi, "\u2013")
        .replace(/&(?:hellip|#8230);/gi, "\u2026")
        .replace(/&#(\d{2,5});/g, function (_m, code) {
            var n = parseInt(code, 10)
            return n > 0 && n < 0x110000 ? String.fromCharCode(n) : _m
        })
        // LAST, always. Decoding it earlier would turn `&amp;lt;` into `<`,
        // which is the classic double-decode that lets escaped markup become
        // markup again.
        .replace(/&amp;/gi, "&")
}

function stripHtml(text) {
    return text
        .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, function (_m, href, label) {
            return safeUrl(href) ? "[" + label.replace(/<[^>]*>/g, "") + "](" + href + ")" : label.replace(/<[^>]*>/g, "")
        })
        .replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)\s*>/gi, "**$1**")
        .replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)\s*>/gi, "*$1*")
        .replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, "\`$1\`")
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]*>/g, "")
}

function attribute(attrs, name) {
    var doubleQuoted = new RegExp('\\b' + name + '\\s*=\\s*"([^"]+)"', "i").exec(attrs || "")
    var singleQuoted = new RegExp("\\b" + name + "\\s*=\\s*'([^']+)'", "i").exec(attrs || "")
    var match = doubleQuoted || singleQuoted
    return match ? match[1] : ""
}
function sourceAttribute(html) {
    var match = /<source\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(html)
    return match ? match[1] : ""
}
function safeUrl(url) {
    return /^(https?:|file:|qrc:)/i.test(String(url || "").trim())
}
function escapeAttribute(text) { return String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;") }
function escape(text) { return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") }
