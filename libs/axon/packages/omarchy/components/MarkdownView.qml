import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Commons

import "../src/markdown.js" as Markdown
import "../src/highlight.js" as Highlight

/**
 * A markdown document, rendered one QML item per block.
 *
 * ── Why blocks and not one Text ─────────────────────────────────────────────
 *
 * Qt's rich text has no border radius, no way to position anything, and its
 * `<font size>` attribute is the HTML 1-7 scale — a pixel value passed to it
 * clamps to 7, which is why every code fence rendered at poster size. None of
 * the things that make a code block look like a code block are reachable from
 * inside a Text.
 *
 * So the document is parsed into blocks and each is a real item. Prose and
 * headings stay rich text, because inline links and emphasis are exactly what
 * Qt's subset is good at; code gets a surface, a language label and its own
 * horizontal scroll, which is the whole reason for the split.
 *
 * Spacing follows the Axon docs — generous above a heading, tight beneath it,
 * paragraphs closer to each other than to the section they sit under — using
 * Omarchy's own type scale so it reads as part of the desktop rather than as a
 * web page pasted into one.
 */
Column {
    id: root

    property string source: ""
    property color foreground: Color.menu.text
    property color accent: "#0094d2"
    property string fontFamily: Style.font.menuFamily

    signal linkActivated(string url)

    property string copiedCode: ""

    function copyCode(text) {
        Quickshell.execDetached(["wl-copy", "-n", "--", String(text || "")])
        copiedCode = String(text || "")
        copiedReset.restart()
    }

    Timer {
        id: copiedReset
        interval: 1400
        repeat: false
        onTriggered: root.copiedCode = ""
    }

    // Distinct roles keep dense model cards easy to scan.
    readonly property color muted: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.64)
    readonly property color dim: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.46)
    readonly property color rule: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.14)
    /**
     * The one recessed surface everything inset sits on — code, figures, media.
     *
     * Code used to be a LIGHTER shade than the page while a figure was a
     * hardcoded near-black, so two things playing the same role — content
     * lifted out of the prose — were two different colours, and the difference
     * carried no meaning. One token means a card reads as one document.
     *
     * Recessed rather than raised: these are things the page contains, not
     * things floating above it.
     *
     * A FIXED near-black rather than a shade derived from the theme. Deriving
     * it was tried and lands too light — `darker(menu.background, 1.3)` on a
     * dark theme is barely a step down, so the figures visibly lifted while
     * the code barely moved. It is also the wrong idea for a figure: a
     * screenshot with transparency needs a neutral ground of its own, not one
     * that follows whatever colour the shell is wearing, and code shares that
     * requirement the moment the two sit in the same document.
     */
    readonly property color codeSurface: "#111111"
    /** Softer and larger than a control's corner — these are surfaces, not buttons. */
    readonly property real surfaceRadius: Style.space(10)
    readonly property real surfacePadding: Style.space(14)
    /** Figures are framed, not padded like a code surface. */
    readonly property real figurePadding: Style.space(4)
    readonly property string linkColor: Qt.lighter(accent, 1.2)

    /**
     * Prose defaults to the reading tone. Bright foreground is reserved for
     * headings and focused UI so a long card keeps a clear visual hierarchy.
     */
    function span(text, tone) {
        var content = tone || root.muted
        return Markdown.inline(text, {
            link: root.linkColor,
            codeBg: root.codeSurface,
            code: content,
            body: content,
            // Lifted a little, not a different colour. A caller that wants
            // emphasis to disappear passes the tone it already has.
            emphasis: tone ? content : Qt.lighter(content, 1.12)
        })
    }

    spacing: 0

    Repeater {
        model: Markdown.blocks(root.source)

        Loader {
            required property var modelData
            width: root.width
            sourceComponent: {
                switch (modelData.kind) {
                case "heading": return headingBlock
                case "code": return codeBlock
                case "list": return listBlock
                case "rule": return ruleBlock
                case "quote": return quoteBlock
                case "table": return tableBlock
                case "image": return imageBlock
                case "media": return mediaBlock
                default: return paragraphBlock
                }
            }
        }
    }

    // ── Prose ───────────────────────────────────────────────────────────────

    Component {
        id: paragraphBlock
        Item {
            width: parent.width
            // Paragraphs need a visible pause; this is the document's base rhythm.
            implicitHeight: body.implicitHeight + Style.space(16)

            Text {
                id: body
                width: parent.width
                textFormat: Text.RichText
                text: root.span(modelData.text)
                color: root.muted
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                lineHeight: 1.5
                wrapMode: Text.WordWrap
                onLinkActivated: function (url) { root.linkActivated(url) }
                HoverHandler { cursorShape: body.hoveredLink !== "" ? Qt.PointingHandCursor : Qt.ArrowCursor }
            }
        }
    }

    Component {
        id: headingBlock
        Item {
            width: parent.width
            // Generous above, tight below: a heading belongs to what follows
            // it, and equal margins make it float between two sections.
            readonly property bool major: modelData.depth <= 2
            implicitHeight: title.implicitHeight + (major ? Style.space(26) : Style.space(20)) + Style.space(6)

            Text {
                id: title
                width: parent.width
                y: parent.major ? Style.space(26) : Style.space(20)
                textFormat: Text.RichText
                text: root.span(modelData.text, root.foreground)
                color: root.foreground
                font.family: root.fontFamily
                // Two sizes only. A card that used six would be a document;
                // the useful distinction here is section versus sub-section.
                font.pixelSize: modelData.depth === 1 ? Style.font.title : Style.font.subtitle
                font.bold: true
                wrapMode: Text.WordWrap
                onLinkActivated: function (url) { root.linkActivated(url) }
            }
        }
    }

    // ── Code ────────────────────────────────────────────────────────────────

    Component {
        id: codeBlock
        Item {
            width: parent.width
            implicitHeight: surface.height + Style.space(16)

            Rectangle {
                id: surface
                width: parent.width
                y: Style.space(6)
                height: header.height + codeFlick.height + root.surfacePadding * 2
                // No border. A filled surface already separates itself from
                // prose, and an outline on top of a fill reads as a form field.
                radius: root.surfaceRadius
                color: root.codeSurface

                // Fences are a direct copy target. Code remains visibly selectable
                // for accessibility, but a normal click copies the whole command.
                TapHandler {
                    acceptedButtons: Qt.LeftButton
                    onTapped: root.copyCode(modelData.text)
                }

                Item {
                    id: header
                    x: root.surfacePadding
                    y: root.surfacePadding
                    width: parent.width - root.surfacePadding * 2
                    // The header also carries copy feedback for unlabelled fences.
                    height: label.implicitHeight + Style.space(8)
                    visible: true

                    Text {
                        id: label
                        anchors.left: parent.left
                        anchors.top: parent.top
                        textFormat: Text.PlainText
                        text: root.copiedCode === modelData.text ? "Copied" : (modelData.language !== "" ? modelData.language : "Click to copy")
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                    }

                    // The three dots the Axon docs put on a code surface. Pure
                    // decoration, and the cheapest signal that this block is a
                    // terminal rather than prose.
                    Row {
                        anchors.right: parent.right
                        anchors.verticalCenter: label.verticalCenter
                        spacing: Style.space(5)

                        Repeater {
                            model: 3
                            Rectangle {
                                width: Style.space(7)
                                height: width
                                radius: width / 2
                                color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.55)
                            }
                        }
                    }
                }

                Flickable {
                    id: codeFlick
                    x: root.surfacePadding
                    y: root.surfacePadding + header.height
                    width: parent.width - root.surfacePadding * 2
                    /*
                     * The code's own height, uncapped.
                     *
                     * This was clamped to 340 with vertical scrolling turned
                     * OFF, so any fence longer than about twenty lines was
                     * silently cut at the bottom of its surface with no
                     * scrollbar and no indication anything was missing — a
                     * quickstart whose last three lines simply did not exist.
                     *
                     * Horizontal scrolling stays: code must not wrap, because
                     * a wrapped command line is one you cannot copy. Vertical
                     * is the page's job, and the page already scrolls.
                     */
                    height: codeText.implicitHeight
                    contentWidth: codeText.implicitWidth
                    contentHeight: codeText.implicitHeight
                    clip: true
                    // Code does not wrap — it scrolls. A wrapped command line
                    // is a command line you cannot copy or read.
                    // The enclosing surface owns clicks for copy. Long code
                    // stays readable through the horizontal scrollbar.
                    interactive: false
                    boundsBehavior: Flickable.StopAtBounds
                    ScrollBar.horizontal: ScrollBar { policy: ScrollBar.AsNeeded }

                    Text {
                        id: codeText
                        textFormat: Text.RichText
                        text: Highlight.render(modelData.text, modelData.language, {
                            plain: root.muted,
                            comment: root.dim,
                            string: "#9ac8a0",
                            number: "#d8a657",
                            keyword: root.accent,
                            call: Qt.lighter(root.accent, 1.35),
                        })
                        font.family: "monospace"
                        font.pixelSize: Style.font.bodySmall
                        lineHeight: 1.45
                    }
                }
            }
        }
    }

    // ── Figures ─────────────────────────────────────────────────────────────

    Component {
        id: imageBlock
        Item {
            width: parent.width
            implicitHeight: figure.height + Style.space(16)

            Rectangle {
                id: figure
                width: parent.width
                y: Style.space(6)
                // A quiet frame: screenshots need the width, not a caption bar.
                height: view.height + root.figurePadding * 2
                radius: root.surfaceRadius
                color: root.codeSurface

                /*
                 * Fetched by the shell process, which is a real decision and
                 * not a free one: this draws whatever a registry serves, in the
                 * process that draws the desktop. It is bounded rather than
                 * trusted — decoded at a capped size, loaded asynchronously so
                 * a slow host never blocks a frame, and a failure falls back to
                 * the alt text rather than a broken box.
                 */
                Image {
                    id: view
                    x: root.figurePadding
                    y: root.figurePadding
                    width: parent.width - root.figurePadding * 2
                    source: modelData.url
                    asynchronous: true
                    cache: true
                    // Each source keeps its own aspect ratio. The view takes
                    // the full document width, then derives its height from the
                    // decoded image so neither a portrait terminal nor a wide
                    // Fleet trace can escape or be cropped by its frame.
                    fillMode: Image.PreserveAspectFit
                    sourceSize.width: 1200
                    height: status === Image.Ready
                        ? Math.min(implicitHeight * (width / Math.max(1, implicitWidth)), Style.space(420))
                        : Style.space(60)

                    Text {
                        anchors.centerIn: parent
                        visible: view.status === Image.Loading
                        textFormat: Text.PlainText
                        text: "Loading figure…"
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                    }
                }
            }
        }
    }

    // ── Embedded media ───────────────────────────────────────────────────────

    Component {
        id: mediaBlock
        Item {
            width: parent.width
            implicitHeight: surface.height + Style.space(16)

            Rectangle {
                id: surface
                width: parent.width
                y: Style.space(6)
                height: Style.space(58)
                radius: root.surfaceRadius
                color: root.codeSurface

                Text {
                    id: mediaKind
                    anchors.left: parent.left
                    anchors.leftMargin: root.surfacePadding
                    anchors.verticalCenter: parent.verticalCenter
                    text: modelData.media === "audio" ? "Audio attachment" : "Video attachment"
                    color: root.muted
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                }

                Text {
                    anchors.left: mediaKind.right
                    anchors.leftMargin: Style.space(12)
                    anchors.verticalCenter: parent.verticalCenter
                    text: "Open externally ↗"
                    color: root.linkColor
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption

                    HoverHandler { cursorShape: Qt.PointingHandCursor }
                    TapHandler { onTapped: root.linkActivated(modelData.url) }
                }

                Text {
                    anchors.left: parent.left
                    anchors.leftMargin: root.surfacePadding
                    anchors.right: parent.right
                    anchors.rightMargin: root.surfacePadding
                    anchors.bottom: parent.bottom
                    anchors.bottomMargin: Style.space(7)
                    textFormat: Text.PlainText
                    text: modelData.url
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    elide: Text.ElideMiddle
                }
            }
        }
    }

    // ── Lists, rules, quotes, tables ────────────────────────────────────────

    Component {
        id: listBlock
        Column {
            width: parent.width
            /*
             * Wider than the line spacing INSIDE an item.
             *
             * A wrapped bullet sets its own lines about a line-height apart;
             * at 7 the gap between two items was smaller than that, so a
             * two-line entry ran into the next one and the list read as a
             * paragraph with dots in it. The separation between items has to
             * beat the separation within one or there is no grouping at all.
             */
            spacing: Style.space(13)
            topPadding: Style.space(4)
            bottomPadding: Style.space(14)

            Repeater {
                model: modelData.items

                // Anchored rather than laid out in a Row: the marker sits in a
                // fixed gutter and the text anchors past it, so a wrapped line
                // stays under the text instead of falling back to the margin.
                Item {
                    required property var modelData
                    required property int index
                    readonly property real indent: modelData.depth * Style.space(18)
                    width: parent.width
                    implicitHeight: item.implicitHeight

                    Text {
                        id: bullet
                        x: parent.indent
                        anchors.top: parent.top
                        width: Style.space(18)
                        textFormat: Text.PlainText
                        text: modelData.checked === true ? "☑" : (modelData.checked === false ? "☐" : (modelData.ordered ? modelData.marker : "•"))
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.body
                        lineHeight: 1.45
                    }

                    Text {
                        id: item
                        anchors.left: bullet.right
                        anchors.right: parent.right
                        anchors.leftMargin: Style.space(3)
                        anchors.top: parent.top
                        textFormat: Text.RichText
                        text: root.span(modelData.text)
                        color: modelData.checked === true ? root.dim : root.muted
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.body
                        lineHeight: 1.5
                        wrapMode: Text.WordWrap
                        onLinkActivated: function (url) { root.linkActivated(url) }
                        HoverHandler { cursorShape: item.hoveredLink !== "" ? Qt.PointingHandCursor : Qt.ArrowCursor }
                    }
                }
            }
        }
    }

    Component {
        id: ruleBlock
        Item {
            width: parent.width
            implicitHeight: Style.space(26)
            Rectangle {
                anchors.centerIn: parent
                width: parent.width
                height: 1
                color: root.rule
            }
        }
    }

    Component {
        id: quoteBlock
        Item {
            width: parent.width
            /*
             * Room above and below, not just below.
             *
             * A callout is an aside — it has to detach from the prose on BOTH
             * sides or it reads as a paragraph someone drew a line next to.
             * The rule tracks the text with the same inset, so the bar grows
             * with the quote rather than floating short of it.
             */
            implicitHeight: quoted.implicitHeight + Style.space(30)

            Rectangle {
                x: 0
                y: Style.space(12)
                width: 2
                height: quoted.implicitHeight
                color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.5)
            }

            Text {
                id: quoted
                x: Style.space(14)
                y: Style.space(12)
                width: parent.width - Style.space(14)
                textFormat: Text.RichText
                text: root.span(modelData.text)
                color: root.muted
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                lineHeight: 1.5
                wrapMode: Text.WordWrap
                onLinkActivated: function (url) { root.linkActivated(url) }
            }
        }
    }

    Component {
        id: tableBlock
        /*
         * A real table: aligned columns, a ruled header, one row per row.
         *
         * It used to join cells with " · " into a single wrapped line, which
         * is not a table — a three-column spec sheet rendered as run-on prose
         * that a reader has to re-parse in their head. Model cards use tables
         * for exactly the content that needs alignment: locales by tier,
         * variants by size, benchmarks by task.
         *
         * The header also emitted the literal string "&lt;b>" where it meant
         * "<b>", so every heading cell showed its own markup.
         */
        Column {
            id: table
            width: parent.width
            spacing: Style.space(4)
            topPadding: Style.space(4)
            bottomPadding: Style.space(14)

            /**
             * Column widths, weighted by the longest cell in each.
             *
             * Equal fractions waste the width a one-word column does not need
             * and starve the prose column that does. Measured in characters
             * rather than pixels because this is monospace and the two are the
             * same fact — and clamped so a single long cell cannot collapse
             * every other column to nothing.
             */
            readonly property var weights: {
                var all = [modelData.headers].concat(modelData.rows)
                var widths = []
                for (var c = 0; c < modelData.headers.length; c++) {
                    var longest = 1
                    for (var r = 0; r < all.length; r++) {
                        var cell = String((all[r] || [])[c] || "")
                        if (cell.length > longest) longest = cell.length
                    }
                    widths.push(Math.max(6, Math.min(longest, 48)))
                }
                var total = 0
                for (var i = 0; i < widths.length; i++) total += widths[i]
                return widths.map(function (w) { return w / total })
            }

            Row {
                width: parent.width
                spacing: Style.space(10)

                Repeater {
                    model: modelData.headers
                    Text {
                        required property var modelData
                        required property int index
                        width: table.cellWidth(index)
                        textFormat: Text.PlainText
                        text: String(modelData)
                        /*
                         * PLAIN text, and the accent.
                         *
                         * A heading rendered through `span` inherited whatever
                         * emphasis its cell contained, so a header sat at the
                         * same weight as the bold first column beneath it and
                         * the table read as four body rows. Colour separates
                         * them where weight cannot: nothing in the body is
                         * ever the accent.
                         *
                         * Plain rather than rich because a header cell is a
                         * label — markup inside one is noise, and rendering it
                         * is how `<b>` ended up on screen as text.
                         */
                        color: root.accent
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        font.bold: true
                        wrapMode: Text.WordWrap
                    }
                }
            }

            // Ruled, because a header that only differs by weight stops
            // reading as a header the moment a body cell is also bold.
            Rectangle {
                width: parent.width
                height: 1
                // `foreground`, not `body`: the inline palette uses the name `body`
                // for this colour, but the component's own property is
                // `foreground` — reading `root.body` threw on every table drawn.
                color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.16)
            }

            Repeater {
                model: modelData.rows

                Row {
                    required property var modelData
                    width: table.width
                    spacing: Style.space(10)

                    Repeater {
                        model: parent.modelData

                        Text {
                            id: cell
                            required property var modelData
                            required property int index
                            width: table.cellWidth(index)
                            textFormat: Text.RichText
                            // Emphasis pinned to the cell's own colour: a bold
                            // first column is how a card marks a row's KEY, and
                            // brightening it made every table look like it was
                            // shouting one column at you.
                            text: root.span(String(modelData), root.muted)
                            color: root.muted
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.caption
                            wrapMode: Text.WordWrap
                            onLinkActivated: function (url) { root.linkActivated(url) }
                            HoverHandler { cursorShape: cell.hoveredLink !== "" ? Qt.PointingHandCursor : Qt.ArrowCursor }
                        }
                    }
                }
            }

            /** One column's width, less its share of the gaps between them. */
            function cellWidth(index) {
                var gaps = Style.space(10) * Math.max(0, table.weights.length - 1)
                var usable = Math.max(0, table.width - gaps)
                return Math.floor(usable * (table.weights[index] || 0))
            }
        }
    }
}
