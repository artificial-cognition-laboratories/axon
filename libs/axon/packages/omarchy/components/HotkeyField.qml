import QtQuick
import qs.Commons

/**
 * A key combination, captured by pressing it.
 *
 * A text field would be the wrong control twice over: it asks a person to
 * transcribe a chord they can simply perform, and it invites spellings the
 * compositor does not accept. Press-to-bind is the interaction every desktop
 * uses for this, and it cannot produce an invalid value.
 *
 * The chord is rendered the way Hyprland writes one — `SUPER+ALT+D`, modifiers
 * in a fixed order — because that string is what ends up in a keybind, and a
 * second spelling here would mean translating between two vocabularies that
 * describe the same thing.
 */
Item {
    id: root

    /** The current binding, e.g. "SUPER+ALT+D". Empty means nothing is bound. */
    property string value: ""

    property color foreground: Color.menu.text
    property color accent: "#0094d2"
    property string fontFamily: Style.font.menuFamily

    /** Emitted with the new chord. The owner decides whether to keep it. */
    signal bound(string chord)
    /** Emitted when the binding is cleared. */
    signal cleared()

    readonly property color dim: Qt.darker(foreground, 1.55)

    /** True while waiting for a chord. */
    property bool arming: false

    implicitWidth: Style.space(150)
    implicitHeight: Style.space(26)

    /**
     * Modifiers, in Hyprland's own order.
     *
     * Fixed rather than "whichever was pressed first", so the same physical
     * chord always produces the same string — otherwise a rebind that changed
     * nothing would still write a different value.
     */
    function chordFor(event) {
        var key = root.keyName(event)
        if (key === "") return ""

        var parts = []
        if (event.modifiers & Qt.MetaModifier) parts.push("SUPER")
        if (event.modifiers & Qt.ControlModifier) parts.push("CTRL")
        if (event.modifiers & Qt.AltModifier) parts.push("ALT")
        if (event.modifiers & Qt.ShiftModifier) parts.push("SHIFT")
        parts.push(key)
        return parts.join("+")
    }

    /**
     * The key's NAME, from its code — never from `event.text`.
     *
     * Text is what the key would type, and under a modifier that is not a
     * name: Ctrl+D delivers `\u0004`, the EOT control character, which is
     * non-empty and survives `trim()` and `toUpperCase()` unchanged. So the
     * first chord anyone bound with Ctrl was written as "CTRL+" plus an
     * invisible byte — a string the compositor cannot parse and a person
     * cannot see, in a field whose whole job is showing them what they bound.
     *
     * The key CODE is stable under every modifier, which is why it is the
     * right source. Empty for a bare modifier, so holding SUPER while deciding
     * on a letter is not mistaken for a finished chord.
     */
    function keyName(event) {
        var code = event.key

        // A modifier alone is someone still assembling the chord.
        if (code === Qt.Key_Control || code === Qt.Key_Shift
            || code === Qt.Key_Alt || code === Qt.Key_Meta
            || code === Qt.Key_AltGr || code === Qt.Key_CapsLock) return ""

        if (code >= Qt.Key_A && code <= Qt.Key_Z) return String.fromCharCode(code)
        if (code >= Qt.Key_0 && code <= Qt.Key_9) return String.fromCharCode(code)
        if (code >= Qt.Key_F1 && code <= Qt.Key_F35) return "F" + (code - Qt.Key_F1 + 1)

        if (code === Qt.Key_Space) return "SPACE"
        if (code === Qt.Key_Return || code === Qt.Key_Enter) return "RETURN"
        if (code === Qt.Key_Tab) return "TAB"
        if (code === Qt.Key_Up) return "UP"
        if (code === Qt.Key_Down) return "DOWN"
        if (code === Qt.Key_Left) return "LEFT"
        if (code === Qt.Key_Right) return "RIGHT"

        /*
         * Printable punctuation, from the text — but ONLY when it is printable.
         *
         * This is the branch that was the whole bug: anything below 0x20 is a
         * control character, never a key name, and it must be refused rather
         * than uppercased into the binding.
         */
        var text = String(event.text || "")
        if (text.length === 1 && text.charCodeAt(0) >= 0x20 && text.charCodeAt(0) !== 0x7f) {
            return text.toUpperCase()
        }
        return ""
    }

    Rectangle {
        anchors.fill: parent
        radius: Style.cornerRadius
        color: root.arming
            ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.14)
            : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, hover.hovered ? 0.10 : 0.06)
        border.width: root.arming ? 1 : 0
        border.color: root.accent
    }

    Text {
        anchors.centerIn: parent
        textFormat: Text.PlainText
        text: root.arming
            ? "Press a combination…"
            : (root.value !== "" ? root.value : "Not bound")
        color: root.arming ? root.accent : (root.value !== "" ? root.foreground : root.dim)
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
    }

    HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }

    TapHandler {
        onTapped: {
            root.arming = true
            capture.forceActiveFocus()
        }
    }

    /**
     * An Item, not a TextInput: nothing here is text, and a focused input
     * would swallow the very keys this is trying to observe into a buffer.
     */
    Item {
        id: capture
        anchors.fill: parent
        focus: false

        Keys.onPressed: function (event) {
            if (!root.arming) return
            event.accepted = true

            // Escape leaves the binding alone; Backspace clears it. Both are
            // what a person expects and neither can be part of a chord.
            if (event.key === Qt.Key_Escape) {
                root.arming = false
                return
            }
            if (event.key === Qt.Key_Backspace || event.key === Qt.Key_Delete) {
                root.arming = false
                root.cleared()
                return
            }

            // A modifier on its own is the person still assembling the chord,
            // not the chord. Waiting for a real key is what lets them hold
            // SUPER+ALT and then decide on the letter.
            var chord = root.chordFor(event)
            if (chord === "") return

            root.arming = false
            root.bound(chord)
        }

        // Losing focus mid-capture must not leave the control armed — it would
        // sit there claiming to be listening to a keyboard it cannot hear.
        onActiveFocusChanged: if (!activeFocus) root.arming = false
    }
}
