import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DemoStore } from '../store.js';
import { MarketCli, data, list, object, payload } from './cli.js';
import { BANNED_WORDS } from './publisher.js';
export interface Listing { name: string; description: string; service_name: string; service_description: string; pricing: 'per_call' | 'monthly' | 'monthly_trial'; fee: string; }
export function validateRegistration(o: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const name = typeof o['name'] === 'string' ? o['name'] : '';
  const min = /[\u3400-\u9fff]/.test(name) ? 2 : 3; const max = min === 2 ? 12 : 25;
  if (name.length < min || name.length > max) errors.push(`name 长度必须是 ${min}–${max}`);
  if (typeof o['description'] !== 'string' || o['description'].length > 500 || !o['description'].trim()) errors.push('description 必填且不超过 500 字');
  if (typeof o['service_name'] !== 'string' || o['service_name'].length < 5 || o['service_name'].length > 30) errors.push('service_name 长度必须是 5–30');
  if (typeof o['service_description'] !== 'string' || !o['service_description'].trim()) errors.push('service_description 必填');
  if (!['per_call', 'monthly', 'monthly_trial'].includes(String(o['pricing']))) errors.push('pricing 必须是 per_call/monthly/monthly_trial');
  if (typeof o['fee'] !== 'string' || !/^\d+(?:\.\d{1,6})?$/.test(o['fee'])) errors.push('fee 必须是最多 6 位小数的十进制字符串');
  if (BANNED_WORDS.test([name, o['description'], o['service_name'], o['service_description']].join(' '))) errors.push('包含禁止的收益保证词');
  return errors;
}
function listingArgs(o: Listing): string[] {
  const service = { serviceName: o.service_name, serviceType: 'A2A', serviceDescription: o.service_description, fee: o.pricing === 'per_call' ? o.fee : '', subscription: o.pricing === 'per_call' ? [] : [{ interval: 'month', fee: o.fee }], ...(o.pricing === 'monthly_trial' ? { freeTrial: '72' } : {}) };
  return ['--role', 'asp', '--name', o.name, '--description', o.description, '--service', JSON.stringify([service])];
}
export class MarketIdentity {
  private details = new Map<string, { at: number; value: unknown }>();
  constructor(private readonly cli: MarketCli, private readonly store: DemoStore) {}
  async mine(fresh = false): Promise<{ buyer: Record<string, unknown> | null; asp: Record<string, unknown> | null }> {
    const raw = this.store.kvGet('market.asp_identity');
    if (!fresh && raw) { const c = JSON.parse(raw); if (Date.now() - c.at < 60000) return c.value; }
    // get-my-agents 的 list 是「账户」行,agent 在每行的 agentList 里;先摊平再按角色找。
    const rows = list(await this.cli.call('get-my-agents')).flatMap((x) => Array.isArray(x['agentList']) ? (x['agentList'] as unknown[]).map(object) : [x]);
    const value = { buyer: rows.find((x) => /\b(user|buyer)\b/i.test(String(x['roleLabel'] ?? x['role']))) ?? null, asp: rows.find((x) => /\b(asp|provider|seller)\b/i.test(String(x['roleLabel'] ?? x['role']))) ?? null };
    this.store.kvSet('market.asp_identity', JSON.stringify({ at: Date.now(), value })); return value;
  }
  async aspId(): Promise<string> { const asp = (await this.mine()).asp; const id = asp?.['agentId'] ?? asp?.['aspAgentId'] ?? asp?.['id']; if (!id) throw Object.assign(new Error('尚未注册 ASP 身份'), { status: 409 }); return String(id); }
  async detail(id: string): Promise<unknown> {
    const cached = this.details.get(id); if (cached && Date.now() - cached.at < 300000) return cached.value;
    const [profile, services, feedback] = await Promise.all([this.cli.call('profile', [id]), this.cli.call('service-list', ['--agent-id', id]), this.cli.call('feedback-list', ['--agent-id', id])]);
    const value = { profile: payload(profile), services: payload(services), feedback: payload(feedback) }; this.details.set(id, { at: Date.now(), value }); return value;
  }
  async validate(o: Record<string, unknown>) { return data(await this.cli.call('validate-listing', listingArgs(o as unknown as Listing))); }
  async register(o: Record<string, unknown>, avatar: { bytes: Buffer; type: string } | null) {
    const errors = validateRegistration(o);
    if (!avatar || !['image/png', 'image/jpeg', 'image/webp'].includes(avatar.type) || avatar.bytes.length === 0 || avatar.bytes.length > 1048576) errors.push('avatar 必须是 1MB 内的 PNG/JPEG/WebP 文件');
    if (errors.length) throw Object.assign(new Error(errors.join(';')), { status: 400 });
    const precheck = data(await this.cli.call('pre-check', ['--role', 'asp']));
    if (precheck['canCreate'] !== true) return { created: false, precheck };
    const dir = await mkdtemp(join(tmpdir(), 'tg-asp-avatar-'));
    try {
      const file = join(dir, avatar!.type === 'image/png' ? 'avatar.png' : avatar!.type === 'image/webp' ? 'avatar.webp' : 'avatar.jpg');
      await writeFile(file, avatar!.bytes, { mode: 0o600 });
      const uploaded = data(await this.cli.call('upload', ['--file', file]));
      const picture = uploaded['url'] ?? uploaded['picture'] ?? uploaded['imageUrl'];
      if (typeof picture !== 'string' || !picture.startsWith('https://')) throw new Error('头像上传未返回 HTTPS URL');
      const result = data(await this.cli.call('create', [...listingArgs(o as unknown as Listing), '--picture', picture]));
      this.store.kvSet('market.asp_identity', ''); return { created: true, result };
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  async mutate(command: 'activate' | 'deactivate' | 'update', o: Record<string, unknown>) {
    const id = await this.aspId();
    let args = ['--agent-id', id, ...(command === 'activate' ? ['--preferred-language', 'zh-CN'] : [])];
    if (command === 'update') {
      const errors = validateRegistration(o); if (errors.length) throw Object.assign(new Error(errors.join(';')), { status: 400 });
      await this.cli.call('get-agents', ['--agent-ids', id]);
      const serviceId = o['service_id'];
      if (typeof serviceId !== 'string' || !serviceId) throw Object.assign(new Error('update 需要 service_id'), { status: 400 });
      const current = list(await this.cli.call('service-list', ['--agent-id', id])).find((x) => String(x['id'] ?? x['serviceId']) === serviceId);
      if (!current) throw Object.assign(new Error('找不到要更新的服务'), { status: 404 });
      const monthly = Array.isArray(current['subscription']) && current['subscription'].length > 0;
      if (monthly === (o['pricing'] === 'per_call')) throw Object.assign(new Error('现有服务不允许切换计费模型'), { status: 400 });
      const fields = listingArgs(o as unknown as Listing).slice(2);
      const services = JSON.parse(fields[fields.length - 1]!) as Record<string, unknown>[];
      services[0] = { ...services[0], id: serviceId, operation: 'update' };
      fields[fields.length - 1] = JSON.stringify(services);
      args = [...args, ...fields];
    }
    const result = data(await this.cli.call(command, args)); this.store.kvSet('market.asp_identity', ''); this.details.delete(id); return result;
  }
}
