/** 身份文档直接读包根 agents,src/dist 都无需拷贝;mtime 改变即失效。 */
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AGENT_REGISTRY } from './agent-registry.js';
import { botDescription, type BotRole } from './bots.js';

export const AGENT_DOC_DIR = fileURLToPath(new URL('../../agents/', import.meta.url));
const cache = new Map<string, { mtime: number; size: number; text: string }>();
export function readAgentMd(role: BotRole, description = botDescription(role), directory = AGENT_DOC_DIR): string {
  const file = `${directory}/${role}.md`;
  try {
    const stat = statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtime === stat.mtimeMs && hit.size === stat.size) return hit.text;
    const text = readFileSync(file, 'utf8');
    cache.set(file, { mtime: stat.mtimeMs, size: stat.size, text });
    return text;
  } catch {
    cache.delete(file);
    return `# ${AGENT_REGISTRY[role].name}\n\n## 我是谁\n\n${description}\n`;
  }
}
