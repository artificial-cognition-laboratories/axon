"""Persistent stdio worker for a cognet's Python systems.

Stdout is the protocol. User prints go to stderr; every job receives a reply,
including import failures and exceptions with their Python traceback.
"""

import array
import asyncio
import base64
import importlib.util
import inspect
import json
import pathlib
import sys
import traceback
import types

from cognet.runtime import KernelError, Run, materialize
from cognet_generated.world import HYDRATE

KIND = {"f64": "d", "f32": "f", "i32": "i", "u32": "I", "u8": "B"}
FORMAT = {"d": "f64", "f": "f32", "i": "i32", "I": "u32", "B": "u8"}


def decode(value, kinds, buffers):
    if isinstance(value, dict) and set(value) == {"$array"}:
        index = value["$array"]
        if type(index) is not int or index < 0 or index >= len(buffers):
            raise ValueError(f"invalid array marker {index!r}")
        kind = kinds[index]
        if kind not in KIND:
            raise ValueError(f"unknown array kind {kind!r}")
        out = array.array(KIND[kind])
        out.frombytes(base64.b64decode(buffers[index], validate=True))
        if sys.byteorder != "little" and kind != "u8":
            out.byteswap()
        return out
    if isinstance(value, dict):
        return {key: decode(item, kinds, buffers) for key, item in value.items()}
    if isinstance(value, list):
        return [decode(item, kinds, buffers) for item in value]
    return value


def encode(value, kinds, buffers):
    from cognet.runtime import record
    value = record(value)
    if isinstance(value, (array.array, memoryview, bytes, bytearray)) or hasattr(value, "__array_interface__"):
        view = memoryview(value)
        fmt = view.format.lstrip("@=<>!")
        kind = FORMAT.get(fmt)
        if kind is None:
            raise TypeError(f"unsupported array format {view.format!r}; use f64, f32, i32, u32 or u8")
        if not view.c_contiguous:
            raise TypeError("an array written by a Python system must be C-contiguous")
        raw = view.tobytes()
        if sys.byteorder != "little" and kind != "u8":
            swapped = array.array(fmt)
            swapped.frombytes(raw)
            swapped.byteswap()
            raw = swapped.tobytes()
        buffers.append(base64.b64encode(raw).decode("ascii"))
        kinds.append(kind)
        return {"$array": len(buffers) - 1}
    if isinstance(value, dict):
        return {key: encode(item, kinds, buffers) for key, item in value.items()}
    if isinstance(value, list):
        return [encode(item, kinds, buffers) for item in value]
    return value


def load(path, root):
    relative = path.relative_to(root)
    parts = ["_cognet_user", *relative.parts[:-1]]
    for at in range(1, len(parts) + 1):
        name = ".".join(parts[:at])
        if name in sys.modules:
            continue
        package = types.ModuleType(name)
        package.__path__ = [str(root.joinpath(*parts[1:at]))]
        sys.modules[name] = package
    name = ".".join([*parts, relative.stem.replace(".", "_")])
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load Python system {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def write(message):
    """One protocol message, on the real stdout — a system's own prints go to stderr."""
    sys.__stdout__.write(json.dumps(message, allow_nan=False) + "\n")
    sys.__stdout__.flush()


def packed(value):
    kinds, buffers = [], []
    encoded = encode(value, kinds, buffers)
    return json.dumps(encoded, allow_nan=False), kinds, buffers


class Server:
    """
    Every Python system of one cognet, in one asyncio loop. A job runs as a
    task, so an async system waiting on the kernel holds up no other; a sync
    system runs to completion on the loop, as a sync system holds its tick.
    """

    def __init__(self, systems):
        self.systems = systems
        self.jobs = {}
        # The last kernel state the runtime sent; sent again only when it changes, or this process restarts.
        self.state = None

    async def serve(self):
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader(limit=1 << 30)
        await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
        while line := await reader.readline():
            message = json.loads(line)
            kind = message["kind"]
            if kind == "job":
                self.start(message)
            elif kind == "answer":
                self.answered(message)
            elif kind == "event":
                self.jobs[message["job"]]["streams"][message["call"]].put_nowait(("event", self.value(message)))
            elif kind == "end":
                self.jobs[message["job"]]["streams"][message["call"]].put_nowait(("end", None))
            elif kind == "cancel":
                job = self.jobs.get(message["job"])
                if job is not None:
                    job["task"].cancel()
            else:
                raise ValueError(f"the runtime sent a {kind!r} message, which this process does not know")
        for job in list(self.jobs.values()):
            job["task"].cancel()

    def start(self, message):
        identifier = message["job"]
        job = {"calls": {}, "streams": {}, "next": 0}
        self.jobs[identifier] = job
        job["task"] = asyncio.get_running_loop().create_task(self.run(identifier, message, job))

    def answered(self, message):
        job = self.jobs[message["job"]]
        stream = job["streams"].get(message["call"])
        if stream is not None:
            # A stream is answered once only when it fails: the error that stopped it.
            stream.put_nowait(("error", KernelError(message["error"]["code"], message["error"]["message"])))
            return
        future = job["calls"].pop(message["call"])
        if "error" in message:
            future.set_exception(KernelError(message["error"]["code"], message["error"]["message"]))
        else:
            future.set_result(self.value(message))

    def value(self, message):
        return materialize(decode(json.loads(message["value"]), message["kinds"], message["arrays"]))

    async def run(self, identifier, message, job):
        try:
            fn, declared = self.systems[message["system"]]
            snapshot = json.loads(message["snapshot"])
            entries = decode(snapshot["entries"], message["kinds"], message["arrays"])
            streams = decode(snapshot["streams"], message["kinds"], message["arrays"])
            streamed = {name: [tuple(write) for write in writes] for name, writes in streams}
            stimuli = decode(snapshot.get("stimuli", []), message["kinds"], message["arrays"])
            if "state" in snapshot:
                self.state = snapshot["state"]
            asynchronous = inspect.iscoroutinefunction(fn)
            run = Run(snapshot["now"], entries, declared["reads"] + declared["recalls"], declared["writes"], streamed,
                      stimuli, snapshot["entities"], HYDRATE, self.state,
                      send=(lambda effect: self.effect(identifier, effect)) if asynchronous else None,
                      ask=(lambda op, args: self.ask(identifier, job, op, args)) if asynchronous else None,
                      stream=(lambda op, args: self.stream(identifier, job, op, args)) if asynchronous else None)
            result = (await fn(run)) if asynchronous else fn(run)
            if result is not None:
                raise ValueError(f'{message["system"]} returned a value; systems return None')
            ran, kinds, buffers = packed({"changes": run.ecs.complete(), "effects": run.kernel.effects})
            self.abandoned(identifier, job)
            write({"kind": "done", "job": identifier, "ran": ran, "kinds": kinds, "arrays": buffers})
        except asyncio.CancelledError:
            self.abandoned(identifier, job)
            write({"kind": "cancelled", "job": identifier})
        except Exception:
            self.abandoned(identifier, job)
            write({"kind": "error", "job": identifier, "error": traceback.format_exc()})
        finally:
            self.jobs.pop(identifier, None)

    def effect(self, identifier, effect):
        text, kinds, buffers = packed(effect)
        write({"kind": "effect", "job": identifier, "effect": text, "kinds": kinds, "arrays": buffers})

    async def ask(self, identifier, job, op, args):
        call = job["next"]
        job["next"] += 1
        future = asyncio.get_running_loop().create_future()
        job["calls"][call] = future
        text, kinds, buffers = packed(args)
        write({"kind": "call", "job": identifier, "call": call, "op": op, "args": text, "kinds": kinds, "arrays": buffers})
        return await future


    async def stream(self, identifier, job, op, args):
        """A streamed call: each event as it comes, until the end. Left early, the runtime is told to stop."""
        call = job["next"]
        job["next"] += 1
        queue = asyncio.Queue()
        job["streams"][call] = queue
        text, kinds, buffers = packed(args)
        write({"kind": "call", "job": identifier, "call": call, "op": op, "args": text, "kinds": kinds, "arrays": buffers})
        ended = False
        try:
            while True:
                kind, value = await queue.get()
                if kind == "end":
                    ended = True
                    return
                if kind == "error":
                    ended = True
                    raise value
                yield value
        finally:
            # Left early. Python closes an abandoned generator whenever it likes — after its run may be over, when
            # `abandoned` has already said so; a stop for a finished run would be a protocol error.
            if job["streams"].pop(call, None) is not None and not ended:
                write({"kind": "stop", "job": identifier, "call": call})

    def abandoned(self, identifier, job):
        """Every stream a run left open, stopped before it says it is done."""
        for call in list(job["streams"]):
            write({"kind": "stop", "job": identifier, "call": call})
        job["streams"].clear()


def main():
    root = pathlib.Path(sys.argv[1]).resolve()
    specs = json.loads(sys.argv[2])
    # Stdout is the protocol: whatever a system prints goes to stderr, for the whole process.
    sys.stdout = sys.stderr
    systems = {}
    for item in specs:
        module = load(root / item["file"], root)
        fn = getattr(module, item["function"])
        if not hasattr(fn, "__cognet_system__"):
            raise ValueError(f'{item["file"]}: declared function is missing @system')
        systems[item["name"]] = (fn, item["declaration"])
    asyncio.run(Server(systems).serve())


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc(file=sys.stderr)
        raise
