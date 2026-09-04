import QtQuick
import qs.Commons

/**
 * A thin track with a shuttle crossing it: something is happening, nobody
 * knows how far along.
 *
 * Extracted from `ProgressLine` because two surfaces now need the motion and
 * only one of them wants the label, figure and detail rows around it. An
 * empty track reads as stalled and a half-filled one is a claim we cannot
 * make, so motion is the honest signal for work of unknown length — which
 * loading a weight and running an inference both are.
 */
Rectangle {
    id: root

    property color accent: "#0094d2"
    /** The ground the shuttle runs over. Usually the surface's foreground, faint. */
    property color track: Qt.rgba(1, 1, 1, 0.12)
    /** Stops the animation when nothing is waiting on it. */
    property bool active: true

    implicitHeight: Style.space(3)
    radius: height / 2
    color: root.track
    clip: true

    Rectangle {
        id: shuttle
        width: parent.width * 0.32
        height: parent.height
        radius: parent.radius
        color: root.accent
        x: -width
        visible: root.active

        SequentialAnimation on x {
            running: root.active && root.visible
            loops: Animation.Infinite
            NumberAnimation {
                from: -shuttle.width
                to: root.width
                duration: 1150
                easing.type: Easing.InOutQuad
            }
            PauseAnimation { duration: 260 }
        }
    }
}
