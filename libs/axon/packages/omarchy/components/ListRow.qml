import QtQuick
import qs.Commons

/**
 * A two-line row with a trailing figure.
 *
 * One component for both lists, because a resident model and a running agent
 * are the same shape — a name, a line of provenance under it, and a number on
 * the right. Two near-identical row components would drift apart within a
 * week.
 *
 * `depth` indents, which is what renders the live ownership graph: an agent
 * with a `parentSessionId` was spawned by another and nests under it rather
 * than sitting beside it as a peer.
 */
Item {
    id: root

    property string primary: ""
    property string secondary: ""
    property string trailing: ""
    /** Nesting level. Non-zero draws a rail, so a child reads as owned rather than merely indented. */
    property int depth: 0

    property color foreground: Color.foreground
    property color accent: "#0094d2"
    property string fontFamily: Style.font.family
    /** Tint the name — a resident weight, a root agent. */
    property bool emphasised: false

    /**
     * Whether this row leads anywhere.
     *
     * Declared by the caller, not sniffed. Asking whether a signal has a
     * handler does not work — a QML signal is a function, so `.length` is its
     * arity and every row read as connected, lighting up on hover and
     * promising a click that went nowhere.
     */
    property bool interactive: false

    /** Emitted when an interactive row is clicked. */
    signal activated()

    readonly property color dim: Qt.darker(foreground, 1.55)
    readonly property real indent: depth * Style.space(14)

    width: parent ? parent.width : implicitWidth
    implicitHeight: labels.implicitHeight

    HoverHandler {
        id: rowHover
        enabled: root.interactive
        cursorShape: Qt.PointingHandCursor
    }

    TapHandler {
        enabled: root.interactive
        onTapped: root.activated()
    }

    Rectangle {
        visible: root.depth > 0
        x: root.indent - Style.space(8)
        width: 1
        height: parent.height
        color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.18)
    }

    Column {
        id: labels
        x: root.indent
        width: parent.width - root.indent - (trailingText.implicitWidth + Style.space(10))
        spacing: Style.space(1)

        Text {
            width: parent.width
            textFormat: Text.PlainText
            text: root.primary
            /*
             * Hover tints the TITLE rather than filling the row.
             *
             * A background needs breathing room on both sides to read as a
             * surface, and the dropdown is narrow enough that the padding
             * would have to come out of the text. Colouring the name says the
             * same thing — this is a link — and costs no width at all.
             */
            color: (rowHover.hovered && root.interactive) || root.emphasised
                ? root.accent : root.foreground
            Behavior on color { ColorAnimation { duration: 90 } }
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
        anchors.top: parent.top
        textFormat: Text.PlainText
        text: root.trailing
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
    }
}
