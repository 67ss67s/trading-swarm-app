/**
 * 一键中英切换。设计取「最省改动」的一条:**中文原文就是 key**。
 *
 *   t('紧急停止')            → zh: '紧急停止'   en: 'Emergency stop'
 *   t('已选 {n} 个', { n })  → 插值用 {name} 占位,zh / en 两边都套
 *   tmap({ long: '做多' })   → 标签表包一层 Proxy,读属性时才翻译(调用点一个字不用改)
 *
 * 这样审校后的中文既是显示文案又是词典 key,不用给几千条文案起 id。
 * 英文词典在 ./i18n-en.ts;缺的 key 在 en 下回退中文,并在 dev 里 console.warn 一次(去重)。
 *
 * 重渲染:App.tsx 顶层调一次 useLang(),语言一变整棵树重渲染,t() 读到新值。
 * 组件自己不需要 hook,非组件代码(format.ts 的标签表)也能直接用 t()。
 */
import { useSyncExternalStore } from 'react';
import { EN } from './i18n-en';
import { DEFAULT_LANG } from './edition';

export type Lang = 'zh' | 'en';

const STORAGE_KEY = 'tg.lang';

/** 用户手动切过就用存的;没切过用默认语言(英文,见 ./edition.ts) */
function readStored(): Lang {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved === 'en' || saved === 'zh' ? saved : DEFAULT_LANG;
  } catch {
    return DEFAULT_LANG; // 隐私模式等
  }
}

let current: Lang = readStored();
const listeners = new Set<() => void>();

function syncDocumentLang(): void {
  try {
    document.documentElement.lang = current === 'en' ? 'en' : 'zh-CN';
    document.title = 'Trading Swarm';
  } catch {
    /* SSR / 无 document */
  }
}
syncDocumentLang();

export function getLang(): Lang {
  return current;
}

/** 列表分隔符:中文「、」,英文「, 」(前端拼列表用 xs.join(listSep()),别写死中文顿号) */
export function listSep(): string {
  return current === 'en' ? ', ' : '、';
}

/** 引用一段文字:中文「…」,英文 “…” */
export function quote(text: string): string {
  return current === 'en' ? `\u201c${text}\u201d` : `「${text}」`;
}

export function setLang(next: Lang): void {
  if (next === current) return;
  current = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* 隐私模式等 */
  }
  syncDocumentLang();
  for (const fn of listeners) fn();
}

export function toggleLang(): void {
  setLang(current === 'zh' ? 'en' : 'zh');
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 订阅当前语言。App.tsx 顶层调一次就够,别的组件按需。 */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang);
}

export type TVars = Record<string, string | number | null | undefined>;

const warned = new Set<string>();

function interpolate(text: string, vars?: TVars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name] ?? '') : whole));
}

/** 翻译。第一个参数是审校过的中文原文,同时也是词典 key。 */
export function t(zh: string, vars?: TVars): string {
  if (current === 'zh') return interpolate(zh, vars);
  const en = EN[zh];
  if (en === undefined) {
    if (import.meta.env.DEV && !warned.has(zh)) {
      warned.add(zh);
      console.warn(`[i18n] 缺英文翻译: ${JSON.stringify(zh)}`);
    }
    return interpolate(zh, vars);
  }
  return interpolate(en, vars);
}

/**
 * 把「常量标签表」包成读属性时才翻译的 Proxy —— `ACTION_LABEL[action]` 这类调用点一个字不用改,
 * 又不会在模块加载时把语言冻死。Object.entries / keys / values 照常工作。
 */
export function tmap<T extends Record<string, string>>(table: T): T {
  return new Proxy(table, {
    get(target, prop, receiver) {
      const raw = Reflect.get(target, prop, receiver);
      return typeof raw === 'string' && typeof prop === 'string' ? t(raw) : raw;
    },
  });
}
