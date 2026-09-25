/* 图表专用色 — 已用 dataviz validate_palette.js 校验(明度带/色度/CVD/对比度全绿)
   暗色 surface #12161c,浅色 surface #ffffff */
export const CHART_COLORS = {
  dark: {
    up: "#2aa76e",
    down: "#c94b3e",
    emaFast: "#3f9ac2",
    emaSlow: "#b58530",
    vwap: "#a468e0",
    grid: "rgba(255,255,255,0.06)",
    text: "#97a3b4",
    border: "rgba(255,255,255,0.12)",
  },
  light: {
    up: "#1b9e5f",
    down: "#d64f44",
    emaFast: "#1f7fb2",
    emaSlow: "#996a10",
    vwap: "#7d54b8",
    grid: "rgba(20,30,45,0.07)",
    text: "#5c6675",
    border: "rgba(20,30,45,0.16)",
  },
} as const;

export type ChartTheme = keyof typeof CHART_COLORS;
