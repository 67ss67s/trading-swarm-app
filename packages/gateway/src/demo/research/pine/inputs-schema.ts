/**
 * Pine 脚本参数 schema:从源码里的 input.*() 声明推导,或由作者显式给出;引用脚本时按它校验参数。
 *
 * 形状(存在 pine_scripts.inputs_schema_json):
 *   { params: { 变量名: { type, default?, min?, max?, step?, options?, title? } }, defaults?: {...}, derived?: true }
 *   - type:int / float / bool / string / source(source 只能是 open/high/low/close/volume/hl2/hlc3/ohlc4/hlcc4)
 *   - derived=true 表示是从源码推导的(改了正文要重新推导);作者显式给的不会被覆盖
 *   - 旧数据可能是 {} 或只有 defaults:取用时现场从源码推导,不需要迁移
 *
 * 为什么要校验:client.applyInputs 会把参数值**拼进 Pine 源码**,类型不对轻则引擎报一句看不懂的语法错,
 * 重则把一段表达式注进脚本;范围/枚举不对则是「改了参数却跑了个没意义的指标」。所以编译引用 pine_series 时
 * 参数不合 schema 直接判错,准入时也把所用参数过一遍。
 */

export type PineInputType = 'int' | 'float' | 'bool' | 'string' | 'source';
export interface PineInputSpec {
  type: PineInputType;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: (string | number)[];
  title?: string;
}
export interface PineInputsSchema {
  params?: Record<string, PineInputSpec>;
  defaults?: Record<string, unknown>;
  derived?: boolean;
}

export const PINE_SOURCES = ['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4', 'hlcc4'] as const;
const TYPES: readonly PineInputType[] = ['int', 'float', 'bool', 'string', 'source'];

/** 按顶层逗号切实参(跳过括号 / 方括号 / 引号里的逗号)。 */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0, quote: string | null = null, cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) { cur += ch; if (ch === quote && text[i - 1] !== '\\') quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 从 `(` 之后找到配对的 `)`,返回括号内文本。 */
function callBody(text: string, open: number): string | null {
  let depth = 0, quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) { if (ch === quote && text[i - 1] !== '\\') quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return text.slice(open + 1, i); }
  }
  return null;
}

function literal(raw: string): unknown {
  const s = raw.trim();
  if (/^["'].*["']$/s.test(s)) return s.slice(1, -1);
  if (s === 'true' || s === 'false') return s === 'true';
  if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (/^\[.*\]$/s.test(s)) return splitArgs(s.slice(1, -1)).map(literal);
  return s; // 标识符(input.source 的 close 等)
}

/** 从源码推导参数 schema:`name = input.int(14, "标题", minval=1, maxval=100, options=[…])` 这类声明。 */
export function parsePineInputs(script: string): Record<string, PineInputSpec> {
  const params: Record<string, PineInputSpec> = {};
  const decl = /^[ \t]*(?:(?:var|varip|const|simple|series|int|float|bool|string)\s+)*([A-Za-z_]\w*)\s*=\s*input(?:\.(int|float|bool|string|source|integer))?\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(script))) {
    const name = m[1]!;
    const body = callBody(script, m.index + m[0].length - 1);
    if (body === null) continue;
    const args = splitArgs(body);
    const named: Record<string, unknown> = {};
    const positional: unknown[] = [];
    for (const arg of args) {
      const kv = /^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/.exec(arg);
      if (kv) named[kv[1]!] = literal(kv[2]!);
      else positional.push(literal(arg));
    }
    const def = named.defval ?? positional[0];
    const title = named.title ?? positional[1];
    let type = (m[2] === 'integer' ? 'int' : m[2]) as PineInputType | undefined;
    if (!type) {
      type = typeof def === 'boolean' ? 'bool'
        : typeof def === 'number' ? (Number.isInteger(def) && !/\./.test(String(args[0] ?? '')) ? 'int' : 'float')
        : typeof def === 'string' && (PINE_SOURCES as readonly string[]).includes(def) && !/^["']/.test(String(args[0] ?? '').trim()) ? 'source'
        : 'string';
    }
    const spec: PineInputSpec = { type };
    if (def !== undefined) spec.default = def;
    if (typeof title === 'string') spec.title = title;
    if (typeof named.minval === 'number') spec.min = named.minval;
    if (typeof named.maxval === 'number') spec.max = named.maxval;
    if (typeof named.step === 'number') spec.step = named.step;
    if (Array.isArray(named.options)) spec.options = (named.options as unknown[]).filter((o): o is string | number => typeof o === 'string' || typeof o === 'number');
    params[name] = spec;
  }
  return params;
}

/** 取用时的有效 schema:有显式 params 用它,否则从源码推导。 */
export function effectiveInputsSchema(raw: unknown, script: string): PineInputsSchema {
  const schema = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as PineInputsSchema;
  if (schema.params && typeof schema.params === 'object' && Object.keys(schema.params).length) return schema;
  return { ...schema, params: parsePineInputs(script), derived: true };
}

/** schema 本身是否合格(类型已知、范围自洽、默认值满足自身约束)。 */
export function checkInputsSchema(schema: PineInputsSchema): string[] {
  const errors: string[] = [];
  for (const [name, spec] of Object.entries(schema.params ?? {})) {
    if (!spec || typeof spec !== 'object') { errors.push(`${name}:参数定义必须是对象`); continue; }
    if (!TYPES.includes(spec.type)) { errors.push(`${name}:未知类型 ${String(spec.type)}(只支持 ${TYPES.join('/')})`); continue; }
    if (spec.min !== undefined && typeof spec.min !== 'number') errors.push(`${name}:min 必须是数字`);
    if (spec.max !== undefined && typeof spec.max !== 'number') errors.push(`${name}:max 必须是数字`);
    if (typeof spec.min === 'number' && typeof spec.max === 'number' && spec.min > spec.max) errors.push(`${name}:min ${spec.min} > max ${spec.max}`);
    if (spec.options !== undefined && (!Array.isArray(spec.options) || !spec.options.length)) errors.push(`${name}:options 必须是非空数组`);
    if (spec.default !== undefined) errors.push(...valueErrors(name, spec, spec.default).map((e) => `${e}(默认值)`));
  }
  return errors;
}

function valueErrors(name: string, spec: PineInputSpec, value: unknown): string[] {
  const errors: string[] = [];
  const asNumber = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : NaN;
  switch (spec.type) {
    case 'int':
      if (!Number.isInteger(asNumber)) errors.push(`${name}:应为整数,收到 ${JSON.stringify(value)}`);
      break;
    case 'float':
      if (!Number.isFinite(asNumber)) errors.push(`${name}:应为数字,收到 ${JSON.stringify(value)}`);
      break;
    case 'bool':
      if (typeof value !== 'boolean') errors.push(`${name}:应为 true/false,收到 ${JSON.stringify(value)}`);
      break;
    case 'string':
      if (typeof value !== 'string') errors.push(`${name}:应为字符串,收到 ${JSON.stringify(value)}`);
      break;
    case 'source':
      if (typeof value !== 'string' || !(PINE_SOURCES as readonly string[]).includes(value)) errors.push(`${name}:应为 ${PINE_SOURCES.join('/')} 之一,收到 ${JSON.stringify(value)}`);
      break;
  }
  if (errors.length) return errors;
  if ((spec.type === 'int' || spec.type === 'float')) {
    if (typeof spec.min === 'number' && asNumber < spec.min) errors.push(`${name}:${asNumber} 小于下限 ${spec.min}`);
    if (typeof spec.max === 'number' && asNumber > spec.max) errors.push(`${name}:${asNumber} 大于上限 ${spec.max}`);
  }
  if (Array.isArray(spec.options) && spec.options.length) {
    const hit = spec.options.some((o) => o === value || (typeof o === 'number' && o === asNumber));
    if (!hit) errors.push(`${name}:${JSON.stringify(value)} 不在可选值 ${JSON.stringify(spec.options)} 里`);
  }
  return errors;
}

/** 校验一组参数(键可以是变量名或标题);返回错误列表,空 = 合格。 */
export function validatePineInputs(schema: PineInputsSchema, inputs: Record<string, unknown> | undefined): string[] {
  const params = schema.params ?? {};
  const errors: string[] = [];
  for (const [key, value] of Object.entries(inputs ?? {})) {
    const name = key in params ? key : Object.keys(params).find((n) => params[n]!.title === key);
    if (!name) { errors.push(`${key}:脚本没有这个参数(可用:${Object.keys(params).join('、') || '无'})`); continue; }
    errors.push(...valueErrors(key, params[name]!, value));
  }
  return errors;
}

/** schema 里声明的默认参数(准入时用)。 */
export function schemaDefaults(schema: PineInputsSchema): Record<string, unknown> | undefined {
  return schema.defaults && typeof schema.defaults === 'object' && Object.keys(schema.defaults).length ? schema.defaults : undefined;
}
