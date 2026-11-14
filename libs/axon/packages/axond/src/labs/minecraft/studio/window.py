"""Keep the dedicated Minecraft window flush with Studio's resizable X display."""

import sys
import time
from pathlib import Path

from Xlib import display


def main():
    ready = Path(sys.argv[1])
    screen = display.Display()
    root = screen.screen().root
    first_window_deadline = time.monotonic() + 45
    mismatch_since = None

    while True:
        windows = [child for child in root.query_tree().children
                   if (child.get_wm_name() or "").startswith("Minecraft")]
        if len(windows) > 1:
            raise RuntimeError("Studio display contains multiple Minecraft windows")
        if not windows:
            if time.monotonic() > first_window_deadline:
                raise RuntimeError("Minecraft never opened a Studio window")
            time.sleep(0.1)
            continue

        target = windows[0]
        desktop = root.get_geometry()
        bounds = target.get_geometry()
        wanted = (0, 0, desktop.width, desktop.height)
        actual = (bounds.x, bounds.y, bounds.width, bounds.height)
        if actual != wanted:
            target.configure(x=0, y=0, width=desktop.width, height=desktop.height)
            screen.sync()
            mismatch_since = mismatch_since or time.monotonic()
            if time.monotonic() - mismatch_since > 3:
                raise RuntimeError(f"Minecraft window refused Studio size {wanted}; still {actual}")
        else:
            mismatch_since = None
            if not ready.exists():
                ready.write_text("ready\n")
        time.sleep(0.1)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Studio window sizing failed: {error}", file=sys.stderr, flush=True)
        raise
