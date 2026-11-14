"""Read system declarations without importing user code or its dependencies."""

import ast
import json
import pathlib
import sys

FIELDS = {"on", "reads", "recalls", "streams", "writes", "uses", "once", "lag", "thread"}
NAMES = {"on", "reads", "recalls", "streams", "writes", "uses"}


def declaration(path: pathlib.Path, root: pathlib.Path) -> dict:
    tree = ast.parse(path.read_text(), filename=str(path))
    found = []
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        decorators = [part for part in node.decorator_list if isinstance(part, ast.Call)
                      and isinstance(part.func, ast.Name) and part.func.id == "system"]
        if not decorators:
            continue
        if len(decorators) != 1 or len(node.decorator_list) != 1:
            raise ValueError(f"{path}: a system function has exactly one @system decorator")
        call = decorators[0]
        if call.args or any(field.arg is None or field.arg not in FIELDS for field in call.keywords):
            raise ValueError(f"{path}: @system accepts only named declaration fields")
        fields = {}
        for field in call.keywords:
            if field.arg in fields:
                raise ValueError(f"{path}: duplicate {field.arg} in @system")
            try:
                value = ast.literal_eval(field.value)
            except (ValueError, TypeError, SyntaxError) as cause:
                raise ValueError(f"{path}: {field.arg} must be literal declaration data") from cause
            if field.arg in NAMES and (not isinstance(value, list) or not all(isinstance(name, str) for name in value)):
                raise ValueError(f"{path}: {field.arg} must be a list of {'use' if field.arg == 'uses' else 'component'} names")
            fields[field.arg] = value
        if fields.get("thread", "process") != "process":
            raise ValueError(f"{path}: Python systems run in a process; thread must be 'process'")
        if not isinstance(fields.get("once", False), bool):
            raise ValueError(f"{path}: once must be a boolean")
        if "lag" in fields and (type(fields["lag"]) is not int or fields["lag"] < 0):
            raise ValueError(f"{path}: lag must be a nonnegative integer")
        fields.pop("thread", None)
        named = path.relative_to(root).as_posix()
        if named.startswith("src/"):
            named = named[4:]
        found.append({"name": named.removesuffix(".system.py"), "file": path.relative_to(root).as_posix(),
                      "function": node.name, "declaration": {"reads": [], "recalls": [], "streams": [], "writes": [], "once": False, **fields}})
    if len(found) != 1:
        raise ValueError(f"{path}: expected exactly one top-level function with @system, found {len(found)}")
    return found[0]


def main() -> None:
    root = pathlib.Path(sys.argv[1]).resolve()
    paths = [root / name for name in sys.argv[2:]]
    print(json.dumps([declaration(path, root) for path in paths]))


if __name__ == "__main__":
    main()
