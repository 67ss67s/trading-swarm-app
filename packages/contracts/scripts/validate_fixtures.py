#!/usr/bin/env python3
"""用 python-jsonschema(Draft 2020-12)独立校验 schema/ 与 fixtures/——第三方仲裁,不信任 TS/Rust 任何一方。

fixtures 目录约定:
  fixtures/<schema-name>/<case>.json           必须通过 schema/<schema-name>.json
  fixtures/invalid/<schema-name>/<case>.json   必须不通过
  fixtures/hash/vectors.json                   canonical/sha256 向量(canonical_ref.py 生成)
"""
import json
import pathlib
import sys

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
SCHEMA_DIR = ROOT / "schema"
FIXTURE_DIR = ROOT / "fixtures"


def load_registry():
    resources = []
    for path in sorted(SCHEMA_DIR.glob("*.json")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        Draft202012Validator.check_schema(doc)
        resources.append((doc["$id"], Resource.from_contents(doc)))
    return Registry().with_resources(resources)


def main():
    registry = load_registry()
    failures = 0
    checked = 0
    validators = {}
    for path in sorted(SCHEMA_DIR.glob("*.json")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        validators[path.stem] = Draft202012Validator(doc, registry=registry)

    for schema_name, validator in validators.items():
        for case in sorted((FIXTURE_DIR / schema_name).glob("*.json")) if (FIXTURE_DIR / schema_name).exists() else []:
            checked += 1
            instance = json.loads(case.read_text(encoding="utf-8"))
            errors = sorted(validator.iter_errors(instance), key=lambda e: list(e.path))
            if errors:
                failures += 1
                print(f"FAIL valid fixture {case.relative_to(ROOT)}:")
                for err in errors[:5]:
                    print(f"   - {'/'.join(map(str, err.path)) or '<root>'}: {err.message}")
        invalid_dir = FIXTURE_DIR / "invalid" / schema_name
        for case in sorted(invalid_dir.glob("*.json")) if invalid_dir.exists() else []:
            checked += 1
            instance = json.loads(case.read_text(encoding="utf-8"))
            if validator.is_valid(instance):
                failures += 1
                print(f"FAIL invalid fixture unexpectedly valid: {case.relative_to(ROOT)}")

    print(f"checked {checked} fixtures against {len(validators)} schemas, failures={failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
