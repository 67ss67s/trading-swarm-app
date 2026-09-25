/**
 * 楼层 v4 英文模式守卫:floor-v4 源码里每个带中文的字符串字面量都必须在 EN 词典里有英文(FLOOR_EN 挂在 EN 上)。
 * 不是给人看的文案(命令行解析词表、正则词等)在那一行加 `i18n-ignore` 注释豁免(或上一行写 `// i18n-ignore(下一行…)`)。
 * 带 ${} 的模板字符串里有中文 = 没走 t(),直接判失败(改成 t('… {x}', { x }))。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EN } from '../src/lib/i18n-en';

const ROOT = join(__dirname, '..', 'src');
const CJK = /[㐀-鿿＀-￯　-〿]/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(f) && !/i18n-en/.test(f) ? [p] : [];
  });
}

interface Lit {
  text: string;
  line: number;
  template: boolean;
}

/** 极简词法:跳过注释,收集 '…' "…" `…` 字面量(模板里 ${} 的表达式递归扫) */
export function literals(src: string): Lit[] {
  const out: Lit[] = [];
  let i = 0;
  let line = 1;
  const scan = (stopAtBrace: boolean): void => {
    let depth = 0;
    while (i < src.length) {
      const c = src[i]!;
      if (c === '\n') line++;
      if (c === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
          if (src[i] === '\n') line++;
          i++;
        }
        i += 2;
        continue;
      }
      if (stopAtBrace) {
        if (c === '{') depth++;
        if (c === '}') {
          if (depth === 0) {
            i++;
            return;
          }
          depth--;
        }
      }
      if (c === "'" || c === '"') {
        const start = line;
        let s = '';
        i++;
        while (i < src.length && src[i] !== c) {
          if (src[i] === '\\') {
            s += src[i + 1];
            i += 2;
            continue;
          }
          if (src[i] === '\n') break;
          s += src[i];
          i++;
        }
        i++;
        out.push({ text: s, line: start, template: false });
        continue;
      }
      if (c === '`') {
        const start = line;
        let s = '';
        let hasExpr = false;
        i++;
        while (i < src.length && src[i] !== '`') {
          if (src[i] === '\\') {
            s += src[i + 1];
            i += 2;
            continue;
          }
          if (src[i] === '$' && src[i + 1] === '{') {
            hasExpr = true;
            i += 2;
            scan(true);
            s += '${}';
            continue;
          }
          if (src[i] === '\n') line++;
          s += src[i];
          i++;
        }
        i++;
        out.push({ text: s, line: start, template: hasExpr });
        continue;
      }
      i++;
    }
  };
  scan(false);
  return out;
}

const SOURCES = [...files(join(ROOT, 'components', 'floor-v4')), join(ROOT, 'pages', 'floor-v4.tsx')];

describe('floor-v4 i18n', () => {
  it('every Chinese string literal has an English entry', () => {
    const missing: string[] = [];
    for (const f of SOURCES) {
      const src = readFileSync(f, 'utf8');
      const lines = src.split('\n');
      for (const l of literals(src)) {
        if (!CJK.test(l.text)) continue;
        // 同一行,或上一行是「// i18n-ignore(下一行…)」
        if (lines[l.line - 1]?.includes('i18n-ignore') || lines[l.line - 2]?.includes('i18n-ignore(下一行')) continue;
        // CSS 里的 font-family 之类不会有中文;import 路径也不会
        const rel = f.slice(ROOT.length + 1);
        if (l.template) missing.push(`${rel}:${l.line} template with CJK (use t()): ${l.text.slice(0, 50)}`);
        else if (EN[l.text] === undefined) missing.push(`${rel}:${l.line} ${JSON.stringify(l.text)}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('lexer skips comments and sees template expressions', () => {
    const ls = literals("// '注释'\nconst a = t('你好'); /* \"不算\" */ const b = `x ${t('里面')} y`;");
    expect(ls.map((l) => l.text)).toEqual(['你好', '里面', 'x ${} y']);
    expect(ls[2]!.template).toBe(true);
  });
});
