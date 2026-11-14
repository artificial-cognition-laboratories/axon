"""The Python runtime against the pinned contract: the kernel surface it implements, and every
message of the conversation — spoken and heard by the real Server, with no host."""

import asyncio
import json
import pathlib
import sys
import types

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))
# serve.py reads the cognet's generated hydration table; this test has no cognet.
generated = types.ModuleType("cognet_generated")
world = types.ModuleType("cognet_generated.world")
world.HYDRATE = {}
sys.modules["cognet_generated"] = generated
sys.modules["cognet_generated.world"] = world

import serve  # noqa: E402
from cognet import system  # noqa: E402
from cognet.runtime import SURFACE  # noqa: E402

CONTRACT = ROOT / "tests" / "contract"


def pinned(name):
    return json.loads((CONTRACT / name).read_text())


def test_surface():
    assert SURFACE == pinned("verbs.json")


@system(once=True, writes=["seen"])
async def look(run):
    depth = await run.services.depth.call("estimate", picture=[1.0, 2.0])
    run.kernel.output("text", channel="/log", content="asked")
    run.ecs.write("self").seen(list(depth)).commit()


async def converse():
    messages = pinned("messages.json")
    said = []
    serve.write = said.append
    server = serve.Server({"look": (look, {"reads": [], "recalls": [], "writes": ["seen"], "uses": ["depth"]})})
    server.start(messages["told"]["job"])
    await asyncio.sleep(0)
    call = said[0]
    assert sorted(call) == sorted(messages["said"]["call"])
    assert json.loads(call["args"]) == json.loads(messages["said"]["call"]["args"])
    server.answered({**messages["told"]["answer"], "call": call["call"]})
    for _ in range(5):
        await asyncio.sleep(0)
    effect, done = said[1], said[2]
    assert sorted(effect) == sorted(messages["said"]["effect"])
    assert json.loads(effect["effect"]) == json.loads(messages["said"]["effect"]["effect"])
    assert sorted(done) == sorted(messages["said"]["done"])
    assert json.loads(done["ran"]) == json.loads(messages["said"]["done"]["ran"])


@system(once=True, writes=["seen"])
async def chat(run):
    assert run.services.main.available and not run.services.hear.available
    assert run.services.depth.describe().maxSide == 518
    written = []
    async for event in run.services.main.stream("stream", conversation={"messages": [{"role": "user", "text": "hi"}]}):
        written.append(event.text)
        break
    run.ecs.write("self").seen(written).commit()


async def stream():
    """A streamed call: asked as pinned, each event heard as it comes, and stopped when the system leaves early."""
    messages = pinned("messages.json")
    snapshot = pinned("snapshot.json")
    state = {**snapshot["state"], "services": {**snapshot["state"]["services"], "main": {"available": True, "describe": {"context": 200000}}}}
    job = {**messages["told"]["job"], "snapshot": json.dumps({**json.loads(messages["told"]["job"]["snapshot"]), "state": state})}
    said = []
    serve.write = said.append
    server = serve.Server({"look": (chat, {"reads": [], "recalls": [], "writes": ["seen"]})})
    server.start(job)
    await asyncio.sleep(0)
    call = said[0]
    assert sorted(call) == sorted(messages["said"]["stream"])
    assert json.loads(call["args"]) == json.loads(messages["said"]["stream"]["args"])
    asked = server.jobs[job["job"]]
    for key in ("event",):
        message = {**messages["told"][key], "call": call["call"]}
        asked["streams"][call["call"]].put_nowait(("event", server.value(message)))
    for _ in range(5):
        await asyncio.sleep(0)
    stop, done = said[1], said[2]
    assert stop == {**messages["said"]["stop"], "call": call["call"]}
    assert json.loads(done["ran"])["changes"][0]["data"] == ["Hel"]


def test_conversation():
    asyncio.run(converse())


def test_stream():
    asyncio.run(stream())


if __name__ == "__main__":
    test_surface()
    test_conversation()
    test_stream()
    print("ok")
