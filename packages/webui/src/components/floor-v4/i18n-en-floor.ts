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
};

export const FLOOR_EN: Record<string, string> = { ...FLOOR_EN_A, ...FLOOR_EN_B, ...FLOOR_EN_SHELL };
