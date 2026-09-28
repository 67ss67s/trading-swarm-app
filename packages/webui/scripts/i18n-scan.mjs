#!/usr/bin/env node
/**
 * webui 漏翻静态扫描(评审版英文优先,2026-09-26)。
 *
 * 用 TypeScript 编译器 API 解析 src 下每个 .ts/.tsx(注释天然不进 AST),出两份清单:
 *
 *   1. untranslated —— 含中文、用户看得见、却没经过 t()/tr()/tmap() 的字符串:
 *      JSX 文本、JSX 属性值(title / placeholder / aria-label …)、toast 文案、常量表标签、带中文的模板串。
 *      排除:console.* 参数、import 路径、类型位置的字面量、对象键、比较/匹配用的字面量
 *      (=== / case / includes / startsWith / match / replace 第一参 / new RegExp …,那是在解析后端文本,不是给人看的)、
 *      按 getLang() 分支的中文那一支、行内 `i18n-ignore` 或上一行 `// i18n-ignore(下一行…)`、写了 `// i18n-ignore-file` 的整个文件。
 *      常量表 / 普通变量里的中文如果 EN 词典里有,记作 indirect(大概率在使用处套了 t()),不算进漏翻数,单列备查。
 *   2. missing —— 所有 t('…') / tr('…') / tmap({…}) 的字面量 key 里,EN 词典查不到的。
 *
 * EN 词典 = 所有 i18n-en*.ts 文件里对象字面量的字符串键(它们全部 spread 进 lib/i18n-en.ts 的 EN)。
 *
 * 用法:
 *   node packages/webui/scripts/i18n-scan.mjs                 # 打印摘要
 *   node packages/webui/scripts/i18n-scan.mjs --out <dir>     # 另存 untranslated.txt / missing-keys.txt / indirect.txt / summary.json
 *   node packages/webui/scripts/i18n-scan.mjs --list          # 把两份清单打到 stdout
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const CJK = /[㐀-鿿豈-﫿　-〿＀-￯]/;
/** 只算汉字(全角标点单独出现不算「中文文案」,比如 '·' '…' '—') */
const HAN = /[㐀-鿿豈-﫿]/;

const T_FUNCS = new Set(['t', 'tr']);
const MAP_FUNCS = new Set(['tmap']);
/** 这些方法的第一个参数是拿来匹配/解析的,不是显示用 */
const MATCH_METHODS = new Set(['includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'match', 'matchAll', 'test', 'split', 'search', 'has', 'replace', 'replaceAll']);
const COMPARE_OPS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
const LANG_COND = /getLang\(\)|\blang\b|\bisEn\b|\bLANG\b/;

function listFiles(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return listFiles(p);
    return /\.(ts|tsx)$/.test(f) && !/\.d\.ts$/.test(f) ? [p] : [];
  });
}

export function isDictFile(path) {
  return /(^|\/)i18n-en[\w-]*\.ts$/.test(path);
}

/** 不扫的文件:词典本身、后端文案句式表(里面的中文是匹配模式) */
export function isExcludedFile(path) {
  return isDictFile(path) || /(^|\/)server-text-en(-patterns)?\.ts$/.test(path) || /(^|\/)lib\/i18n\.ts$/.test(path);
}

function parse(path, text) {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function stringOf(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

/** 词典键:对象字面量里字符串(或标识符)键 → 值为字符串的属性 */
export function collectDictKeys(text, path = 'dict.ts') {
  const keys = new Set();
  const sf = parse(path, text);
  const visit = (n) => {
    if (ts.isPropertyAssignment(n) && (ts.isStringLiteral(n.initializer) || ts.isNoSubstitutionTemplateLiteral(n.initializer))) {
      const name = n.name;
      if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) keys.add(name.text);
      else if (ts.isIdentifier(name)) keys.add(name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return keys;
}

function calleeName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

function calleeObject(call) {
  const e = call.expression;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) return e.expression.text;
  return undefined;
}

/** 往上穿过括号 / 三元 / ?? || && / as / 满足 satisfies,找到「值实际流向」的父节点 */
function valueParent(node) {
  let cur = node;
  let p = cur.parent;
  while (
    p &&
    (ts.isParenthesizedExpression(p) ||
      (ts.isConditionalExpression(p) && p.condition !== cur) ||
      (ts.isBinaryExpression(p) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(p.operatorToken.kind)) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression?.(p) ||
      ts.isNonNullExpression(p))
  ) {
    cur = p;
    p = p.parent;
  }
  return { child: cur, parent: p };
}

function inLangBranch(node) {
  let cur = node;
  while (cur.parent) {
    const p = cur.parent;
    if (ts.isConditionalExpression(p) && p.condition !== cur && LANG_COND.test(p.condition.getText())) return true;
    if (ts.isIfStatement(p) && p.expression !== cur && LANG_COND.test(p.expression.getText())) return true;
    if (ts.isFunctionLike(p) || ts.isSourceFile(p)) return false;
    cur = p;
  }
  return false;
}

/** 字面量是否处在 t()/tr() 的第一个参数里,或 tmap({…}) 的对象里 */
function translatedBy(node) {
  let cur = node;
  while (cur.parent) {
    const p = cur.parent;
    if (ts.isCallExpression(p)) {
      const name = calleeName(p);
      if (name && T_FUNCS.has(name) && ts.isIdentifier(p.expression) && p.arguments[0] === cur) return 't';
      if (name && MAP_FUNCS.has(name) && p.arguments[0] === cur) return 'tmap';
      return undefined;
    }
    if (ts.isFunctionLike(p) || ts.isSourceFile(p) || ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p)) return undefined;
    // tmap 里嵌对象 / 数组 / 属性赋值;t 里三元 / 括号
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isConditionalExpression(p) ||
      ts.isBinaryExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isObjectLiteralExpression(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isArrayLiteralExpression(p)
    ) {
      if (ts.isConditionalExpression(p) && p.condition === cur) return undefined;
      if (ts.isPropertyAssignment(p) && p.name === cur) return undefined;
      cur = p;
      continue;
    }
    return undefined;
  }
  return undefined;
}

/** 非用户可见的用途 → 返回原因;可见 → undefined */
function invisibleReason(node) {
  const { child, parent: p } = valueParent(node);
  if (!p) return undefined;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return 'import';
  if (ts.isLiteralTypeNode(p)) return 'type';
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p)) && p.name === child) return 'key';
  if (ts.isElementAccessExpression(p) && p.argumentExpression === child) return 'key';
  if (ts.isBinaryExpression(p) && COMPARE_OPS.has(p.operatorToken.kind)) return 'compare';
  if (ts.isCaseClause(p)) return 'compare';
  if (ts.isNewExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === 'RegExp') return 'regex';
  if (ts.isCallExpression(p)) {
    const name = calleeName(p);
    const obj = calleeObject(p);
    if (obj === 'console') return 'console';
    if (name && MATCH_METHODS.has(name) && p.arguments[0] === child) return 'match';
    if (name === 'RegExp') return 'regex';
  }
  // console.x(`…${}…`) 等嵌在更深处
  let cur = node;
  while (cur.parent && !ts.isSourceFile(cur.parent)) {
    const q = cur.parent;
    if (ts.isCallExpression(q) && calleeObject(q) === 'console') return 'console';
    if (ts.isFunctionLike(q)) break;
    cur = q;
  }
  // Set / Map / 数组 的 .has/.includes 用法:new Set(['做多', …]) 这种纯匹配表不好判,留给 i18n-ignore
  return undefined;
}

function contextOf(node) {
  if (ts.isJsxText(node)) return 'jsx-text';
  const { child, parent: p } = valueParent(node);
  if (p && ts.isJsxExpression(p)) {
    const pp = p.parent;
    if (pp && ts.isJsxAttribute(pp)) return `jsx-attr:${pp.name.getText()}`;
    return 'jsx-expr';
  }
  if (p && ts.isJsxAttribute(p)) return `jsx-attr:${p.name.getText()}`;
  // toast / confirm / alert
  let cur = node;
  while (cur.parent && !ts.isSourceFile(cur.parent)) {
    const q = cur.parent;
    if (ts.isCallExpression(q)) {
      const name = calleeName(q);
      const obj = calleeObject(q);
      if (obj === 'toast' || name === 'toast') return 'toast';
      if (name === 'alert' || name === 'confirm' || name === 'prompt') return 'dialog';
      if (name === 'Error' || (ts.isNewExpression(q) && name === 'Error')) return 'error';
      break;
    }
    if (ts.isNewExpression(q) && ts.isIdentifier(q.expression) && /Error$/.test(q.expression.text)) return 'error';
    if (ts.isFunctionLike(q) || ts.isStatement(q)) break;
    cur = q;
  }
  if (p && (ts.isPropertyAssignment(p) || ts.isArrayLiteralExpression(p) || ts.isShorthandPropertyAssignment(p))) return 'table';
  void child;
  return 'other';
}

function lineOf(sf, pos) {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function ignoredLine(lines, line) {
  return Boolean(lines[line - 1]?.includes('i18n-ignore') || lines[line - 2]?.includes('i18n-ignore(下一行'));
}

/** 模板串 → `前缀{0}中间{1}` 形式,便于人看 */
function templateText(node) {
  let s = node.head.text;
  node.templateSpans.forEach((sp, i) => {
    s += `{${i}}` + sp.literal.text;
  });
  return s;
}

/**
 * 扫一个源文件。
 * @returns {{ untranslated: Finding[], indirect: Finding[], keys: {text:string,line:number,dynamic:boolean}[] }}
 */
export function scanSource(text, path, dict) {
  const sf = parse(path, text);
  const lines = text.split('\n');
  const untranslated = [];
  const indirect = [];
  const keys = [];

  const visit = (n) => {
    // t('…') / tmap({…}) 的 key
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const name = n.expression.text;
      const arg = n.arguments[0];
      if (T_FUNCS.has(name) && arg) collectKeys(arg, keys, sf, false);
      if (MAP_FUNCS.has(name) && arg && ts.isObjectLiteralExpression(arg)) {
        for (const prop of arg.properties) if (ts.isPropertyAssignment(prop)) collectKeys(prop.initializer, keys, sf, false);
      }
    }

    let textVal;
    let isTemplate = false;
    if (ts.isJsxText(n)) textVal = n.text.replace(/\s+/g, ' ').trim();
    else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) textVal = n.text;
    else if (ts.isTemplateExpression(n)) {
      textVal = templateText(n);
      isTemplate = true;
    }
    if (textVal !== undefined && HAN.test(textVal)) {
      const line = lineOf(sf, n.getStart(sf));
      if (!ignoredLine(lines, line) && !inLangBranch(n)) {
        const by = ts.isJsxText(n) ? undefined : translatedBy(n);
        if (!by || isTemplate) {
          const why = ts.isJsxText(n) ? undefined : invisibleReason(n);
          if (!why) {
            const ctx = contextOf(n);
            const f = { file: path, line, context: isTemplate ? `template(${ctx})` : ctx, text: textVal, inDict: dict.has(textVal) };
            // 常量表 / 变量里、词典里有的 → 多半在使用处套了 t(),单列
            if (!isTemplate && f.inDict && (ctx === 'table' || ctx === 'other')) indirect.push(f);
            else untranslated.push(f);
          }
        }
      }
      if (isTemplate) {
        // 模板里的 ${} 表达式照常往下扫
        ts.forEachChild(n, visit);
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { untranslated, indirect, keys };
}

function collectKeys(arg, keys, sf, _nested) {
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    keys.push({ text: arg.text, line: lineOf(sf, arg.getStart(sf)), dynamic: false });
  } else if (ts.isConditionalExpression(arg)) {
    collectKeys(arg.whenTrue, keys, sf, true);
    collectKeys(arg.whenFalse, keys, sf, true);
  } else if (ts.isParenthesizedExpression(arg)) {
    collectKeys(arg.expression, keys, sf, true);
  } else if (ts.isBinaryExpression(arg) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(arg.operatorToken.kind)) {
    collectKeys(arg.right, keys, sf, true);
  } else if (ts.isTemplateExpression(arg)) {
    const s = templateText(arg);
    if (HAN.test(s)) keys.push({ text: s, line: lineOf(sf, arg.getStart(sf)), dynamic: true });
  }
}

/** 扫整个 src。root = packages/webui */
export function scanTree(root) {
  const src = join(root, 'src');
  const all = listFiles(src);
  const dict = new Set();
  for (const f of all.filter(isDictFile)) for (const k of collectDictKeys(readFileSync(f, 'utf8'), f)) dict.add(k);
  const untranslated = [];
  const indirect = [];
  const missing = [];
  const dynamicKeys = [];
  let keyCount = 0;
  for (const f of all) {
    if (isExcludedFile(f)) continue;
    const rel = relative(root, f);
    const text = readFileSync(f, 'utf8');
    const r = scanSource(text, rel, dict);
    // 整文件豁免(测试夹具等不上界面的数据):文件里写一行 `// i18n-ignore-file`
    if (!/\/\/\s*i18n-ignore-file/.test(text)) {
      untranslated.push(...r.untranslated);
      indirect.push(...r.indirect);
    }
    for (const k of r.keys) {
      if (!HAN.test(k.text)) continue;
      keyCount++;
      if (k.dynamic) dynamicKeys.push({ file: rel, line: k.line, text: k.text });
      else if (!dict.has(k.text)) missing.push({ file: rel, line: k.line, text: k.text });
    }
  }
  return { dictSize: dict.size, keyCount, untranslated, indirect, missing, dynamicKeys };
}

function fmt(f) {
  return `${f.file}:${f.line}\t${f.context ?? ''}\t${JSON.stringify(f.text)}`;
}

function uniqueCount(list) {
  return new Set(list.map((f) => f.text)).size;
}

export function summarize(r) {
  const byCtx = {};
  for (const f of r.untranslated) {
    const c = f.context.replace(/:.*/, '').replace(/^template.*/, 'template');
    byCtx[c] = (byCtx[c] ?? 0) + 1;
  }
  const byDir = {};
  for (const f of r.untranslated) {
    const d = f.file.replace(/^src\//, '').split('/').slice(0, 2).join('/');
    byDir[d] = (byDir[d] ?? 0) + 1;
  }
  return {
    dict_keys: r.dictSize,
    t_keys: r.keyCount,
    untranslated: r.untranslated.length,
    untranslated_unique: uniqueCount(r.untranslated),
    missing_keys: r.missing.length,
    missing_keys_unique: uniqueCount(r.missing),
    dynamic_keys: r.dynamicKeys.length,
    indirect: r.indirect.length,
    by_context: byCtx,
    by_dir: Object.fromEntries(Object.entries(byDir).sort((a, b) => b[1] - a[1])),
  };
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '..');
  const args = process.argv.slice(2);
  const r = scanTree(root);
  const s = summarize(r);
  const outIdx = args.indexOf('--out');
  if (outIdx >= 0) {
    const out = args[outIdx + 1];
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'untranslated.txt'), r.untranslated.map(fmt).join('\n') + '\n');
    writeFileSync(join(out, 'missing-keys.txt'), [...r.missing.map(fmt), ...r.dynamicKeys.map((f) => `${fmt(f)}\t(dynamic key)`)].join('\n') + '\n');
    writeFileSync(join(out, 'indirect.txt'), r.indirect.map(fmt).join('\n') + '\n');
    writeFileSync(join(out, 'summary.json'), JSON.stringify(s, null, 2) + '\n');
  }
  if (args.includes('--list')) {
    console.log('# untranslated');
    for (const f of r.untranslated) console.log(fmt(f));
    console.log('# missing keys');
    for (const f of r.missing) console.log(fmt(f));
    for (const f of r.dynamicKeys) console.log(`${fmt(f)}\t(dynamic key)`);
  }
  console.log(JSON.stringify(s, null, 2));
  if (args.includes('--check') && (r.untranslated.length > 0 || r.missing.length > 0)) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
