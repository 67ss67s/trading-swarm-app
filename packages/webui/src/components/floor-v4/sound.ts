/**
 * 楼层 v4 的 8-bit 小音效:WebAudio 方波 / 三角波程序化合成,不用音频文件、不加依赖。
 * 默认关;开关记在 localStorage(tg.floor.v4.sound),读写都 try/catch。
 * AudioContext 懒建(浏览器要求用户手势后才能出声 —— 开关按钮本身就是那个手势)。
 */
import type { SfxKind } from './engine-b/types';

export const SOUND_KEY = 'tg.floor.v4.sound';

export function loadSoundOn(): boolean {
  try {
    return window.localStorage.getItem(SOUND_KEY) === 'on';
  } catch {
    return false;
  }
}
export function saveSoundOn(on: boolean): void {
  try {
    window.localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
  } catch {
    /* 私密模式 */
  }
}

/** 一个音符:频率 Hz、起点秒、时长秒、波形、音量 */
export interface Note {
  f: number;
  at: number;
  d: number;
  wave?: OscillatorType;
  v?: number;
  /** 滑音终点频率(可选) */
  to?: number;
}

/** 每种事件的乐句(纯数据,测试可断言) */
export const SFX: Record<SfxKind, Note[]> = {
  // 信封送达:两声短促上行「叮叮」
  envelope: [
    { f: 988, at: 0, d: 0.06, wave: 'square', v: 0.05 },
    { f: 1319, at: 0.07, d: 0.09, wave: 'square', v: 0.05 },
  ],
  // 审批通过:金币音(B5 → E6 延音)
  approval: [
    { f: 988, at: 0, d: 0.07, wave: 'square', v: 0.06 },
    { f: 1319, at: 0.07, d: 0.22, wave: 'square', v: 0.06 },
  ],
  // 进化 +1:三连上行琶音
  evolve: [
    { f: 523, at: 0, d: 0.07, wave: 'triangle', v: 0.09 },
    { f: 659, at: 0.07, d: 0.07, wave: 'triangle', v: 0.09 },
    { f: 784, at: 0.14, d: 0.07, wave: 'triangle', v: 0.09 },
    { f: 1047, at: 0.21, d: 0.16, wave: 'square', v: 0.05 },
  ],
  // 击掌:短噪感下滑「啪」
  highfive: [
    { f: 1400, to: 300, at: 0, d: 0.08, wave: 'square', v: 0.06 },
    { f: 660, at: 0.09, d: 0.06, wave: 'triangle', v: 0.08 },
  ],
};

export interface Sfx {
  play(k: SfxKind): void;
  setOn(on: boolean): void;
  isOn(): boolean;
}

export function createSfx(initialOn: boolean): Sfx {
  let on = initialOn;
  let ctx: AudioContext | null = null;
  const last: Partial<Record<SfxKind, number>> = {};
  const ensure = (): AudioContext | null => {
    if (ctx) return ctx;
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      ctx = AC ? new AC() : null;
    } catch {
      ctx = null;
    }
    return ctx;
  };
  return {
    play(k) {
      if (!on) return;
      // 同类音 150ms 内只响一次(一批信封同时到别炸耳朵)
      const nowMs = Date.now();
      if (nowMs - (last[k] ?? 0) < 150) return;
      last[k] = nowMs;
      const ac = ensure();
      if (!ac) return;
      if (ac.state === 'suspended') void ac.resume().catch(() => undefined);
      const t0 = ac.currentTime + 0.01;
      for (const n of SFX[k]) {
        const osc = ac.createOscillator();
        const g = ac.createGain();
        osc.type = n.wave ?? 'square';
        osc.frequency.setValueAtTime(n.f, t0 + n.at);
        if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to, t0 + n.at + n.d);
        const v = n.v ?? 0.06;
        g.gain.setValueAtTime(0, t0 + n.at);
        g.gain.linearRampToValueAtTime(v, t0 + n.at + 0.005);
        g.gain.setValueAtTime(v, t0 + n.at + n.d * 0.7);
        g.gain.linearRampToValueAtTime(0, t0 + n.at + n.d);
        osc.connect(g).connect(ac.destination);
        osc.start(t0 + n.at);
        osc.stop(t0 + n.at + n.d + 0.02);
      }
    },
    setOn(v) {
      on = v;
      if (v) ensure();
    },
    isOn: () => on,
  };
}
