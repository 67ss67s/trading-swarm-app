/**
 * 判断记录里的「闸门拒绝」与「真正的异常」分开显示(评审版 #judgments,09-26)。
 *
 * 后端把闸门拒绝(净盈亏比不够、持仓计划建不起来、ATR 尺度不合规…)同时写进 reducer.reason 和 error,
 * 前端原来当成 Error 标红。判定:
 *   1. 数据优先:reducer 拒绝了这次迁移(accepted=false),且 error 就是 reducer.reason 原文 → 闸门拒绝;
 *   2. 兜底按句式:以「持仓计划 / 策略ATR尺度 / 净盈亏比 / 净RR」开头的也算闸门(老记录没有 reducer 时)。
 * 其余 error(网络 / 交易所 / 解析失败…)照旧是 Error。句式本身的英文翻译归后端出口 / server-text-en,这里只管层级。
 */
const GATE_PREFIX = /^(持仓计划|策略ATR尺度|净盈亏比|净RR)\s*[:：]/;

export interface EpisodeGateInput {
  error?: string | null;
  reducer?: { accepted: boolean; reason: string } | null;
}

/** 是闸门拒绝就返回理由原文,否则 null(包括没有 error 的情况) */
export function episodeGateReason(s: EpisodeGateInput): string | null {
  const err = s.error?.trim();
  if (!err) return null;
  if (s.reducer && s.reducer.accepted === false && s.reducer.reason?.trim() === err) return err;
  if (GATE_PREFIX.test(err)) return err;
  return null;
}
