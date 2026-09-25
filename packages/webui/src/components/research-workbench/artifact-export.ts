import type { ResearchArtifact } from "@/api/research-types";

export function artifactExport(
  a: ResearchArtifact,
  format: "json" | "csv" | "md",
) {
  const body = (a.content ?? a.spec) as Record<string, unknown> | string;
  if (format === "json") return JSON.stringify(a, null, 2);
  if (format === "md") {
    const text = typeof body === "string" ? body : String(body?.text ?? "");
    return `${text}\n\n## 证据索引\n\n产物：${a.id}\n\n快照：${(a.snapshot_refs ?? []).join(", ") || "未关联快照"}\n\n${typeof body === "object" ? JSON.stringify({ artifact_refs: body.artifact_refs, run_ids: body.run_ids }, null, 2) : ""}\n`;
  }
  if (
    !body ||
    typeof body !== "object" ||
    !Array.isArray(body.columns) ||
    !Array.isArray(body.rows)
  )
    throw Error("这份产物没有可导出的表格");
  const cell = (v: unknown) => {
    let s =
      typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? "");
    if (typeof v !== "number" && /^[\s]*[=+@-]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  return (
    "\ufeff" +
    [body.columns, ...body.rows]
      .map((row) => (row as unknown[]).map(cell).join(","))
      .join("\r\n")
  );
}
export function downloadArtifact(
  a: ResearchArtifact,
  format: "json" | "csv" | "md",
) {
  const blob = new Blob([artifactExport(a, format)], {
    type:
      format === "json"
        ? "application/json"
        : format === "csv"
          ? "text/csv;charset=utf-8"
          : "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `research-${a.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.${format}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
