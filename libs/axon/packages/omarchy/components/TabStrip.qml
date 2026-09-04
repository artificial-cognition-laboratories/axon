import QtQuick
import qs.Commons

// Named TabStrip rather than TabBar: QtQuick.Controls exports a TabBar, and
// Panel.qml imports that module for ScrollBar, so the shorter name resolves to
// theirs and every property assignment here fails.

/**
 * The tab strip: inline labels between two full-width rules, the active one
 * underlined in brand cyan.
 *
 * Deliberately not `ButtonGroup`. That component draws a segmented control —
 * bordered, filled, chunky — which is right for picking a value and wrong for
 * navigating a view. This is the same strip the Axon Console uses in the
 * editor, so the two surfaces read as one product.
 *
 * The underline sits ON the bottom rule rather than above it, so the active
 * tab looks like it is holding the line open rather than floating over it.
 */
Item {
    id: root

    /** [{ value, label }] */
    property var tabs: []
    property string value: ""

    property color foreground: Color.foreground
    property color accent: Color.accent
    property string fontFamily: Style.font.family
    property real fontSize: Style.font.body

    /** Rule tint, matched to PanelSeparator so strips and dividers agree. */
    property real ruleStrength: 0.12
    /** Underline thickness. Two pixels reads as deliberate where one reads as an artifact. */
    property real markerHeight: 2

    signal selected(string value)

    readonly property color dim: Qt.darker(foreground, 1.55)
    readonly property color rule: Qt.rgba(foreground.r, foreground.g, foreground.b, ruleStrength)

    width: parent ? parent.width : implicitWidth
    implicitHeight: strip.height + 2

    Rectangle {
        id: topRule
        anchors.top: parent.top
        width: parent.width
        height: 1
        color: root.rule
    }

    Row {
        id: strip
        anchors.top: topRule.bottom
        // Shifted left by one tab's internal padding so the FIRST LABEL sits
        // flush with everything below it. Padding that centres a label inside
        // its hit area also pushes the first one off the column's left edge,
        // which reads as the whole strip being indented.
        x: -Style.space(12)
        height: childrenRect.height

        Repeater {
            model: root.tabs

            delegate: Item {
                id: tab
                required property var modelData

                readonly property bool active: root.value === String(modelData.value)

                width: label.implicitWidth + Style.space(24)
                height: label.implicitHeight + Style.space(16)

                Text {
                    id: label
                    anchors.centerIn: parent
                    textFormat: Text.PlainText
                    text: String(tab.modelData.label)
                    color: tab.active ? root.foreground : (hover.hovered ? root.foreground : root.dim)
                    font.family: root.fontFamily
                    font.pixelSize: root.fontSize
                    font.bold: tab.active

                    Behavior on color {
                        ColorAnimation { duration: 90 }
                    }
                }

                /*
                 * Underlines the LABEL, not the hit area.
                 *
                 * The strip is shifted left by one tab's padding so the first
                 * label sits flush with the content below it — which put the
                 * first tab's full-width marker 12px left of that column, the
                 * one place in the window where anything overhangs the text.
                 * Matching the label is both the fix and the better mark:
                 * an underline is about the word, and the hit area is
                 * deliberately larger than the word.
                 *
                 * Sits ON the bottom rule, drawn after it, so the active tab
                 * interrupts the line rather than floating over it.
                 */
                Rectangle {
                    anchors.bottom: parent.bottom
                    anchors.bottomMargin: -1
                    anchors.horizontalCenter: parent.horizontalCenter
                    width: label.implicitWidth
                    height: root.markerHeight
                    color: root.accent
                    visible: tab.active
                }

                HoverHandler {
                    id: hover
                    cursorShape: Qt.PointingHandCursor
                }

                TapHandler {
                    onTapped: root.selected(String(tab.modelData.value))
                }
            }
        }
    }

    Rectangle {
        id: bottomRule
        anchors.top: strip.bottom
        width: parent.width
        height: 1
        color: root.rule
    }
}
