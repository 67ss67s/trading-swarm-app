import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Brain } from '../../../src/demo/brain.js';
import { openStateDb } from '../../../src/state-db.js';
import { runReplay } from '../../../src/demo/research/engine.js';
import { ResearchService } from '../../../src/demo/research/service.js';
import { ResearchStore } from '../../../src/demo/research/store.js';
import { researchChat } from '../../../src/demo/research/tools.js';
import { fixture, params, study } from './fixtures.js';

type Event = { chat_id: string; seq: number; at: number; event: string; data: Record<string, unknown> };
type Step = unknown | ((user: string) => unknown);
const identity = { kind: 'stub' as const, model: null, name: 'chat-test', configuration_hash: 'chat-test' };
const forbiddenLaunch = () => { throw Error('chat_must_not_launch_experiment'); };

function scriptedBrain(steps: Step[]): Brain {
  let index = 0;
  return {
    name: 'scripted-chat',
    async complete(_system, user) {
      if (index >= steps.length) throw Error('unexpected_model_call');
      const step = steps[index++];
      const output = typeof step === 'function' ? step(user) : step;
      return { text: JSON.stringify(output), latency_ms: 0, model: 'stub', input_tokens: 0, output_tokens: 0 };
    },
  };
}

async function withChat(fn: (store: ResearchStore, service: ResearchService, root: string) => Promise<void>) {
  const state = openStateDb(':memory:');
  const root = mkdtempSync('/tmp/research-chat-loop-');
  try {
    const store = new ResearchStore(state.db);
    await fn(store, new ResearchService(store), root);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe('研究 chat 沙箱循环、产物和断线恢复', () => {
  it('exports a run, repairs a failed script, persists artifacts and immutable ordered SSE events', () => withChat(async (store, service, root) => {
    const data = fixture();
    const datasetId = store.putDataset(data).id;
    store.putStudy(study(datasetId));
    const row = store.create({ ...params(datasetId), arms: ['a_rules'] }, null, identity, '');
    const result = await runReplay(data, row.manifest.request, async () => { throw Error('no_model'); });
    store.status(row.id, 'completed', result);
    const events: Event[] = [];
    const artifacts: string[] = [];
    const script = [
      "import {readFileSync,writeFileSync} from 'node:fs';",
      "const run=JSON.parse(readFileSync('run.json','utf8'));",
      "const dataset=JSON.parse(readFileSync('dataset.json','utf8'));",
      "const equity=JSON.parse(readFileSync('arms/a_rules:0/equity.json','utf8'));",
      "writeFileSync('chart.json',JSON.stringify({kind:'chart',type:'line',title:'权益核对',x:'time',series:[{name:'A',points:equity.map(x=>[x.at,Number(x.equity)])}],y_label:'USDT',note:'由导出权益逐点验证'}));",
      "writeFileSync('report.md','# 诊断报告\\n样本数：'+dataset.bars.length+'\\n下一次实验：提高 ATR 倍数，验证成本门。');",
      "console.log(JSON.stringify({run_id:run.id,bars:dataset.bars.length,points:equity.length}));",
    ].join('\n');
    const brain = scriptedBrain([
      { task: '检查文件', tool: 'research.list_files', args: {} },
      { task: '读取字段说明', tool: 'research.read_file', args: { path: 'README.md' } },
      { task: '读取冻结实验', tool: 'research.read_file', args: { path: 'run.json' } },
      { task: '写入验证脚本', tool: 'research.write_file', args: { path: 'analysis.mjs', content: "throw Error('deliberate_script_failure');" } },
      { task: '执行初稿', tool: 'research.execute', args: { path: 'analysis.mjs', timeout_ms: 2000 } },
      (user: string) => {
        expect(user).toContain('deliberate_script_failure');
        return { task: '修复脚本', tool: 'research.write_file', args: { path: 'analysis.mjs', content: script } };
      },
      { task: '验证修复', tool: 'research.execute', args: { path: 'analysis.mjs', timeout_ms: 2000 } },
      { task: '保存权益图', tool: 'research.register_artifact', args: { path: 'chart.json', kind: 'chart', title: '权益核对' } },
      { task: '保存诊断报告', tool: 'research.register_artifact', args: { path: 'report.md', kind: 'markdown', title: '诊断报告' } },
      () => ({ final: `已执行脚本验证。[[artifact:${artifacts[0]}]] [[artifact:${artifacts[1]}]] 下一次提高 ATR 倍数验证成本门。` }),
    ]);
    const chat = await researchChat({ run_id: row.id, message: '验证权益并生成诊断报告', max_rounds: 24 }, service, brain, forbiddenLaunch, {
      root,
      emit(value) {
        const event = structuredClone(value) as Event;
        events.push(event);
        if (event.event === 'artifact') artifacts.push(String(event.data['id']));
      },
    });

    expect(chat.status).toBe('completed');
    expect(chat.error).toBeNull();
    expect(chat.trace).toHaveLength(9);
    expect(chat.tasks).toHaveLength(10);
    expect(chat.artifacts).toHaveLength(2);
    const files = (chat.trace[0]!.result as { files: string[] }).files;
    expect(files).toEqual(expect.arrayContaining(['README.md', 'run.json', 'dataset.json', 'arms/a_rules:0/trades.json', 'arms/a_rules:0/decisions.json', 'arms/a_rules:0/equity.json']));
    expect(JSON.parse(readFileSync(join(root, chat.id, 'run.json'), 'utf8')).manifest).toEqual(row.manifest);
    expect(chat.trace[4]!.result).toMatchObject({ path: 'analysis.mjs', exit_code: 1, stderr_tail: expect.stringContaining('deliberate_script_failure'), duration_ms: expect.any(Number) });
    expect(chat.trace[6]!.result).toMatchObject({ exit_code: 0, stdout_tail: expect.stringContaining('"bars":420') });
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.every(event => event.chat_id === chat.id && Number.isInteger(event.at))).toBe(true);
    expect(events.at(-1)?.event).toBe('final');
    expect(events.filter(event => event.event === 'tool').every(event => chat.tasks.some(task => task.id === event.data['task_id']))).toBe(true);

    const saved = store.getChat(chat.id);
    expect(saved).toMatchObject({ id: chat.id, status: 'completed', trace: chat.trace, tasks: chat.tasks, artifacts: chat.artifacts, final: chat.final });
    expect(saved['events']).toEqual(events);
    expect((saved['events'] as Event[])[0]!.data['status']).toBe('running');
    expect(chat.tasks[0]!.status).toBe('done');
    const chart = store.artifact(artifacts[0]!);
    expect(chart).toMatchObject({ chat_id: chat.id, run_id: row.id, kind: 'chart', title: '权益核对', created_at: expect.any(Number) });
    expect(chart.content).toMatchObject({ kind: 'chart', series: [{ name: 'A', points: result.arms[0]!.equity.map(point => [point.at, Number(point.equity)]) }] });
    expect(store.artifact(artifacts[1]!).content).toContain('样本数：420');
    expect(chat.final).toContain(`[[artifact:${chart.id}]]`);
  }));

  it.each([false, true])('rejects a final numeric conclusion without a successful script execution (failed attempt: %s)', attempted => withChat(async (store, service, root) => {
    const unsupported = '平均收益 99%，验证成功。';
    const steps = [
      ...(attempted ? [
        { task: '写入错误脚本', tool: 'research.write_file', args: { path: 'bad.mjs', content: "throw Error('no_verified_numbers');" } },
        { task: '执行错误脚本', tool: 'research.execute', args: { path: 'bad.mjs', timeout_ms: 2000 } },
      ] : []),
      { final: unsupported },
    ];
    const chat = await researchChat({ message: '给出研究结论', max_rounds: steps.length }, service, scriptedBrain(steps), forbiddenLaunch, { root });
    expect(chat.final).not.toBe(unsupported);
    expect(chat.final).toContain('尚无完整结论');
    expect(chat.trace).toHaveLength(steps.length);
    expect(chat.trace.at(-1)!.result).toMatchObject({ error: expect.stringContaining('先执行脚本验证') });
    expect(chat.tasks.at(-1)!.status).toBe('failed');
    expect(store.getChat(chat.id)).toMatchObject({ final: chat.final, trace: chat.trace, artifacts: [] });
  }));

  it('persists completed tool work and an error event when the model fails mid-loop', () => withChat(async (store, service, root) => {
    const events: Event[] = [];
    const brain = scriptedBrain([
      { task: '检查文件', tool: 'research.list_files', args: {} },
      () => { throw Error('model_disconnected_mid_loop'); },
    ]);
    const chat = await researchChat({ message: '继续研究', max_rounds: 24 }, service, brain, forbiddenLaunch, { root, emit: event => events.push(structuredClone(event) as Event) });
    expect(chat).toMatchObject({ status: 'failed', error: 'model_disconnected_mid_loop' });
    expect(chat.trace).toHaveLength(1);
    expect(chat.tasks[0]!.status).toBe('done');
    expect(events.at(-1)).toMatchObject({ event: 'error', data: { error: 'model_disconnected_mid_loop' } });
    expect(store.getChat(chat.id)).toMatchObject({ status: 'failed', error: chat.error, trace: chat.trace, tasks: chat.tasks, artifacts: [], events });
  }));
});
