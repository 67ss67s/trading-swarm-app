/**
 * 漏翻扫描脚本(scripts/i18n-scan.mjs)的单测 + 全库守卫:src 里不能再有未走 t() 的中文文案、也不能有查不到英文的 t() key。
 * 新加文案按 i18n.ts 的约定写 t('中文') 并在词典里补英文;确实不上界面的中文(匹配词、后端值)行尾加 `// i18n-ignore`。
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error 纯 JS 脚本,没有类型声明
import { collectDictKeys, scanSource, scanTree } from '../scripts/i18n-scan.mjs';

const DICT = new Set(['已翻', '共 {n} 条']);
type Finding = { context: string; text: string; inDict: boolean };
const scan = (src: string, file = 'x.tsx') => scanSource(src, file, DICT) as { untranslated: Finding[]; indirect: Finding[]; keys: { text: string; dynamic: boolean }[] };

describe('i18n-scan: untranslated', () => {
  it('flags JSX text, JSX attributes, toast text and templates; ignores t() args', () => {
    const r = scan(`
      const a = <div title="提示">你好 {t('已翻')}</div>;
      toast.error('出错了');
      const s = \`共 \${n} 条\`;
      const ok = t('共 {n} 条', { n });
    `);
    expect(r.untranslated.map((f) => [f.context, f.text])).toEqual([
      ['jsx-attr:title', '提示'],
      ['jsx-text', '你好'],
      ['toast', '出错了'],
      ['template(other)', '共 {0} 条'],
    ]);
  });

  it('skips comments, console, comparisons, matching calls, type literals, object keys and i18n-ignore lines', () => {
    const r = scan(`
      // 注释里的中文
      /* 块注释 */
      console.warn('调试输出');
      if (x === '做多') {}
      s.includes('止损');
      type K = '中文类型';
      const m = { 中文键: 1, '引号键': 2 };
      const p = '匹配词'; // i18n-ignore
      switch (v) { case '平仓': break; }
      const lang = getLang() === 'en' ? 'Hi' : '你好';
    `, 'x.ts');
    expect(r.untranslated).toEqual([]);
    expect(r.indirect).toEqual([]);
  });

  it('table values already in the dictionary are "indirect", not untranslated', () => {
    const r = scan(`const L = { a: '已翻', b: '没翻' };`, 'x.ts');
    expect(r.indirect.map((f) => f.text)).toEqual(['已翻']);
    expect(r.untranslated.map((f) => f.text)).toEqual(['没翻']);
  });

  it('tmap() values count as translated and as keys', () => {
    const r = scan(`const L = tmap({ a: '已翻', b: '缺词' });`, 'x.ts');
    expect(r.untranslated).toEqual([]);
    expect(r.keys.map((k) => k.text)).toEqual(['已翻', '缺词']);
  });
});

describe('i18n-scan: keys', () => {
  it('collects t()/tr() keys through ternaries and marks template keys dynamic', () => {
    const r = scan('t(ok ? "甲" : "乙"); tr("丙"); t(`丁${x}`);', 'x.ts');
    expect(r.keys.map((k) => [k.text, k.dynamic])).toEqual([['甲', false], ['乙', false], ['丙', false], ['丁{0}', true]]);
  });

  it('reads dictionary keys from i18n-en style files', () => {
    expect([...collectDictKeys(`export const X = { '中文': 'Chinese', "双引号": "x", nested: 'y' };`)]).toEqual(['中文', '双引号', 'nested']);
  });
});

describe('i18n-scan: whole webui src', () => {
  it('has no untranslated user-visible Chinese and no missing EN keys', () => {
    const r = scanTree(join(__dirname, '..')) as { untranslated: { file: string; line: number; text: string }[]; missing: { file: string; line: number; text: string }[] };
    const fmt = (f: { file: string; line: number; text: string }) => `${f.file}:${f.line} ${f.text}`;
    expect(r.untranslated.map(fmt)).toEqual([]);
    expect(r.missing.map(fmt)).toEqual([]);
  }, 60_000);
});
