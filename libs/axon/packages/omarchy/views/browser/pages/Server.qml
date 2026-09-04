import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui

import "../../../components"
import "../../../src/format.js" as Format

/**
 * This machine: what it is doing, and every weight on it.
 *
 * ── Why one page and not two rail entries ───────────────────────────────────
 *
 * "Downloaded" and "Loaded" were separate scopes, and the split forced a
 * choice nobody has: the question is never "show me resident weights", it is
 * "I want to use one of my models", and answering that meant checking one list
 * and then the other. They are one set with a state, so they are one page with
 * two groups — and the search field narrows both at once, which is what makes
 * find-then-load a single motion.
 *
 * ── Why the machine's own readings sit on top ───────────────────────────────
 *
 * Whether to load something is a memory question. Putting the four resources
 * at the head of the page puts the answer beside the decision instead of in a
 * dropdown behind it. Inline rather than pinned: this is a header, not a
 * status bar, and a reader scrolling to their models should be able to leave
 * it behind.
 */
Item {
    id: root

    property var machine: null
    property var service: null

    /** The search text, so both groups narrow together. */
    property string term: ""

    property color foreground: Color.menu.text
    property color accent: "#0094d2"
    property string fontFamily: Style.font.menuFamily

    /**
     * The running transfer for a model, or null.
     *
     * Matched on the repository, because a download names the specifier that
     * was asked for while a catalogue row names the repository — the same
     * mismatch `mark()` handles daemon-side, and for the same reason.
     */
    function transferFor(record) {
        var list = root.machine ? root.machine.downloads : null
        if (!record || !list) return null
        for (var i = 0; i < list.length; i++) {
            if (list[i].state !== "downloading") continue
            if (String(list[i].model).indexOf(String(record.id)) === 0
                || String(record.id).indexOf(String(list[i].model)) === 0) return list[i]
        }
        return null
    }

    readonly property color dim: Qt.darker(foreground, 1.55)
    readonly property color rule: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.14)

    readonly property var capacity: machine ? machine.capacity : null
    readonly property var usage: machine ? machine.usage : null
    readonly property var samples: machine ? machine.samples : []
    readonly property bool live: !!machine && machine.health === "connected"

    signal picked(var record)

    /** One field out of the sample ring, as a plain series. See Overview. */
    function series(field) {
        var out = []
        for (var i = 0; i < samples.length; i++) out.push(samples[i][field])
        return out
    }

    readonly property var times: series("at")

    /** RAM is reported as available; a chart wants used. */
    function ramUsed() {
        var out = []
        if (!capacity) return out
        for (var i = 0; i < samples.length; i++) out.push(capacity.ram - samples[i].ramAvailable)
        return out
    }

    /** Axon's own share of a resource, or an empty series when unattributed. */
    function share(field) {
        var out = []
        for (var i = 0; i < samples.length; i++) {
            var mine = samples[i].axon
            out.push(mine ? mine[field] : null)
        }
        return out
    }

    function asPercent(value) { return Format.percent(value) }
    function asBytes(value) { return Format.bytes(value) }

    /*
     * Both groups come off the MACHINE, not the catalogue.
     *
     * `search` already answers "what is on this disk" from the live stream —
     * a catalogue row records what was true when the registry answered, so a
     * weight downloaded since would still say it was not here.
     */
    /** What the person has asked for and the daemon has not confirmed. */
    readonly property var pending: service ? service.intents : ({})

    function intentFor(record) {
        if (!record) return ""
        for (var id in pending) {
            if (String(record.id).indexOf(id) === 0 || id.indexOf(String(record.id)) === 0) return pending[id]
        }
        return ""
    }

    /*
     * ACTIVE is everything in motion or in memory; STORED is the rest.
     *
     * Grouping by "loaded" alone meant a weight you had just asked for stayed
     * in the lower group looking untouched until the daemon confirmed — the
     * one moment you are watching it. Downloading, loading and loaded are all
     * "this is what the machine is doing right now", which is one question;
     * what else is on the disk is another.
     *
     * An UNLOADING row stays in Active until it leaves, so it does not jump
     * groups and then jump back if the unload fails.
     */
    /**
     * Rows for transfers that have nothing on disk yet.
     *
     * A model being downloaded is not in `cached` — that is the whole point of
     * downloading it — so a group built from cached rows could never show one,
     * however the filtering was written. The transfer itself is the only
     * record that exists at that moment, so a row is made from it.
     *
     * Name and owner are parsed out of the specifier rather than looked up:
     * the catalogue row that started this may be on a page nobody is on any
     * more, and `hf:owner/name` already carries both.
     */
    readonly property var arriving: {
        if (!machine || !machine.downloads) return []
        var known = {}
        var rows = machine.search("", "cached")
        for (var i = 0; i < rows.length; i++) known[String(rows[i].id)] = true

        var out = []
        var q = String(term || "").toLowerCase().trim()
        for (var d = 0; d < machine.downloads.length; d++) {
            var job = machine.downloads[d]
            if (job.state !== "downloading") continue

            var already = false
            for (var k in known) {
                if (k.indexOf(String(job.model)) === 0 || String(job.model).indexOf(k) === 0) { already = true; break }
            }
            if (already) continue

            var body = String(job.model).replace(/^[a-z]+:/, "").split("@")[0]
            var parts = body.split("/")
            var owner = parts.length > 1 ? parts[0] : ""
            var name = parts.length > 1 ? parts.slice(1).join("/") : body
            if (q !== "" && (name + " " + owner).toLowerCase().indexOf(q) === -1) continue

            out.push({
                id: job.model, name: name, owner: owner,
                source: String(job.model).indexOf("ollama:") === 0 ? "ollama" : "huggingface",
                cached: false, resident: false, runtime: null, bytes: null,
            })
        }
        return out
    }

    readonly property var active: {
        if (!machine) return []
        var rows = machine.search(term, "cached")
        var out = []
        for (var i = 0; i < rows.length; i++) {
            var intent = intentFor(rows[i])
            if (rows[i].resident || intent !== "" || (service && service.transferring(rows[i].id))) out.push(rows[i])
        }
        // Arrivals first: the thing that is changing is the thing being watched.
        return arriving.concat(out)
    }

    readonly property var stored: {
        if (!machine) return []
        var live = {}
        for (var i = 0; i < active.length; i++) live[active[i].id] = true
        // A model in both groups reads as two models.
        return machine.search(term, "cached").filter(function (m) { return !live[m.id] })
    }

    Flickable {
        anchors.fill: parent
        contentWidth: width
        contentHeight: page.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
            id: page
            width: parent.width
            spacing: Style.space(14)

            // ── The machine ─────────────────────────────────────────────────

            Item {
                width: parent.width
                height: title.implicitHeight + Style.space(4) + subtitle.implicitHeight

                Text {
                    id: title
                    anchors.left: parent.left
                    anchors.top: parent.top
                    textFormat: Text.PlainText
                    text: "This machine"
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.subtitle
                    font.bold: true
                }

                Text {
                    id: subtitle
                    anchors.left: parent.left
                    anchors.top: title.bottom
                    anchors.topMargin: Style.space(4)
                    textFormat: Text.PlainText
                    text: root.capacity && root.capacity.gpu ? root.capacity.gpu : "Local inference"
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                }

                Text {
                    anchors.right: parent.right
                    anchors.verticalCenter: title.verticalCenter
                    textFormat: Text.PlainText
                    text: root.machine && root.machine.hasData
                        ? (Format.bytes(root.machine.held) + " held"
                            + (root.capacity && root.capacity.vram
                                ? " of " + Format.bytes(root.capacity.vram) : ""))
                        : ""
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                }
            }

            /*
             * Four resources across, one minute each.
             *
             * A minute rather than the dropdown's five: this is a glance at
             * what the machine is doing RIGHT NOW, taken while deciding
             * whether to load something. The longer window belongs where
             * someone is watching a trend rather than making a decision.
             */
            Row {
                width: parent.width
                spacing: Style.space(12)
                visible: !!root.machine && root.machine.hasData

                readonly property real cell:
                    Math.floor((width - Style.space(12) * 3) / 4)

                ResourceRow {
                    width: parent.cell
                    chartHeight: Style.space(22)
                    windowMs: 60000
                    label: "GPU"
                    format: root.asPercent
                    live: root.live
                    reading: root.usage ? Format.percent(root.usage.gpuUtil) : "—"
                    unavailable: root.usage && root.usage.gpuUtil !== null ? "" : "No GPU"
                    values: root.series("gpuUtil")
                    times: root.times
                    max: 100
                    foreground: root.foreground
                    accent: root.accent
                    fontFamily: root.fontFamily
                }

                ResourceRow {
                    width: parent.cell
                    chartHeight: Style.space(22)
                    windowMs: 60000
                    label: "VRAM"
                    format: root.asBytes
                    live: root.live
                    reading: root.usage && root.capacity
                        ? Format.bytes(root.usage.vramUsed) : "—"
                    unavailable: root.capacity && root.capacity.vram ? "" : "Unreadable"
                    values: root.series("vramUsed")
                    share: root.share("vram")
                    times: root.times
                    max: root.capacity ? root.capacity.vram : null
                    foreground: root.foreground
                    accent: root.accent
                    fontFamily: root.fontFamily
                }

                ResourceRow {
                    width: parent.cell
                    chartHeight: Style.space(22)
                    windowMs: 60000
                    label: "RAM"
                    format: root.asBytes
                    live: root.live
                    reading: root.usage && root.capacity
                        ? Format.bytes(root.capacity.ram - root.usage.ramAvailable) : "—"
                    values: root.ramUsed()
                    share: root.share("ram")
                    times: root.times
                    max: root.capacity ? root.capacity.ram : null
                    foreground: root.foreground
                    accent: root.accent
                    fontFamily: root.fontFamily
                }

                ResourceRow {
                    width: parent.cell
                    chartHeight: Style.space(22)
                    windowMs: 60000
                    label: "CPU"
                    format: root.asPercent
                    live: root.live
                    reading: root.usage ? Format.percent(root.usage.cpuUtil) : "—"
                    values: root.series("cpuUtil")
                    share: root.share("cpuUtil")
                    times: root.times
                    max: 100
                    foreground: root.foreground
                    accent: root.accent
                    fontFamily: root.fontFamily
                }
            }

            Rectangle { width: parent.width; height: 1; color: root.rule }

            // ── What is on it ───────────────────────────────────────────────

            PanelSectionHeader {
                text: "ACTIVE"
                foreground: root.foreground
                fontFamily: root.fontFamily
            }

            Text {
                width: parent.width
                visible: root.active.length === 0
                textFormat: Text.PlainText
                text: root.term === ""
                    ? "Nothing is loaded or downloading."
                    : "Nothing active matches."
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
            }

            // Its own column at the LIST's spacing, not the page's. Rows are
            // a list and read as one; the page's rhythm is for the blocks
            // between them.
            Column {
                width: parent.width
                spacing: Style.space(2)

                Repeater {
                    model: root.active

                    ModelRow {
                        required property var modelData
                        width: parent.width
                        record: modelData
                        term: root.term
                        controls: true
                        transfer: root.transferFor(modelData)
                        pending: root.intentFor(modelData)
                        // An estimate wears a tilde. See ModelRow.sizeColor.
                        sizeText: modelData.bytes
                            ? Format.bytes(modelData.bytes)
                            : (modelData.estimatedBytes ? "~" + Format.bytes(modelData.estimatedBytes) : "")
                        foreground: root.foreground
                        accent: root.accent
                        fontFamily: root.fontFamily
                        onActivated: root.picked(modelData)
                        onDownload: if (root.service) root.service.fetchModel(modelData.id)
                        onCancel: {
                            var job = root.transferFor(modelData)
                            if (job && root.service) root.service.cancelDownload(job.id)
                        }
                        onLoad: if (root.service) root.service.loadModel(modelData.id)
                        onUnload: if (root.service) root.service.unloadModel(modelData.id)
                        onRemove: if (root.service) root.service.removeModel(modelData.id)
                    }
                }
            }

            Item { width: 1; height: Style.space(4) }

            PanelSectionHeader {
                text: "STORED"
                foreground: root.foreground
                fontFamily: root.fontFamily
            }

            Text {
                width: parent.width
                visible: root.stored.length === 0
                textFormat: Text.PlainText
                text: root.term === ""
                    ? "No other weights on this disk yet."
                    : "Nothing stored matches."
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
            }

            // Its own column at the LIST's spacing, not the page's. Rows are
            // a list and read as one; the page's rhythm is for the blocks
            // between them.
            Column {
                width: parent.width
                spacing: Style.space(2)

                Repeater {
                    model: root.stored

                    ModelRow {
                        required property var modelData
                        width: parent.width
                        record: modelData
                        term: root.term
                        controls: true
                        transfer: root.transferFor(modelData)
                        pending: root.intentFor(modelData)
                        // An estimate wears a tilde. See ModelRow.sizeColor.
                        sizeText: modelData.bytes
                            ? Format.bytes(modelData.bytes)
                            : (modelData.estimatedBytes ? "~" + Format.bytes(modelData.estimatedBytes) : "")
                        foreground: root.foreground
                        accent: root.accent
                        fontFamily: root.fontFamily
                        onActivated: root.picked(modelData)
                        onDownload: if (root.service) root.service.fetchModel(modelData.id)
                        onCancel: {
                            var job = root.transferFor(modelData)
                            if (job && root.service) root.service.cancelDownload(job.id)
                        }
                        onLoad: if (root.service) root.service.loadModel(modelData.id)
                        onUnload: if (root.service) root.service.unloadModel(modelData.id)
                        onRemove: if (root.service) root.service.removeModel(modelData.id)
                    }
                }
            }

            Item { width: 1; height: Style.space(16) }
        }
    }
}
