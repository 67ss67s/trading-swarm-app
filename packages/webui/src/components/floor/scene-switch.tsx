/**
 * 楼层顶栏的场景切换(三段式):指挥中心 / 研究楼层 / 霓虹实验室。写 localStorage(prefs.ts),
 * 切换只换视觉。设置页「楼层外观」里有同一个开关的大号版本。
 */
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { setFloorScene, useFloorPrefs } from './prefs';
import { SCENES, SCENE_ORDER } from './scenes';

export function SceneSwitch({ className }: { className?: string }) {
  const prefs = useFloorPrefs();
  return (
    <div className={cn('of-scene-switch inline-flex overflow-hidden rounded-sm border border-[var(--of-line)] text-[10px]', className)} role="tablist" aria-label={t('楼层场景')}>
      {SCENE_ORDER.map((k) => {
        const on = prefs.scene === k;
        return (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={on}
            title={t(SCENES[k].hint)}
            onClick={() => setFloorScene(k)}
            className={cn('whitespace-nowrap px-2 py-1 transition-colors', on ? 'bg-[var(--of-accent)] text-[var(--of-bg)] font-semibold' : 'text-[var(--of-ink-dim)] hover:text-[var(--of-ink)]')}
          >
            {t(SCENES[k].label)}
          </button>
        );
      })}
    </div>
  );
}
