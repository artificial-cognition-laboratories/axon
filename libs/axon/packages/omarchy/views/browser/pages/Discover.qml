import QtQuick
import QtQuick.Controls
import qs.Commons

import "../../../components"
import "../../../src/format.js" as Format

/**
 * The results list.
 *
 * Rows rather than cards: at this width a card buys a thumbnail nobody needs
 * and costs three models' worth of vertical space. What a person compares here
 * is name, size, and whether it is already on the machine, and rows put those
 * in columns you can scan.
 */
Item {
    id: root

    property var results: []
    property int cursor: 0
    property var machine: null
    /** The daemon command path, for asking the registry for another page. */
    property var service: null
    /** The live query, passed down so a row can show what matched. */
    property string term: ""

    property color foreground: Color.menu.text
    property color accent: "#0094d2"
    property string fontFamily: Style.font.menuFamily

    signal picked(int index)

    /** "relevance" | "downloads" | "size" | "recent" */
    property string sort: "relevance"
    property bool fitsOnly: true

    signal sortChanged2(string next)
    signal fitsToggled()

    readonly property var sorts: ["relevance", "downloads", "size", "recent"]

    /** The same set the cycle used, in the shape a menu takes. */
    readonly property var sortOptions: root.sorts.map(function (value) {
        return { value: value, label: root.sortLabels[value] || value }
    })
    readonly property var sortLabels: ({
        relevance: "Best match", downloads: "Downloads", size: "Size", recent: "Newest",
    })

    /**
     * The running transfer for a model, or null.
     *
     * Matched on the repository, because a download names the specifier that
     * was asked for while a catalogue row names the repository — the same
     * mismatch `mark()` handles daemon-side, and for the same reason.
     */
    /** What has been asked for on this model but not yet confirmed. See Service. */
    function intentFor(record) {
        var map = root.service ? root.service.intents : null
        if (!record || !map) return ""
        for (var id in map) {
            if (String(record.id).indexOf(id) === 0 || id.indexOf(String(record.id)) === 0) return map[id]
        }
        return ""
    }

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

    Text {
        anchors.centerIn: parent
        visible: root.results.length === 0
        textFormat: Text.PlainText
        // A cold scope is SEARCHING, not empty. Saying "no models match" while
        // the request is still out is wrong, and it is the state a person sees
        // most often on a first visit to a scope.
        // Names the query when there is one. "No models match" over a search
        // box someone forgot they typed in reads as a broken catalogue — which
        // is exactly how it read when dictation typed into this field.
        text: root.service && root.service.searchingCold
            ? "Searching…"
            : (root.term !== "" ? "No models match \u201C" + root.term + "\u201D" : "No models match")
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        font.italic: true

        SequentialAnimation on opacity {
            running: !!root.service && root.service.searchingCold
            loops: Animation.Infinite
            alwaysRunToEnd: true
            NumberAnimation { to: 0.4; duration: 600; easing.type: Easing.InOutQuad }
            NumberAnimation { to: 1.0; duration: 600; easing.type: Easing.InOutQuad }
        }
    }

    // Mirrors the rail's own section heading, so the first result lines up with
    // the first scope rather than floating above it — and says what is being
    // listed, which the rail alone does not once a query narrows it.
    Item {
        id: headingRow
        anchors.top: parent.top
        anchors.left: parent.left
        anchors.right: parent.right
        height: Style.space(30)

        Text {
            id: heading
            anchors.left: parent.left
            anchors.leftMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        // "LOADED", not a total: the registry publishes no count and pages by
        // cursor, so this describes what is here and says nothing about what
        // exists.
        text: root.results.length === 0 ? "" : (root.results.length + " LOADED")
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.bold: true
        }

        Row {
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            ListControl {
                // "Runs here", not "fits": it now covers format as
                // well as memory, and "fits" only ever described one of them.
                label: "Runs on this machine"
                active: root.fitsOnly
                foreground: root.foreground
                accent: root.accent
                fontFamily: root.fontFamily
                onClicked: root.fitsToggled()
            }

            Dropdown {
                options: root.sortOptions
                value: root.sort
                foreground: root.foreground
                accent: root.accent
                fontFamily: root.fontFamily
                onSelected: function (next) { root.sortChanged2(next) }
            }
        }
    }

    ListView {
        id: list
        anchors.top: headingRow.bottom
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.topMargin: Style.space(2)
        visible: root.results.length > 0
        model: root.results
        clip: true
        spacing: Style.space(2)
        currentIndex: root.cursor
        highlightMoveDuration: 90
        // Keep the selection in view while the arrows drive it from the
        // search field, which never loses focus.
        preferredHighlightBegin: height * 0.2
        preferredHighlightEnd: height * 0.8
        highlightRangeMode: ListView.ApplyRange
        boundsBehavior: Flickable.StopAtBounds
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        /*
         * Fetch the next page as the foot comes into view.
         *
         * Also when the list is SHORT: a query narrow enough to return under a
         * screenful never scrolls, so waiting for a scroll event would leave it
         * on one page forever with more waiting behind the cursor.
         */
        function reachedEnd() {
            return root.results.length < 20 || (contentY + height) >= (contentHeight - Style.space(200))
        }

        function maybeMore() {
            if (!root.service || !root.service.hasMore || root.service.loadingMore) return
            if (reachedEnd()) root.service.loadMore()
        }

        onContentYChanged: maybeMore()
        onCountChanged: Qt.callLater(maybeMore)

        footer: Item {
            width: list.width
            height: root.service && (root.service.loadingMore || root.service.hasMore)
                ? Style.space(44) : 0

            Text {
                anchors.centerIn: parent
                visible: !!root.service && root.service.loadingMore
                textFormat: Text.PlainText
                text: "Loading more…"
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.italic: true

                SequentialAnimation on opacity {
                    running: !!root.service && root.service.loadingMore
                    loops: Animation.Infinite
                    NumberAnimation { to: 0.4; duration: 600; easing.type: Easing.InOutQuad }
                    NumberAnimation { to: 1.0; duration: 600; easing.type: Easing.InOutQuad }
                }
            }
        }

        delegate: ModelRow {
            required property var modelData
            required property int index
            width: list.width
            record: modelData
            selected: index === root.cursor
            term: root.term
            controls: true
            transfer: root.transferFor(modelData)
            pending: root.service ? root.intentFor(modelData) : ""
            // An estimate wears a tilde. See ModelRow.sizeColor.
            sizeText: modelData.bytes
                ? Format.bytes(modelData.bytes)
                : (modelData.estimatedBytes ? "~" + Format.bytes(modelData.estimatedBytes) : "")
            foreground: root.foreground
            accent: root.accent
            fontFamily: root.fontFamily
            onActivated: root.picked(index)
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
