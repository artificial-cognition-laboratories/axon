import QtQuick
import qs.Commons

/**
 * One node in a process tree: guides, a caret, two lines, a trailing figure.
 *
 * The same row serves running agents and the weights they hold, because both
 * are the same shape — an instance with n children, usually few. Guides are
 * drawn per ancestor level rather than as box-drawing glyphs so they stay
 * hairline at any font and never depend on a character being present.
 */
Item {
    id: root

    property string primary: ""
    property string secondary: ""
    property string trailing: ""

    property int depth: 0
    property bool hasChildren: false
    property bool expanded: true
    /** True when this is the last child at its level — its own guide stops here. */
    property bool isLast: false
    /** Per ancestor level, whether that ancestor still has siblings below. */
    property var rails: []

    property color foreground: Color.foreground
    property color accent: "#0094d2"
    property string fontFamily: Style.font.family
    property bool emphasised: false

    signal toggled()
    signal activated()

    readonly property color dim: Qt.darker(foreground, 1.55)
    readonly property color guide: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.18)
    readonly property real step: Style.space(14)
    readonly property real indent: depth * step

    width: parent ? parent.width : implicitWidth
    implicitHeight: Math.max(labels.implicitHeight, Style.space(20))

    // Ancestor guides: one per level, continuing only where that ancestor has
    // more children coming.
    Repeater {
        model: root.rails

        Rectangle {
            required property var modelData
            required property int index
            visible: !!modelData
            x: index * root.step + Style.space(4)
            width: 1
            height: root.height
            color: root.guide
        }
    }

    // This node's own elbow: down to the row's middle, then across to the caret.
    Item {
        visible: root.depth > 0
        x: (root.depth - 1) * root.step + Style.space(4)
        width: root.step
        height: root.height

        Rectangle {
            width: 1
            height: root.isLast ? root.height / 2 : root.height
            color: root.guide
        }

        Rectangle {
            y: root.height / 2
            width: Style.space(7)
            height: 1
            color: root.guide
        }
    }

    Text {
        id: caret
        x: root.indent
        anchors.verticalCenter: labels.top
        anchors.verticalCenterOffset: firstLine.implicitHeight / 2
        visible: root.hasChildren
        textFormat: Text.PlainText
        text: root.expanded ? "▾" : "▸"
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        width: Style.space(12)
    }

    Column {
        id: labels
        x: root.indent + Style.space(12)
        width: parent.width - x - (trailingText.implicitWidth + Style.space(10))
        spacing: Style.space(1)

        Text {
            id: firstLine
            width: parent.width
            textFormat: Text.PlainText
            text: root.primary
            color: root.emphasised ? root.accent : root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            elide: Text.ElideRight
        }

        Text {
            width: parent.width
            visible: root.secondary !== ""
            textFormat: Text.PlainText
            text: root.secondary
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
        }
    }

    Text {
        id: trailingText
        anchors.right: parent.right
        anchors.verticalCenter: labels.top
        anchors.verticalCenterOffset: firstLine.implicitHeight / 2
        textFormat: Text.PlainText
        text: root.trailing
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
    }

    HoverHandler {
        id: hover
        cursorShape: Qt.PointingHandCursor
    }

    Rectangle {
        anchors.fill: parent
        anchors.leftMargin: -Style.space(6)
        anchors.rightMargin: -Style.space(6)
        z: -1
        radius: Style.cornerRadius
        color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.05)
        visible: hover.hovered
    }

    TapHandler {
        onTapped: root.hasChildren ? root.toggled() : root.activated()
    }
}
