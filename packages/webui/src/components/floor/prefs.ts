/**
 * 楼层外观偏好:配色预设 + 每个角色的像素人体型/颜色。存 localStorage(纯本机、纯展示,
 * 不进网关、不影响任何交易语义)。设置页「楼层外观」写,楼层页读;跨组件用
 * useSyncExternalStore 订阅,同标签页内改完立即生效。
 *
 * 文案的中英切换由顶栏的语言开关(lib/i18n.ts)负责,这里的 label / hint 一律写中文原文,
 * 渲染处再 t();旧版本存过的 `tone` 字段已废弃,读到直接忽略。
 */
import { useSyncExternalStore } from 'react';
import type { BotRole } from './types';
import { SCENES, isScene, type FloorScene } from './scenes';

export type FloorPalette = 'terminal' | 'amber' | 'ice' | 'paper' | 'wood' | 'neon';
export type SpriteShape = 'blob' | 'tall' | 'wide' | 'boxy' | 'cat' | 'bot';

export interface RoleLook {
  shape?: SpriteShape;
  color?: string;
}

export interface FloorPrefs {
  /** 楼层场景(scenes.ts 三个方向);切场景会一并把 palette 切到场景推荐色 */
  scene: FloorScene;
  palette: FloorPalette;
  looks: Partial<Record<BotRole, RoleLook>>;
}

export const DEFAULT_PREFS: FloorPrefs = { scene: 'command', palette: 'terminal', looks: {} };

export const PALETTES: Record<FloorPalette, { label: string; hint: string; vars: Record<string, string> }> = {
  terminal: {
    label: '终端绿',
    hint: '黑底荧光绿,像老终端',
    vars: { '--of-bg': '#0b0d0b', '--of-panel': '#111411', '--of-panel-2': '#161a16', '--of-line': '#232823', '--of-ink': '#e8e6df', '--of-ink-dim': '#8d948a', '--of-ink-faint': '#5a615a', '--of-accent': '#9be15d', '--of-warn': '#ffd166', '--of-danger': '#ff5d8f', '--of-info': '#5ec8ff', '--of-desk': '#2a2418', '--of-desk-2': '#1b1710', '--of-desk-line': '#3a3222' },
  },
  amber: {
    label: '琥珀',
    hint: '暖黑底配琥珀,老式行情屏',
    vars: { '--of-bg': '#0e0c09', '--of-panel': '#151210', '--of-panel-2': '#1c1814', '--of-line': '#2b251c', '--of-ink': '#efe6d6', '--of-ink-dim': '#9c917f', '--of-ink-faint': '#635a4c', '--of-accent': '#f5b544', '--of-warn': '#ffd166', '--of-danger': '#ff6b6b', '--of-info': '#7dd3fc', '--of-desk': '#2e2416', '--of-desk-2': '#1d1710', '--of-desk-line': '#443622' },
  },
  ice: {
    label: '冰蓝',
    hint: '和主站冷灰蓝同调,最不扎眼',
    vars: { '--of-bg': '#0f1217', '--of-panel': '#151a21', '--of-panel-2': '#1a2029', '--of-line': '#242c37', '--of-ink': '#e6ebf2', '--of-ink-dim': '#8b96a6', '--of-ink-faint': '#56606e', '--of-accent': '#7cd4fd', '--of-warn': '#f4c66b', '--of-danger': '#ff7a90', '--of-info': '#9bb8ff', '--of-desk': '#252b35', '--of-desk-2': '#191e26', '--of-desk-line': '#333c4a' },
  },
  wood: {
    label: '暖木',
    hint: '夜景暖灯、木地板,配研究楼层',
    vars: { '--of-bg': '#14100c', '--of-panel': '#1c1610', '--of-panel-2': '#241c14', '--of-line': '#3a2e20', '--of-ink': '#f3e9d8', '--of-ink-dim': '#a8987f', '--of-ink-faint': '#6b5d4a', '--of-accent': '#ffb454', '--of-warn': '#ffd166', '--of-danger': '#ff6b6b', '--of-info': '#7fd1c8', '--of-desk': '#5a3d22', '--of-desk-2': '#3d2916', '--of-desk-line': '#7a5530' },
  },
  neon: {
    label: '霓虹',
    hint: '深紫黑底配青 / 品红,配霓虹实验室',
    vars: { '--of-bg': '#0a0612', '--of-panel': '#120b1e', '--of-panel-2': '#1a1028', '--of-line': '#2e1f45', '--of-ink': '#f1e9ff', '--of-ink-dim': '#9c8bbf', '--of-ink-faint': '#5d4f7a', '--of-accent': '#39f0ff', '--of-warn': '#ffd166', '--of-danger': '#ff3ec9', '--of-info': '#b78cff', '--of-desk': '#2a1b45', '--of-desk-2': '#1b1130', '--of-desk-line': '#4a2f78' },
  },
  paper: {
    label: '纸面',
    hint: '浅色,像打印出来的值班表',
    vars: { '--of-bg': '#f4f1ea', '--of-panel': '#fbf9f4', '--of-panel-2': '#efeae0', '--of-line': '#d8d2c4', '--of-ink': '#22201c', '--of-ink-dim': '#6b665c', '--of-ink-faint': '#a39d90', '--of-accent': '#2f8f4e', '--of-warn': '#b7791f', '--of-danger': '#c53d5e', '--of-info': '#2b6cb0', '--of-desk': '#d9cdb5', '--of-desk-2': '#c9bb9f', '--of-desk-line': '#b9a98a' },
  },
};

export const SHAPES: Record<SpriteShape, { label: string; rows: string[] }> = {
  blob: { label: '圆头', rows: ['....####....', '...######...', '..########..', '.##h#eeh#e#.', '.####ee####.', '.##########.', '..##.##.##..', '.###.##.###.', '.##..##..##.', '....#..#....', '...##..##...', '..##....##..'] },
  tall: { label: '高个', rows: ['....####....', '...######...', '...#e##e#...', '...######...', '....####....', '..########..', '.##########.', '.##.####.##.', '.##.####.##.', '....####....', '....#..#....', '...##..##...'] },
  wide: { label: '外星', rows: ['..........', '.##....##.', '..##..##..', '.########.', '##e####e##', '##########', '#.######.#', '#.#....#.#', '...#..#...', '..##..##..', '.##....##.', '..........'].map((r) => r.padEnd(12, '.')) },
  boxy: { label: '方块', rows: ['.##########.', '.#h########.', '.##e####e##.', '.##########.', '.###.##.###.', '.####..####.', '.##########.', '..########..', '...##..##...', '...##..##...', '..###..###..', '............'] },
  cat: { label: '猫', rows: ['.#........#.', '.##......##.', '.###....###.', '.##########.', '.#e######e#.', '.##########.', '.####.#####.', '..########..', '...######...', '..##.##.##..', '..##.##.##..', '............'] },
  bot: { label: '机器人', rows: ['.....##.....', '.....##.....', '..########..', '.#h########.', '.#e######e#.', '.##########.', '.###....###.', '.##########.', '..##.##.##..', '.###.##.###.', '.##..##..##.', '............'] },
};

export const SPRITE_COLORS = ['#ff7a5c', '#9be15d', '#c98bff', '#5ec8ff', '#ffd166', '#f4a261', '#ff5d8f', '#4fd1c5', '#e8e6df', '#a3e635', '#fb7185', '#60a5fa'];

const KEY = 'tg.floor.prefs.v1';
const listeners = new Set<() => void>();
let cache: FloorPrefs | null = null;

function read(): FloorPrefs {
  if (cache) return cache;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<FloorPrefs>;
      // 逐字段校验:旧版本 / 手改过的 localStorage 里可能有不认识的配色或体型,直接用会让整页崩成黑屏
      const scene: FloorScene = isScene(p.scene) ? p.scene : DEFAULT_PREFS.scene;
      const palette: FloorPalette = p.palette && p.palette in PALETTES ? p.palette : SCENES[scene].palette;
      const looks: FloorPrefs['looks'] = {};
      if (p.looks && typeof p.looks === 'object') {
        for (const [role, look] of Object.entries(p.looks)) {
          if (!look || typeof look !== 'object') continue;
          const shape = (look as RoleLook).shape;
          const color = (look as RoleLook).color;
          const clean: RoleLook = {};
          if (shape && shape in SHAPES) clean.shape = shape;
          if (typeof color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(color)) clean.color = color;
          looks[role as BotRole] = clean;
        }
      }
      cache = { scene, palette, looks };
      return cache;
    }
  } catch {
    /* 没有 storage 或坏数据:回默认 */
  }
  cache = DEFAULT_PREFS;
  return cache;
}

export function getFloorPrefs(): FloorPrefs {
  return read();
}

export function setFloorPrefs(next: FloorPrefs): void {
  cache = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 私密模式等:只在内存里生效 */
  }
  listeners.forEach((l) => l());
}

export function updateFloorPrefs(fn: (p: FloorPrefs) => FloorPrefs): void {
  setFloorPrefs(fn(read()));
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      cache = null;
      l();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener('storage', onStorage);
  };
}

export function useFloorPrefs(): FloorPrefs {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_PREFS);
}

/** 切场景:同时把配色切到场景推荐色(之后仍可单独改配色) */
export function setFloorScene(scene: FloorScene): void {
  updateFloorPrefs((s) => ({ ...s, scene, palette: SCENES[scene].palette }));
}

export function paletteStyle(p: FloorPalette): Record<string, string> {
  return PALETTES[p].vars;
}
