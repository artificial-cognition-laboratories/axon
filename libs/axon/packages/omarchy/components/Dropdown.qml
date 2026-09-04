import QtQuick
import qs.Commons

/**
 * A value picked from a short list, the way a menu works.
 *
 * ── Why not the cycling control it replaces ─────────────────────────────────
 *
 * The sort used to advance on click. That is fine for two states and wrong for
 * four: you cannot see what the options ARE without pressing until they come
 * round, and reaching the one you want may take three presses that each
 * re-sort a list of two hundred rows underneath you. A menu shows the set,
 * costs one click for any member, and is the pattern everyone already knows.
 *
 * ── Why it is a fixed width ─────────────────────────────────────────────────
 *
 * Sized to its LONGEST option, not its current one. Sized to the current value
 * it grew and shrank as the value changed, and because it sits at the right of
 * a header row, everything beside it moved — the control you had just clicked
 * jumped out from under the pointer.
 */
Item {
    id: root

    /*
     * Above its siblings, because the menu escapes this item's bounds.
     *
     * `z` only orders within one parent, so raising it on the popup alone left
     * the menu behind whatever the CONTROL's siblings drew — the results list,
     * in the one place this is used.
     */
    z: 100

    /** [{ value, label }] — the whole set, in the order it should be shown. */
    property var options: []
    property string value: ""

    property color foreground: Color.menu.text
    property color accent: "#0094d2"
    property string fontFamily: Style.font.menuFamily

    signal selected(string value)

    readonly property color dim: Qt.darker(foreground, 1.55)
    readonly property bool open: menu.visible

    /** One option's height. Fixed, so the menu's size is arithmetic. */
    readonly property real rowHeight: Style.space(26)

    readonly property string label: {
        for (var i = 0; i < options.length; i++)
            if (String(options[i].value) === value) return String(options[i].label)
        return options.length > 0 ? String(options[0].label) : ""
    }

    /** The widest option, measured once, so the control never resizes. */
    readonly property real widest: {
        var most = 0
        for (var i = 0; i < options.length; i++) {
            var w = String(options[i].label).length
            if (w > most) most = w
        }
        return most
    }

    implicitWidth: metric.implicitWidth + Style.space(28)
    implicitHeight: current.implicitHeight + Style.space(8)

    // Off-screen, and the only thing that decides this control's width.
    Text {
        id: metric
        visible: false
        text: "M".repeat(Math.max(1, root.widest))
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
    }

    Rectangle {
        anchors.fill: parent
        radius: Style.cornerRadius
        color: root.open || hover.hovered
            ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)
            : "transparent"
        Behavior on color { ColorAnimation { duration: 90 } }
    }

    Text {
        id: current
        anchors.left: parent.left
        anchors.leftMargin: Style.space(8)
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        text: root.label
        color: root.open ? root.accent : (hover.hovered ? root.foreground : root.dim)
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
    }

    Text {
        anchors.right: parent.right
        anchors.rightMargin: Style.space(8)
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        text: ""  // codicon chevron-down
        color: root.open ? root.accent : root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
    }

    HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }
    TapHandler {
        onTapped: {
            if (menu.visible) { menu.visible = false; return }
            root.place()
            menu.visible = true
        }
    }

    /** Put the menu under the control, right edges aligned. */
    function place() {
        var at = root.mapToItem(root.window(), 0, 0)
        menu.x = at.x + root.width - menu.width
        menu.y = at.y + root.height + Style.space(4)
    }

    /*
     * The menu hangs BELOW and is right-aligned with the control, because the
     * control lives at the right edge of a header row and a left-aligned menu
     * would run off the pane.
     */
    /*
     * The menu lives on the WINDOW, not inside this control.
     *
     * `z` only orders siblings, so a popup nested in a header can never rise
     * above the list that header sits on — and a dismiss catcher parented
     * anywhere else would then cover the menu it is meant to protect.
     * Hoisting both to the outermost item puts them in one stacking context
     * where 99 and 100 mean what they say.
     *
     * The cost is positioning by hand, which is why `place()` runs on open
     * rather than a binding: the control does not move while a menu is
     * showing, so mapping once is both correct and cheaper than tracking it.
     */
    Rectangle {
        id: menu
        parent: root.window()
        visible: false
        // Above the dismiss catcher, which is at 99.
        z: 100
        /*
         * Sized from the CONTROL, never from its own contents.
         *
         * It read `Math.max(root.width, list.implicitWidth + …)` while the
         * Column inside was anchored to both its edges — so the menu's width
         * came from the Column and the Column's width came from the menu.
         * Qt reported it as a polish loop and stopped laying the page out,
         * which took the whole Server view down with it.
         *
         * The control is already sized to the longest option, so it is the
         * right measure for both and neither has to ask the other.
         */
        width: root.width
        /*
         * Computed from the OPTION COUNT, not from the Column inside.
         *
         * Reading `list.implicitHeight` kept the loop alive even after the
         * width was fixed: the Column is a positioner, so asking it for a
         * size during layout schedules another layout, and Qt spun on
         * `polish() inside updatePolish()` until the whole shell went
         * sluggish. Every row is one fixed height, so the total is
         * arithmetic — nothing has to be measured at all.
         */
        height: root.options.length * root.rowHeight + Style.space(8)
        radius: Style.cornerRadius
        /*
         * Opaque, explicitly.
         *
         * `Color.menu.background` carries the panel's own alpha, which is
         * right for a panel sitting over a desktop and wrong for a menu
         * sitting over a list — the rows beneath showed straight through the
         * options.
         */
        color: Qt.rgba(Color.menu.background.r, Color.menu.background.g, Color.menu.background.b, 1)
        border.width: 1
        border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.18)

        /*
         * Absorbs every press that lands on the menu.
         *
         * The options are TapHandlers, and a handler does not consume — so a
         * press on an option also reached whatever sat beneath the menu, and
         * picking a sort could press the button it was covering. A MouseArea
         * does consume, so one behind the options stops the click at the menu
         * without touching how the options themselves work.
         */
        MouseArea { anchors.fill: parent }

        Column {
            id: list
            // Width TAKEN from the menu, not anchored to it: an anchored
            // Column reports an implicit width the menu was reading back.
            width: menu.width
            anchors.top: parent.top
            anchors.topMargin: Style.space(4)
            spacing: 0

            Repeater {
                model: root.options

                Item {
                    id: option
                    required property var modelData
                    width: menu.width
                    height: root.rowHeight

                    readonly property bool chosen: String(option.modelData.value) === root.value

                    Rectangle {
                        anchors.fill: parent
                        anchors.leftMargin: Style.space(4)
                        anchors.rightMargin: Style.space(4)
                        radius: Style.cornerRadius
                        color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)
                        visible: optionHover.hovered
                    }

                    Text {
                        anchors.left: parent.left
                        anchors.leftMargin: Style.space(10)
                        anchors.verticalCenter: parent.verticalCenter
                        textFormat: Text.PlainText
                        text: String(option.modelData.label)
                        color: option.chosen ? root.accent : root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                    }

                    HoverHandler { id: optionHover; cursorShape: Qt.PointingHandCursor }
                    TapHandler {
                        onTapped: {
                            menu.visible = false
                            root.selected(String(option.modelData.value))
                        }
                    }
                }
            }
        }
    }

    /**
     * Pressing anywhere else closes it.
     *
     * A full-window catcher UNDER the menu rather than a handler on each
     * surface that might be clicked: the alternative is every page learning
     * that a dropdown exists somewhere and remembering to dismiss it, which
     * is a rule nobody applies consistently and a menu left hanging when they
     * forget.
     *
     * `parent` is walked to the top so the catcher covers the whole window;
     * the menu sits above it and keeps its own clicks.
     */
    MouseArea {
        parent: root.window()
        anchors.fill: parent
        visible: menu.visible
        z: 99
        // Accepts the press so the click that dismisses does not also land on
        // whatever was underneath — closing a menu is a complete action, not
        // a pass-through.
        onPressed: menu.visible = false
    }

    /** The outermost ancestor, which is as wide as the surface this sits on. */
    function window() {
        var item = root
        while (item.parent) item = item.parent
        return item
    }

    /** Dismissed by pressing anywhere else, which is what a menu is expected to do. */
    function close() { menu.visible = false }
}
