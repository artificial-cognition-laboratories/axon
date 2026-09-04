import QtQuick
import qs.Commons

import "../src/format.js" as Format

/**
 * One model in the results list.
 *
 * The row's state is read straight off `ModelRecord` — no derived flags. The
 * four states the record can express are the four this draws, including the
 * one every other model manager gets wrong: fetched, and nothing on this
 * machine can run it.
 */
Item {
    id: root

    property var record: null
    property bool selected: false
    /** The live query, so a row can show which part of it matched. */
    property string term: ""

    property color foreground: Color.menu.text
    property color accent: "#0094d2"
    property string fontFamily: Style.font.menuFamily

    signal activated()

    /**
     * Inline actions, emitted for the owner to route.
     *
     * The row knows what STATE a model is in and therefore which verbs make
     * sense; it does not know how to perform any of them. Wiring the service
     * in here would put the daemon inside a list delegate that a search
     * rebuilds forty times a keystroke.
     */
    signal download()
    signal cancel()
    signal load()
    signal unload()
    signal remove()

    /** Whether to offer the inline actions at all. Off in a bare listing. */
    property bool controls: false

    readonly property color dim: Qt.darker(foreground, 1.55)

    /** "remote" | "cached" | "resident" | "unrunnable" */
    readonly property string state: {
        if (!record) return "remote"
        if (!record.cached) return "remote"
        if (record.resident) return "resident"
        if (!record.runtime) return "unrunnable"
        return "cached"
    }

    readonly property string action: {
        switch (state) {
        case "resident": return "LOADED"
        case "cached": return "ON DISK"
        case "unrunnable": return "NO RUNTIME"
        default: return record && record.fit === "over" ? "TOO LARGE" : ""
        }
    }

    /**
     * The size, and how confident we are in it.
     *
     * A tilde marks an estimate read from the model's name rather than
     * published by the registry — Hugging Face listings carry no size, so most
     * rows are estimates, and a number that looks measured when it was guessed
     * is the kind of small dishonesty that erodes a whole surface.
     */
    readonly property color sizeColor: {
        if (!record) return dim
        if (record.fit === "over") return Qt.darker(foreground, 2.2)
        if (record.fit === "tight") return "#e0a640"
        return dim
    }

    width: parent ? parent.width : implicitWidth
    implicitHeight: Style.space(44)

    /** Breathing room between the highlight's edge and the text inside it. */
    readonly property real inset: Style.space(10)

    Rectangle {
        anchors.fill: parent
        radius: Style.cornerRadius
        color: root.selected
            ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.14)
            : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.05)
        visible: root.selected || hover.hovered
    }

    Column {
        anchors.left: parent.left
        anchors.leftMargin: root.inset
        anchors.right: actions.left
        anchors.rightMargin: Style.space(10)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(2)

        Text {
            width: parent.width
            textFormat: Text.RichText
            text: root.record ? Format.highlight(root.record.name, root.term, root.accent) : ""
            // Brand-coloured once the weight is HERE, resident or not. The
            // question a list answers first is "do I have this", and colour
            // answers it faster than a word at the far right of the row.
            color: root.state !== "remote" ? root.accent : root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            elide: Text.ElideRight
        }

        Text {
            width: parent.width
            textFormat: Text.RichText
            text: root.record
                ? Format.highlight(root.record.owner, root.term, root.accent)
                    + " · " + root.record.source
                : ""
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
        }
    }

    /*
     * The verbs this row's state actually permits.
     *
     * Always drawn, not revealed on hover. Hidden controls are controls
     * nobody knows are there — and the whole point of putting them on the row
     * is that downloading or loading should not require opening the model
     * first. A row shows at most two: the one thing you would do with it in
     * its current state, and delete.
     *
     * The row is the same height with or without them, because a list that
     * reflows under the cursor cannot be clicked accurately.
     */
    Row {
        id: actions
        anchors.right: badge.left
        anchors.rightMargin: actions.width > 0 ? Style.space(10) : 0
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(2)
        /*
         * No `width` binding.
         *
         * It read `visible ? implicitWidth : 0`, which is a Row's width bound
         * to the width it derives from its own children — a loop Qt breaks by
         * leaving it at zero. The whole chain hung off that: the badge
         * anchored to this Row's left edge and the name column to the badge's,
         * so a zero-width Row collapsed the actions to nothing and drew none
         * of them.
         *
         * A Row sizes itself from its visible children. Gating each child on
         * `controls` is what makes this collapse to zero when there are no
         * actions, without ever describing its own width.
         */

        /*
         * Stopping a transfer, offered only while one is running.
         *
         * A download is the one action here that takes long enough to regret,
         * and it is started by a single click on a row — so the way out has to
         * be in the same place, not on a page you have to open. It replaces
         * the download icon rather than sitting beside it: there is exactly
         * one thing to do with a model that is already arriving.
         */
        IconButton {
            visible: root.controls && root.downloading
            glyph: "\uea76"  // codicon close
            destructive: true
            foreground: root.foreground
            accent: root.accent
            fontFamily: root.fontFamily
            onClicked: root.cancel()
        }

        IconButton {
            visible: root.controls && root.state === "remote" && !root.busy
            glyph: "\ueac2"  // codicon cloud-download
            foreground: root.foreground
            accent: root.accent
            fontFamily: root.fontFamily
            onClicked: root.download()
        }

        IconButton {
            visible: root.controls && root.state === "cached" && !root.busy
            glyph: "\ueaa1"  // codicon play
            foreground: root.foreground
            accent: root.accent
            fontFamily: root.fontFamily
            onClicked: root.load()
        }

        IconButton {
            visible: root.controls && root.state === "resident" && !root.busy
            glyph: "\uead7"  // codicon debug-stop
            foreground: root.foreground
            accent: root.accent
            fontFamily: root.fontFamily
            onClicked: root.unload()
        }

        // Deleting bytes is not the same kind of act as loading them, and the
        // colour says so without a confirmation step in a list.
        IconButton {
            visible: root.controls && root.state !== "remote" && !root.busy
            glyph: "\uea81"  // codicon trash
            destructive: true
            foreground: root.foreground
            accent: root.accent
            fontFamily: root.fontFamily
            onClicked: root.remove()
        }
    }

    Column {
        id: badge
        anchors.right: parent.right
        anchors.rightMargin: root.inset
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(2)

        Text {
            anchors.right: parent.right
            textFormat: Text.PlainText
            text: root.sizeText
            color: root.sizeColor
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
        }

        Text {
            anchors.right: parent.right
            visible: root.action !== "" && !root.busy
            textFormat: Text.PlainText
            text: root.action
            color: root.state === "unrunnable" || root.action === "TOO LARGE"
                ? Qt.darker(root.foreground, 2.0) : root.accent
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.bold: true
        }

        /*
         * While it downloads, the row says so where the state usually goes.
         *
         * A rate rather than a percentage on its own: "1.2 MB/s" answers the
         * question a percentage cannot, which is whether anything is actually
         * happening. Many transfers report no total at all — chunked responses
         * have no length — so a bar alone would sit empty for the whole
         * download on exactly the models that take longest.
         */
        Text {
            anchors.right: parent.right
            visible: root.busy
            textFormat: Text.PlainText
            text: root.pendingLabel !== "" ? root.pendingLabel
                : (root.rate > 0 ? Format.bytes(root.rate) + "/s" : "starting…")
            color: root.accent
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.bold: true
        }
    }

    /*
     * The transfer, drawn along the row's own bottom edge.
     *
     * Inside the row's footprint rather than added beneath it: a list whose
     * rows change height as downloads start and finish moves every row below
     * them, and the one thing someone is doing while a model downloads is
     * looking at other models.
     *
     * Indeterminate when the server declares no length — the shuttle says
     * "running, length unknown", where a bar resting at zero says "stuck".
     */
    Rectangle {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.leftMargin: root.inset
        anchors.rightMargin: root.inset
        anchors.bottomMargin: Style.space(3)
        height: Style.space(2)
        radius: height / 2
        visible: root.busy
        color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)

        Rectangle {
            visible: root.progress >= 0
            width: parent.width * Math.max(0, root.progress)
            height: parent.height
            radius: parent.radius
            color: root.accent
            Behavior on width { NumberAnimation { duration: 300; easing.type: Easing.OutQuad } }
        }

        BusyTrack {
            anchors.fill: parent
            visible: root.progress < 0
            active: root.busy
            accent: root.accent
            track: "transparent"
        }
    }

    Rectangle {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.leftMargin: root.inset
        anchors.rightMargin: root.inset
        anchors.bottomMargin: Style.space(3)
        height: Style.space(2)
        radius: height / 2
        visible: root.busy
        color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)

        Rectangle {
            visible: root.progress >= 0
            width: parent.width * Math.max(0, root.progress)
            height: parent.height
            radius: parent.radius
            color: root.accent
            Behavior on width { NumberAnimation { duration: 300; easing.type: Easing.OutQuad } }
        }

        BusyTrack {
            anchors.fill: parent
            visible: root.progress < 0
            active: root.busy
            accent: root.accent
            track: "transparent"
        }
    }

    /** Set by the owner, which holds the formatter. */
    property string sizeText: ""

    /**
     * The transfer for this model, when one is running. Supplied by the owner,
     * which is the only thing holding the daemon's download list.
     *
     * Called `transfer`, not `download`: this object already has a `download`
     * SIGNAL, and a property of the same name shadows it — `root.download()`
     * resolved to the property rather than the signal and the button did
     * nothing at all. QML accepts the pair without a word, which is exactly
     * what made it hard to see.
     */
    property var transfer: null

    /** "download" | "load" | "unload" — asked for, not yet confirmed. */
    property string pending: ""

    readonly property bool downloading: (!!transfer && transfer.state === "downloading")
        || pending === "download"

    /** Any operation in flight, which is what suppresses the row's usual verbs. */
    readonly property bool busy: downloading || pending === "load" || pending === "unload"

    /** What the row says while it works. */
    readonly property string pendingLabel: {
        switch (pending) {
        case "load": return "LOADING"
        case "unload": return "UNLOADING"
        default: return ""
        }
    }
    readonly property real progress: {
        if (!downloading || !transfer.total || transfer.total <= 0) return -1
        return Math.max(0, Math.min(1, transfer.received / transfer.total))
    }

    /*
     * Transfer rate, measured here because nothing upstream reports one.
     *
     * The daemon publishes bytes received, not a speed — a rate is a property
     * of an observer over an interval, and the daemon has no interval. Two
     * samples and the wall clock give it, smoothed so the number is readable
     * rather than twitching every frame.
     */
    property real rate: 0
    property real lastBytes: -1
    property double lastAt: 0

    onTransferChanged: {
        if (!downloading) { rate = 0; lastBytes = -1; return }
        var now = Date.now()
        if (lastBytes >= 0 && now > lastAt) {
            var instant = (transfer.received - lastBytes) * 1000 / (now - lastAt)
            // Only ever forward: a stall should decay the number, not make it
            // negative, and a burst should not make it spike.
            rate = rate > 0 && instant >= 0 ? rate * 0.7 + instant * 0.3 : Math.max(0, instant)
        }
        lastBytes = transfer.received
        lastAt = now
    }

    HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }

    /*
     * Opening the model, unless the tap landed on one of its actions.
     *
     * Two TapHandlers over the same point BOTH fire — a handler does not
     * consume an event the way a MouseArea does — so pressing Download also
     * opened the detail page, and the thing you asked for happened behind a
     * page you did not ask for.
     *
     * Excluded by geometry rather than by restructuring the row into nested
     * MouseAreas: the actions already occupy a known strip on the right, and
     * one comparison is cheaper to read than a second input layer.
     */
    TapHandler {
        onTapped: function (point) {
            if (actions.visible && actions.width > 0 && point.position.x >= actions.x) return
            root.activated()
        }
    }
}
