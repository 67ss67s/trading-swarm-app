import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** mulberry32 — small, fast, deterministic; seeded from a string or number. */
export function seededRng(seed: string | number): () => number {
  let a = typeof seed === 'number' ? seed >>> 0 : Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export function listJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => join(dir, f));
}

/** Number of decimals in a decimal string ("108208.40" → 2). */
export function decimalsOf(s: string): number {
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

export function fmtDec(n: number, decimals: number): string {
  return n.toFixed(decimals);
}

/** Compact UTC stamp for ids: 2026-08-12T10:15Z → 20260812T1015 */
export function stamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace(/[-:]/g, '');
}

export function isoMinute(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16) + 'Z';
}

export function parseDateArg(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
  if (!Number.isFinite(t)) throw new Error(`bad date: ${s}`);
  return t;
}

export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * q)));
  return s[idx]!;
}

export function round(n: number, d = 4): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
