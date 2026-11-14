"""One Python run's declared view of the ECS and its staged writes."""

from dataclasses import fields, is_dataclass


class _Unset:
    pass


UNSET = _Unset()


def system(**declaration):
    """Attach declaration data; prepare reads the same literals without importing code."""
    def decorate(fn):
        fn.__cognet_system__ = declaration
        return fn
    return decorate


class Value:
    """A record received from the world, readable with attribute syntax."""

    def __init__(self, fields):
        self._fields = fields

    def __getattr__(self, name):
        key = name[:-1] if name.endswith("_") and name[:-1] in self._fields else name
        try:
            return self._fields[key]
        except KeyError as cause:
            raise AttributeError(name) from cause

    def __getitem__(self, name):
        return self._fields[name]


def materialize(value):
    if isinstance(value, dict):
        return Value({key: materialize(item) for key, item in value.items()})
    if isinstance(value, list):
        return [materialize(item) for item in value]
    return value


def record(value):
    if is_dataclass(value) and not isinstance(value, type):
        return {field.metadata.get("json", field.name): record(item) for field in fields(value)
                if (item := getattr(value, field.name)) is not UNSET}
    if isinstance(value, Value):
        return record(value._fields)
    if isinstance(value, dict):
        return {key: record(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [record(item) for item in value]
    return value


class Component:
    def __init__(self, world, name):
        self.world = world
        self.name = name

    def get(self, entity):
        self.world.readable(self.name)
        return self.world.entries.get((self.name, entity))

    def first(self):
        rows = self.all()
        return rows[0] if rows else None

    def all(self):
        self.world.readable(self.name)
        return [(entity, value) for (name, entity), value in self.world.entries.items() if name == self.name]


class Writer:
    def __init__(self, world, entity):
        self.world = world
        self.entity = entity
        self.staged = []
        self.closed = False

    def __getattr__(self, short):
        name = self.world.resolve(short)
        self.world.writable(name)

        def put(value):
            if self.closed:
                raise RuntimeError("a committed writer cannot be used again")
            self.staged.append({"op": "set", "entity": self.entity, "component": name, "data": record(value)})
            return self
        return put

    def remove(self, name):
        full = self.world.resolve(name)
        self.world.writable(full)
        self.staged.append({"op": "remove", "entity": self.entity, "component": full})
        return self

    def commit(self):
        if self.closed:
            raise RuntimeError("a writer can commit only once")
        self.closed = True
        self.world.changes.extend(self.staged)


class Ecs:
    def __init__(self, entries, reads, writes, streams, entities, hydrate):
        self.hydrate = hydrate
        self.entries = {(name, entity): self.value(name, value) for name, entity, value in entries}
        self.reads = set(reads)
        self.writes = set(writes)
        self.changes = []
        self.writers = []
        self.entities = set(entities)
        all_names = self.reads | self.writes | set(streams)
        self.aliases = {name: name for name in all_names}
        for name in all_names:
            short = name.rsplit("/", 1)[-1]
            if short not in self.aliases:
                matches = [full for full in all_names if full.rsplit("/", 1)[-1] == short]
                if len(matches) == 1:
                    self.aliases[short] = name

    def value(self, name, raw):
        return self.hydrate[name](raw) if name in self.hydrate else materialize(raw)

    def resolve(self, name):
        found = self.aliases.get(name)
        if found is None:
            raise ValueError(f'component "{name}" is undeclared or ambiguous; use its full name')
        return found

    def readable(self, name):
        if name not in self.reads:
            raise ValueError(f'read "{name}" without declaring it in reads or recalls')

    def writable(self, name):
        if name not in self.writes:
            raise ValueError(f'wrote "{name}" without declaring it in writes')

    def __getattr__(self, name):
        return Component(self, self.resolve(name))

    def write(self, entity):
        writer = Writer(self, entity)
        self.writers.append(writer)
        return writer

    def has(self, entity):
        return entity in self.entities

    def query(self, *, components, optional=()):
        required = [self.resolve(name) for name in components]
        extras = [self.resolve(name) for name in optional]
        for name in [*required, *extras]:
            self.readable(name)
        ids = {entity for name, entity in self.entries if name in required}
        if not required:
            ids = self.entities
        rows = []
        for entity in sorted(ids):
            if any((name, entity) not in self.entries for name in required):
                continue
            fields = {"id": entity}
            for name in [*required, *extras]:
                value = self.entries.get((name, entity))
                if value is not None:
                    fields[name.rsplit("/", 1)[-1]] = value
            rows.append(Value(fields))
        return rows

    def complete(self):
        if any(not writer.closed for writer in self.writers):
            raise RuntimeError("a Python system left an uncommitted ECS writer")
        return self.changes


class Time:
    """When a stimulus arrived: wall-clock ms, and its place in the session."""

    def __init__(self, ms, seq):
        self.ms = ms
        self.seq = seq


class Stimulus:
    """One reading, from one sense, on one channel. Its fields are the kind's, in snake_case."""

    def __init__(self, kind, time, data):
        self.kind = kind
        self.time = time
        for key, value in data.items():
            setattr(self, snake(key), materialize(value))


class TextStimulus(Stimulus): pass
class AudioStimulus(Stimulus): pass
class VisualStimulus(Stimulus): pass
class VectorStimulus(Stimulus): pass


STIMULI = {"text": TextStimulus, "audio": AudioStimulus, "visual": VisualStimulus, "vector": VectorStimulus}


def stimulus(entry):
    kind = entry["type"].rsplit(":", 1)[-1]
    if not entry["type"].startswith("cognet:stimulus:") or kind not in STIMULI:
        raise ValueError(f'the runtime sent a stimulus of kind {entry["type"]}, which this runtime does not know')
    return STIMULI[kind](kind, Time(entry["time"]["ms"], entry["time"]["seq"]), entry["data"])


# What this runtime's kernel implements, as the runtime's verb table names it — held to
# tests/contract/verbs.json with the runtime's and the Rust crate's.
SURFACE = {
    "effects": ["output", "emit", "fault", "release", "reset", "close"],
    "state": ["body", "presence", "scope", "services"],
    "calls": [
        "service.call",
        "service.stream",
        "service.open",
        "service.push",
        "run",
        "store.get",
        "store.set",
        "store.session",
        "knowledge.list",
        "knowledge.read",
        "knowledge.write",
        "knowledge.remove",
        "memory.connect",
        "base",
    ],
}


class KernelError(Exception):
    """The kernel refused a call: its structured code, and why."""

    def __init__(self, code, message):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


class Kernel:
    """
    The kernel for one run. Effects need no answer: a sync system's are made
    when its run lands, an async one's as it makes them. State is as it stood
    when the run began. Calls need an answer, so only an async system may make
    them — `ask` is how it asks; a sync run has none.
    """

    def __init__(self, state, send=None, ask=None, stream=None):
        self._state = state
        self._send = send
        self._ask = ask
        self._stream = stream
        self.effects = []
        self.store = _Store(self)
        self.knowledge = _Knowledge(self)
        self.memory = _Memory(self)

    def output(self, type, **data):
        if type not in ("text", "audio", "visual", "vector"):
            raise ValueError(f"output takes text, audio, visual or vector, not {type!r}")
        self._effect("output", {"type": type, "data": {camel(key): record(value) for key, value in data.items() if value is not None}})

    def emit(self, type, data):
        if not type.startswith("cognet:"):
            raise ValueError(f"emit takes a cognet:… type, not {type!r}")
        self._effect("emit", {"type": type, "data": record(data)})

    def fault(self, code, message, excerpt=None):
        args = {"code": code, "message": message}
        if excerpt is not None:
            args["excerpt"] = excerpt
        self._effect("fault", args)

    # TEMP (2026-10-13): plain values until the schema readers express tagged unions; then Manifest, Presence and
    # Scope are generated from @arcforge/types like every component.
    def body(self):
        return materialize(self._held()["body"])

    def presence(self):
        return materialize(self._held()["presence"])

    def scope(self):
        return materialize(self._held()["scope"])

    async def run(self, code):
        return await self.call("run", {"code": code})

    async def base(self):
        return await self.call("base", {})

    async def call(self, op, args):
        if self._ask is None:
            raise RuntimeError(f"{op} needs an answer, so only an async system may ask it — make the system `async def`")
        return await self._ask(op, args)

    def stream(self, op, args):
        if self._stream is None:
            raise RuntimeError(f"{op} answers as it goes, so only an async system may ask it — make the system `async def`")
        return self._stream(op, args)

    def _effect(self, verb, args):
        effect = {"verb": verb, "args": args}
        if self._send is None:
            self.effects.append(effect)
        else:
            self._send(effect)

    def _held(self):
        if self._state is None:
            raise RuntimeError("this run has no kernel state")
        return self._state


class _Session:
    def __init__(self, kernel):
        self._kernel = kernel

    async def get(self, after=None):
        return await self._kernel.call("store.session", {} if after is None else {"after": after})


class _Store:
    def __init__(self, kernel):
        self._kernel = kernel
        self.session = _Session(kernel)

    async def get(self, key):
        return await self._kernel.call("store.get", {"key": key})

    async def set(self, key, value):
        await self._kernel.call("store.set", {"key": key, "value": record(value)})


class _Knowledge:
    def __init__(self, kernel):
        self._kernel = kernel

    async def list(self, match=None, limit=None):
        args = {}
        if match is not None:
            args["match"] = match
        if limit is not None:
            args["limit"] = limit
        return await self._kernel.call("knowledge.list", args)

    async def read(self, name):
        return await self._kernel.call("knowledge.read", {"name": name})

    async def write(self, name, content):
        await self._kernel.call("knowledge.write", {"name": name, "content": content})

    async def remove(self, name):
        await self._kernel.call("knowledge.remove", {"name": name})


class _Memory:
    def __init__(self, kernel):
        self._kernel = kernel

    async def connect(self, name):
        return await self._kernel.call("memory.connect", {"name": name})


class Handle:
    """
    Something a provider keeps — an encoded picture, a loaded scene — crossing
    only as its id. Pass it back to the use that made it; release it when done.
    """

    def __init__(self, kernel, name, id):
        self._kernel = kernel
        self.name = name
        self.id = id

    def release(self):
        self._kernel._effect("release", {"handle": self.id})

    def __repr__(self):
        return f"Handle({self.name!r}, {self.id!r})"


class ServiceSession:
    """Pushes that share state, each answered in order, until it is closed."""

    def __init__(self, kernel, id):
        self._kernel = kernel
        self.id = id

    async def push(self, value):
        return _answer(self._kernel, await self._kernel.call("service.push", {"session": self.id, "value": _argument(value)}))

    def reset(self):
        self._kernel._effect("reset", {"session": self.id})

    def close(self):
        self._kernel._effect("close", {"session": self.id})


class Use:
    """
    One use a cognet declared, by its own name. `available` and `describe()`
    are state, as they stood when the run began; calls need an answer, so only
    an async system makes them.
    """

    def __init__(self, kernel, name):
        self._kernel = kernel
        self.name = name

    @property
    def available(self):
        return self._state()["available"]

    def describe(self):
        """What the granted provider reports of itself — None while nothing fills the use."""
        described = self._state()["describe"]
        return None if described is None else materialize(described)

    async def call(self, method, **args):
        return _answer(self._kernel, await self._kernel.call("service.call", self._asked(method, args)))

    async def stream(self, method, **args):
        async for event in self._kernel.stream("service.stream", self._asked(method, args)):
            yield _answer(self._kernel, event)

    async def open(self, method):
        return ServiceSession(self._kernel, await self._kernel.call("service.open", {"use": self.name, "method": method}))

    def _asked(self, method, args):
        return {"use": self.name, "method": method, "args": {camel(key): _argument(value) for key, value in args.items()}}

    def _state(self):
        return self._kernel._held()["services"][self.name]


class Services:
    """Every use the cognet declared, by name: `run.services.depth`."""

    def __init__(self, kernel):
        self._kernel = kernel

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        if name not in self._kernel._held()["services"]:
            raise AttributeError(f"{name} is no use this cognet declares in uses")
        return Use(self._kernel, name)


def _argument(value):
    if isinstance(value, Handle):
        return {"handle": value.name, "id": value.id}
    if isinstance(value, ServiceSession):
        raise TypeError("a session is pushed to, not passed as an argument")
    return record(value)


def _answer(kernel, value):
    """An answer as a system holds it: every handle in it one it can release."""
    if isinstance(value, Value) and set(value._fields) == {"handle", "id"}:
        return Handle(kernel, value.handle, value.id)
    if isinstance(value, Value):
        return Value({key: _answer(kernel, item) for key, item in value._fields.items()})
    if isinstance(value, list):
        return [_answer(kernel, item) for item in value]
    return value


def snake(name):
    return "".join(f"_{char.lower()}" if char.isupper() else char for char in name)


def camel(name):
    head, *rest = name.split("_")
    return head + "".join(part.title() for part in rest)


class Run:
    def __init__(self, now, entries, reads, writes, streams, stimuli, entities, hydrate, state=None, send=None, ask=None, stream=None):
        self.now = now
        self.ecs = Ecs(entries, reads, writes, streams, entities, hydrate)
        self.stimuli = [stimulus(entry) for entry in stimuli]
        self.kernel = Kernel(state, send, ask, stream)
        self.services = Services(self.kernel)
        self._streams = streams

    def since(self, name):
        full = self.ecs.resolve(name)
        if full not in self._streams:
            raise ValueError(f'stream "{name}" was not declared')
        return [(entity, self.ecs.value(full, value), at) for entity, value, at in self._streams[full]]
