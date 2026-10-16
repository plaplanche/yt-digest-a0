"""Generates the contract code from the JSON Schemas in contracts/.

Usage: python scripts/contracts_gen.py <out_dir>

Reads every contracts/*.schema.json of the repository and writes Pydantic v2 models to
<out_dir>/py/ and TypeScript types and validators to <out_dir>/ts/. It is called by
scripts/contracts.sh, which formats the Python output and moves or compares it.

Only the subset of JSON Schema used by the contracts is supported; anything else is an
error, so that a schema never says more than the generated code enforces.
"""

import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
ROOT_KEYS = {
    "$schema",
    "$id",
    "title",
    "description",
    "type",
    "properties",
    "required",
    "additionalProperties",
}
FIELD_KEYS = {
    "title",
    "description",
    "type",
    "enum",
    "pattern",
    "minimum",
    "maximum",
    "items",
}
TYPES = {"string", "integer", "number", "boolean", "array", "object"}


class SchemaError(Exception):
    pass


@dataclass
class Field:
    """One property of a schema, normalised."""

    name: str
    schema: dict[str, Any]
    required: bool


@dataclass
class Contract:
    """One schema file, normalised."""

    source: str
    stem: str
    title: str
    description: str
    fields: list[Field]


def load(path: Path) -> Contract:
    schema = json.loads(path.read_text())
    where = path.name
    unknown = set(schema) - ROOT_KEYS
    if unknown:
        raise SchemaError(f"{where}: unsupported keywords {sorted(unknown)}")
    if (
        schema.get("type") != "object"
        or schema.get("additionalProperties") is not False
    ):
        raise SchemaError(f"{where}: the root must be an object with no other field")
    title = schema.get("title")
    if not isinstance(title, str) or not re.fullmatch(r"[A-Z][A-Za-z0-9]*", title):
        raise SchemaError(f"{where}: the root needs a PascalCase title")
    required = schema.get("required", [])
    properties: dict[str, Any] = schema["properties"]
    if set(required) - set(properties):
        raise SchemaError(f"{where}: required names an unknown property")
    fields = []
    for name, field_schema in properties.items():
        if not re.fullmatch(r"[a-z][a-z0-9_]*", name):
            raise SchemaError(f"{where}: property {name!r} is not snake_case")
        check_field(f"{where}: {name}", field_schema, top=True)
        fields.append(Field(name, field_schema, name in required))
    return Contract(
        source=f"contracts/{path.name}",
        stem=path.name.removesuffix(".schema.json"),
        title=title,
        description=schema.get("description", title),
        fields=fields,
    )


def check_field(where: str, schema: dict[str, Any], top: bool) -> None:
    unknown = set(schema) - FIELD_KEYS
    if unknown:
        raise SchemaError(f"{where}: unsupported keywords {sorted(unknown)}")
    if "enum" in schema:
        if set(schema) - {"title", "description", "enum"}:
            raise SchemaError(f"{where}: an enum takes no other keyword")
        values = schema["enum"]
        if not values or not all(v is None or isinstance(v, str) for v in values):
            raise SchemaError(f"{where}: an enum holds strings and optionally null")
        if "title" in schema:
            if not top or None in values:
                raise SchemaError(f"{where}: a titled enum is top level and not null")
            if not re.fullmatch(r"[A-Z][A-Za-z0-9]*", schema["title"]):
                raise SchemaError(f"{where}: the title is not PascalCase")
        return
    if "title" in schema:
        raise SchemaError(f"{where}: only enums take a title")
    base, _ = base_type(where, schema)
    allowed = {
        "string": {"pattern"},
        "integer": {"minimum", "maximum"},
        "number": {"minimum", "maximum"},
        "boolean": set(),
        "array": {"items"},
        "object": set(),
    }[base] | {"type", "description"}
    if set(schema) - allowed:
        raise SchemaError(f"{where}: unsupported keywords for {base}")
    if base == "array":
        items = schema.get("items")
        if not isinstance(items, dict):
            raise SchemaError(f"{where}: an array needs items")
        check_field(f"{where}[]", items, top=False)


def base_type(where: str, schema: dict[str, Any]) -> tuple[str, bool]:
    """Returns the type of a non-enum schema and whether it is nullable."""
    kind = schema.get("type")
    kinds = kind if isinstance(kind, list) else [kind]
    nullable = "null" in kinds
    rest = [k for k in kinds if k != "null"]
    if len(rest) != 1 or rest[0] not in TYPES:
        raise SchemaError(f"{where}: type must be one of {sorted(TYPES)}, or null")
    return rest[0], nullable


def upper_snake(text: str) -> str:
    text = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", text)
    return re.sub(r"[^A-Za-z0-9]+", "_", text).strip("_").upper()


def literal(value: object) -> str:
    """A string, number or null as a literal of both Python and TypeScript."""
    return json.dumps(value)


def header(contract: Contract) -> str:
    return f"Generated by scripts/contracts.sh from {contract.source}: do not edit."


# Python


def py_type(schema: dict[str, Any]) -> str:
    if "enum" in schema:
        if "title" in schema:
            return str(schema["title"])
        values = [v for v in schema["enum"] if v is not None]
        text = f"Literal[{', '.join(literal(v) for v in values)}]"
        return f"{text} | None" if None in schema["enum"] else text
    base, nullable = base_type("", schema)
    if base == "array":
        text = f"list[{py_type(schema['items'])}]"
    elif base == "object":
        text = "dict[str, object]"
    else:
        args = ["strict=True"]
        if "pattern" in schema:
            args.append(f"pattern={literal(schema['pattern'])}")
        if "minimum" in schema:
            args.append(f"ge={literal(schema['minimum'])}")
        if "maximum" in schema:
            args.append(f"le={literal(schema['maximum'])}")
        names = {
            "string": "str",
            "integer": "int",
            "number": "float",
            "boolean": "bool",
        }
        text = f"Annotated[{names[base]}, Field({', '.join(args)})]"
    return f"{text} | None" if nullable else text


def nullable(schema: dict[str, Any]) -> bool:
    if "enum" in schema:
        return None in schema["enum"]
    return base_type("", schema)[1]


def python(contract: Contract) -> str:
    enums = [f.schema for f in contract.fields if "title" in f.schema]
    body = [py_type(f.schema) for f in contract.fields]
    # An optional property that is not nullable is absent or valid, never null.
    not_null = [
        f.name for f in contract.fields if not f.required and not nullable(f.schema)
    ]
    imports = []
    if enums:
        imports.append("from enum import StrEnum")
    typing = [name for name in ("Annotated", "Literal") if any(name in t for t in body)]
    if typing:
        imports.append(f"from typing import {', '.join(typing)}")
    pydantic = ["BaseModel", "ConfigDict"]
    if any("Field(" in t for t in body):
        pydantic.append("Field")
    if not_null:
        pydantic.append("field_validator")
    lines = [f"# {header(contract)}", f'"""{contract.description}"""', ""]
    lines += [*imports, "", f"from pydantic import {', '.join(pydantic)}", "", ""]
    for enum in enums:
        lines.append(f"class {enum['title']}(StrEnum):")
        lines += [f'    """{enum.get("description", enum["title"])}"""', ""]
        for value in enum["enum"]:
            lines.append(f"    {upper_snake(value)} = {literal(value)}")
        lines += ["", ""]
    lines.append(f"class {contract.title}(BaseModel):")
    lines += [f'    """{contract.description}"""', ""]
    lines += ['    model_config = ConfigDict(extra="forbid")', ""]
    for field, annotation in zip(contract.fields, body, strict=True):
        if field.required:
            lines.append(f"    {field.name}: {annotation}")
        else:
            optional = annotation if nullable(field.schema) else f"{annotation} | None"
            lines.append(f"    {field.name}: {optional} = None")
    if not_null:
        names = ", ".join(literal(n) for n in not_null)
        lines += [
            "",
            f'    @field_validator({names}, mode="before")',
            "    @classmethod",
            "    def _not_null(cls, value: object) -> object:",
            "        if value is None:",
            '            raise ValueError("may be absent but not null")',
            "        return value",
        ]
    return "\n".join(lines) + "\n"


# TypeScript


def ts_type(schema: dict[str, Any]) -> str:
    if "enum" in schema:
        if "title" in schema:
            return str(schema["title"])
        return " | ".join(literal(v) for v in schema["enum"])
    base, nullable = base_type("", schema)
    if base == "array":
        item = ts_type(schema["items"])
        text = f"{item}[]" if re.fullmatch(r"\w+", item) else f"({item})[]"
    elif base == "object":
        text = "Record<string, unknown>"
    else:
        names = {"string": "string", "integer": "number", "number": "number"}
        text = names.get(base, "boolean")
    return f"{text} | null" if nullable else text


def ts_check(schema: dict[str, Any], var: str) -> str:
    """A TypeScript boolean expression: `var` (of type unknown) matches `schema`."""
    if "enum" in schema:
        if "title" in schema:
            values = upper_snake(schema["title"]) + "S"
        else:
            values = "[" + ", ".join(literal(v) for v in schema["enum"]) + "]"
        return f"({values} as readonly unknown[]).includes({var})"
    base, nullable = base_type("", schema)
    checks: list[str] = []
    if base == "string":
        checks.append(f'typeof {var} === "string"')
        if "pattern" in schema:
            regex = schema["pattern"].replace("/", "\\/")
            checks.append(f"/{regex}/.test({var})")
    elif base in ("integer", "number"):
        checks.append(f'typeof {var} === "number"')
        checks.append(
            f"Number.isInteger({var})"
            if base == "integer"
            else f"Number.isFinite({var})"
        )
        if "minimum" in schema:
            checks.append(f"{var} >= {literal(schema['minimum'])}")
        if "maximum" in schema:
            checks.append(f"{var} <= {literal(schema['maximum'])}")
    elif base == "boolean":
        checks.append(f'typeof {var} === "boolean"')
    elif base == "array":
        item = ts_check(schema["items"], "item")
        checks.append(f"Array.isArray({var})")
        checks.append(f"{var}.every((item: unknown) => {item})")
    else:
        checks.append(f'typeof {var} === "object"')
        checks.append(f"{var} !== null")
        checks.append(f"!Array.isArray({var})")
    text = " && ".join(checks)
    return f"{var} === null || ({text})" if nullable else text


def typescript(contract: Contract) -> str:
    fields = upper_snake(contract.title) + "_FIELDS"
    lines = [f"// {header(contract)}", ""]
    for field in contract.fields:
        enum = field.schema
        if "title" in enum:
            values = ", ".join(literal(v) for v in enum["enum"])
            doc = f"/** {enum.get('description', enum['title'])} */"
            lines.append(doc)
            lines.append(
                f"export const {upper_snake(enum['title'])}S = [{values}] as const;"
            )
            lines.append(doc)
            name = upper_snake(enum["title"]) + "S"
            lines += [f"export type {enum['title']} = (typeof {name})[number];", ""]
    lines += [f"/** {contract.description} */", f"export interface {contract.title} {{"]
    for field in contract.fields:
        mark = "" if field.required else "?"
        lines.append(f"  {field.name}{mark}: {ts_type(field.schema)};")
    lines += ["}", ""]
    lines.append(
        f"const {fields}: Record<string, {{ required: boolean; "
        "check: (value: unknown) => boolean }> = {"
    )
    for field in contract.fields:
        check = ts_check(field.schema, "value")
        required = "true" if field.required else "false"
        lines.append(
            f"  {field.name}: {{ required: {required}, check: (value) => {check} }},"
        )
    lines += [
        "};",
        "",
        f"/** Checks a value against {contract.source}; throws on a violation. */",
        f"export function parse{contract.title}(value: unknown): {contract.title} {{",
        '  if (typeof value !== "object" || value === null || Array.isArray(value)) {',
        f'    throw new Error("{contract.title}: expected an object");',
        "  }",
        "  const record = value as Record<string, unknown>;",
        "  for (const key of Object.keys(record)) {",
        f"    if (!Object.hasOwn({fields}, key)) {{",
        f"      throw new Error(`{contract.title}: unknown field ${{key}}`);",
        "    }",
        "  }",
        f"  for (const [key, field] of Object.entries({fields})) {{",
        "    if (!Object.hasOwn(record, key)) {",
        "      if (field.required) {",
        f"        throw new Error(`{contract.title}: missing field ${{key}}`);",
        "      }",
        "    } else if (!field.check(record[key])) {",
        f"      throw new Error(`{contract.title}: invalid field ${{key}}`);",
        "    }",
        "  }",
        f"  return value as {contract.title};",
        "}",
    ]
    return "\n".join(lines) + "\n"


def main(out: Path) -> None:
    contracts = [load(p) for p in sorted((ROOT / "contracts").glob("*.schema.json"))]
    py, ts = out / "py", out / "ts"
    py.mkdir(parents=True)
    ts.mkdir(parents=True)
    init = "# Generated by scripts/contracts.sh: do not edit.\n"
    init += '"""Models generated from the JSON Schemas in contracts/."""\n'
    (py / "__init__.py").write_text(init)
    for contract in contracts:
        (py / f"{contract.stem.replace('-', '_')}.py").write_text(python(contract))
        (ts / f"{contract.stem}.ts").write_text(typescript(contract))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: contracts_gen.py <out_dir>")
    try:
        main(Path(sys.argv[1]))
    except SchemaError as error:
        sys.exit(f"contracts: {error}")
