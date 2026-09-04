import QtQuick
import QtQuick.Shapes

/**
 * A filled area chart over a time series.
 *
 * Drawn with `QtQuick.Shapes` — there is no chart component in `qs.Ui` and no
 * QtCharts on the system, so paths are the primitive. Retained mode, so the
 * scene graph animates it rather than a CPU repaint per tick.
 *
 * ── The fill IS the meter ───────────────────────────────────────────────────
 *
 * Full height is `max`, so the height of the fill reads as "how much of the
 * capacity is in use" while its shape reads as "which way it is going". That is
 * why there is no separate track-and-fill bar beside it: one mark carries both
 * answers, and at panel width two would be noise.
 *
 * Two of these stacked is how VRAM shows the machine's total use and Axon's
 * own share inside it — no special case here, just one drawn over the other.
 */
Item {
    id: root

    /** Numbers, oldest first. Fewer than two points draws nothing. */
    property var values: []
    /**
     * When each reading was taken, epoch ms, aligned with `values`.
     *
     * Load-bearing, not decoration. The daemon's cadence is ADAPTIVE — half a
     * second while a panel watches, two seconds while something is resident,
     * ten when neither — so spacing points evenly by index draws a ten-second
     * gap the same width as a half-second one, and a chart that lies about
     * time is worse than no chart.
     *
     * Empty falls back to even spacing, which is right only when the caller
     * genuinely has no timestamps.
     */
    property var times: []
    /**
     * How much time the full width represents.
     *
     * Fixed, so the axis means the same thing at every moment. Without it the
     * series simply stretched to fill whatever width it had, so three samples
     * spanned a chart's worth of time and then visibly compressed as more
     * arrived — the line appeared to slow down as the machine kept going.
     *
     * Five minutes, matching what the daemon's ring holds. Since the daemon
     * samples from boot and the stream reads ITS history rather than its own,
     * a panel opened on a machine that has been up longer than this opens onto
     * a full graph.
     */
    property int windowMs: 300000
    /** Full-scale value. Null or zero means unmeasurable — the chart stays empty. */
    property var max: null

    property color stroke: "#0094d2"
    property color fill: Qt.rgba(stroke.r, stroke.g, stroke.b, 0.18)
    property real strokeWidth: 1.25
    /**
     * How rounded the line is, 0 straight to 1 fully curved.
     *
     * The curve is MONOTONE cubic, not a plain spline: an ordinary smoothing
     * pass overshoots between points, and on a series capped at capacity that
     * draws a GPU briefly above 100% or video memory above the card. A curve
     * that invents readings the machine never reported is not a nicer chart,
     * it is a wrong one. Monotone interpolation cannot leave the interval
     * between two neighbouring samples, so rounding stays cosmetic.
     */
    property real smoothing: 0.9

    /**
     * Whether the axis should advance between readings.
     *
     * The window slides against the wall clock rather than pinning the newest
     * sample to the right edge, which is what makes the line drift smoothly
     * instead of stepping once per tick. Only honest while something is
     * actually watching: the daemon's cadence drops to ten seconds when
     * nothing is, and sliding a ten-second gap would open a visible void at
     * the right edge. The drift is capped for the same reason — see `edge`.
     */
    property bool live: false

    implicitHeight: 22

    /** Is there a scale to draw against, and more than one reading. */
    readonly property bool scaled: !!max && max > 0 && !!values && values.length > 1

    /** Enough points survived the window to make a line. */
    readonly property bool drawable: points.length > 1

    /**
     * The wall clock, ticked at 24fps while live.
     *
     * A property rather than a direct `Date.now()` read inside the points
     * binding, because a binding has to be told what changed before it will
     * re-evaluate. 24fps is deliberate: the line moves about a pixel per
     * frame at panel width, which is smooth to the eye, and a panel that is
     * only a status readout has no business asking for 60.
     */
    property double nowMs: Date.now()

    Timer {
        interval: 42
        running: root.live && root.visible && root.scaled
        repeat: true
        onTriggered: root.nowMs = Date.now()
    }

    /**
     * The instant drawn at the right edge.
     *
     * The wall clock while readings keep arriving, but never more than one
     * slow tick past the newest one. Without the cap a stalled stream — the
     * daemon restarting, the machine suspending — would scroll the whole
     * series off the left of the chart, which reads as "everything stopped"
     * rather than "no new reading yet". Pinned to the newest sample when not
     * live, which is the old behaviour and the right one for a still frame.
     */
    readonly property double edge: {
        var n = values ? values.length : 0
        var timed = !!times && times.length === n && n > 0
        if (!timed) return 0
        var newest = times[n - 1]
        if (!live) return newest
        return Math.min(nowMs, newest + 2500)
    }

    /**
     * Sample points, split into contiguous RUNS.
     *
     * A run breaks wherever a reading is null. Null here means the daemon
     * could not measure that field at that instant — Axon's video-memory share
     * is only queried while something is watching, so an unwatched stretch is
     * genuinely absent rather than zero. Drawing it as zero would claim we
     * measured an idle machine; drawing a line straight across it would claim
     * continuity through readings nobody took. A gap says what happened.
     *
     * Anything older than the window is dropped rather than clamped to the
     * left edge, where it would pile into a vertical wall.
     */
    readonly property var runs: {
        if (!scaled || width <= 0 || height <= 0) return []
        var out = []
        var run = []
        var n = values.length
        var timed = !!times && times.length === n

        for (var i = 0; i < n; i++) {
            var raw = values[i]
            var v = Number(raw)
            if (raw === null || raw === undefined || !isFinite(v)) {
                if (run.length > 0) { out.push(run); run = [] }
                continue
            }
            var ratio = Math.max(0, Math.min(1, v / max))

            var x
            if (timed) {
                var age = edge - times[i]
                if (age > windowMs) continue
                x = width - width * (age / windowMs)
            } else {
                x = width * (i / (n - 1))
            }
            // Carries its source index so a hover can name the reading it hit.
            run.push({ x: x, y: height - height * ratio, i: i, v: v })
        }
        if (run.length > 0) out.push(run)
        return out
    }

    /** Every drawn point, flattened — what hovering and the head marker read. */
    readonly property var points: {
        var out = []
        for (var r = 0; r < runs.length; r++)
            for (var i = 0; i < runs[r].length; i++) out.push(runs[r][i])
        return out
    }

    /** Where the newest reading sits, for the caller's live dot. Null when there is none. */
    readonly property var head: points.length > 0 ? points[points.length - 1] : null

    /**
     * The drawn point nearest an x in item coordinates, or null.
     *
     * Nearest rather than interpolated: every point here is a reading the
     * machine actually reported, and a hover box should quote one of those
     * rather than a value invented between two of them.
     */
    function nearest(px) {
        var p = points
        if (p.length === 0) return null
        var best = p[0]
        var gap = Math.abs(p[0].x - px)
        for (var i = 1; i < p.length; i++) {
            var d = Math.abs(p[i].x - px)
            if (d < gap) { gap = d; best = p[i] }
        }
        return best
    }

    /**
     * The line as SVG path data.
     *
     * A string rather than `PathPolyline` because a curve needs cubic
     * segments and `ShapePath` cannot hold a Repeater of them. Built once per
     * change of the points, which is once per frame while live — cheap next
     * to the scene graph work it feeds.
     *
     * Monotone cubic (Fritsch–Carlson): the tangent at a point is zeroed
     * wherever the series changes direction, which is exactly what stops the
     * curve leaving the interval its neighbours define.
     */
    readonly property string line: {
        var d = ""
        for (var r = 0; r < runs.length; r++) {
            var segment = curve(runs[r])
            if (segment !== "") d += (d === "" ? "" : " ") + segment
        }
        return d
    }

    /** The same curve closed down to the baseline, so the path can be filled. */
    readonly property string areaPath: {
        var d = ""
        for (var r = 0; r < runs.length; r++) {
            var p = runs[r]
            var segment = curve(p)
            if (segment === "") continue
            d += (d === "" ? "" : " ") + segment
                 + " L " + p[p.length - 1].x + " " + height
                 + " L " + p[0].x + " " + height + " Z"
        }
        return d
    }

    /**
     * One contiguous run as SVG path data.
     *
     * A string rather than `PathPolyline` because a curve needs cubic
     * segments and `ShapePath` cannot hold a Repeater of them. Built once per
     * change of the points, which is once per frame while live — cheap next
     * to the scene graph work it feeds.
     *
     * Monotone cubic (Fritsch-Carlson): the tangent at a point is zeroed
     * wherever the series changes direction, which is exactly what stops the
     * curve leaving the interval its neighbours define.
     */
    function curve(p) {
        if (!p || p.length < 2) return ""
        if (smoothing <= 0) {
            var flat = "M " + p[0].x + " " + p[0].y
            for (var f = 1; f < p.length; f++) flat += " L " + p[f].x + " " + p[f].y
            return flat
        }

        var n = p.length
        var dx = [], slope = []
        for (var i = 0; i < n - 1; i++) {
            var ddx = p[i + 1].x - p[i].x
            dx.push(ddx)
            // A zero step would divide by zero. Two readings at one instant is
            // not a shape, so the segment simply has no slope.
            slope.push(ddx === 0 ? 0 : (p[i + 1].y - p[i].y) / ddx)
        }

        var m = [slope[0]]
        for (var k = 1; k < n - 1; k++) {
            // Direction change, or a flat step: tangent zero. This is the
            // whole overshoot guard.
            if (slope[k - 1] * slope[k] <= 0) m.push(0)
            else {
                var w1 = 2 * dx[k] + dx[k - 1]
                var w2 = dx[k] + 2 * dx[k - 1]
                m.push((w1 + w2) / (w1 / slope[k - 1] + w2 / slope[k]))
            }
        }
        m.push(slope[slope.length - 1])

        var d = "M " + p[0].x + " " + p[0].y
        for (var s2 = 0; s2 < n - 1; s2++) {
            var h = dx[s2] / 3 * smoothing
            d += " C " + (p[s2].x + h) + " " + (p[s2].y + m[s2] * h)
               + " " + (p[s2 + 1].x - h) + " " + (p[s2 + 1].y - m[s2 + 1] * h)
               + " " + p[s2 + 1].x + " " + p[s2 + 1].y
        }
        return d
    }

    Shape {
        anchors.fill: parent
        preferredRendererType: Shape.CurveRenderer
        visible: root.drawable

        ShapePath {
            strokeWidth: 0
            strokeColor: "transparent"
            /*
             * A gradient rather than a flat wash. A constant alpha reads as a
             * block of colour sitting under the line; a fade to nothing lets
             * the line stay the figure and the fill stay its shadow, which is
             * what separates two stacked series at 30 pixels tall.
             */
            fillGradient: LinearGradient {
                x1: 0; y1: 0
                x2: 0; y2: root.height
                GradientStop { position: 0.0; color: Qt.rgba(root.fill.r, root.fill.g, root.fill.b, root.fill.a) }
                GradientStop { position: 1.0; color: Qt.rgba(root.fill.r, root.fill.g, root.fill.b, 0.0) }
            }
            PathSvg { path: root.areaPath }
        }

        ShapePath {
            strokeColor: root.stroke
            strokeWidth: root.strokeWidth
            fillColor: "transparent"
            capStyle: ShapePath.RoundCap
            joinStyle: ShapePath.RoundJoin
            PathSvg { path: root.line }
        }
    }
}
