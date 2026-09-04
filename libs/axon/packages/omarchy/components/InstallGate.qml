import QtQuick
import qs.Commons

/**
 * The install offer, covering a whole surface.
 *
 * The bar panel can put the prompt in its header and keep its shape, because
 * that panel is a column and one more block fits. The browser and the work
 * view cannot: their chrome is a search field, a filter rail and a composer,
 * all of which drive a daemon that is not there. Rendering them behind an
 * offer would be a window of dead controls.
 *
 * So this covers them. It also swallows every click, which is the point —
 * there is nothing underneath worth reaching, and a filter that silently does
 * nothing is a worse answer than one you cannot press.
 */
Item {
    id: root

    /** The `Install` leaf off the service. */
    property var install: null

    property color foreground: Color.foreground
    property color accent: "#0094d2"
    property color background: Color.menu.background
    property string fontFamily: Style.font.family

    Rectangle {
        anchors.fill: parent
        color: root.background
    }

    // Nothing behind this is usable, so nothing behind it is reachable.
    MouseArea { anchors.fill: parent }

    InstallPrompt {
        anchors.centerIn: parent
        width: Math.min(Style.space(420), root.width - Style.space(48) * 2)
        install: root.install
        foreground: root.foreground
        accent: root.accent
        fontFamily: root.fontFamily
    }
}
