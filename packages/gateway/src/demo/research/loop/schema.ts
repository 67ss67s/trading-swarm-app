import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema, ValidateFunction } from "ajv";
import { schemas } from "@trade-gate/contracts";
const root = schemas["research-loop"];
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(root);
export type JSONSchema = AnySchema;
export function schema(name: string): AnySchema {
  return { $ref: `${root.$id}#/$defs/Loop${name}` };
}
const validators = new Map<string, ValidateFunction>();
export function validator(s: AnySchema): ValidateFunction {
  return ajv.compile(s);
}
export function check<T>(name: string, value: unknown): T {
  let v = validators.get(name);
  if (!v) {
    v = validator(schema(name));
    validators.set(name, v);
  }
  if (!v(value))
    throw new Error(`SCHEMA_MISMATCH:${name}:${ajv.errorsText(v.errors)}`);
  // JSON.stringify silently converts nonfinite numbers to null; reject before storage.
  function finite(x: unknown): void {
    if (typeof x === "number" && !Number.isFinite(x))
      throw Error("SCHEMA_MISMATCH:nonfinite");
    if (x && typeof x === "object")
      for (const child of Object.values(x)) finite(child);
  }
  finite(value);
  return value as T;
}
export function encode(name: string, value: unknown): string {
  check(name, value);
  return JSON.stringify(value);
}
/** Self-contained schemas for HTTP consumers and the planner; no hidden $ref documents. */
export function schemaDocument(s: AnySchema): AnySchema {
  if (
    typeof s !== "object" ||
    typeof s.$ref !== "string" ||
    !s.$ref.startsWith(root.$id + "#/$defs/")
  )
    return s;
  const name = s.$ref.split("/").at(-1)!;
  const defs: Record<string, unknown> = {};
  const source = root.$defs as Record<string, unknown>;
  const collect = (key: string) => {
    if (key in defs) return;
    defs[key] = source[key];
    const scan = (v: unknown) => {
      if (!v || typeof v !== "object") return;
      for (const [k, child] of Object.entries(v)) {
        if (
          k === "$ref" &&
          typeof child === "string" &&
          child.startsWith("#/$defs/")
        )
          collect(child.slice(8));
        else scan(child);
      }
    };
    scan(source[key]);
  };
  collect(name);
  return { $schema: root.$schema, ...(source[name] as object), $defs: defs };
}
