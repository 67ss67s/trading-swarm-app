import { useEffect, useState } from "react";

export interface ResearchPreferences {
  metric_summary: boolean;
  compact_charts: boolean;
  sources: boolean;
}
const defaults: ResearchPreferences = {
  metric_summary: true,
  compact_charts: false,
  sources: true,
};
const key = "tg.research.presentation.v1";
function read(): ResearchPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "{}");
    return Object.fromEntries(
      Object.entries(defaults).map(([k, v]) => [
        k,
        typeof value[k] === "boolean" ? value[k] : v,
      ]),
    ) as unknown as ResearchPreferences;
  } catch {
    return defaults;
  }
}
export function useResearchPreferences() {
  const [value, setValue] = useState(read);
  useEffect(() => {
    const update = () => setValue(read());
    window.addEventListener("research-preferences", update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener("research-preferences", update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return value;
}
export function saveResearchPreferences(value: ResearchPreferences) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Private mode keeps defaults. */
  }
  window.dispatchEvent(new Event("research-preferences"));
}
