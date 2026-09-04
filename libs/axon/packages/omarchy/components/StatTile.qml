import QtQuick
import qs.Commons

/**
 * One number, what it counts, and its denominator.
 *
 * Three of these open the Overview, one per domain the daemon owns — agents,
 * models, machine. The tiles are not a dashboard of everything measurable;
 * they are the daemon's own shape, which is why there are exactly three and
 * why a fourth needs a reason.
 */
Item {
    id: root

    property string value: "—"
    property string label: ""
    property string sub: ""

    property color foreground: Color.foreground
    property color accent: "#0094d2"
    property string fontFamily: Style.font.family
    /** Tint the number when it means something is live. */
    property bool emphasised: false

    readonly property color dim: Qt.darker(foreground, 1.55)

    implicitHeight: stack.implicitHeight

    Column {
        id: stack
        width: parent.width
        spacing: Style.space(1)

        Text {
            textFormat: Text.PlainText
            text: root.value
            color: root.emphasised ? root.accent : root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.heading
            font.bold: true
        }

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
            visible: root.sub !== ""
            text: root.sub
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
        }
    }
}
