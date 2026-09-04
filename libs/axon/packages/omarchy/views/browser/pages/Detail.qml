import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Commons
import qs.Ui

import "../../../components"
import "../../../src/format.js" as Format
import "../../../src/markdown.js" as Markdown

/**
 * One model in full, over the content pane.
 *
 * ── What a detail page is for ───────────────────────────────────────────────
 *
 * Someone arrives here to answer four questions in order: what is this, can my
 * machine run it, is it worth the disk, and what does it actually do. So the
 * page is a name, an identity line, a block of figures, and the card — in that
 * order, with nothing between them competing for the eye.
 *
 * The figures are laid out as label/value pairs in two columns rather than a
 * run-on of separators. A dot-joined chain reads fine at three items and
 * becomes a wall at eight, which is what it had become.
 *
 * Rail and header stay put behind this — only the pane changes. On a keyboard
 * surface a frame that moves is a frame you have to re-find, and losing the
 * result list every time you inspect a model makes comparison impossible.
 */
Item {
    id: root

    property var record: null
    property var machine: null
    /** The daemon command path. Null while the service has not resolved. */
    property var service: null

    property color foreground: Color.menu.text
    property color accent: "#0094d2"
    property string fontFamily: Style.font.menuFamily

    signal dismissed()

    readonly property color dim: Qt.darker(foreground, 1.55)

    /** The full record, once fetched. Falls back to the listing row meanwhile. */
    readonly property var full: service && record ? service.detailFor(record.id) : null

    function request() {
        if (!service || !record) return
        attempted = false
        service.loadDetail(record.id)
        // Marked after the request so `failed` cannot fire on the frame before
        // the process has even started.
        Qt.callLater(function () { root.attempted = true })
    }

    onRecordChanged: request()
    Component.onCompleted: request()

    /**
     * What this machine has, read LIVE rather than off the row.
     *
     * A search result carries whatever was true when it was fetched, and the
     * catalogue caches those rows — so downloading a model and reopening it
     * showed "Download" again, because the row still said `cached: false` from
     * before. The stream always knows what is on disk and what is held; the
     * row is a description of a registry, not of this machine.
     */
    readonly property var local: {
        if (!record || !machine) return null
        var disk = machine.cached || []
        for (var i = 0; i < disk.length; i++) {
            if (disk[i].id === record.id || disk[i].name === record.name) return disk[i]
        }
        return null
    }

    readonly property bool isCached: !!local || (!!record && record.cached === true)

    readonly property bool isResident: {
        if (local && local.resident) return true
        if (!record || !machine || !machine.holds) return false
        for (var i = 0; i < machine.holds.length; i++) {
            if (machine.holds[i].model === record.id) return true
        }
        return false
    }

    /** True while this model is the one being fetched. */
    readonly property bool downloading: {
        if (!record || !machine || !machine.downloads) return false
        for (var i = 0; i < machine.downloads.length; i++) {
            var d = machine.downloads[i]
            if (d.model === record.id && d.state === "downloading") return true
        }
        return false
    }

    /** "remote" | "cached" | "resident" | "unrunnable" */
    readonly property string state: {
        if (!isCached) return "remote"
        if (isResident) return "resident"
        var runtime = local ? local.runtime : (record ? record.runtime : null)
        if (!runtime) return "unrunnable"
        return "cached"
    }

    /**
     * What this weight can actually do, in one place.
     *
     * Derived from `state` rather than hand-written per control, so the page
     * cannot offer Load for something that is not on the disk or Remove for
     * something that was never fetched. The primary verb is the first entry;
     * the rest are the inline icons beside it.
     *
     * Load appears only for a CACHED and runnable weight. Loading from a
     * browser used to be omitted entirely on the grounds that nothing here
     * would use the memory — but a person testing a weight, or holding one
     * warm before an agent needs it, is a real intent, and the hold it takes
     * names them as its holder so the machine's accounting still adds up.
     */
    readonly property var actions: {
        if (downloading) return []
        switch (state) {
        case "resident": return [
            { verb: "unload", label: "Unload", glyph: "\uead7", destructive: false },
            { verb: "remove", label: "Remove", glyph: "\uea81", destructive: true },
        ]
        case "cached": return [
            { verb: "load", label: "Load", glyph: "\ueaa1", destructive: false },
            { verb: "remove", label: "Remove", glyph: "\uea81", destructive: true },
        ]
        // Cached and unrunnable can still be DELETED — it is on the disk
        // either way, and "nothing here can run it" is the best reason to
        // want it gone. There is nothing to load it with, so no Load.
        case "unrunnable": return [
            { verb: "remove", label: "Remove", glyph: "\uea81", destructive: true },
        ]
        default: return [
            { verb: "download", label: "Download", glyph: "\ueac2", destructive: false },
        ]
        }
    }

    readonly property string primaryAction: downloading ? "Downloading\u2026"
        : (actions.length > 0 ? actions[0].label : "")

    /** The icons beside the primary verb. */
    readonly property var extraActions: actions.length > 1 ? actions.slice(1) : []

    function invoke(verb) {
        if (!service || !record) return
        if (downloading) return
        var id = local ? local.id : record.id
        switch (verb) {
        case "unload": service.unloadModel(id); break
        case "load": service.loadModel(id); break
        case "remove":
            service.removeModel(id)
            // Back out. The page describes a weight on this machine, and the
            // weight is about to stop being on this machine — staying would
            // leave the reader looking at a record whose every local figure is
            // about to go false under them.
            root.dismissed()
            break
        default: service.fetchModel(record.id); break
        }
    }

    /** Big numbers, short. 255143740 reads as nothing; 255.1M reads at a glance. */
    function count(n) {
        if (n === null || n === undefined) return "—"
        if (n >= 1000000000) return (n / 1000000000).toFixed(1) + "B"
        if (n >= 1000000) return (n / 1000000).toFixed(1) + "M"
        if (n >= 1000) return (n / 1000).toFixed(1) + "k"
        return String(n)
    }

    function text(value) {
        return value === null || value === undefined || value === "" ? "—" : String(value)
    }

    /** The figures, paired into two columns. Empty until the detail lands. */
    /**
     * The figures, paired into two columns — and only the ones there is an
     * answer for.
     *
     * Registries publish different things. Hugging Face has downloads, likes, a
     * licence and a parameter count; Ollama's library has a name and a size and
     * nothing else. Rendering a fixed grid meant an Ollama model showed eight
     * rows of dashes, which reads as a page that failed rather than a registry
     * that is terse. A row with no value is simply not a row.
     *
     * Falls back to the listing for anything the detail lacks: the row that
     * opened this page already knew the size.
     */
    readonly property var facts: {
        if (!full && !record) return []
        var f = full || {}
        var r = record || {}
        var size = f.storage || r.bytes

        var all = [
            { k: "Downloads", v: (f.downloads || r.downloads) ? count(f.downloads || r.downloads) : "" },
            { k: "License", v: f.license || "" },
            { k: "Likes", v: f.likes ? count(f.likes) : "" },
            { k: "Library", v: f.library || "" },
            { k: "Parameters", v: f.params ? count(f.params) : "" },
            { k: "Base model", v: f.baseModel ? Format.basename(f.baseModel) : "" },
            { k: "Size", v: size ? Format.bytes(size) : "" },
            { k: "Updated", v: f.updatedAt ? Qt.formatDate(new Date(f.updatedAt), "d MMM yyyy") : "" },
        ]

        var out = []
        for (var i = 0; i < all.length; i++) if (all[i].v !== "") out.push(all[i])
        return out
    }

    /** A registry that publishes no engagement figures gets no cards for them. */
    readonly property bool hasHeadline: !!full && (full.downloads !== null || full.likes !== null)

    readonly property bool hasCard: !!full && !!full.readme && String(full.readme).trim() !== ""

    /**
     * Where this model lives, for the case where we cannot show its card.
     *
     * Ollama's library publishes no card through its API at all, and a Hugging
     * Face repository can simply not ship a README. Either way the page has
     * somewhere to send someone, which is a better answer than an empty half
     * of the screen.
     */
    readonly property string homepage: {
        if (!record) return ""
        if (record.source === "ollama") {
            // The library is addressed by name; the tag after the colon is a
            // variant of the same entry.
            return "https://ollama.com/library/" + String(record.name).split(":")[0]
        }
        return "https://huggingface.co/" + record.owner + "/" + record.name
    }

    /**
     * Nothing renders until everything has arrived.
     *
     * A page that drew its title, then its figures a beat later, then its card
     * after that, reads as three separate loads however fast each one is. One
     * centred mark while the record is in flight, then the whole page at once,
     * is both calmer and — because the detail cache answers instantly on a
     * second visit — the state most people never see.
     */
    readonly property bool ready: !!full

    /**
     * A load that stopped without producing anything.
     *
     * Not every specifier resolves — an Ollama model has no Hugging Face
     * repository, a registry can refuse — and without this the page waited
     * forever on a record that was never coming, with no way back except
     * closing the whole surface. A failure that a person can act on beats one
     * they have to escape.
     */
    readonly property bool failed: !ready && !!service && !service.loadingDetail && attempted

    property bool attempted: false

    Item {
        anchors.fill: parent
        visible: !root.ready

        // Present in EVERY state, including this one. A loading view with no
        // way out is a trap, and a page that fails to resolve is exactly when
        // someone most wants to leave it.
        Row {
            id: loadingBack
            anchors.top: parent.top
            anchors.left: parent.left
            height: Style.space(26)
            spacing: Style.space(6)

            Text {
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: "\u2039"
                color: loadingBackHover.hovered ? root.foreground : root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.subtitle
            }

            Text {
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: "Back"
                color: loadingBackHover.hovered ? root.foreground : root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
            }

            HoverHandler { id: loadingBackHover; cursorShape: Qt.PointingHandCursor }
            TapHandler { onTapped: root.dismissed() }
        }

        Column {
            anchors.centerIn: parent
            spacing: Style.space(14)

            Chevron {
                anchors.horizontalCenter: parent.horizontalCenter
                color: root.accent
                size: Style.font.displayLarge
                weight: 0.13

                SequentialAnimation on opacity {
                    running: !root.ready && !root.failed
                    loops: Animation.Infinite
                    alwaysRunToEnd: true
                    NumberAnimation { to: 0.35; duration: 650; easing.type: Easing.InOutQuad }
                    NumberAnimation { to: 1.0; duration: 650; easing.type: Easing.InOutQuad }
                }
            }

            Text {
                anchors.horizontalCenter: parent.horizontalCenter
                textFormat: Text.PlainText
                text: root.record ? root.record.name : ""
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
            }

            Text {
                anchors.horizontalCenter: parent.horizontalCenter
                visible: root.failed
                textFormat: Text.PlainText
                text: "No details published for this model"
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.italic: true
            }

            ActionButton {
                anchors.horizontalCenter: parent.horizontalCenter
                visible: root.failed
                text: "Try again"
                foreground: root.foreground
                accent: root.accent
                fontFamily: root.fontFamily
                onClicked: root.request()
            }
        }
    }

    Flickable {
        anchors.fill: parent
        visible: root.ready
        contentWidth: width
        contentHeight: page.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        // Keep normal content scrolling. Selection needs a dedicated TextEdit
        // implementation; disabling this steals both drag and wheel navigation.
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
            id: page
            /*
             * One readable measure, centred — the same 575 every page here uses.
             *
             * The pane is as wide as the window and this content is prose,
             * settings rows and a text box, all of which get harder to read
             * the wider they run. 575 is the number these pages were tuned to
             * by eye; the rail and the card around them can grow without this
             * following, which is the point of pinning it.
             */
            anchors.horizontalCenter: parent.horizontalCenter
            width: Math.min(parent.width, Style.space(575))
            spacing: Style.space(14)

            // ── Breadcrumb and the one action ───────────────────────────────
            Item {
                width: parent.width
                height: Style.space(26)

                Row {
                    id: back
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Style.space(6)

                    // Its own glyph rather than a character in the label, so the
                    // chevron sits on the text's optical centre instead of its
                    // baseline — which is why it read as slightly dropped.
                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        textFormat: Text.PlainText
                        text: "\u2039"
                        color: backHover.hovered ? root.foreground : root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.subtitle
                    }

                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        textFormat: Text.PlainText
                        text: "Back"
                        color: backHover.hovered ? root.foreground : root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                    }

                    // Handlers on the ROW, not the row's container. On the
                    // container they spanned the full width and sat under the
                    // action button at the far end, so pressing Download went
                    // back instead — a destructive-feeling surprise on the one
                    // control the page exists for.
                    HoverHandler { id: backHover; cursorShape: Qt.PointingHandCursor }
                    TapHandler { onTapped: root.dismissed() }
                }

                Row {
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Style.space(6)
                    layoutDirection: Qt.RightToLeft

                    /*
                     * The primary verb, as an icon like every other verb here.
                     *
                     * It used to be a filled button, which made the same act
                     * look like two different things depending on where you
                     * triggered it — a blue slab on the detail page and a
                     * glyph on the row that opened it. One vocabulary is
                     * easier to learn and quieter to look at.
                     *
                     * Progress moves to the row's status text rather than into
                     * the button's label: an icon has nowhere to say
                     * "Working…", and dimming it says the same thing without
                     * needing the room.
                     */
                    IconButton {
                        anchors.verticalCenter: parent.verticalCenter
                        visible: root.primaryAction !== ""
                        glyph: root.actions.length > 0 ? root.actions[0].glyph : ""
                        enabled: !root.downloading && !(root.service && root.service.working)
                        opacity: enabled ? 1 : 0.4
                        // From the verb, not the state: with Load now the
                        // primary for a cached weight, keying off the state
                        // would paint Load in the delete colour.
                        destructive: root.actions.length > 0 && root.actions[0].destructive === true
                        foreground: root.foreground
                        accent: root.accent
                        fontFamily: root.fontFamily
                        onClicked: root.invoke(root.actions.length > 0 ? root.actions[0].verb : "")
                    }

                    /*
                     * The secondary verbs, inline. Icons rather than a second
                     * row of words: Remove sitting beside Load as an equal
                     * button reads as an equal choice, and it is not one.
                     */
                    Repeater {
                        model: root.extraActions
                        IconButton {
                            anchors.verticalCenter: parent.verticalCenter
                            glyph: modelData.glyph
                            destructive: modelData.destructive
                            enabled: !(root.service && root.service.working)
                            opacity: enabled ? 1 : 0.4
                            foreground: root.foreground
                            accent: root.accent
                            fontFamily: root.fontFamily
                            onClicked: root.invoke(modelData.verb)
                        }
                    }
                }
            }

            // What the last command said, when it had something to say. A
            // refusal here is usually actionable — a repository with several
            // weights wants one naming — so it is shown where the action was.
            Rectangle {
                width: parent.width
                visible: !!root.service && root.service.lastError !== ""
                height: visible ? failure.implicitHeight + Style.space(18) : 0
                radius: Style.cornerRadius
                color: Qt.rgba(0.88, 0.32, 0.32, 0.12)

                Text {
                    id: failure
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.leftMargin: Style.space(12)
                    anchors.rightMargin: Style.space(12)
                    textFormat: Text.PlainText
                    text: root.service ? root.service.lastError : ""
                    color: "#e88"
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    wrapMode: Text.WordWrap
                }
            }

            // ── Identity ────────────────────────────────────────────────────
            Column {
                width: parent.width
                spacing: Style.space(6)

                Text {
                    width: parent.width
                    textFormat: Text.PlainText
                    text: root.record ? root.record.name : ""
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.display
                    font.bold: true
                    elide: Text.ElideRight
                }

                Row {
                    width: parent.width
                    spacing: Style.space(8)

                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        textFormat: Text.PlainText
                        text: root.record ? root.record.owner : ""
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                    }

                    // Capability as a chip, because it is the one attribute a
                    // person filters on — a word in a sentence of separators
                    // does not read as the same thing they clicked in the rail.
                    Rectangle {
                        anchors.verticalCenter: parent.verticalCenter
                        visible: !!root.record && root.record.capability && root.record.capability !== "other"
                        width: capability.implicitWidth + Style.space(12)
                        height: capability.implicitHeight + Style.space(4)
                        radius: Style.cornerRadius
                        color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.16)

                        Text {
                            id: capability
                            anchors.centerIn: parent
                            textFormat: Text.PlainText
                            text: root.record ? String(root.record.capability).toUpperCase() : ""
                            color: root.accent
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.caption
                            font.bold: true
                        }
                    }

                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        textFormat: Text.PlainText
                        text: root.record && root.record.runtime ? root.record.runtime : "no runtime here"
                        color: root.record && root.record.runtime ? root.dim : Qt.darker(root.foreground, 2.1)
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                    }
                }
            }

            // ── The two figures worth reading first ─────────────────────────
            Row {
                width: parent.width
                spacing: Style.space(12)
                visible: root.hasHeadline

                StatCard {
                    width: (parent.width - Style.space(12)) / 2
                    label: "DOWNLOADS"
                    value: root.count(root.full ? root.full.downloads : null)
                    caption: "last 30 days"
                    foreground: root.foreground
                    accent: root.accent
                    fontFamily: root.fontFamily
                }

                StatCard {
                    width: (parent.width - Style.space(12)) / 2
                    label: "LIKES"
                    value: root.count(root.full ? root.full.likes : null)
                    caption: "all time"
                    foreground: root.foreground
                    accent: root.accent
                    fontFamily: root.fontFamily
                }
            }

            // ── Everything else worth knowing ───────────────────────────────
            Grid {
                width: parent.width
                columns: 2
                columnSpacing: Style.space(28)
                rowSpacing: Style.space(3)
                visible: root.facts.length > 0

                Repeater {
                    model: root.facts

                    Item {
                        required property var modelData
                        width: (page.width - Style.space(28)) / 2
                        height: Math.max(factKey.implicitHeight, factValue.implicitHeight)

                        Text {
                            id: factKey
                            anchors.left: parent.left
                            textFormat: Text.PlainText
                            text: modelData.k
                            color: root.dim
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.caption
                        }

                        Text {
                            id: factValue
                            anchors.left: parent.left
                            anchors.leftMargin: Style.space(90)
                            anchors.right: parent.right
                            textFormat: Text.PlainText
                            text: modelData.v
                            color: root.foreground
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.caption
                            elide: Text.ElideRight
                        }
                    }
                }
            }

            TagFlow {
                width: parent.width
                visible: !!root.full && (root.full.tags || []).length > 0
                tags: root.full ? (root.full.tags || []) : []
                foreground: root.foreground
                fontFamily: root.fontFamily
            }

            Rectangle {
                width: parent.width
                height: 1
                color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
            }

            // ── The card ────────────────────────────────────────────────────
            //
            // One QML item per block, not one Text for the document. Qt's rich
            // text cannot give a code fence a surface, a label or its own
            // scroll, and those are most of what makes a card readable.
            MarkdownView {
                width: parent.width
                visible: root.hasCard
                source: root.hasCard ? root.full.readme : ""
                foreground: root.foreground
                accent: root.accent
                fontFamily: root.fontFamily
                onLinkActivated: function (url) { Quickshell.execDetached(["xdg-open", url]) }
            }

            // An empty half-screen reads as a page that failed to load. This
            // says which it is — a registry that publishes no card, rather
            // than a card we could not fetch — and hands over the one thing
            // still worth offering.
            Item {
                width: parent.width
                height: Style.space(160)
                visible: !root.hasCard

                Column {
                    anchors.centerIn: parent
                    spacing: Style.space(10)

                    Text {
                        anchors.horizontalCenter: parent.horizontalCenter
                        textFormat: Text.PlainText
                        text: root.record && root.record.source === "ollama"
                            ? "Ollama's library publishes no model card"
                            : "This model ships no README"
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.body
                    }

                    ActionButton {
                        anchors.horizontalCenter: parent.horizontalCenter
                        visible: root.homepage !== ""
                        text: root.record && root.record.source === "ollama"
                            ? "View on ollama.com" : "View on huggingface.co"
                        foreground: root.foreground
                        accent: root.accent
                        fontFamily: root.fontFamily
                        onClicked: Quickshell.execDetached(["xdg-open", root.homepage])
                    }
                }
            }

            Item { width: 1; height: Style.space(8) }
        }
    }
}
