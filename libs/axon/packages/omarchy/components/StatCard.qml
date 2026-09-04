import QtQuick
import qs.Commons

/**
 * One headline figure, in a card.
 *
 * The pattern Axon's own registry uses for stars and installs: a small label, a
 * large number, and the shape of it over time underneath. Two side by side is
 * the rhythm the top of a detail page wants — a number you can read from
 * across the room, before any of the fine print.
 *
 * ── The chart is optional, deliberately ─────────────────────────────────────
 *
 * Hugging Face publishes totals, not series: `downloads` is a thirty-day count
 * and `likes` is a running total, and neither comes with a history. So the card
 * draws bars when it is handed a series and just the figure when it is not.
 * Inventing a plausible-looking curve for a number we were given once would be
 * the single most dishonest thing on the page.
 *
 * Axon's own registry does publish per-day installs and stars, so the same card
 * carries both cases without a second component.
 */
Item {
    id: root

    property string label: ""
    property string value: "—"
    property string caption: ""
    /** Numbers, oldest first. Empty draws no chart and reserves no space for one. */
    property var series: []

    property color foreground: Color.menu.text
    property color accent: "#0094d2"
    property string fontFamily: Style.font.menuFamily

    readonly property color dim: Qt.darker(foreground, 1.55)
    readonly property bool charted: !!series && series.length > 1

    implicitHeight: content.implicitHeight + Style.space(24)

    Rectangle {
        anchors.fill: parent
        radius: Style.cornerRadius
        color: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.04)
        border.width: 1
        border.color: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.10)
    }

    Column {
        id: content
        anchors.fill: parent
        anchors.margins: Style.space(12)
        spacing: Style.space(4)

        Text {
            textFormat: Text.PlainText
            text: root.label
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.bold: true
        }

        Text {
            textFormat: Text.PlainText
            text: root.value
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.displayLarge
            font.bold: true
        }

        Text {
            visible: root.caption !== ""
            textFormat: Text.PlainText
            text: root.caption
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
        }

        Item {
            width: parent.width
            height: root.charted ? Style.space(34) : 0
            visible: root.charted

            Row {
                anchors.fill: parent
                spacing: 2

                Repeater {
                    model: root.series

                    Item {
                        required property var modelData
                        width: Math.max(1, (parent.width - (root.series.length - 1) * 2) / root.series.length)
                        height: parent.height

                        Rectangle {
                            anchors.bottom: parent.bottom
                            width: parent.width
                            height: {
                                var peak = 0
                                for (var i = 0; i < root.series.length; i++) peak = Math.max(peak, root.series[i])
                                return peak > 0 ? Math.max(1, parent.height * (modelData / peak)) : 1
                            }
                            radius: 1
                            color: root.accent
                        }
                    }
                }
            }
        }
    }
}
