// workflow.ts: applyWorkflowPatch (bounds/clamping — the one place the UI/chat tool can push the
// loop's settings) and loadWorkflow (defaults + merge from persisted JSON).

import { describe, expect, it } from 'vitest';
import { applyWorkflowPatch, cliCommandError, DEFAULT_WORKFLOW, loadWorkflow, WORKFLOW_BOUNDS, estimateCallsPerHour } from '../../src/demo/workflow.js';
import type { Workflow } from '../../src/demo/types.js';

function base(): Workflow {
  return { ...DEFAULT_WORKFLOW, updated_at: 0 };
}

describe('applyWorkflowPatch: risk_pct', () => {
  it('accepts an in-range value and stores it as a string', () => {
    const { next, errors } = applyWorkflowPatch(base(), { risk_pct: 1 });
    expect(errors).toEqual([]);
    expect(next.risk_pct).toBe('1');
  });

  it('clamps below the minimum (0.1)', () => {
    const { next, errors } = applyWorkflowPatch(base(), { risk_pct: 0.01 });
    expect(errors).toEqual([]);
    expect(next.risk_pct).toBe('0.1');
  });

  it('clamps above the maximum (2)', () => {
    const { next, errors } = applyWorkflowPatch(base(), { risk_pct: 50 });
    expect(errors).toEqual([]);
    expect(next.risk_pct).toBe('2');
  });

  it('errors on a non-numeric value and leaves risk_pct unchanged', () => {
    const { next, errors } = applyWorkflowPatch(base(), { risk_pct: 'a lot' });
    expect(errors).toEqual(['risk_pct 必须是数字']);
    expect(next.risk_pct).toBe(DEFAULT_WORKFLOW.risk_pct);
  });
});

describe('applyWorkflowPatch: leverage', () => {
  it('accepts an in-range integer', () => {
    const { next, errors } = applyWorkflowPatch(base(), { leverage: 5 });
    expect(errors).toEqual([]);
    expect(next.leverage).toBe(5);
  });

  it('clamps below the minimum (1) and rounds', () => {
    const { next } = applyWorkflowPatch(base(), { leverage: -3 });
    expect(next.leverage).toBe(1);
  });

  it('clamps above the maximum (10) and rounds a fractional value', () => {
    const { next } = applyWorkflowPatch(base(), { leverage: 99.6 });
    expect(next.leverage).toBe(10);
  });

  it('errors on a non-numeric value', () => {
    const { errors } = applyWorkflowPatch(base(), { leverage: 'ten' });
    expect(errors).toEqual(['leverage 必须是数字']);
  });
});

describe('applyWorkflowPatch: watchlist', () => {
  it('normalizes: trims, uppercases, dedupes, keeps only USDT perps', () => {
    const { next, errors } = applyWorkflowPatch(base(), { watchlist: [' btcusdt ', 'ETHUSDT', 'ethusdt', 'btcusdc', 'BTCUSDT'] });
    expect(errors).toEqual([]);
    expect(next.watchlist).toEqual(['BTCUSDT', 'ETHUSDT']); // 'btcusdc' does not end in USDT, so it's dropped
  });

  it('caps at the max watchlist length', () => {
    const many = Array.from({ length: DEFAULT_WORKFLOW.watchlist_max + 4 }, (_, i) => `SYM${i}USDT`);
    const { next, errors } = applyWorkflowPatch(base(), { watchlist: many });
    expect(errors).toEqual([]);
    expect(next.watchlist).toHaveLength(DEFAULT_WORKFLOW.watchlist_max);
    expect(next.watchlist).toEqual(many.slice(0, DEFAULT_WORKFLOW.watchlist_max));
  });

  it('errors when the array is not an array', () => {
    const { errors, next } = applyWorkflowPatch(base(), { watchlist: 'BTCUSDT' });
    expect(errors).toEqual(['watchlist 必须是数组']);
    expect(next.watchlist).toEqual(DEFAULT_WORKFLOW.watchlist);
  });

  it('errors when nothing survives the USDT-perp filter', () => {
    const { errors } = applyWorkflowPatch(base(), { watchlist: ['btc', 'eth-perp', ''] });
    expect(errors).toEqual(['watchlist 至少一个 USDT 永续,如 BTCUSDT']);
  });
});

describe('applyWorkflowPatch: timeframe', () => {
  it('accepts a listed timeframe', () => {
    const { next, errors } = applyWorkflowPatch(base(), { timeframe: '1h' });
    expect(errors).toEqual([]);
    expect(next.timeframe).toBe('1h');
  });

  it('rejects an unlisted timeframe', () => {
    const { errors, next } = applyWorkflowPatch(base(), { timeframe: '2h' });
    expect(errors).toEqual([`timeframe 只能是 ${WORKFLOW_BOUNDS.timeframes.join('/')}`]);
    expect(next.timeframe).toBe(DEFAULT_WORKFLOW.timeframe);
  });
});

describe('applyWorkflowPatch: info_every_ms', () => {
  it('clamps to the minimum (5 minutes)', () => {
    const { next } = applyWorkflowPatch(base(), { info_every_ms: 1000 });
    expect(next.info_every_ms).toBe(WORKFLOW_BOUNDS.info_every_ms[0]);
  });

  it('clamps to the maximum (6 hours)', () => {
    const { next } = applyWorkflowPatch(base(), { info_every_ms: 999 * 3_600_000 });
    expect(next.info_every_ms).toBe(WORKFLOW_BOUNDS.info_every_ms[1]);
  });

  it('rounds a fractional in-range value', () => {
    const { next } = applyWorkflowPatch(base(), { info_every_ms: 600_000.7 });
    expect(next.info_every_ms).toBe(600_001);
  });
});

describe('applyWorkflowPatch: daily_loss_stop_pct', () => {
  it('clamps to [0.5, 20] and rounds to one decimal', () => {
    expect(applyWorkflowPatch(base(), { daily_loss_stop_pct: 0.01 }).next.daily_loss_stop_pct).toBe('0.5');
    expect(applyWorkflowPatch(base(), { daily_loss_stop_pct: 999 }).next.daily_loss_stop_pct).toBe('20');
    expect(applyWorkflowPatch(base(), { daily_loss_stop_pct: 3.456 }).next.daily_loss_stop_pct).toBe('3.5');
  });
});

describe('applyWorkflowPatch: max_open_threads / max_opens_per_day', () => {
  it('clamps max_open_threads to [1, 6]', () => {
    expect(applyWorkflowPatch(base(), { max_open_threads: 0 }).next.max_open_threads).toBe(1);
    expect(applyWorkflowPatch(base(), { max_open_threads: 99 }).next.max_open_threads).toBe(6);
  });

  it('clamps max_opens_per_day to [1, 12]', () => {
    expect(applyWorkflowPatch(base(), { max_opens_per_day: 0 }).next.max_opens_per_day).toBe(1);
    expect(applyWorkflowPatch(base(), { max_opens_per_day: 99 }).next.max_opens_per_day).toBe(12);
  });
});

describe('applyWorkflowPatch: margin_mode', () => {
  it('accepts cross and isolated', () => {
    expect(applyWorkflowPatch(base(), { margin_mode: 'isolated' }).next.margin_mode).toBe('isolated');
    expect(applyWorkflowPatch(base(), { margin_mode: 'cross' }).next.margin_mode).toBe('cross');
  });

  it('rejects anything else', () => {
    const { errors } = applyWorkflowPatch(base(), { margin_mode: 'yolo' });
    expect(errors).toEqual(['margin_mode 只能是 cross/isolated']);
  });
});

describe('applyWorkflowPatch: brain / cheap_brain', () => {
  it('accepts pi/claude/stub for both fields', () => {
    const { next, errors } = applyWorkflowPatch(base(), { brain: 'claude', cheap_brain: 'stub' });
    expect(errors).toEqual([]);
    expect(next.brain).toBe('claude');
    expect(next.cheap_brain).toBe('stub');
  });

  it('rejects an unknown brain', () => {
    const { errors } = applyWorkflowPatch(base(), { brain: 'gpt5' });
    expect(errors).toEqual(['brain 只能是 pi/claude/codex/stub']);
  });
});

describe('applyWorkflowPatch: playbook_text', () => {
  it('accepts a string within the max length', () => {
    const { next, errors } = applyWorkflowPatch(base(), { playbook_text: 'short playbook' });
    expect(errors).toEqual([]);
    expect(next.playbook_text).toBe('short playbook');
  });

  it('truncates to the max char count', () => {
    const long = 'x'.repeat(WORKFLOW_BOUNDS.playbook_max_chars + 500);
    const { next, errors } = applyWorkflowPatch(base(), { playbook_text: long });
    expect(errors).toEqual([]);
    expect(next.playbook_text).toHaveLength(WORKFLOW_BOUNDS.playbook_max_chars);
  });

  it('errors on a non-string value', () => {
    const { errors } = applyWorkflowPatch(base(), { playbook_text: 12345 });
    expect(errors).toEqual(['playbook_text 必须是字符串']);
  });
});

describe('applyWorkflowPatch: booleans', () => {
  it('auto_approve accepts true/false', () => {
    expect(applyWorkflowPatch(base(), { auto_approve: false }).next.auto_approve).toBe(false);
    expect(applyWorkflowPatch(base(), { auto_approve: true }).next.auto_approve).toBe(true);
  });

  it('auto_approve errors on a non-boolean', () => {
    const { errors } = applyWorkflowPatch(base(), { auto_approve: 'yes' });
    expect(errors).toEqual(['auto_approve 必须是布尔']);
  });

  it('paused accepts true/false', () => {
    expect(applyWorkflowPatch(base(), { paused: true }).next.paused).toBe(true);
  });

  it('paused errors on a non-boolean', () => {
    const { errors } = applyWorkflowPatch(base(), { paused: 1 });
    expect(errors).toEqual(['paused 必须是布尔']);
  });
});

describe('applyWorkflowPatch: multiple errors accumulate and updated_at always advances', () => {
  it('collects one error per bad field', () => {
    const { errors } = applyWorkflowPatch(base(), { leverage: 'x', risk_pct: 'y', margin_mode: 'z', auto_approve: 'w' });
    expect(errors).toHaveLength(4);
  });

  it('sets updated_at even when there are errors (caller is expected to check errors, not updated_at)', () => {
    const before = base();
    const { next } = applyWorkflowPatch(before, { leverage: 'bogus' });
    expect(next.updated_at).toBeGreaterThanOrEqual(before.updated_at);
  });

  it('untouched fields in the patch are left as-is', () => {
    const { next } = applyWorkflowPatch(base(), { leverage: 7 });
    expect(next.risk_pct).toBe(DEFAULT_WORKFLOW.risk_pct);
    expect(next.watchlist).toEqual(DEFAULT_WORKFLOW.watchlist);
  });
});

describe('loadWorkflow', () => {
  it('returns the defaults when given undefined', () => {
    const w = loadWorkflow(undefined);
    expect(w.watchlist).toEqual(DEFAULT_WORKFLOW.watchlist);
    expect(w.risk_pct).toBe(DEFAULT_WORKFLOW.risk_pct);
    expect(w.updated_at).toBeGreaterThan(0);
  });

  it('returns the defaults on unparsable JSON', () => {
    const w = loadWorkflow('{not json');
    expect(w.watchlist).toEqual(DEFAULT_WORKFLOW.watchlist);
  });

  it('merges persisted fields over the defaults, keeping defaults for anything missing', () => {
    const persisted = JSON.stringify({ risk_pct: '1.5', leverage: 7 });
    const w = loadWorkflow(persisted);
    expect(w.risk_pct).toBe('1.5');
    expect(w.leverage).toBe(7);
    expect(w.watchlist).toEqual(DEFAULT_WORKFLOW.watchlist); // untouched field keeps the default
    expect(w.timeframe).toBe(DEFAULT_WORKFLOW.timeframe);
  });
});

// ---------------------------------------------------------------- v3 fields (docs/demo/v3-ui-contract.md §1)


describe('v3 workflow fields', () => {
  it('defaults: triggered mode, 30-minute heartbeat, 0.8% fast move, reviews only on events', () => {
    expect(DEFAULT_WORKFLOW.scan_mode).toBe('triggered');
    expect(DEFAULT_WORKFLOW.heartbeat_every_ms).toBe(30 * 60_000);
    expect(DEFAULT_WORKFLOW.fast_move_pct).toBe('0.8');
    expect(DEFAULT_WORKFLOW.review_every_close).toBe(false);
  });

  it('scan_mode accepts only the two modes', () => {
    expect(applyWorkflowPatch(base(), { scan_mode: 'every_close' }).next.scan_mode).toBe('every_close');
    const bad = applyWorkflowPatch(base(), { scan_mode: 'sometimes' });
    expect(bad.errors[0]).toMatch(/scan_mode/);
    expect(bad.next.scan_mode).toBe(base().scan_mode);
  });

  it('heartbeat and fast_move are clamped to their bounds', () => {
    expect(applyWorkflowPatch(base(), { heartbeat_every_ms: 1000 }).next.heartbeat_every_ms).toBe(5 * 60_000);
    expect(applyWorkflowPatch(base(), { fast_move_pct: 99 }).next.fast_move_pct).toBe('5');
    expect(applyWorkflowPatch(base(), { fast_move_pct: 'fast' }).errors[0]).toMatch(/fast_move_pct/);
  });

  it('a mixed patch keeps the valid fields in `next` and lists the invalid ones', () => {
    const r = applyWorkflowPatch(base(), { leverage: 5, review_every_close: 'yes', narrate: false });
    expect(r.next.leverage).toBe(5);
    expect(r.next.narrate).toBe(false);
    expect(r.errors).toEqual(['review_every_close 必须是布尔']);
  });

  it('estimateCallsPerHour: every_close = symbols × closes/hour; triggered = heartbeat + a trigger allowance', () => {
    const w = { ...base(), watchlist: ['A', 'B', 'C'], timeframe: '15m', scan_mode: 'every_close' as const };
    expect(estimateCallsPerHour(w)).toEqual({ min: 12, max: 12 });
    const t = { ...w, scan_mode: 'triggered' as const, heartbeat_every_ms: 30 * 60_000 };
    expect(estimateCallsPerHour(t)).toEqual({ min: 6, max: 18 });
  });
});

describe('applyWorkflowPatch: cli_commands(每台机器怎么启动 CLI)', () => {
  it('默认是裸命令名', () => {
    expect(DEFAULT_WORKFLOW.cli_commands).toEqual({ claude: 'claude', codex: 'codex', pi: 'pi' });
  });

  it('部分对象合法:只给 claude,其它保持不变(Jacky 的 claudeproxy 别名)', () => {
    const { next, errors } = applyWorkflowPatch(base(), { cli_commands: { claude: '  claudeproxy  ' } });
    expect(errors).toEqual([]);
    expect(next.cli_commands).toEqual({ claude: 'claudeproxy', codex: 'codex', pi: 'pi' });
  });

  it('带环境变量前缀的一整行也收', () => {
    const cmd = 'HTTP_PROXY=http://127.0.0.1:7897 ALL_PROXY=socks5://127.0.0.1:7897 claude';
    expect(applyWorkflowPatch(base(), { cli_commands: { claude: cmd } }).next.cli_commands.claude).toBe(cmd);
  });

  it('空 / 超长 / 带换行 / 非字符串都拒绝,并且不改动那一项', () => {
    const long = 'x'.repeat(WORKFLOW_BOUNDS.cli_command_max_chars + 1);
    const r = applyWorkflowPatch(base(), { cli_commands: { claude: '   ', codex: long, pi: 'pi\nrm -rf /' } });
    expect(r.errors).toHaveLength(3);
    expect(r.errors.every((e) => e.startsWith('cli_commands.'))).toBe(true);
    expect(r.next.cli_commands).toEqual(DEFAULT_WORKFLOW.cli_commands);
  });

  it('不认识的 CLI 名字被点名拒绝;非对象直接拒绝', () => {
    expect(applyWorkflowPatch(base(), { cli_commands: { gemini: 'g' } }).errors[0]).toMatch(/cli_commands\.gemini/);
    expect(applyWorkflowPatch(base(), { cli_commands: 'claudeproxy' }).errors[0]).toMatch(/cli_commands/);
  });

  it('cliCommandError 就是那条规则本身', () => {
    expect(cliCommandError('claude')).toBeNull();
    expect(cliCommandError('')).toMatch(/不能为空/);
    expect(cliCommandError(42)).toMatch(/字符串/);
    expect(cliCommandError('a\nb')).toMatch(/一行/);
  });

  it('loadWorkflow:老库没有这个字段 → 默认;半截对象 → 缺的那个补默认', () => {
    expect(loadWorkflow(JSON.stringify({ leverage: 5 })).cli_commands).toEqual(DEFAULT_WORKFLOW.cli_commands);
    const half = loadWorkflow(JSON.stringify({ cli_commands: { claude: 'claudeproxy' } }));
    expect(half.cli_commands).toEqual({ claude: 'claudeproxy', codex: 'codex', pi: 'pi' });
    const bad = loadWorkflow(JSON.stringify({ cli_commands: { claude: '', codex: 'codex', pi: 'pi' } }));
    expect(bad.cli_commands.claude).toBe('claude');
  });
});
