/**
 * 主题 = 调色板 + 道具集 + 窗景。三套共用同一布局与引擎。
 */
import { t } from '@/lib/i18n';
import type { ThemeId } from './types';

export type WallSegKind = 'window' | 'shelf' | 'screen' | 'poster' | 'neon' | 'toys';
export interface WallSeg {
  kind: WallSegKind;
  x: number;
  w: number;
  text?: string[];
}

export interface ThemePalette {
  outline: string;
  ceiling: string;
  wall: string;
  wallHi: string;
  wallDark: string;
  trim: string;
  trimHi: string;
  floorA: string;
  floorB: string;
  floorLine: string;
  floorHi: string;
  rug: string;
  rugDark: string;
  rugEdge: string;
  runner: string;
  runnerEdge: string;
  deskTop: string;
  deskTopHi: string;
  deskFront: string;
  deskFrontDark: string;
  deskEdge: string;
  chair: string;
  chairHi: string;
  monFrame: string;
  monFrameHi: string;
  screen: string;
  screenLine: string;
  table: string;
  tableHi: string;
  tableDark: string;
  holo: string;
  holoDim: string;
  shelf: string;
  shelfDark: string;
  books: string[];
  plant: string;
  plantHi: string;
  plantDark: string;
  pot: string;
  potDark: string;
  lamp: string;
  lampLight: string;
  neonA: string;
  neonB: string;
  sofa: string;
  sofaHi: string;
  sofaDark: string;
  metal: string;
  metalHi: string;
  metalDark: string;
  text: string;
  textDim: string;
  up: string;
  down: string;
  warn: string;
  /** 夜色压暗层(rgba) */
  night: string;
}

export interface Theme {
  id: ThemeId;
  name: string;
  desc: string;
  ui: Record<string, string>;
  c: ThemePalette;
  floor: 'wood' | 'metal' | 'neon';
  wall: WallSeg[];
  win: { sky: string[]; far: string; near: string; nearHi: string; lit: string[]; rain: boolean; moon: string | null; blimp: boolean; stars: boolean };
  pet: { kind: 'cat' | 'corgi'; body: string; dark: string; belly: string };
  lights: 'lamp' | 'screen' | 'neon';
  /** 进化方格四色:好/一般/差/无 */
  evo: { good: string; ok: string; bad: string; none: string };
}

export const THEMES: Record<ThemeId, Theme> = {
  lab: {
    id: 'lab',
    get name() {
      return t('夜间研究所');
    },
    get desc() {
      return t('暖木书房 · 台灯 · 窗外夜雨');
    },
    ui: { '--bg': '#120d09', '--panel': '#1b140e', '--panel2': '#231a12', '--line': '#3a2c1d', '--ink': '#f3e9d8', '--dim': '#a8987f', '--faint': '#6b5d4a', '--accent': '#ffb454', '--up': '#8fd46a', '--down': '#ff6b6b', '--warn': '#ffd166', '--stage': '#0d0906' },
    c: {
      outline: '#140c07', ceiling: '#1a110a', wall: '#4a2e1b', wallHi: '#5e3b22', wallDark: '#321e11', trim: '#6e4526', trimHi: '#8e5c33',
      floorA: '#6b4225', floorB: '#5c381f', floorLine: '#3e2413', floorHi: '#80522e',
      rug: '#6e1f22', rugDark: '#511519', rugEdge: '#c98f45', runner: '#5a1a1c', runnerEdge: '#a8783b',
      deskTop: '#8a5a32', deskTopHi: '#a8703f', deskFront: '#5e3a1f', deskFrontDark: '#452913', deskEdge: '#2a180b',
      chair: '#2a1d14', chairHi: '#3d2b1e', monFrame: '#221b17', monFrameHi: '#3b302a', screen: '#0d1a14', screenLine: '#1c3a2a',
      table: '#7a4a28', tableHi: '#9a6436', tableDark: '#4f2e17', holo: '#ffcf7a', holoDim: '#a8702e',
      shelf: '#4a2c17', shelfDark: '#2e1a0c', books: ['#8b2d2d', '#2f5d50', '#b88a3e', '#3b4a7a', '#6d3b6b', '#9c5a2a', '#d8c7a0', '#4f6b2e'],
      plant: '#3f7a3a', plantHi: '#6aa84f', plantDark: '#244a22', pot: '#9c4f2c', potDark: '#6b3319',
      lamp: '#e8b04a', lampLight: 'rgba(255,190,110,1)', neonA: '#ffb454', neonB: '#ff7a5c',
      sofa: '#2f5a3a', sofaHi: '#3f7449', sofaDark: '#1e3b26', metal: '#6b5a4a', metalHi: '#9c8870', metalDark: '#3a3028',
      text: '#f3e0b8', textDim: '#b89468', up: '#8fd46a', down: '#ff6b6b', warn: '#ffd166', night: 'rgba(20,8,0,0.18)',
    },
    floor: 'wood',
    wall: [
      { kind: 'window', x: 66, w: 88 },
      { kind: 'shelf', x: 162, w: 94 },
      { kind: 'screen', x: 264, w: 112 },
      { kind: 'shelf', x: 384, w: 82 },
      { kind: 'poster', x: 474, w: 56, text: ['DISCIPLINE', 'COMPOUNDS'] },
      { kind: 'window', x: 538, w: 36 },
    ],
    win: { sky: ['#0c1030', '#141a44', '#1f2356', '#2c2a5e'], far: '#1a1c3a', near: '#10122a', nearHi: '#20244a', lit: ['#ffd27a', '#ffb454', '#fff1c4'], rain: true, moon: '#fff4d0', blimp: false, stars: true },
    pet: { kind: 'cat', body: '#e08a3c', dark: '#a45a1c', belly: '#f6d3a0' },
    lights: 'lamp',
    evo: { good: '#8fd46a', ok: '#e8c060', bad: '#e0604a', none: '#6a5640' },
  },
  command: {
    id: 'command',
    get name() {
      return t('指挥中心');
    },
    get desc() {
      return t('深蓝霓虹 · 全息地球 · 大屏行情');
    },
    ui: { '--bg': '#070b14', '--panel': '#0c1320', '--panel2': '#101a2b', '--line': '#1c2a42', '--ink': '#e2ecff', '--dim': '#8497b8', '--faint': '#4e5f7e', '--accent': '#5ef2c8', '--up': '#5ef2a0', '--down': '#ff5d7a', '--warn': '#ffd166', '--stage': '#050810' },
    c: {
      outline: '#03060c', ceiling: '#060a14', wall: '#12203a', wallHi: '#1a2c4e', wallDark: '#0b1528', trim: '#1f3558', trimHi: '#2e6fa8',
      floorA: '#15213a', floorB: '#111b30', floorLine: '#0a1222', floorHi: '#22355a',
      rug: '#5a1624', rugDark: '#420f1a', rugEdge: '#b33a4a', runner: '#0f2744', runnerEdge: '#3fd6ff',
      deskTop: '#243552', deskTopHi: '#34507a', deskFront: '#16233b', deskFrontDark: '#0e182b', deskEdge: '#070d18',
      chair: '#10151f', chairHi: '#1f2838', monFrame: '#0c1220', monFrameHi: '#243452', screen: '#04101c', screenLine: '#0f3350',
      table: '#1a2944', tableHi: '#2c4a74', tableDark: '#0d172a', holo: '#5ef2ff', holoDim: '#1f7fa8',
      shelf: '#16223a', shelfDark: '#0c1426', books: ['#1f6fb2', '#2bb8a0', '#5a6fd6', '#1c3f6e', '#3fd6ff', '#8a9bc0'],
      plant: '#2f7a5a', plantHi: '#4fbf86', plantDark: '#1a4a36', pot: '#2a3a5a', potDark: '#18243c',
      lamp: '#9fe8ff', lampLight: 'rgba(90,200,255,1)', neonA: '#3fd6ff', neonB: '#5ef2c8',
      sofa: '#1c1c26', sofaHi: '#2c2c3c', sofaDark: '#101018', metal: '#3a4a66', metalHi: '#6a82a8', metalDark: '#1c2638',
      text: '#bfe9ff', textDim: '#5f86b0', up: '#5ef2a0', down: '#ff5d7a', warn: '#ffd166', night: 'rgba(0,4,20,0.22)',
    },
    floor: 'metal',
    wall: [
      { kind: 'poster', x: 70, w: 88, text: ['TRADING', 'SWARM'] },
      { kind: 'window', x: 166, w: 94 },
      { kind: 'screen', x: 268, w: 104 },
      { kind: 'window', x: 380, w: 94 },
      { kind: 'poster', x: 482, w: 88, text: ['GOOD AGENTS', 'BETTER', 'MARKETS'] },
    ],
    win: { sky: ['#030814', '#06112a', '#0a1a3c', '#122750'], far: '#0b1a36', near: '#060e22', nearHi: '#10224a', lit: ['#5ec8ff', '#9fe8ff', '#ffd27a', '#5ef2c8'], rain: true, moon: null, blimp: false, stars: false },
    pet: { kind: 'cat', body: '#9aa6b8', dark: '#5f6a7c', belly: '#dfe6ee' },
    lights: 'screen',
    evo: { good: '#5ef2a0', ok: '#ffd166', bad: '#ff5d7a', none: '#3a4f74' },
  },
  meme: {
    id: 'meme',
    name: 'Meme Lab',
    get desc() {
      return t('粉紫霓虹 · 柯基打盹 · 飞艇');
    },
    ui: { '--bg': '#0d0616', '--panel': '#160b24', '--panel2': '#1e1030', '--line': '#3a1f55', '--ink': '#f6e9ff', '--dim': '#b59ad6', '--faint': '#6e5690', '--accent': '#ff4fd8', '--up': '#5effa8', '--down': '#ff5d7a', '--warn': '#ffe066', '--stage': '#08030f' },
    c: {
      outline: '#07020d', ceiling: '#0c0418', wall: '#2a1245', wallHi: '#3a1a5e', wallDark: '#1c0a32', trim: '#4a2070', trimHi: '#ff4fd8',
      floorA: '#24103c', floorB: '#1e0c34', floorLine: '#3d1a66', floorHi: '#3a1a5e',
      rug: '#3a0f3a', rugDark: '#28082a', rugEdge: '#ff4fd8', runner: '#2c0e44', runnerEdge: '#39f0ff',
      deskTop: '#2e1a4a', deskTopHi: '#48287a', deskFront: '#1c0f30', deskFrontDark: '#130a22', deskEdge: '#08030f',
      chair: '#140a1e', chairHi: '#2a1a3c', monFrame: '#120a1e', monFrameHi: '#3a2560', screen: '#0a0418', screenLine: '#2e1350',
      table: '#2a1644', tableHi: '#4a2878', tableDark: '#170b28', holo: '#ff7ae6', holoDim: '#8a2f9a',
      shelf: '#2a1245', shelfDark: '#190a2c', books: ['#ff4fd8', '#39f0ff', '#ffe066', '#8a5cff', '#ff7a5c', '#5effa8'],
      plant: '#2f8a5a', plantHi: '#5ed68a', plantDark: '#1a4a36', pot: '#ff4fd8', potDark: '#a02e8e',
      lamp: '#ff9af0', lampLight: 'rgba(255,90,220,1)', neonA: '#ff4fd8', neonB: '#39f0ff',
      sofa: '#1a1024', sofaHi: '#2c1c3c', sofaDark: '#0e0816', metal: '#4a2c6e', metalHi: '#8a5cc0', metalDark: '#241438',
      text: '#ffd6fa', textDim: '#a07ac8', up: '#5effa8', down: '#ff5d7a', warn: '#ffe066', night: 'rgba(20,0,30,0.16)',
    },
    floor: 'neon',
    wall: [
      { kind: 'window', x: 66, w: 90 },
      { kind: 'poster', x: 164, w: 64, text: ['GOOD', 'MEMES', 'BETTER', 'RETURNS'] },
      { kind: 'neon', x: 238, w: 164, text: ['MEME LAB'] },
      { kind: 'poster', x: 412, w: 64, text: ['DEPLOY', 'ANOTHER', 'ONE <3'] },
      { kind: 'toys', x: 486, w: 86 },
    ],
    win: { sky: ['#12042a', '#2a0a4a', '#4a1266', '#7a1f7a'], far: '#2a0f4a', near: '#16062a', nearHi: '#2e1250', lit: ['#ff4fd8', '#39f0ff', '#ffe066', '#b78cff'], rain: false, moon: '#ffe8a8', blimp: true, stars: true },
    pet: { kind: 'corgi', body: '#e89a4a', dark: '#b0662a', belly: '#fff0dc' },
    lights: 'neon',
    evo: { good: '#5effa8', ok: '#ffe066', bad: '#ff4f7a', none: '#553a7c' },
  },
};

export const THEME_ORDER: ThemeId[] = ['lab', 'command', 'meme'];

const KEY = 'tg.floor.v4.a.theme';
export function loadTheme(): ThemeId {
  try {
    const v = window.localStorage.getItem(KEY);
    if (v && v in THEMES) return v as ThemeId;
  } catch {
    /* 私密模式等 */
  }
  return 'lab';
}
export function saveTheme(id: ThemeId): void {
  try {
    window.localStorage.setItem(KEY, id);
  } catch {
    /* 忽略 */
  }
}
