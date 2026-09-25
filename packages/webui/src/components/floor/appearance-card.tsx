/**
 * 设置页「楼层外观」:场景、配色、每个角色的像素人体型/颜色。
 * 纯本机偏好(localStorage,prefs.ts),不进网关;改完楼层页立刻生效。
 * 中英切换归顶栏的语言开关管,这里不再有「文案语气」这一档。
 */
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { DEFAULT_PREFS, PALETTES, SHAPES, SPRITE_COLORS, setFloorScene, updateFloorPrefs, useFloorPrefs, type FloorPalette, type SpriteShape } from './prefs';
import { SCENES, SCENE_ORDER } from './scenes';
import { ROLE_META, ROLE_ORDER, resolveRoleMeta } from './roles';
import { Sprite } from './sprite';
import type { BotRole } from './types';

export function FloorAppearanceCard() {
  const prefs = useFloorPrefs();
  const meta = resolveRoleMeta(prefs);
  const vars = PALETTES[prefs.palette].vars;
  return (
    <div className="flex flex-col gap-3 p-3 text-[12px]">
      <div>
        <div className="mb-1.5 text-[11px] text-muted-foreground">{t('场景')}</div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {SCENE_ORDER.map((k) => {
            const sc = SCENES[k];
            const on = prefs.scene === k;
            const pv = PALETTES[sc.palette].vars;
            return (
              <button key={k} type="button" onClick={() => setFloorScene(k)} className={cn('rounded-md border p-2 text-left transition-colors', on ? 'border-primary ring-1 ring-primary' : 'hover:bg-accent')}>
                <div className="mb-1.5 flex h-8 overflow-hidden rounded-sm border" style={{ background: pv['--of-bg'] }}>
                  <span className="flex-1" style={{ background: pv['--of-panel'] }} />
                  <span className="w-3" style={{ background: pv['--of-accent'] }} />
                  <span className="w-3" style={{ background: pv['--of-danger'] }} />
                </div>
                <div className="font-medium">{t(sc.label)}</div>
                <div className="text-[11px] text-muted-foreground">{t(sc.hint)}</div>
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <div className="mb-1.5 text-[11px] text-muted-foreground">{t('配色')}</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {(Object.keys(PALETTES) as FloorPalette[]).map((k) => {
            const p = PALETTES[k];
            const on = prefs.palette === k;
            return (
              <button
                key={k}
                type="button"
                onClick={() => updateFloorPrefs((s) => ({ ...s, palette: k }))}
                className={cn('rounded-md border p-2 text-left transition-colors', on ? 'border-primary ring-1 ring-primary' : 'hover:bg-accent')}
              >
                <div className="mb-1.5 flex h-8 overflow-hidden rounded-sm border" style={{ background: p.vars['--of-bg'] }}>
                  <span className="flex-1" style={{ background: p.vars['--of-panel'] }} />
                  <span className="w-3" style={{ background: p.vars['--of-accent'] }} />
                  <span className="w-3" style={{ background: p.vars['--of-warn'] }} />
                  <span className="w-3" style={{ background: p.vars['--of-danger'] }} />
                </div>
                <div className="font-medium">{t(p.label)}</div>
                <div className="text-[11px] text-muted-foreground">{t(p.hint)}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="mb-1.5 flex items-center text-[11px] text-muted-foreground">
          {t('角色形象')}
          <Button variant="ghost" size="sm" className="ml-auto h-6 text-[11px]" onClick={() => updateFloorPrefs(() => ({ ...DEFAULT_PREFS, palette: prefs.palette }))}>
            {t('全部恢复默认')}
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {ROLE_ORDER.map((r) => (
            <RoleLookRow key={r} role={r} shape={meta[r].shape} color={meta[r].color} bg={vars['--of-panel-2']!} />
          ))}
        </div>
      </div>
    </div>
  );
}

function RoleLookRow({ role, shape, color, bg }: { role: BotRole; shape: SpriteShape; color: string; bg: string }) {
  const m = ROLE_META[role];
  const set = (look: { shape?: SpriteShape; color?: string }) => updateFloorPrefs((s) => ({ ...s, looks: { ...s.looks, [role]: { ...s.looks[role], ...look } } }));
  const changed = shape !== m.shape || color !== m.color;
  return (
    <div className="flex items-center gap-3 rounded-md border p-2">
      <div className="grid size-14 shrink-0 place-items-center rounded-sm" style={{ background: bg }}>
        <Sprite rows={SHAPES[shape].rows} color={color} px={4} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold" style={{ color }}>
            {m.callsign}
          </span>
          <span className="text-[11px] text-muted-foreground">{m.title}</span>
          {changed ? (
            <button type="button" className="ml-auto text-[11px] text-muted-foreground underline" onClick={() => updateFloorPrefs((s) => ({ ...s, looks: { ...s.looks, [role]: {} } }))}>
              {t('恢复')}
            </button>
          ) : null}
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {(Object.keys(SHAPES) as SpriteShape[]).map((k) => (
            <button key={k} type="button" onClick={() => set({ shape: k })} className={cn('rounded border px-1.5 py-0.5 text-[10.5px]', shape === k ? 'border-primary bg-primary/10' : 'hover:bg-accent')}>
              {t(SHAPES[k].label)}
            </button>
          ))}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {SPRITE_COLORS.map((c) => (
            <button key={c} type="button" aria-label={c} onClick={() => set({ color: c })} className={cn('size-4 rounded-sm border', color === c ? 'ring-2 ring-primary ring-offset-1 ring-offset-background' : '')} style={{ background: c }} />
          ))}
          <input type="color" value={color} onChange={(e) => set({ color: e.target.value })} className="ml-1 size-5 cursor-pointer rounded border bg-transparent p-0" title={t('自定义颜色')} />
        </div>
      </div>
    </div>
  );
}
