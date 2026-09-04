import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons

/**
 * The one thing on screen while dictation is listening.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Dictation deliberately has no window: you press a key, speak, and words
 * appear where the cursor already is. That is the right design and it has one
 * genuine hole — a person cannot tell whether the microphone is open. Pressing
 * the key and getting silence is indistinguishable from a shortcut that never
 * registered, which is exactly how it felt before this existed.
 *
 * So this is not a UI for dictation. It is a LIGHT: it says "listening, and
 * this is what I can hear", and it has no controls at all, because every
 * control it could offer is a key that is already bound.
 *
 * ── Why it lives on the service ─────────────────────────────────────────────
 *
 * It must appear without being summoned, and the service is the only part of
 * this plugin that is always loaded. Putting it in the on-demand overlay would
 * mean it could only be seen by someone who had already opened the panel to
 * look for it.
 *
 * ── Why the bars are measured, not animated ─────────────────────────────────
 *
 * Every bar is a real RMS window read off the audio the daemon is already
 * writing. A plausible-looking animation would have been easier and would lie
 * whenever the microphone was muted, dead, or capturing the wrong device —
 * which are precisely the cases someone is staring at this to diagnose.
 */
PanelWindow {
    id: root

    /** The Machine handle. `dictation.levels` is the only thing read. */
    property var machine: null

    property color accent: "#0094d2"
    property color foreground: Color.menu.text

    /** Where it sits: "top", "center", "bottom" — or "off" to show nothing. */
    property string placement: "bottom"
    /** Overall scale, so it can be made unobtrusive without editing QML. */
    property real scale: 1.0

    readonly property var dictation: machine && machine.dictation ? machine.dictation : ({})
    /**
     * Recording, AND the daemon has said so recently.
     *
     * `recording` alone is the last thing we were told, which is not the same
     * claim: when the stream dies mid-recording — the daemon restarts, the
     * socket drops — that last frame says "recording" forever and the overlay
     * sits on screen with no way to dismiss it, over a daemon that is not
     * listening to anything. Observed exactly that.
     *
     * Frames arrive at ~16Hz while recording, so a two-second gap is three
     * dozen missed and unambiguous. The cost of being wrong is a pill that
     * blinks off during a reconnect; the cost of the alternative is one that
     * never goes away.
     */
    readonly property bool listening: dictation.recording === true && !stale

    property bool stale: false

    onDictationChanged: {
        stale = false
        if (dictation.recording === true) heartbeat.restart()
        else heartbeat.stop()
    }

    Timer {
        id: heartbeat
        /*
         * Generous, because the daemon is single-threaded.
         *
         * A transcription pass is CPU-bound work in the same process as the
         * level stream, so frames genuinely stop for the length of a pass —
         * over a second on this runtime. At two seconds the indicator went
         * stale and vanished mid-sentence on a long dictation. Five is longer
         * than any single pass and still short enough that a dead daemon does
         * not leave a pill on screen.
         */
        interval: 5000
        onTriggered: root.stale = true
    }
    readonly property var levels: dictation.levels || []
    /*
     * The transcript is NOT drawn here any more.
     *
     * It was, and it was in the way: a line of text floating over whatever you
     * were dictating INTO, saying the same words that were already appearing
     * at the cursor. The document is the display — that is the whole point of
     * typing at the cursor — and repeating it above the pill was a second
     * place to read the same thing, in front of the first.
     *
     * The overlay keeps the one job the document cannot do: saying that the
     * microphone is open and what it can hear. `partial` remains on the
     * daemon's state for anything that genuinely has nowhere else to show it.
     */

    // "off" is a real choice, not a missing value: someone who finds any
    // overlay intrusive should be able to turn it off and still have dictation.
    visible: listening && placement !== "off"

    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    WlrLayershell.namespace: "arclabs-axon-voice"
    WlrLayershell.layer: WlrLayer.Overlay
    /*
     * Takes no keyboard and no pointer.
     *
     * This is the whole reason it can sit over everything: dictation types
     * into the window that already has focus, so an overlay that stole focus
     * would make the feature type into itself. `None` plus the input mask
     * below means the pill is visible and completely intangible.
     */
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
    exclusionMode: ExclusionMode.Ignore
    mask: Region {}

    readonly property real unit: Style.space(1) * root.scale

    Rectangle {
        id: pill

        readonly property real pad: Style.space(14) * root.scale

        width: Math.round(bars.width + pad * 2)
        height: Math.round(Style.space(46) * root.scale)
        radius: height / 2

        anchors.horizontalCenter: parent.horizontalCenter
        // Placement is a preference because a fixed position is wrong for
        // somebody: the bottom of the screen is where a status pill belongs on
        // most desktops and is exactly where a terminal's prompt sits on some.
        anchors.verticalCenter: root.placement === "center" ? parent.verticalCenter : undefined
        anchors.top: root.placement === "top" ? parent.top : undefined
        anchors.bottom: root.placement === "bottom" ? parent.bottom : undefined
        anchors.topMargin: Style.space(48)
        anchors.bottomMargin: Style.space(48)

        color: Qt.rgba(0, 0, 0, 0.82)
        border.width: 1
        border.color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.45)

        // Fades in rather than appearing. A pill that pops reads as an error
        // dialog; one that fades reads as something switching on.
        opacity: root.listening ? 1 : 0
        Behavior on opacity { NumberAnimation { duration: 130 } }

        Row {
            id: bars
            anchors.centerIn: parent
            spacing: Math.max(2, Math.round(3 * root.scale))

            Repeater {
                model: 24

                Rectangle {
                    required property int index

                    readonly property real level: {
                        var l = root.levels
                        if (!l || l.length === 0) return 0
                        // Newest on the RIGHT: the levels array is oldest-first
                        // and a meter that scrolled the other way would read as
                        // running backwards.
                        var at = Math.floor(index * l.length / 24)
                        var v = l[at]
                        return (typeof v === "number" && isFinite(v)) ? Math.max(0, Math.min(1, v)) : 0
                    }

                    width: Math.max(2, Math.round(3 * root.scale))
                    // A floor, so silence is a quiet line rather than nothing.
                    // An empty meter looks broken; a flat one looks listening.
                    height: Math.round((Style.space(4) + level * Style.space(26)) * root.scale)
                    radius: width / 2
                    anchors.verticalCenter: parent.verticalCenter

                    color: root.accent
                    opacity: 0.35 + level * 0.65

                    // Smoothing between ticks. The VALUES are measured; only
                    // the motion between two measurements is interpolated,
                    // which is the difference between a smooth meter and an
                    // invented one.
                    Behavior on height { NumberAnimation { duration: 110; easing.type: Easing.OutQuad } }
                    Behavior on opacity { NumberAnimation { duration: 110 } }
                }
            }
        }
    }
}
