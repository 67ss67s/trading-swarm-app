// 让 node --experimental-transform-types 直接跑 gateway 的 TS 源码:源码里的相对 import 写的是 .js,这里在 .js 不存在而同名 .ts 存在时改指 .ts。
// 用法:node --experimental-transform-types --import ./scripts/research-oracle/register.mjs scripts/research-oracle/study.ts
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:')) && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier, context.parentURL);
    if (!existsSync(fileURLToPath(url))) {
      const ts = new URL(url.href.replace(/\.js$/, '.ts'));
      if (existsSync(fileURLToPath(ts))) return next(ts.href, context);
    }
  }
  return next(specifier, context);
}
