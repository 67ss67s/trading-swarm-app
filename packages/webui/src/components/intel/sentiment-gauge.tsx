/**
 * 情绪仪表:market_state.sentiment.fng 的 0-100 半环 SVG + fng_label。
 * 纯 SVG,不引第三方图表库(项目已有 lightweight-charts 用于 K 线,这里没必要)。
 */
import { t } from '@/lib/i18n';

const R = 46;
const CX = 60;
const CY = 56;
const HALF_CIRC = Math.PI * R; // 半圆弧长

function arcColor(v: number): string {
  if (v <= 24) return 'var(--down)'; // 极度恐慌
  if (v <= 44) return 'var(--warn)'; // 恐慌
  if (v <= 55) return 'var(--muted-foreground)'; // 中性
  if (v <= 75) return 'var(--up)'; // 贪婪
  return 'var(--up)'; // 极度贪婪
}

export function SentimentGauge({ value, label }: { value: number | null; label: string | null }) {
  if (value === null) {
    return <div className="py-6 text-center text-[11.5px] text-muted-foreground">{t('还没有情绪数据。')}</div>;
  }
  const v = Math.max(0, Math.min(100, value));
  const filled = (v / 100) * HALF_CIRC;
  return (
    <div className="flex flex-col items-center gap-1 py-2">
      <svg viewBox="0 0 120 66" width="180" height="99" className="overflow-visible">
        <path d={`M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`} fill="none" stroke="var(--muted)" strokeWidth={10} strokeLinecap="round" />
        <path
          d={`M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`}
          fill="none"
          stroke={arcColor(v)}
          strokeWidth={10}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${HALF_CIRC * 2}`}
        />
        <text x={CX} y={CY - 8} textAnchor="middle" className="num" fontSize={22} fontWeight={700} fill="var(--foreground)">
          {Math.round(v)}
        </text>
      </svg>
      <div className="text-[11.5px] text-muted-foreground">{label ?? '—'}</div>
    </div>
  );
}
