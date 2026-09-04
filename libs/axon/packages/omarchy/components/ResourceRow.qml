import QtQuick
import qs.Commons

/**
 * One resource: a name, a reading, and its recent history as an area chart.
 *
 * `held` is optional and exists for video memory, where the machine's total use
 * and Axon's own share are different facts. It draws as a second series over
 * the first — "12.4 GB used, 8.1 GB of it yours" is the sentence this row is
 * built to say, and no other widget in the registry can say it.
 *
 * An unreadable resource says so. Null is not zero: a machine with no GPU and
 * a machine whose GPU cannot be probed are different, and a meter resting at
 * the floor would claim the second is idle.
 *
 * ── Hovering ────────────────────────────────────────────────────────────────
 *
 * The chart reads at a glance and answers precisely on hover: a hairline at
 * the pointer, a dot on every series it crosses, and a small box quoting the
 * readings and when they were taken. Nothing moves and nothing expands — the
 * row is the same size hovered as not, because four of these stacked in a
 * dropdown cannot reflow under the pointer.
 */
Item {
    id: root

    property string label: ""
    /** Display string for the current reading — already formatted by the caller. */
    property string reading: ""
    /** Why there is no reading. Shown in place of the chart when set. */
    property string unavailable: ""

    /** Numbers, oldest first. */
    property var values: []
    /** When each reading was taken, epoch ms, aligned with `values`. */
    property var times: []
    /**
     * Optional second series drawn over the first, in brand cyan: Axon's own
     * share of this resource.
     *
     * Null entries are gaps, not zeroes — see Sparkline.runs. A resource we
     * cannot attribute simply has no second line.
     */
    property var share: []
    property var max: null

    /**
     * Turns one raw value into the string the hover box shows.
     *
     * Supplied by the caller because only it knows whether this series is
     * bytes or a percentage — the same reason `reading` arrives pre-formatted.
     * Without one the box would have to guess, and a guess here prints video
     * memory as "11811160064".
     */
    property var format: null

    /** Whether the stream is live, so the axis may advance between readings. */
    property bool live: false

    /**
     * How tall the chart is, and how much history it shows.
     *
     * Both exposed so the same row can serve a dropdown and a page header. A
     * second, smaller component would have been a second copy of the hover
     * logic — the hairline, the per-series dots, the tooltip — which is most
     * of this file and none of what differs between the two uses.
     */
    property real chartHeight: Style.space(32)
    property int windowMs: 300000

    property color foreground: Color.foreground
    property color accent: "#0094d2"
    property string fontFamily: Style.font.family

    readonly property color dim: Qt.darker(foreground, 1.55)

    /**
     * Whether the second series has anything to say.
     *
     * Needs a real reading above zero somewhere in the window. A line flat
     * along the baseline is not information — it reads as a drawing artefact
     * rather than as "Axon is holding nothing" — and an all-null series is a
     * resource this machine cannot attribute at all.
     */
    readonly property bool hasShare: {
        if (!share || share.length < 2) return false
        for (var i = 0; i < share.length; i++) if (Number(share[i]) > 0) return true
        return false
    }

    width: parent ? parent.width : implicitWidth
    implicitHeight: header.height + Style.space(4) + chart.height

    Item {
        id: header
        width: parent.width
        height: Math.max(name.implicitHeight, value.implicitHeight)

        Text {
            id: name
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText
            text: root.label
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.bold: true
        }

        Text {
            id: value
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText
            text: root.unavailable !== "" ? "—" : root.reading
            color: root.unavailable !== "" ? root.dim : root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
        }
    }

    Item {
        id: chart
        anchors.top: header.bottom
        anchors.topMargin: Style.space(4)
        width: parent.width
        height: root.chartHeight

        /** Where the pointer is, in chart coordinates. Negative means gone. */
        property real cursor: -1
        readonly property bool probing: cursor >= 0 && root.unavailable === "" && total.drawable

        readonly property var totalHit: probing ? total.nearest(cursor) : null
        readonly property var shareHit: probing && root.hasShare ? mine.nearest(cursor) : null

        // The machine as a whole, in the panel foreground at low weight.
        Sparkline {
            id: total
            anchors.fill: parent
            visible: root.unavailable === ""
            values: root.values
            times: root.times
            max: root.max
            live: root.live
            windowMs: root.windowMs
            stroke: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.45)
            fill: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.14)
        }

        // Axon's share, over the top, in brand cyan.
        Sparkline {
            id: mine
            anchors.fill: parent
            // Hidden while our share is zero throughout: a flat line along the
            // baseline is not information, and it reads as a drawing artefact
            // rather than as "Axon is holding nothing".
            visible: root.unavailable === "" && root.hasShare
            values: root.share
            times: root.times
            max: root.max
            live: root.live
            windowMs: root.windowMs
            stroke: root.accent
            fill: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.30)
        }

        /*
         * The newest reading, marked. A chart of a live machine that shows no
         * sign of being live reads as a screenshot — this is the one element
         * that says the number at the top is still moving.
         */
        Rectangle {
            visible: root.unavailable === "" && total.head !== null && !chart.probing
            x: (total.head ? total.head.x : 0) - width / 2
            y: (total.head ? total.head.y : 0) - height / 2
            width: Style.space(4)
            height: width
            radius: width / 2
            color: root.hasShare ? root.accent : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.75)
        }

        // ── The probe ───────────────────────────────────────────────────────

        Rectangle {
            visible: chart.probing && chart.totalHit !== null
            x: chart.totalHit ? chart.totalHit.x : 0
            width: 1
            height: parent.height
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.22)
        }

        Repeater {
            // One dot per series the hairline crosses, so a hover on the VRAM
            // row marks the machine's reading and ours at the same instant.
            model: chart.probing
                ? (chart.shareHit ? [chart.totalHit, chart.shareHit] : [chart.totalHit])
                : []
            Rectangle {
                visible: !!modelData
                x: (modelData ? modelData.x : 0) - width / 2
                y: (modelData ? modelData.y : 0) - height / 2
                width: Style.space(5)
                height: width
                radius: width / 2
                color: index === 1 ? root.accent : root.foreground
                border.width: 1
                border.color: Color.menu.background
            }
        }

        Text {
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            visible: root.unavailable !== ""
            textFormat: Text.PlainText
            text: root.unavailable
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.italic: true
        }

        HoverHandler {
            id: probe
            onPointChanged: chart.cursor = point.position.x
            onHoveredChanged: if (!hovered) chart.cursor = -1
        }
    }

    /*
     * The hover box.
     *
     * Sits above the chart rather than beside the pointer: at thirty pixels
     * tall there is nowhere inside the chart a box can go without covering the
     * line it describes. A child of the ROW, not the chart, so it can overhang
     * both without being clipped by either.
     */
    Rectangle {
        id: tip
        visible: chart.probing && chart.totalHit !== null
        z: 10
        // Clamped to the row, so a reading near either edge stays legible
        // instead of hanging off the panel.
        x: Math.max(0, Math.min(root.width - width, (chart.totalHit ? chart.totalHit.x : 0) - width / 2))
        y: chart.y - height - Style.space(4)
        width: tipContent.implicitWidth + Style.space(16)
        height: tipContent.implicitHeight + Style.space(10)
        radius: Style.cornerRadius
        color: Color.menu.background
        border.width: 1
        border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.16)
        opacity: visible ? 1 : 0
        Behavior on opacity { NumberAnimation { duration: 90 } }

        Column {
            id: tipContent
            anchors.centerIn: parent
            spacing: Style.space(2)

            Text {
                textFormat: Text.PlainText
                text: root.hit(chart.totalHit)
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
            }

            Text {
                visible: chart.shareHit !== null
                textFormat: Text.PlainText
                text: "Axon " + root.hit(chart.shareHit)
                color: root.accent
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
            }

            Text {
                textFormat: Text.PlainText
                text: root.ago(chart.totalHit)
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
            }
        }
    }

    /** One hovered reading, in the caller's units. */
    function hit(point) {
        if (!point) return ""
        return root.format ? root.format(point.v) : String(point.v)
    }

    /** How long ago a hovered reading was taken. */
    function ago(point) {
        if (!point || !times || point.i >= times.length) return ""
        var seconds = Math.max(0, Math.round((Date.now() - times[point.i]) / 1000))
        if (seconds < 1) return "now"
        if (seconds < 60) return seconds + "s ago"
        var minutes = Math.floor(seconds / 60)
        return minutes + "m " + (seconds % 60) + "s ago"
    }
}
