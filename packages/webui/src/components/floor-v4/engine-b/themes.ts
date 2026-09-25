/**
 * 主题 = 调色板 + 道具集 + 窗景。三套共用同一座楼的布局与引擎。
 */
import type { ThemeId } from './types';

export interface Theme {
  id: ThemeId;
  name: string;
  /** 天空自上而下的色带(像素抖动过渡) */
  sky: string[];
  /** UTC 白天的天空 */
  skyDay: string[];
  stars: string;
  moon: string | null;
  rain: boolean;
  searchlights: boolean;
  blimp: boolean;
  cityFar: string;
  cityNear: string;
  cityWin: string[];
  /** 外立面 */
  facade: { base: string; dark: string; light: string; trim: string; pattern: 'brick' | 'panel' | 'tile' };
  slab: { top: string; face: string; dark: string };
  /** 室内墙 */
  wall: { a: string; b: string; dark: string; pattern: 'wood' | 'grid' | 'stripe' };
  floorBoard: string;
  lampStyle: 'lamp' | 'strip' | 'neon';
  /** 灯光池颜色(lighter 叠加) */
  light: string;
  neon: [string, string];
  screen: { bg: string; line: string; hi: string; frame: string };
  desk: { top: string; face: string; dark: string };
  metal: { a: string; b: string; dark: string };
  books: string[];
  plant: { a: string; b: string; pot: string };
  outline: string;
  street: { walk: string; road: string; line: string; lamp: string };
  pet: 'cat' | 'robodog' | 'shiba';
  /** 进化方格四色:好 / 一般 / 差 / 无 */
  evo: { good: string; ok: string; bad: string; none: string; plate: string };
  /** 右栏 / 顶栏 DOM 用的 CSS 变量 */
  ui: Record<string, string>;
}

export const THEMES: Record<ThemeId, Theme> = {
  study: {
    id: 'study',
    name: '夜间研究所',
    sky: ['#0b1024', '#111836', '#18203f', '#222849', '#2d2f4f'],
    skyDay: ['#3d5f94', '#5a7fb3', '#7f9fc6', '#b6b9c2', '#e2b98a'],
    stars: '#e9e2c8',
    moon: '#f3e7b3',
    rain: true,
    searchlights: false,
    blimp: false,
    cityFar: '#1a1e3a',
    cityNear: '#141730',
    cityWin: ['#f7c66b', '#ffdd8a', '#e9a64a', '#8fb8ff'],
    facade: { base: '#5a3527', dark: '#3d231a', light: '#7a4a35', trim: '#c9a26b', pattern: 'brick' },
    slab: { top: '#8a6a48', face: '#4b3423', dark: '#2a1c12' },
    wall: { a: '#4a2f1f', b: '#553726', dark: '#2e1d13', pattern: 'wood' },
    floorBoard: '#6b4a2e',
    lampStyle: 'lamp',
    light: '#ffc36b',
    neon: ['#ffb454', '#ffd98a'],
    screen: { bg: '#0f1a14', line: '#9be15d', hi: '#d8ffb0', frame: '#221a14' },
    desk: { top: '#9a6a3c', face: '#6e4526', dark: '#4a2d18' },
    metal: { a: '#8c8778', b: '#5f5b50', dark: '#35322b' },
    books: ['#9b3b2e', '#2f5d50', '#c9a24a', '#3d4f7c', '#7a3f5a', '#d6c7a1', '#4e6b2e'],
    plant: { a: '#4f8a3c', b: '#2f5e2a', pot: '#9a5a38' },
    outline: '#140c08',
    street: { walk: '#4a4038', road: '#23201e', line: '#8c7a55', lamp: '#ffcf7a' },
    pet: 'cat',
    evo: { good: '#8fd45a', ok: '#f0c24a', bad: '#e0553f', none: '#6e5a45', plate: '#1a120c' },
    ui: {
      '--bg': '#120d0a', '--panel': '#1b1410', '--panel-2': '#241a14', '--line': '#3b2b1f', '--ink': '#f3e9d8', '--dim': '#a8987f',
      '--faint': '#6b5d4a', '--accent': '#ffb454', '--good': '#9be15d', '--bad': '#ff6b6b', '--warn': '#ffd166',
    },
  },
  command: {
    id: 'command',
    name: '指挥中心',
    sky: ['#030712', '#050c1c', '#081328', '#0b1a34', '#0f2140'],
    skyDay: ['#123057', '#1b4679', '#28609c', '#4a82b8', '#7eaad0'],
    stars: '#a9c8ff',
    moon: null,
    rain: false,
    searchlights: true,
    blimp: false,
    cityFar: '#0a1830',
    cityNear: '#071226',
    cityWin: ['#39c6ff', '#7fe3ff', '#2a8cff', '#ffcf5a'],
    facade: { base: '#1a2638', dark: '#0f1826', light: '#2a3a52', trim: '#39c6ff', pattern: 'panel' },
    slab: { top: '#3a4d68', face: '#1c2940', dark: '#0c1422' },
    wall: { a: '#0f1b2e', b: '#132340', dark: '#08111f', pattern: 'grid' },
    floorBoard: '#1e3150',
    lampStyle: 'strip',
    light: '#6fd6ff',
    neon: ['#39c6ff', '#4fffc8'],
    screen: { bg: '#04121c', line: '#39e0ff', hi: '#c6f6ff', frame: '#0b1626' },
    desk: { top: '#2b3d58', face: '#1a273c', dark: '#0e1727' },
    metal: { a: '#6b7d96', b: '#3f4d63', dark: '#1f2837' },
    books: ['#2a6fd6', '#39c6ff', '#4fffc8', '#9bb8ff', '#1e3a6a', '#6fd6ff'],
    plant: { a: '#3fae6a', b: '#22704a', pot: '#2b3d58' },
    outline: '#02060d',
    street: { walk: '#1a2538', road: '#0a101c', line: '#39c6ff', lamp: '#8fe8ff' },
    pet: 'robodog',
    evo: { good: '#3dffb4', ok: '#ffd04a', bad: '#ff4f7a', none: '#3a5078', plate: '#050b16' },
    ui: {
      '--bg': '#050a14', '--panel': '#0a1322', '--panel-2': '#0f1a2e', '--line': '#1c2c46', '--ink': '#e6f1ff', '--dim': '#8aa0bf',
      '--faint': '#4c6080', '--accent': '#39e0ff', '--good': '#4fffc8', '--bad': '#ff5d8f', '--warn': '#ffcf5a',
    },
  },
  meme: {
    id: 'meme',
    name: 'Meme Lab',
    sky: ['#1a0630', '#2a0a45', '#3d0f5a', '#5a1670', '#7a2080'],
    skyDay: ['#5a2fa0', '#8043b8', '#b55ac4', '#e27dbb', '#ffb3a8'],
    stars: '#ffd6f5',
    moon: '#ffe9a8',
    rain: false,
    searchlights: false,
    blimp: true,
    cityFar: '#2a0e4a',
    cityNear: '#1c0836',
    cityWin: ['#ff4fd8', '#39f0ff', '#ffd166', '#b78cff'],
    facade: { base: '#2c1650', dark: '#1a0c33', light: '#44246e', trim: '#ff4fd8', pattern: 'tile' },
    slab: { top: '#6a3aa0', face: '#34195c', dark: '#1a0b30' },
    wall: { a: '#2a1245', b: '#331652', dark: '#180a2c', pattern: 'stripe' },
    floorBoard: '#3d1d66',
    lampStyle: 'neon',
    light: '#ff7ae6',
    neon: ['#ff4fd8', '#39f0ff'],
    screen: { bg: '#12062a', line: '#39f0ff', hi: '#ffffff', frame: '#1c0c36' },
    desk: { top: '#3e2270', face: '#27144a', dark: '#170a2e' },
    metal: { a: '#9d86c9', b: '#5e4a8a', dark: '#2e2150' },
    books: ['#ff4fd8', '#39f0ff', '#ffd166', '#b78cff', '#7dffb0', '#ff7a5c'],
    plant: { a: '#4fd18a', b: '#2a8a5a', pot: '#ff4fd8' },
    outline: '#0c0418',
    street: { walk: '#2a1845', road: '#120822', line: '#ff4fd8', lamp: '#ff9af0' },
    pet: 'shiba',
    evo: { good: '#7dffb0', ok: '#ffd166', bad: '#ff4fa0', none: '#5a3d80', plate: '#0e0620' },
    ui: {
      '--bg': '#0c0518', '--panel': '#150a28', '--panel-2': '#1d0f36', '--line': '#3a1f60', '--ink': '#f6ecff', '--dim': '#b39bd6',
      '--faint': '#6e5694', '--accent': '#ff4fd8', '--good': '#7dffb0', '--bad': '#ff5d8f', '--warn': '#ffd166',
    },
  },
};

export const THEME_ORDER: ThemeId[] = ['study', 'command', 'meme'];

export function isThemeId(x: unknown): x is ThemeId {
  return x === 'study' || x === 'command' || x === 'meme';
}
