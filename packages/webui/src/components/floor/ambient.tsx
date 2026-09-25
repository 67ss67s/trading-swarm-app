import { useEffect, useState } from 'react';

/** 和 CSS 同步,系统设置在页面打开期间变化也立即生效。 */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return reduced;
}

/** 静态房间层。常驻动画预算共四处:HELM 核心、RADAR 光标、一个 LED、LAB 桌灯。 */
export function Ambient() {
  return <div className="of-ambient" aria-hidden="true"><span className="of-room-wash" /><span className="of-floor-perspective" /><span className="of-wall-light of-wall-light-left" /><span className="of-wall-light of-wall-light-right" /></div>;
}
