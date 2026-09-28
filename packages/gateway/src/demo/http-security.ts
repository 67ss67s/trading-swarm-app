// 网关监听与非公网部署的入口鉴权。
//   默认只听 127.0.0.1(TG_DEMO_HOST 可改);
//   公网演示(TG_PUBLIC_DEMO=1)的身份与权限在 public-gate.ts,这里不管;
//   非公网又要监听非回环地址时,必须配 TG_GATEWAY_TOKEN_FILE(0600,>=32 字符),所有请求带 `Authorization: Bearer <token>`。
import { readFileSync, statSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { publicDemo } from './public-demo.js';

const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];

export interface GatewaySecurity {
  host: string;
  /** 通过返回 true;不通过时已写好 401 响应。 */
  authorize(req: IncomingMessage, res: ServerResponse): boolean;
}

export function gatewaySecurity(): GatewaySecurity {
  const host = process.env['TG_DEMO_HOST'] ?? '127.0.0.1';
  const tokenPath = process.env['TG_GATEWAY_TOKEN_FILE'];
  let token = '';
  if (tokenPath) {
    if (statSync(tokenPath).mode & 0o077) throw new Error('TG_GATEWAY_TOKEN_FILE 权限必须为 0600');
    token = readFileSync(tokenPath, 'utf8').trim();
    if (token.length < 32) throw new Error('网关令牌至少 32 个字符');
  }
  if (!LOOPBACK.includes(host) && !token && !publicDemo()) throw new Error('非回环监听必须配置 TG_PUBLIC_DEMO=1 或 TG_GATEWAY_TOKEN_FILE');
  const expected = Buffer.from(`Bearer ${token}`);
  return {
    host,
    authorize(req, res) {
      if (!token) return true; // 回环开发入口
      const supplied = Buffer.from(req.headers.authorization ?? '');
      if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return true;
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
      res.end(JSON.stringify({ error: { code: 'unauthorized', message: '需要网关身份认证' } }));
      return false;
    },
  };
}
