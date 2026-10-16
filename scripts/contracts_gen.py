"""Generates the contract code from the JSON Schemas in contracts/.

Usage: python scripts/contracts_gen.py <out_dir>

Reads every contracts/*.schema.json of the repository and writes Pydantic v2 models to
<out_dir>/py/ and TypeScript types and validators to <out_dir>/ts/. It is called by
scripts/contracts.sh, which formats the Python output and moves or compares it.

Only the subset of JSON Schema used by the contracts is supported; anything else is an
error, so that a schema never says more than the generated code enforces. An object
with `properties` (the root, or a field or array item) needs a PascalCase `title` and
`additionalProperties: false`, and becomes a named type. A field may refer to the root
of another schema of contracts/ with `{"$ref": "<file>"}`, or, when it may be null,
with `{"anyOf": [{"$ref": "<file>"}, {"type": "null"}]}`; the generated code then
imports the type generated for that file instead of defining it again.
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
OBJECT_KEYS = ROOT_KEYS - {"$schema", "$id"}
FIELD_KEYS = {
    "title",
    "description",
    "type",
    "enum",
    "pattern",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "items",
    "$ref",
    "anyOf",
}
TYPES = {"string", "integer", "number", "boolean", "array", "object"}


class SchemaError(Exception):
    pass


@dataclass
class Ref:
    """A field that holds the root type of another schema file."""

    file: str
    title: str
    nullable: bool

    @property
    def stem(self) -> str:
        return self.file.removesuffix(".schema.json")


@dataclass
class Field:
    """One property of an object, normalised."""

    name: str
    schema: dict[str, Any]
    required: bool
    ref: Ref | None


@dataclass
class Model:
    """One object with properties: the root of a schema or a nested object."""

    title: str
    description: str
    fields: list[Field]


@dataclass
class Contract:
    """One schema file, normalised; its root model is the last of `models`."""

    source: str
    stem: str
    models: list[Model]
    refs: list[Ref]

    @property
    def root(self) -> Model:
        return self.models[-1]


def is_title(value: object) -> bool:
    return (
        isinstance(value, str) and re.fullmatch(r"[A-Z][A-Za-z0-9]*", value) is not None
    )


def root_title(path: Path) -> str:
    title = json.loads(path.read_text()).get("title")
    if not is_title(title):
        raise SchemaError(f"{path.name}: the root needs a PascalCase title")
    return str(title)


def load(path: Path, titles: dict[str, str]) -> Contract:
    """Reads one schema; `titles` maps every file of contracts/ to its root title."""
    schema = json.loads(path.read_text())
    models: list[Model] = []
    refs: list[Ref] = []
    parse_object(path.name, schema, ROOT_KEYS, titles, models, refs)
    if any(ref.file == path.name for ref in refs):
        raise SchemaError(f"{path.name}: a schema cannot refer to itself")
    return Contract(
        source=f"contracts/{path.name}",
        stem=path.name.removesuffix(".schema.json"),
        models=models,
        refs=refs,
    )


def parse_object(
    where: str,
    schema: dict[str, Any],
    keys: set[str],
    titles: dict[str, str],
    models: list[Model],
    refs: list[Ref],
) -> None:
    """Checks an object with properties and appends its model after its nested ones."""
    unknown = set(schema) - keys
    if unknown:
        raise SchemaError(f"{where}: unsupported keywords {sorted(unknown)}")
    if (
        schema.get("type") != "object"
        or schema.get("additionalProperties") is not False
    ):
        raise SchemaError(f"{where}: an object must allow no other field")
    title = schema.get("title")
    if not is_title(title):
        raise SchemaError(f"{where}: an object needs a PascalCase title")
    required = schema.get("required", [])
    properties: dict[str, Any] = schema.get("properties", {})
    if set(required) - set(properties):
        raise SchemaError(f"{where}: required names an unknown property")
    fields = []
    for name, field_schema in properties.items():
        if not re.fullmatch(r"[a-z][a-z0-9_]*", name):
            raise SchemaError(f"{where}: property {name!r} is not snake_case")
        inner = f"{where}: {name}"
        ref = check_field(inner, field_schema, True, titles, models, refs)
        fields.append(Field(name, field_schema, name in required, ref))
    models.append(Model(title, schema.get("description", title), fields))


def parse_ref(where: str, schema: dict[str, Any], titles: dict[str, str]) -> Ref:
    nullable = "anyOf" in schema
    target = schema
    if nullable:
        options = schema["anyOf"]
        if (
            set(schema) - {"description", "anyOf"}
            or not isinstance(options, list)
            or len(options) != 2
            or not isinstance(options[0], dict)
            or options[1] != {"type": "null"}
        ):
            raise SchemaError(
                f'{where}: anyOf is only [{{"$ref": "<file>"}}, {{"type": "null"}}]'
            )
        target = options[0]
    if set(target) - {"$ref", "description"} or "$ref" not in target:
        raise SchemaError(f"{where}: a $ref takes no other keyword")
    file = target["$ref"]
    if file not in titles:
        raise SchemaError(f"{where}: $ref names no schema file of contracts/")
    return Ref(file, titles[file], nullable)


def check_field(
    where: str,
    schema: dict[str, Any],
    top: bool,
    titles: dict[str, str],
    models: list[Model],
    refs: list[Ref],
) -> Ref | None:
    """Checks a field or array item; returns the reference a field makes, if any."""
    if not isinstance(schema, dict):
        raise SchemaError(f"{where}: expected a schema object")
    if "properties" in schema:
        parse_object(where, schema, OBJECT_KEYS, titles, models, refs)
        return None
    unknown = set(schema) - FIELD_KEYS
    if unknown:
        raise SchemaError(f"{where}: unsupported keywords {sorted(unknown)}")
    if "$ref" in schema or "anyOf" in schema:
        if not top:
            raise SchemaError(f"{where}: only a property takes a $ref")
        ref = parse_ref(where, schema, titles)
        refs.append(ref)
        return ref
    if "enum" in schema:
        if set(schema) - {"title", "description", "enum"}:
            raise SchemaError(f"{where}: an enum takes no other keyword")
        values = schema["enum"]
        if not values or not all(v is None or isinstance(v, str) for v in values):
            raise SchemaError(f"{where}: an enum holds strings and optionally null")
        if "title" in schema:
            if not top or None in values:
                raise SchemaError(f"{where}: a titled enum is top level and not null")
            if not is_title(schema["title"]):
                raise SchemaError(f"{where}: the title is not PascalCase")
        return None
    if "title" in schema:
        raise SchemaError(f"{where}: only enums and objects take a title")
    base, _ = base_type(where, schema)
    allowed = {
        "string": {"pattern", "minLength", "maxLength"},
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
        check_field(f"{where}[]", items, False, titles, models, refs)
    for key in ("minLength", "maxLength"):
        if key in schema and (not isinstance(schema[key], int) or schema[key] < 0):
            raise SchemaError(f"{where}: {key} is not a natural number")
    return None


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


def is_object(schema: dict[str, Any]) -> bool:
    """Whether a schema is an object with properties, generated as a named type."""
    return "properties" in schema


def field_nullable(field: Field) -> bool:
    return field.ref.nullable if field.ref else nullable(field.schema)


# Python


def py_type(schema: dict[str, Any]) -> str:
    if "enum" in schema:
        if "title" in schema:
            return str(schema["title"])
        values = [v for v in schema["enum"] if v is not None]
        text = f"Literal[{', '.join(literal(v) for v in values)}]"
        return f"{text} | None" if None in schema["enum"] else text
    if is_object(schema):
        return str(schema["title"])
    base, nullable = base_type("", schema)
    if base == "array":
        text = f"list[{py_type(schema['items'])}]"
    elif base == "object":
        text = "dict[str, object]"
    else:
        args = ["strict=True"]
        if "pattern" in schema:
            args.append(f"pattern={literal(schema['pattern'])}")
        if "minLength" in schema:
            args.append(f"min_length={literal(schema['minLength'])}")
        if "maxLength" in schema:
            args.append(f"max_length={literal(schema['maxLength'])}")
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


def py_field_type(field: Field) -> str:
    if field.ref:
        return f"{field.ref.title} | None" if field.ref.nullable else field.ref.title
    return py_type(field.schema)


def nullable(schema: dict[str, Any]) -> bool:
    if "enum" in schema:
        return None in schema["enum"]
    return base_type("", schema)[1]


def py_model(model: Model) -> list[str]:
    # An optional property that is not nullable is absent or valid, never null.
    not_null = [
        f.name for f in model.fields if not f.required and not field_nullable(f)
    ]
    lines = [f"class {model.title}(BaseModel):"]
    lines += [f'    """{model.description}"""', ""]
    lines += ['    model_config = ConfigDict(extra="forbid")', ""]
    for field in model.fields:
        annotation = py_field_type(field)
        if field.required:
            lines.append(f"    {field.name}: {annotation}")
        else:
            optional = annotation if field_nullable(field) else f"{annotation} | None"
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
    return lines


def python(contract: Contract) -> str:
    fields = [f for model in contract.models for f in model.fields]
    enums = [f.schema for f in fields if "title" in f.schema and "enum" in f.schema]
    body = [py_field_type(f) for f in fields]
    imports = []
    if enums:
        imports.append("from enum import StrEnum")
    typing = [name for name in ("Annotated", "Literal") if any(name in t for t in body)]
    if typing:
        imports.append(f"from typing import {', '.join(typing)}")
    pydantic = ["BaseModel", "ConfigDict"]
    if any("Field(" in t for t in body):
        pydantic.append("Field")
    if any(not f.required and not field_nullable(f) for f in fields):
        pydantic.append("field_validator")
    lines = [f"# {header(contract)}", f'"""{contract.root.description}"""', ""]
    lines += [*imports, "", f"from pydantic import {', '.join(pydantic)}", ""]
    for ref in sorted({(r.stem, r.title) for r in contract.refs}):
        lines.append(f"from .{ref[0].replace('-', '_')} import {ref[1]}")
    lines += ["", ""]
    for enum in enums:
        lines.append(f"class {enum['title']}(StrEnum):")
        lines += [f'    """{enum.get("description", enum["title"])}"""', ""]
        for value in enum["enum"]:
            lines.append(f"    {upper_snake(value)} = {literal(value)}")
        lines += ["", ""]
    for index, model in enumerate(contract.models):
        if index:
            lines += ["", ""]
        lines += py_model(model)
    return "\n".join(lines) + "\n"


# TypeScript


def ts_type(schema: dict[str, Any]) -> str:
    if "enum" in schema:
        if "title" in schema:
            return str(schema["title"])
        return " | ".join(literal(v) for v in schema["enum"])
    if is_object(schema):
        return str(schema["title"])
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


def ts_field_type(field: Field) -> str:
    if field.ref:
        return f"{field.ref.title} | null" if field.ref.nullable else field.ref.title
    return ts_type(field.schema)


def ts_check(schema: dict[str, Any], var: str) -> str:
    """A TypeScript boolean expression: `var` (of type unknown) matches `schema`."""
    if "enum" in schema:
        if "title" in schema:
            values = upper_snake(schema["title"]) + "S"
        else:
            values = "[" + ", ".join(literal(v) for v in schema["enum"]) + "]"
        return f"({values} as readonly unknown[]).includes({var})"
    if is_object(schema):
        return f"check{schema['title']}({var}) === null"
    base, nullable = base_type("", schema)
    checks: list[str] = []
    if base == "string":
        checks.append(f'typeof {var} === "string"')
        if "pattern" in schema:
            regex = schema["pattern"].replace("/", "\\/")
            checks.append(f"/{regex}/.test({var})")
        # JSON Schema counts characters (code points), not UTF-16 units.
        if "minLength" in schema:
            checks.append(f"[...{var}].length >= {literal(schema['minLength'])}")
        if "maxLength" in schema:
            checks.append(f"[...{var}].length <= {literal(schema['maxLength'])}")
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


def ts_field_check(field: Field) -> str:
    if field.ref:
        check = f"check{field.ref.title}(value) === null"
        return f"value === null || {check}" if field.ref.nullable else check
    return ts_check(field.schema, "value")


def ts_model(model: Model) -> list[str]:
    title = model.title
    fields = upper_snake(title) + "_FIELDS"
    lines = [f"/** {model.description} */", f"export interface {title} {{"]
    for field in model.fields:
        mark = "" if field.required else "?"
        lines.append(f"  {field.name}{mark}: {ts_field_type(field)};")
    lines += ["}", ""]
    lines.append(
        f"const {fields}: Record<string, {{ required: boolean; "
        "check: (value: unknown) => boolean }> = {"
    )
    for field in model.fields:
        required = "true" if field.required else "false"
        lines.append(
            f"  {field.name}: {{ required: {required}, "
            f"check: (value) => {ts_field_check(field)} }},"
        )
    lines += [
        "};",
        "",
        f"/** Returns why a value is not a {title}, or null when it is one. */",
        f"export function check{title}(value: unknown): string | null {{",
        '  if (typeof value !== "object" || value === null || Array.isArray(value)) {',
        f'    return "{title}: expected an object";',
        "  }",
        "  const record = value as Record<string, unknown>;",
        "  for (const key of Object.keys(record)) {",
        f"    if (!Object.hasOwn({fields}, key)) {{",
        f"      return `{title}: unknown field ${{key}}`;",
        "    }",
        "  }",
        f"  for (const [key, field] of Object.entries({fields})) {{",
        "    if (!Object.hasOwn(record, key)) {",
        "      if (field.required) {",
        f"        return `{title}: missing field ${{key}}`;",
        "      }",
        "    } else if (!field.check(record[key])) {",
        f"      return `{title}: invalid field ${{key}}`;",
        "    }",
        "  }",
        "  return null;",
        "}",
    ]
    return lines


def typescript(contract: Contract) -> str:
    root = contract.root.title
    lines = [f"// {header(contract)}", ""]
    refs = sorted({(r.stem, r.title) for r in contract.refs})
    for stem, title in refs:
        lines.append(f'import {{ check{title}, type {title} }} from "./{stem}";')
    if refs:
        lines.append("")
    for model in contract.models:
        for field in model.fields:
            enum = field.schema
            if "title" in enum and "enum" in enum:
                values = ", ".join(literal(v) for v in enum["enum"])
                doc = f"/** {enum.get('description', enum['title'])} */"
                name = upper_snake(enum["title"]) + "S"
                lines.append(doc)
                lines.append(f"export const {name} = [{values}] as const;")
                lines.append(doc)
                lines += [f"export type {enum['title']} = (typeof {name})[number];", ""]
    for model in contract.models:
        lines += [*ts_model(model), ""]
    lines += [
        f"/** Checks a value against {contract.source}; throws on a violation. */",
        f"export function parse{root}(value: unknown): {root} {{",
        f"  const error = check{root}(value);",
        "  if (error !== null) {",
        "    throw new Error(error);",
        "  }",
        f"  return value as {root};",
        "}",
    ]
    return "\n".join(lines) + "\n"


def main(out: Path) -> None:
    paths = sorted((ROOT / "contracts").glob("*.schema.json"))
    titles = {path.name: root_title(path) for path in paths}
    contracts = [load(path, titles) for path in paths]
    names = [m.title for c in contracts for m in c.models]
    names += [
        str(f.schema["title"])
        for c in contracts
        for m in c.models
        for f in m.fields
        if "enum" in f.schema and "title" in f.schema
    ]
    duplicates = sorted({name for name in names if names.count(name) > 1})
    if duplicates:
        raise SchemaError(f"titles used more than once: {duplicates}")
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
