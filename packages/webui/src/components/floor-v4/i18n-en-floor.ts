/**
 * 楼层 v4 英文词条(挂在 src/lib/i18n-en.ts 的 EN 上)。
 * 外壳(页面 / 卡片 / 快照 / 派活表 / 适配层)在本文件;两套引擎各一份子表。
 */
import { FLOOR_EN_A } from './i18n-en-floor-a';
import { FLOOR_EN_B } from './i18n-en-floor-b';

const FLOOR_EN_SHELL: Record<string, string> = {
  '楼层(旧)': 'Floor (legacy)',
  '加一个币到顶栏': 'Add a coin to the top bar',
  '最多 {n} 个,拖给 agent 派活': 'Up to {n}; drag one onto an agent to assign work',
  '顶栏满了(最多 {n} 个),先删一个': 'Top bar is full (max {n}); remove one first',
  '加载币种…': 'Loading symbols…',
  '{symbol} 议会:{a}/{r} 同意{dir}': '{symbol} council: {a}/{r} agree {dir}',
  '{symbol} 议会:没有共识({a}/{r})': '{symbol} council: no consensus ({a}/{r})',
  '拖给 RADAR / THREAD / LAB · 拖到别的币上排序': 'Drag to RADAR / THREAD / LAB · drop on another coin to reorder',
  '把币拖给 RADAR / THREAD / LAB;拖到别的币上排序': 'Drag a coin to RADAR / THREAD / LAB; drop on another coin to reorder',
  '从顶栏移除': 'Remove from top bar',
  '从顶栏移除 {s}': 'Remove {s} from top bar',
  '加一个币(最多 {n} 个)': 'Add a coin (max {n})',
  '加一个币': 'Add a coin',
  '音效:开(点一下关)': 'Sound: on (click to mute)',
  '音效:关(点一下开)': 'Sound: off (click to enable)',
  '音效开': 'Sound on',
  '音效关': 'Sound off',
  '顶栏「当前策略」可切换': 'Switch it from “Current strategy” in the top bar',
  'agent 按 playbook 自由判断': 'Agent judges freely by its playbook',
  '没在运行': 'not running',
  // §9.55 楼层对话框
  '判断桌 · Jev 实盘判断': 'judgment desk · live Jev calls',
  '读': 'Read',
  '你来点': 'You click',
  '网关还没提供这个 agent 的循环信息(/api/agents 未就绪)': 'The gateway doesn\'t expose this agent\'s loop yet (/api/agents not ready)',
  '下次': 'Next',
  '{s} 后': 'in {s}',
  '马上': 'now',
  '事件触发 / 算不出': 'event-driven / unknown',
  '切到 {c} 的对话': 'Switch to the chat with {c}',
  '最近运行': 'Recent runs',
  '我是谁': 'Who I am',
  '我负责': 'What I own',
  '我不负责(找谁)': 'Not mine (who to ask)',
  '红线': 'Red lines',
  '我能调的工具': 'My tools',
  '口径': 'Conventions',
  '网关还没提供 AGENT.md': 'The gateway doesn\'t expose AGENT.md yet',
  '和 {c} 对话': 'Chat with {c}',
  '循环': 'Loop',
  '身份': 'Identity',
  '同一条对话,在 Agent 页全屏看': 'Same conversation, full screen on the Agent page',
  '在 Agent 页打开': 'Open on Agent page',
  '回你消息': 'Replying to you',
  '回你了': 'Replied',
  '{c} 回你了': '{c} replied to you',
  // PM 对话框:仓位倍率生效模式(workflow.sizing_agent)
  '仓位倍率生效模式': 'Sizing multiplier mode',
  '生效': 'Apply',
  '不调用仓位模型,按基础风险下单': 'No sizing model; orders use the base risk budget',
  '每次开仓给一个倍率,只记录不生效': 'Suggests a multiplier per entry; logged only, not applied',
  '基础风险 × 0.25–2 倍率 + 拆单建议,数量仍由代码算': 'Base risk × 0.25–2 multiplier + split hint; quantity is still computed by code',
  '公网演示模式访客只读,只有所有者能切换': 'Read-only for visitors in the public demo; only the owner can change this',
  '读不到当前仓位模式': 'Couldn’t read the current sizing mode',
  '仓位模式没生效': 'Sizing mode was not applied',
  '仓位模式已切到「{m}」': 'Sizing mode set to “{m}”',
  '仓位模式切换失败': 'Failed to change sizing mode',
};

export const FLOOR_EN: Record<string, string> = { ...FLOOR_EN_A, ...FLOOR_EN_B, ...FLOOR_EN_SHELL };
