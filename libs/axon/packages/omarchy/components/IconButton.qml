import QtQuick
import Quickshell
import qs.Commons

/**
 * A small square glyph button.
 *
 * A bare clickable character has a hit target the size of the glyph, which on
 * a cancel control is both hard to hit and easy to hit by accident. This gives
 * it a real area and a hover surface, the way every other control in the bar
 * has one.
 */
Item {
    id: root

    /**
     * A character to draw, usually a Nerd Font icon.
     *
     * ── Why glyphs and not SVG files ────────────────────────────────────────
     *
     * An `Image` cannot be recoloured. The discord and github marks are SVGs
     * with their fill baked in, which is right for a brand and wrong for a
     * control: a load button has to answer hover, the accent, and the
     * destructive red, and a picture answers none of them.
     *
     * The panel's font is JetBrainsMono Nerd Font — the shell resolves
     * `monospace` to it and Omarchy ships it — so an icon here is text. It
     * takes the colour of whatever draws it, scales with the font, and sits on
     * the same metrics as the labels beside it, which is why these line up
     * with a size column without anyone nudging them.
     *
     * Use CODICONS (U+EA00–EB00). They are one family drawn for small UI at a
     * consistent stroke weight; mixing in Material or FontAwesome codepoints
     * gets icons of visibly different weights sitting next to each other.
     */
    property string glyph: ""

    /** Icon glyphs need more than caption size to read. Labels do not. */
    property real glyphSize: Style.font.body
    /** Optional local SVG icon; falls back to glyph for existing callers. */
    property url iconSource: ""
    /** Optional destination; handled here so icon links cannot lose a relayed click. */
    property string externalUrl: ""
    property color foreground: Color.menu.text
    property color accent: "#0094d2"
    property bool destructive: false
    property string fontFamily: Style.font.menuFamily

    signal clicked()

    readonly property color dim: Qt.darker(foreground, 1.55)
    readonly property color tint: destructive ? "#e05252" : accent

    implicitWidth: Style.space(22)
    implicitHeight: Style.space(22)

    Rectangle {
        anchors.fill: parent
        radius: Style.cornerRadius
        color: hover.hovered ? Qt.rgba(root.tint.r, root.tint.g, root.tint.b, 0.16) : "transparent"
        Behavior on color { ColorAnimation { duration: 90 } }
    }

    Image {
        anchors.centerIn: parent
        width: Style.space(13)
        height: width
        // iconSource resolves at the call site, where the relative asset path lives.
        source: root.iconSource
        /*
         * Compared as a STRING, not against the empty literal.
         *
         * `iconSource` is a `url`, and an unset url is not `=== ""` — the
         * strict comparison against a QUrl is always false. So a glyph-only
         * button drew an empty Image and hid its glyph: the hover surface
         * appeared, the mark never did, and the control looked like a blank
         * square.
         */
        visible: String(root.iconSource) !== ""
        fillMode: Image.PreserveAspectFit
        /*
         * Width only, so the rasteriser keeps the mark's own aspect.
         *
         * Discord's viewBox is 127x96 and GitHub's is 16x16. Pinning BOTH
         * dimensions to the same square told Qt to rasterise a 1.32:1 mark
         * into a 1:1 texture, and the letterboxing that followed sat the
         * discord glyph off-centre in its hover box while the square github
         * mark looked fine. Giving only the width lets the height follow the
         * source, and `centerIn` then centres what was actually drawn.
         *
         * Doubled for the rasteriser: an SVG scaled up from its natural size
         * is soft, and these are small enough that the extra pixels are free.
         */
        sourceSize.width: Math.round(width * 2)
        opacity: hover.hovered ? 1.0 : 0.68
    }

    Text {
        anchors.centerIn: parent
        // Driven by the GLYPH, which is the thing this draws — rather than by
        // the absence of an icon, which is a different question.
        visible: root.glyph !== ""
        textFormat: Text.PlainText
        text: root.glyph
        color: hover.hovered ? root.tint : root.dim
        font.family: root.fontFamily
        font.pixelSize: root.glyphSize
    }

    HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }
    TapHandler {
        onTapped: {
            if (root.externalUrl !== "") Quickshell.execDetached(["xdg-open", root.externalUrl])
            else root.clicked()
        }
    }
}
