.pragma library

/**
 * Flatten a nested node list into rows a Repeater can render.
 *
 * QML can recurse through nested Loaders, but a process tree is shallow and
 * rebuilt on every tick — walking it once in JS is cheaper than instantiating a
 * component per level, and it puts collapse in one place: a collapsed node is
 * simply not descended into.
 *
 * A node is `{ key, children, ...whatever the row needs }`. The walk adds:
 *   depth        how far to indent
 *   hasChildren  whether to draw a caret at all
 *   expanded     caret direction, and whether the walk descended
 *   rails        for each ancestor level, true when that ancestor has a later
 *                sibling — which is what decides whether its guide continues
 *                past this row or stops
 */
function flatten(nodes, collapsed) {
    var out = []
    walk(nodes || [], collapsed || ({}), 0, [], out)
    return out
}

function walk(nodes, collapsed, depth, rails, out) {
    for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i]
        var children = node.children || []
        var isLast = i === nodes.length - 1
        var expanded = !collapsed[node.key]

        out.push({
            node: node,
            key: node.key,
            depth: depth,
            hasChildren: children.length > 0,
            expanded: expanded,
            isLast: isLast,
            rails: rails.slice(),
        })

        if (children.length > 0 && expanded)
            walk(children, collapsed, depth + 1, rails.concat([!isLast]), out)
    }
}

/** Toggle one key in a collapsed map, returning a new map so bindings fire. */
function toggle(collapsed, key) {
    var next = {}
    for (var k in collapsed) next[k] = collapsed[k]
    if (next[key]) delete next[key]
    else next[key] = true
    return next
}
