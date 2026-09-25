/**
 * 楼层「场景」注册表(2026-09-07,来源 ~/Downloads/trading_swarm_pixel_ui_design.ipynb 的三个方向):
 *   command  — 方向 A「自主指挥中心」:石墨黑 + 终端绿,市场格 / 指挥核心 / 四张岗位桌,产品默认。
 *   research — 方向 B「研究楼层」:暖灯夜景木地板、书架、圆桌,偏情报 / 策略讨论。
 *   meme     — 方向 C「霓虹实验室」:青 / 品红霓虹,高波动感,给 demo / 传播用。
 *
 * 一个场景 = 一套推荐配色(prefs.PALETTES 里的 key)+ 一个根 class(`of-scene-<id>`,各自的 CSS 在
 * scene-<id>.css)+ 墙上分区文字。切场景只换视觉,不改任何数据 / 权限语义;桌位拓扑(roles.ts x/y)
 * 三个场景共用,场景 CSS 只能通过 `.of-scene-<id> .of-deck …` 这样的选择器改外观。
 */
import type { FloorPalette } from './prefs';

export type FloorScene = 'command' | 'research' | 'meme';

export interface SceneMeta {
  id: FloorScene;
  /** 中文原文;渲染处 t() 翻译(别在模块加载时冻住语言) */
  label: string;
  hint: string;
  /** 选中该场景时一并切到的配色;用户之后仍可在设置页单独换配色 */
  palette: FloorPalette;
  /** 墙上四段分区文字(左 / 右 / 上 / 下) */
  zones: { left: string; right: string; top: string; bottom: string };
}

export const SCENES: Record<FloorScene, SceneMeta> = {
  command: { id: 'command', label: '指挥中心', hint: '石墨黑配终端绿,岗位桌围着指挥核心', palette: 'terminal', zones: { left: '情报区', right: '研究区', top: '指挥区', bottom: '执行区' } },
  research: { id: 'research', label: '研究楼层', hint: '暖灯夜景,书架和圆桌', palette: 'wood', zones: { left: '情报角', right: '策略角', top: '圆桌', bottom: '执行角' } },
  meme: { id: 'meme', label: '霓虹实验室', hint: '青配品红霓虹,躁一点', palette: 'neon', zones: { left: 'SIGNALS', right: 'ALPHA', top: 'LAB', bottom: 'EXEC' } },
};

export const SCENE_ORDER: FloorScene[] = ['command', 'research', 'meme'];

export function isScene(v: unknown): v is FloorScene {
  return typeof v === 'string' && v in SCENES;
}
