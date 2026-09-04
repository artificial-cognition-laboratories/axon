import QtQuick

import "browser"

Item {
  id: root

  property var shell: null
  property var manifest: null
  property var service: null
  // The shell reads this to decide whether the overlay is open. It mirrors the
  // mounted surface; Browser and Jobs still own their own windows and dismissal.
  readonly property bool opened: surface.item ? surface.item.opened === true : false
  property bool loaded: false
  property string view: "browser"
  property string payload: "{}"

  /*
   * One surface now.
   *
   * The jobs view is gone. It was a THIRD place to look at agent work beside
   * the terminal and the debugger, and every attempt at it grew a message box
   * — at which point it was competing with the terminal, which owns the
   * conversation and wins. The capability survives as `axon job`, and the
   * fleet page launches work rather than hosting it.
   *
   * The payload is still parsed rather than ignored: `summon` callers pass one
   * and a future surface will want it.
   */
  function parseView(payloadJson) {
    return "browser"
  }

  function open(payloadJson) {
    payload = payloadJson || "{}"
    view = parseView(payload)
    loaded = true
    if (surface.item && typeof surface.item.open === "function") surface.item.open(payload)
  }

  function close() {
    if (surface.item && typeof surface.item.close === "function") surface.item.close()
    loaded = false
  }

  Loader {
    id: surface
    anchors.fill: parent
    active: root.loaded
    sourceComponent: browserSurface

    Component {
      id: browserSurface
      Browser { shell: root.shell; manifest: root.manifest; service: root.service }
    }

    onLoaded: {
      if (root.loaded && item && typeof item.open === "function") item.open(root.payload)
    }
  }
}
