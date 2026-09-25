/**
 * 楼层角色「用什么模型」。
 *
 * §9.52 起(2026-09-25):底层 = 连接 + 角色绑定,答案以 GET /api/models 的 `effective` 为准——
 * 楼层角色先映射到模型角色(components/models/logic.ts BOT_MODEL_ROLE:gate_captain→chat、
 * thread_manager→judge、radar→utility、reviewer→reviewer …),再读 effective[modelRole]
 * (source = 绑定 / 回退主脑 / 回退副脑 / 未设置)。见 roleBrainDisplay()。
 *
 * 下面的两槽推断(ROLE_BRAIN_SLOT / SLOT_* / roleBrainName)只在老网关没有 /api/models 时兜底,
 * 以及「回退主脑 / 副脑」控件(brain-controls.tsx)标注槽位时用:两个旧槽位 workflow.brain /
 * cheap_brain 现在是未单独绑定角色的回退。
 */
import type { BotRole, EffectiveSource, LoopView, ModelRole, ModelsView } from '@/api/types';
import { botRoleModel, SOURCE_LABEL } from '@/components/models/logic';
import { tmap } from '@/lib/i18n';

export type BrainSlot = 'main' | 'cheap';

export const ROLE_BRAIN_SLOT: Partial<Record<BotRole, BrainSlot>> = {
  gate_captain: 'main',
  thread_manager: 'main',
  radar: 'cheap',
  reviewer: 'cheap',
};

export const SLOT_LABEL: Record<BrainSlot, string> = tmap({ main: '主脑', cheap: '副脑' });

/** 同槽位的其它角色呼号,用来提示「切了会一起换」 */
export const SLOT_ROLES: Record<BrainSlot, BotRole[]> = {
  main: ['gate_captain', 'thread_manager'],
  cheap: ['radar', 'reviewer'],
};

/** 每个用模型的角色在这个槽位上干什么(顶栏大脑弹层 / 团队卡共用一份文案) */
export const SLOT_ROLE_DUTY: Partial<Record<BotRole, string>> = tmap({
  gate_captain: '对话',
  thread_manager: '判断',
  radar: '信息员 · 筛选',
  reviewer: '复盘',
});

export function roleBrainName(role: BotRole, loop: Pick<LoopView, 'brain' | 'cheap_brain'> | null | undefined): { slot: BrainSlot; name: string } | null {
  const slot = ROLE_BRAIN_SLOT[role];
  if (!slot || !loop) return null;
  return { slot, name: slot === 'main' ? loop.brain : loop.cheap_brain };
}

/** 楼层角色卡 / 团队 tile 显示用:优先 effective,没有 ModelsView 时回退两槽推断 */
export interface RoleBrainDisplay {
  name: string;
  /** 'slot' = 老网关两槽推断 */
  source: EffectiveSource | 'slot';
  /** 绑定 / 回退主脑 / 回退副脑 / 未设置;两槽推断时是 主脑 / 副脑 */
  sourceLabel: string;
  /** 绑定的连接失效(红点) */
  broken: boolean;
  modelRole: ModelRole | null;
  /** 两槽推断时的槽位;effective 回退时也给出对应槽位(fallback_main→main),方便就地改回退 */
  slot: BrainSlot | null;
}

export function roleBrainDisplay(role: BotRole, models: ModelsView | null | undefined, loop: Pick<LoopView, 'brain' | 'cheap_brain'> | null | undefined): RoleBrainDisplay | null {
  if (models) {
    const m = botRoleModel(role, models);
    if (!m) return null;
    const slot: BrainSlot | null = m.source === 'fallback_main' ? 'main' : m.source === 'fallback_cheap' ? 'cheap' : null;
    return { name: m.name, source: m.source, sourceLabel: SOURCE_LABEL[m.source], broken: m.broken, modelRole: m.modelRole, slot };
  }
  const legacy = roleBrainName(role, loop);
  if (!legacy) return null;
  return { name: legacy.name, source: 'slot', sourceLabel: SLOT_LABEL[legacy.slot], broken: false, modelRole: null, slot: legacy.slot };
}
