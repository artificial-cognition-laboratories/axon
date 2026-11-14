"""Read Python component declarations without importing or executing them."""

import ast
import json
import sys


def fail(node: ast.AST, detail: str) -> None:
    raise ValueError(f"line {getattr(node, 'lineno', '?')}: {detail}")


def annotation(node: ast.expr) -> str:
    if isinstance(node, ast.Name):
        builtins = {"float": "f64", "str": "string", "bool": "boolean", "int": "i32"}
        return builtins.get(node.id, node.id)
    if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name):
        name = node.value.id
        if name in ("list", "List"):
            return f"Vec<{annotation(node.slice)}>"
        if name in ("dict", "Dict") and isinstance(node.slice, ast.Tuple) and len(node.slice.elts) == 2:
            return f"Record<{annotation(node.slice.elts[0])},{annotation(node.slice.elts[1])}>"
        if name in ("tuple", "Tuple") and isinstance(node.slice, ast.Tuple) and node.slice.elts:
            elements = [annotation(element) for element in node.slice.elts]
            if len(set(elements)) != 1:
                fail(node, "fixed tuples must use one element type")
            return f"Fixed<{elements[0]},{len(elements)}>"
    fail(node, f"unsupported Python field type {ast.unparse(node)}")


def field_annotation(node: ast.expr) -> tuple[str, bool]:
    if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and node.value.id == "Optional":
        return annotation(node.slice), True
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        if isinstance(node.right, ast.Constant) and node.right.value is None:
            return annotation(node.left), True
        if isinstance(node.left, ast.Constant) and node.left.value is None:
            return annotation(node.right), True
    return annotation(node), False


def read(path: str) -> list[dict]:
    tree = ast.parse(open(path, encoding="utf8").read(), filename=path)
    shapes = []
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            continue
        if not isinstance(node, ast.ClassDef):
            fail(node, "component files may contain only imports and annotated classes")
        if node.bases or node.decorator_list or node.keywords:
            fail(node, f"{node.name}: inheritance and decorators are not part of the component schema")
        fields = []
        for item in node.body:
            if isinstance(item, ast.Expr) and isinstance(item.value, ast.Constant) and isinstance(item.value.value, str):
                continue
            if isinstance(item, ast.Pass):
                continue
            if not isinstance(item, ast.AnnAssign) or not isinstance(item.target, ast.Name) or item.value is not None:
                fail(item, f"{node.name}: only annotated fields without defaults are supported")
            kind, nullable = field_annotation(item.annotation)
            fields.append({"name": item.target.id, "type": kind, "optional": False, "nullable": nullable})
        shapes.append({"name": node.name, "fields": fields, "component": not node.name.startswith("_"), "doc": ast.get_docstring(node)})
    return shapes


try:
    print(json.dumps(read(sys.argv[1])))
except (SyntaxError, ValueError) as error:
    print(error, file=sys.stderr)
    sys.exit(1)
