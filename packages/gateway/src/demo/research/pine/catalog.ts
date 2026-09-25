/**
 * Pine 脚本目录(内部市场)。migrations/0030_pine_scripts.sql 的 DAO:
 * 增删改查 + 按名字/描述/别名搜索 + 写准入报告 + 用量计数。
 *
 * 语义要点:
 *  - admitted 只能由 admit()(写准入报告)翻,create/update 一律置 0;
 *    改了脚本或 inputs 就等于换了一个东西,必须重跑准入才能再被策略引用。
 *  - outputs 来自准入报告里真实跑出来的 plot 名,不是作者自己写的。
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AdmissionReport } from './admission.js';
import { checkInputsSchema, parsePineInputs, type PineInputsSchema } from './inputs-schema.js';

/**
 * 入库前规整 inputs_schema:没给 params 就从源码推导(标 derived);给了就校验它自洽(类型已知、范围、默认值)。
 * 不合格直接拒——坏 schema 进了目录,后面每次引用的校验都没有意义。
 */
export function normalizeInputsSchema(raw: unknown, script: string): PineInputsSchema {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) throw new Error('pine_inputs_schema_invalid:inputs_schema 必须是对象');
  const given = (raw ?? {}) as PineInputsSchema;
  const explicit = given.params && typeof given.params === 'object' && Object.keys(given.params).length > 0 && !given.derived;
  const schema: PineInputsSchema = explicit ? { ...given } : { ...given, params: parsePineInputs(script), derived: true };
  const errors = checkInputsSchema(schema);
  if (errors.length) throw new Error(`pine_inputs_schema_invalid:${errors.join(';')}`);
  return schema;
}

export type PineSource = 'user' | 'agent' | 'community';

export interface PineScript {
  id: string;
  name: string;
  description: string;
  aliases: string[];
  script: string;
  inputs_schema: Record<string, unknown>;
  outputs: string[];
  source: PineSource;
  license: string | null;
  author: string | null;
  admitted: boolean;
  admission_report: AdmissionReport | null;
  created_at: number;
  updated_at: number;
  usage_count: number;
}

export interface PineScriptDraft {
  id?: string;
  name: string;
  description?: string;
  aliases?: string[];
  script: string;
  inputs_schema?: Record<string, unknown>;
  source?: PineSource;
  license?: string | null;
  author?: string | null;
}

interface Row {
  id: string; name: string; description: string; aliases_json: string; script: string;
  inputs_schema_json: string; outputs_json: string; source: string; license: string | null;
  author: string | null; admitted: number; admission_report_json: string | null;
  created_at: number; updated_at: number; usage_count: number;
}

const parse = <T,>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};

function hydrate(row: Row): PineScript {
  return {
    id: row.id, name: row.name, description: row.description,
    aliases: parse<string[]>(row.aliases_json, []),
    script: row.script,
    inputs_schema: parse<Record<string, unknown>>(row.inputs_schema_json, {}),
    outputs: parse<string[]>(row.outputs_json, []),
    source: row.source as PineSource,
    license: row.license, author: row.author,
    admitted: row.admitted === 1,
    admission_report: parse<AdmissionReport | null>(row.admission_report_json, null),
    created_at: row.created_at, updated_at: row.updated_at, usage_count: row.usage_count,
  };
}

/** 列表里不带脚本正文(可能很长);详情页 / 原语取值才读全文。 */
export type PineScriptSummary = Omit<PineScript, 'script' | 'admission_report'> & {
  admission_summary: { ok: boolean; warmup_bars: number; failed: string[] } | null;
};
export function summarize(s: PineScript): PineScriptSummary {
  const { script: _script, admission_report, ...rest } = s;
  return {
    ...rest,
    admission_summary: admission_report
      ? { ok: admission_report.ok, warmup_bars: admission_report.warmup_bars, failed: admission_report.checks.filter((c) => !c.ok).map((c) => c.name) }
      : null,
  };
}

const COLUMNS = 'id,name,description,aliases_json,script,inputs_schema_json,outputs_json,source,license,author,admitted,admission_report_json,created_at,updated_at,usage_count';

export class PineCatalog {
  constructor(readonly db: DatabaseSync, readonly now: () => number = Date.now) {}

  get(id: string): PineScript | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM pine_scripts WHERE id=?`).get(id) as unknown as Row | undefined;
    return row ? hydrate(row) : null;
  }
  /** id 或 name 都能取到,方便 agent 直接用名字引用。 */
  find(idOrName: string): PineScript | null {
    return this.get(idOrName) ?? (() => {
      const row = this.db.prepare(`SELECT ${COLUMNS} FROM pine_scripts WHERE name=?`).get(idOrName) as unknown as Row | undefined;
      return row ? hydrate(row) : null;
    })();
  }
  list(limit = 100): PineScript[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM pine_scripts ORDER BY usage_count DESC, updated_at DESC LIMIT ?`).all(limit) as unknown as Row[]).map(hydrate);
  }
  /**
   * 按名字 / 描述 / 别名模糊搜索(大小写不敏感);query 为空即列表。
   * 排序:名字命中 > 别名命中 > 描述命中,同级按 usage_count。
   */
  search(query: string, opts: { limit?: number; admitted?: boolean } = {}): PineScript[] {
    const limit = opts.limit ?? 50;
    const all = (this.db.prepare(`SELECT ${COLUMNS} FROM pine_scripts`).all() as unknown as Row[]).map(hydrate);
    const pool = opts.admitted === undefined ? all : all.filter((s) => s.admitted === opts.admitted);
    const q = query.trim().toLowerCase();
    if (!q) return pool.sort((a, b) => b.usage_count - a.usage_count || b.updated_at - a.updated_at).slice(0, limit);
    const rank = (s: PineScript): number => {
      const name = s.name.toLowerCase();
      if (name === q) return 0;
      if (name.includes(q)) return 1;
      if (s.aliases.some((a) => a.toLowerCase().includes(q))) return 2;
      if (s.description.toLowerCase().includes(q)) return 3;
      return 99;
    };
    return pool.map((s) => ({ s, r: rank(s) })).filter((x) => x.r < 99)
      .sort((a, b) => a.r - b.r || b.s.usage_count - a.s.usage_count)
      .slice(0, limit).map((x) => x.s);
  }

  create(draft: PineScriptDraft): PineScript {
    if (!draft.name?.trim()) throw new Error('pine_name_required');
    if (!draft.script?.trim()) throw new Error('pine_script_required');
    const source = draft.source ?? 'user';
    if (!['user', 'agent', 'community'].includes(source)) throw new Error('pine_source_invalid');
    // 社区来源必须留许可:PineTS 本身 AGPL-3.0,抄来的脚本没许可就是个法务坑。
    if (source === 'community' && !draft.license?.trim()) throw new Error('pine_license_required_for_community');
    if (this.db.prepare('SELECT 1 FROM pine_scripts WHERE name=?').get(draft.name)) throw new Error('pine_name_conflict');
    const inputsSchema = normalizeInputsSchema(draft.inputs_schema, draft.script);
    const at = this.now(), id = draft.id ?? `pine_${randomUUID().slice(0, 12)}`;
    this.db.prepare(`INSERT INTO pine_scripts(${COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,0,NULL,?,?,0)`).run(
      id, draft.name, draft.description ?? '', JSON.stringify(draft.aliases ?? []), draft.script,
      JSON.stringify(inputsSchema), '[]', source, draft.license ?? null, draft.author ?? null, at, at,
    );
    return this.get(id)!;
  }

  /** 改正文 / 参数即作废准入(admitted 归 0,报告清空),必须重跑准入。 */
  update(id: string, patch: Partial<PineScriptDraft>): PineScript {
    const current = this.get(id);
    if (!current) throw new Error('pine_script_not_found');
    const next = {
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      aliases: patch.aliases ?? current.aliases,
      script: patch.script ?? current.script,
      // 改了正文而 schema 是推导出来的:跟着重新推导;显式给的 schema 保留(再校验一次)
      inputs_schema: normalizeInputsSchema(
        patch.inputs_schema ?? current.inputs_schema,
        patch.script ?? current.script,
      ) as Record<string, unknown>,
      license: patch.license === undefined ? current.license : patch.license,
      author: patch.author === undefined ? current.author : patch.author,
    };
    // 旧行的 schema 可能是 {}(取用时现场推导),规整后再比,免得只改个名字也作废准入
    const before = (() => { try { return JSON.stringify(normalizeInputsSchema(current.inputs_schema, current.script)); } catch { return JSON.stringify(current.inputs_schema); } })();
    const invalidates = next.script !== current.script || JSON.stringify(next.inputs_schema) !== before;
    this.db.prepare('UPDATE pine_scripts SET name=?,description=?,aliases_json=?,script=?,inputs_schema_json=?,license=?,author=?,updated_at=?' +
      (invalidates ? ',admitted=0,admission_report_json=NULL,outputs_json=\'[]\'' : '') + ' WHERE id=?').run(
      next.name, next.description, JSON.stringify(next.aliases), next.script, JSON.stringify(next.inputs_schema),
      next.license, next.author, this.now(), id,
    );
    return this.get(id)!;
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM pine_scripts WHERE id=?').run(id).changes > 0;
  }

  /** 写入准入报告:ok 才置 admitted=1,outputs 用真跑出来的 plot 名。 */
  admit(id: string, report: AdmissionReport): PineScript {
    if (!this.get(id)) throw new Error('pine_script_not_found');
    this.db.prepare('UPDATE pine_scripts SET admitted=?,admission_report_json=?,outputs_json=?,updated_at=? WHERE id=?')
      .run(report.ok ? 1 : 0, JSON.stringify(report), JSON.stringify(report.outputs), this.now(), id);
    return this.get(id)!;
  }

  /** 被策略真正引用一次就 +1,搜索排序按它来。 */
  used(id: string): void {
    this.db.prepare('UPDATE pine_scripts SET usage_count=usage_count+1 WHERE id=?').run(id);
  }
}

// ---- 进程内单例:路由启动时装配,原语与 agent 工具同步取用(compute 是同步接口,没法现拿 db)。
let current: PineCatalog | null = null;
export function setPineCatalog(catalog: PineCatalog | null): void { current = catalog; }
export function pineCatalog(): PineCatalog | null { return current; }
