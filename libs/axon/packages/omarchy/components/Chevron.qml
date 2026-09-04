import QtQuick
import QtQuick.Shapes

/**
 * The Axon mark — a double chevron.
 *
 * Drawn rather than shipped as an image so it takes whatever colour the bar or
 * panel hands it and stays sharp at every scale factor. An SVG twin lives in
 * `assets/axon.svg` for the desktop entry, which needs a file on disk; that
 * copy and this one are the same geometry and must move together.
 */
Item {
    id: root

    /** Stroke colour. Callers pass the bar or panel foreground. */
    property color color: "white"
    /** Nominal edge length. Both chevrons are laid out inside a 24-unit box and scaled to this. */
    property real size: 16
    /** Stroke width, as a fraction of `size`. */
    property real weight: 0.115

    implicitWidth: size
    implicitHeight: size

    readonly property real unit: size / 24

    /*
     * The drawing is CENTRED in whatever bounds this is given, not anchored to
     * them.
     *
     * `BarIconButton` loads an icon component with `anchors.fill` into a 16px
     * optical canvas, so the item becomes 16 wide while the paths are still
     * laid out against `size` — 13, to match the Nerd Font glyphs beside it.
     * Filling the parent drew that 13-unit mark into the top-left of a 16-unit
     * box, which is exactly the offset that made it sit high of its neighbours.
     */
    Item {
        anchors.centerIn: parent
        width: root.size
        height: root.size

    Shape {
        anchors.fill: parent
        preferredRendererType: Shape.CurveRenderer
        antialiasing: true

        ShapePath {
            strokeColor: root.color
            strokeWidth: Math.max(1, root.size * root.weight)
            fillColor: "transparent"
            capStyle: ShapePath.RoundCap
            joinStyle: ShapePath.RoundJoin

            PathPolyline {
                path: [
                    Qt.point(4 * root.unit, 6 * root.unit),
                    Qt.point(10 * root.unit, 12 * root.unit),
                    Qt.point(4 * root.unit, 18 * root.unit),
                ]
            }
        }

        ShapePath {
            strokeColor: root.color
            strokeWidth: Math.max(1, root.size * root.weight)
            fillColor: "transparent"
            capStyle: ShapePath.RoundCap
            joinStyle: ShapePath.RoundJoin

            PathPolyline {
                path: [
                    Qt.point(13 * root.unit, 6 * root.unit),
                    Qt.point(19 * root.unit, 12 * root.unit),
                    Qt.point(13 * root.unit, 18 * root.unit),
                ]
            }
        }
    }
    }
}
