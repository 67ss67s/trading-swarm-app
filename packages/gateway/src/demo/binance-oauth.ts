/**
 * Gate-native OAuth 2.1 client for Binance's Agentic MCP server (docs/design/execution-binance-mcp-2026-09-04.md).
 *
 * Facts verified on 2026-09-04 against https://agent.binance.com/.well-known/oauth-authorization-server:
 *   authorization_endpoint  https://accounts.binance.com/agentic-oauth/authorize
 *   token_endpoint          https://accounts.binance.com/oauth-agentic/token
 *   token_endpoint_auth_methods_supported ["none"]   (public client, PKCE S256)
 *   grant_types_supported   ["authorization_code"]   (no refresh_token grant → re-authorize when it expires)
 *   client_id_metadata_document_supported true       (no dynamic registration: the client_id IS an https URL
 *                                                     pointing at a JSON document describing this client)
 *
 * So the gateway needs (a) an https URL that serves {@link clientMetadataDocument} — the gateway exposes it at
 * /oauth/binance/client-metadata.json for when it is reachable over https, otherwise the same JSON is uploaded
 * to any static host and its URL is passed via TG_BINANCE_OAUTH_CLIENT_ID; (b) a loopback redirect URI
 * (http://127.0.0.1:<port>/oauth/binance/callback). Tokens are kept in the demo_kv table — the gateway holds no
 * API keys, only a user-revocable bearer token scoped to the Agentic sub-account.
 */

import { createHash, randomBytes } from 'node:crypto';

export interface OAuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  code_challenge_methods_supported?: string[];
  grant_types_supported?: string[];
  scopes_supported?: string[];
}

export interface StoredToken {
  access_token: string;
  token_type: string;
  scope: string | null;
  refresh_token: string | null;
  obtained_at: number;
  /** ms epoch; null when the server did not say. */
  expires_at: number | null;
}

export interface OAuthStatus {
  configured: boolean;
  connected: boolean;
  client_id: string | null;
  redirect_uri: string;
  resource: string;
  expires_at: number | null;
  scope: string | null;
  /** Why `configured` is false, for the UI. */
  missing: string | null;
}

export interface KvLike {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface BinanceOAuthOptions {
  /** https URL of the client metadata document (CIMD). null → not configured. */
  clientId: string | null;
  redirectUri: string;
  /** RFC 8707 resource indicator = the MCP endpoint. */
  resource: string;
  issuer?: string;
  kv: KvLike;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export const BINANCE_MCP_URL = 'https://agent.binance.com/mcp/agentic';
export const BINANCE_OAUTH_ISSUER = 'https://agent.binance.com';
export const TOKEN_KV_KEY = 'binance.oauth.token';
const PENDING_TTL_MS = 10 * 60_000;
/** Treat a token as expired this long before the server does, so a request never races the expiry. */
const EXPIRY_SKEW_MS = 60_000;

export const base64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const pkceChallenge = (verifier: string): string => base64url(createHash('sha256').update(verifier).digest());

/** The document the `client_id` URL must serve (draft-ietf-oauth-client-id-metadata-document). */
export function clientMetadataDocument(clientId: string, redirectUris: string[]): Record<string, unknown> {
  return {
    client_id: clientId,
    client_name: 'trading-swarm',
    client_uri: 'https://github.com/67ss67s/trading-swarm',
    redirect_uris: redirectUris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: '',
  };
}

export class BinanceOAuth {
  private readonly pending = new Map<string, { verifier: string; created_at: number }>();
  private metadata: OAuthServerMetadata | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  readonly clientId: string | null;
  readonly redirectUri: string;
  readonly resource: string;
  readonly issuer: string;
  private readonly kv: KvLike;

  constructor(opts: BinanceOAuthOptions) {
    this.clientId = opts.clientId;
    this.redirectUri = opts.redirectUri;
    this.resource = opts.resource;
    this.issuer = (opts.issuer ?? BINANCE_OAUTH_ISSUER).replace(/\/$/, '');
    this.kv = opts.kv;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async discover(): Promise<OAuthServerMetadata> {
    if (this.metadata) return this.metadata;
    const res = await this.fetchImpl(`${this.issuer}/.well-known/oauth-authorization-server`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`OAuth 元数据获取失败 HTTP ${res.status}`);
    const meta = (await res.json()) as OAuthServerMetadata;
    if (!meta.authorization_endpoint || !meta.token_endpoint) throw new Error('OAuth 元数据缺少 authorization_endpoint/token_endpoint');
    this.metadata = meta;
    return meta;
  }

  /** Builds the consent URL; the state → PKCE verifier pair lives in memory for 10 minutes. */
  async startAuth(): Promise<{ url: string; state: string }> {
    if (!this.clientId) throw new Error('未配置 client_id(TG_BINANCE_OAUTH_CLIENT_ID = 托管 client-metadata.json 的 https 地址)');
    const meta = await this.discover();
    this.sweep();
    const state = base64url(randomBytes(24));
    const verifier = base64url(randomBytes(48));
    this.pending.set(state, { verifier, created_at: this.now() });
    const u = new URL(meta.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.clientId);
    u.searchParams.set('redirect_uri', this.redirectUri);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', pkceChallenge(verifier));
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('resource', this.resource);
    return { url: u.toString(), state };
  }

  /** Exchanges the authorization code from the redirect; rejects unknown/expired state. */
  async handleCallback(query: URLSearchParams): Promise<StoredToken> {
    const err = query.get('error');
    if (err) throw new Error(`授权被拒绝:${err}${query.get('error_description') ? ` — ${query.get('error_description')}` : ''}`);
    const state = query.get('state') ?? '';
    const code = query.get('code') ?? '';
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || this.now() - pending.created_at > PENDING_TTL_MS) throw new Error('state 不匹配或已过期,请重新发起连接');
    if (!code) throw new Error('回调缺少 code');
    if (!this.clientId) throw new Error('未配置 client_id');
    const meta = await this.discover();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      code_verifier: pending.verifier,
      resource: this.resource,
    });
    const res = await this.fetchImpl(meta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`换取 token 失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
    const j = JSON.parse(text) as { access_token?: string; token_type?: string; expires_in?: number; refresh_token?: string; scope?: string };
    if (!j.access_token) throw new Error(`token 响应缺少 access_token: ${text.slice(0, 200)}`);
    const now = this.now();
    const tok: StoredToken = {
      access_token: j.access_token,
      token_type: j.token_type ?? 'Bearer',
      scope: j.scope ?? null,
      refresh_token: j.refresh_token ?? null,
      obtained_at: now,
      expires_at: typeof j.expires_in === 'number' ? now + j.expires_in * 1000 : null,
    };
    this.kv.set(TOKEN_KV_KEY, JSON.stringify(tok));
    return tok;
  }

  stored(): StoredToken | null {
    const raw = this.kv.get(TOKEN_KV_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredToken;
    } catch {
      return null;
    }
  }

  /** A usable bearer token, or null when absent/expired (Binance offers no refresh grant → re-authorize). */
  async token(): Promise<string | null> {
    const t = this.stored();
    if (!t) return null;
    if (t.expires_at !== null && this.now() >= t.expires_at - EXPIRY_SKEW_MS) return null;
    return t.access_token;
  }

  disconnect(): void {
    this.kv.set(TOKEN_KV_KEY, '');
  }

  status(): OAuthStatus {
    const t = this.stored();
    const live = !!t && (t.expires_at === null || this.now() < t.expires_at - EXPIRY_SKEW_MS);
    return {
      configured: !!this.clientId,
      connected: live,
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      resource: this.resource,
      expires_at: t?.expires_at ?? null,
      scope: t?.scope ?? null,
      missing: this.clientId ? null : '缺 TG_BINANCE_OAUTH_CLIENT_ID:把 GET /oauth/binance/client-metadata.json 的内容放到任一 https 静态地址,再把该地址设为 client_id',
    };
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, v] of this.pending) if (now - v.created_at > PENDING_TTL_MS) this.pending.delete(k);
  }
}
