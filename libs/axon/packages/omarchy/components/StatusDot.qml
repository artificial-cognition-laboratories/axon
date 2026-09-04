import QtQuick
import qs.Commons

/**
 * The daemon link, as one dot.
 *
 * Sits over the bottom-right of the Axon mark like a presence badge. The ring
 * is painted in the panel's own background so the dot reads as sitting ON the
 * mark rather than beside it, which is what lets it overlap without muddying
 * the chevron underneath.
 *
 * ── Why these colours are literals ──────────────────────────────────────────
 *
 * Everything else in this plugin takes its colour from `qs.Commons` so it
 * follows the user's theme. Status is the exception on purpose: red, amber and
 * green are read as a traffic light before they are read as colours, and a
 * theme that tinted "offline" to something calm would be actively harmful. The
 * theme has no green or amber token to borrow anyway — only `urgent`.
 */
Item {
    id: root

    /** "offline" | "starting" | "connected" */
    property string health: "offline"

    property real dotSize: 8
    property real ringWidth: 2
    property color ring: Color.popups.background

    property color offlineColor: "#e05252"
    property color startingColor: "#e0a640"
    property color connectedColor: "#3fb96b"

    readonly property color current: health === "connected" ? connectedColor
                                   : health === "starting" ? startingColor
                                   : offlineColor

    implicitWidth: dotSize + ringWidth * 2
    implicitHeight: implicitWidth

    Rectangle {
        anchors.fill: parent
        radius: width / 2
        color: root.ring
    }

    Rectangle {
        anchors.centerIn: parent
        width: root.dotSize
        height: root.dotSize
        radius: width / 2
        color: root.current

        Behavior on color {
            ColorAnimation { duration: 140 }
        }
    }

    // A daemon mid-launch is the one state worth drawing attention to; the
    // other two are steady and must not pulse, or the bar acquires a heartbeat.
    SequentialAnimation on opacity {
        running: root.health === "starting"
        loops: Animation.Infinite
        alwaysRunToEnd: true
        NumberAnimation { to: 0.45; duration: 620; easing.type: Easing.InOutQuad }
        NumberAnimation { to: 1.0; duration: 620; easing.type: Easing.InOutQuad }
    }

    onHealthChanged: if (health !== "starting") opacity = 1.0
}
