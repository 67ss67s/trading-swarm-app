import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { researchApi } from "@/api/client";
import type {
  ResearchRevisionCommand,
  ResearchExecution,
} from "@/api/research-types";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { t, tmap } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/format";
import { useResearchPreferences, saveResearchPreferences } from "./preferences";

import { readableRuleText } from "./presentation";

const tabs = [
  "标的",
  "策略规则",
  "仓位",
  "验证条件",
  "显示偏好",
  "版本记录",
] as const;
const names: Record<string, string> = tmap({
  signal: "何时出现机会",
  entry: "何时买入",
  stop: "何时止损",
  sizing: "投入多少",
  exit: "何时退出",
  regime: "市场条件",
});
type ExecutionPatch = NonNullable<
  ResearchRevisionCommand["execution_overrides"]
>;

export function StrategySettings({
  runId,
  open,
  onClose,
  onCommand,
  onSelectVersion,
}: {
  runId: string | null;
  open: boolean;
  onClose: () => void;
  onCommand: (command: ResearchRevisionCommand, key: string) => Promise<void>;
  onSelectVersion: (id: string) => void;
}) {
  const q = useQuery({
    queryKey: ["research", "revision-context", runId],
    queryFn: () => researchApi.revisionContext(runId!),
    enabled: open && !!runId,
    staleTime: 0,
    retry: false,
  });
  const [tab, setTab] = useState<(typeof tabs)[number]>("策略规则"); // i18n-ignore: tab 状态值,渲染处 t(item)
  const [instruction, setInstruction] = useState("");
  const [count, setCount] = useState<1 | 2>(1);
  const [execution, setExecution] = useState<ExecutionPatch>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState<{
    command: ResearchRevisionCommand;
    key: string;
  } | null>(null);
  const prefs = useResearchPreferences();
  const base = q.data;
  useEffect(() => {
    setInstruction("");
    setExecution({});
    setError(null);
    setRetry(null);
    setCount(1);
  }, [runId]);
  const submit = async (mode: ResearchRevisionCommand["mode"]) => {
    if (!base || sending) return;
    const command: ResearchRevisionCommand = {
      mode,
      baseline_run_id: base.run_id,
      instruction:
        mode === "rerun"
          ? t("保留当前策略规则，按修改后的仓位与验证条件重跑，并与原版并列查看。")
          : instruction.trim(),
      max_candidates: mode === "optimize" ? count : 1,
      ...(mode === "rerun" ? { execution_overrides: execution } : {}),
    };
    const payload =
      retry && JSON.stringify(retry.command) === JSON.stringify(command)
        ? retry
        : { command, key: crypto.randomUUID() };
    setRetry(payload);
    setSending(true);
    setError(null);
    try {
      await onCommand(payload.command, payload.key);
      setRetry(null);
      onClose();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t("提交失败，可使用同一请求重试。"),
      );
    } finally {
      setSending(false);
    }
  };
  const field = (label: string, name: keyof ExecutionPatch, hint: string) => (
    <label className="block space-y-1.5 text-sm">
      <span>{label}</span>
      <Input
        value={
          execution[name] ??
          base?.execution[name as keyof ResearchExecution] ??
          ""
        }
        onChange={(e) =>
          setExecution((old) => ({ ...old, [name]: e.target.value }))
        }
        inputMode="decimal"
      />
      <span className="block text-xs text-muted-foreground">{hint}</span>
    </label>
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !sending) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-[860px]">
        <DialogTitle>{t("研究设置")}{base ? ` · V${base.version}` : ""}</DialogTitle>
        <p className="text-xs text-muted-foreground">
          {t("规则修改形成新版本；验证条件修改创建新回测；显示偏好立即生效。")}
        </p>
        <div className="flex min-h-[390px] flex-col gap-5 sm:flex-row">
          <nav
            aria-label={t("研究设置分区")}
            className="flex shrink-0 gap-1 overflow-x-auto sm:w-36 sm:flex-col"
          >
            {tabs.map((item) => (
              <button
                type="button"
                key={item}
                aria-current={tab === item ? "page" : undefined}
                onClick={() => setTab(item)}
                className={cn(
                  "rounded-md px-3 py-2 text-left text-sm whitespace-nowrap",
                  tab === item
                    ? "bg-accent font-medium"
                    : "text-muted-foreground hover:bg-accent/50",
                )}
              >
                {t(item)}
              </button>
            ))}
          </nav>
          <div className="min-w-0 flex-1 space-y-5">
            {tab === "显示偏好" ? (
              <>
                <h3 className="font-medium">{t("只影响显示")}</h3>
                {(
                  [
                    ["metric_summary", t("展示指标摘要")],
                    ["compact_charts", t("使用紧凑图表")],
                    ["sources", t("展示数据来源展开项")],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-3 text-sm">
                    <input
                      type="checkbox"
                      checked={prefs[key]}
                      onChange={(e) =>
                        saveResearchPreferences({
                          ...prefs,
                          [key]: e.target.checked,
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
                <p className="text-xs text-muted-foreground">
                  {t("保存在当前浏览器，不会调用模型或重新计算结果。")}
                </p>
              </>
            ) : !runId ? (
              <p className="text-sm text-muted-foreground">
                {t("先在对话或实验历史中选中一次回测。")}
              </p>
            ) : q.isLoading ? (
              <p>{t("正在读取冻结的研究条件…")}</p>
            ) : q.error || !base ? (
              <p className="text-sm text-down">{t("暂时无法读取研究设置。")}</p>
            ) : (
              <>
                {tab === "标的" ? (
                  <>
                    <h3 className="font-medium">
                      {base.ir?.label ?? t("当前策略")} · {base.timeframe}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {t("当前版本绑定已保存的行情数据。更换资产或周期需要从对话发起新的研究，避免把不同标的当作同一策略的改善。")}
                    </p>
                    <p className="text-sm">
                      {fmtDateTime(base.window.from_ms)} →{" "}
                      {fmtDateTime(base.window.to_ms)}
                    </p>
                    <details className="text-xs text-muted-foreground">
                      <summary>{t("数据身份")}</summary>
                      <p className="mt-2 break-all">
                        {base.dataset_id ?? t("组合数据")} · {base.study_id}
                      </p>
                    </details>
                  </>
                ) : null}
                {tab === "策略规则" ? (
                  <>
                    <div className="space-y-3">
                      {base.rules.map((r, i) => (
                        <div key={i}>
                          <div className="text-xs text-muted-foreground">
                            {names[r.category] ?? r.category}
                          </div>
                          <p className="mt-1 text-sm leading-relaxed">
                            {readableRuleText(r.text)}
                          </p>
                          <details className="mt-1 text-xs text-muted-foreground">
                            <summary className="cursor-pointer">
                              {t("规则参数")}
                            </summary>
                            <p className="mt-2">{r.text}</p>
                          </details>
                        </div>
                      ))}
                    </div>
                    <label className="block space-y-2 text-sm">
                      <span>{t("想改什么，或希望优化什么？")}</span>
                      <Textarea
                        value={instruction}
                        onChange={(e) => {
                          setInstruction(e.target.value);
                          setRetry(null);
                        }}
                        placeholder={t("例如：减少震荡行情中的频繁进出，保留原来的止损与仓位规则。")}
                      />
                    </label>
                    <div className="flex flex-wrap items-center gap-3 text-xs">
                      <label>
                        {t("本轮最多")}{" "}
                        <select
                          aria-label={t("候选上限")}
                          value={count}
                          onChange={(e) =>
                            setCount(Number(e.target.value) as 1 | 2)
                          }
                          className="rounded border bg-background px-2 py-1"
                        >
                          <option value="1">{t("1 个候选")}</option>
                          <option value="2">{t("2 个候选")}</option>
                        </select>
                      </label>
                      <span className="text-muted-foreground">
                        {t("累计还可运行 {n} 个开发候选", { n: base.remaining_candidates })}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t("每个候选都会保留规则变化、执行状态和对照结果。不会自动替换原版。")}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        disabled={sending || !instruction.trim()}
                        onClick={() => void submit("revise")}
                      >
                        {t("修改并验证新版本")}
                      </Button>
                      <Button
                        variant="outline"
                        disabled={
                          sending || !instruction.trim() || !!base.blocked
                        }
                        onClick={() => void submit("optimize")}
                      >
                        {t("有限优化")}
                      </Button>
                    </div>
                  </>
                ) : null}
                {tab === "仓位" ? (
                  <>
                    {field(
                      t("每笔最大权益占用"),
                      "max_allocation",
                      t("填写比例：0.25 表示最多使用 25% 的权益。"),
                    )}
                    {base.ir?.risk.sizing.primitive === "risk_fraction"
                      ? field(
                          t("每笔风险预算"),
                          "risk_fraction",
                          t("填写比例：0.01 表示止损风险约占权益 1%。"),
                        )
                      : null}
                    <p className="text-xs text-muted-foreground">
                      {t("当前方式：{mode}。费用与仓位变化将单独标注，不能归因于规则改善。", {
                        mode:
                          base.ir?.risk.sizing.primitive === "equal_notional"
                            ? t("等额资金分配")
                            : t("按风险预算计算"),
                      })}
                    </p>
                  </>
                ) : null}
                {tab === "验证条件" ? (
                  <>
                    <p className="text-sm">
                      {t("冻结区间：")}{fmtDateTime(base.window.from_ms)} →{" "}
                      {fmtDateTime(base.window.to_ms)}
                    </p>
                    {field(
                      t("初始资金"),
                      "initial_cash",
                      t("沿用当前资产的计价货币。"),
                    )}
                    {field(
                      t("单边手续费率"),
                      "fee_rate",
                      t("填写比例：0.001 表示单边 0.1%。"),
                    )}
                    {field(
                      t("单边滑点"),
                      "slippage_bps",
                      t("单位 bps：5 表示 0.05%。"),
                    )}
                    <p className="text-xs text-muted-foreground">
                      {t("本入口保留原数据、区间与预注册分段；改变这些条件请新建研究。")}
                    </p>
                  </>
                ) : null}
                {tab === "仓位" || tab === "验证条件" ? (
                  <Button
                    disabled={
                      sending ||
                      !Object.keys(execution).length ||
                      !!base.blocked
                    }
                    onClick={() => void submit("rerun")}
                  >
                    {t("保存条件并新建回测")}
                  </Button>
                ) : null}
                {tab === "版本记录" ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      {t("包括失败与取消的实验。选择版本会明确更新后续追问的引用。")}
                    </p>
                    {base.versions.map((v) => (
                      <button
                        type="button"
                        key={v.run_id}
                        disabled={sending}
                        onClick={() => {
                          onSelectVersion(v.run_id);
                          onClose();
                        }}
                        className={cn(
                          "flex w-full items-center justify-between rounded-lg border p-3 text-left text-sm",
                          v.run_id === base.run_id && "border-primary/50",
                        )}
                      >
                        <span>
                          V{v.version} ·{" "}
                          {v.purpose === "development"
                            ? t("开发段")
                            : v.purpose === "validation"
                              ? t("验证段")
                              : t("留出段")}
                          <small className="mt-1 block text-muted-foreground">
                            {fmtDateTime(v.created_at)}
                          </small>
                        </span>
                        <span>
                          {(
                            {
                              completed: t("已完成"),
                              failed: t("失败"),
                              cancelled: t("已取消"),
                              queued: t("排队"),
                              running: t("运行中"),
                            } as Record<string, string>
                          )[v.status] ?? v.status}
                        </span>
                      </button>
                    ))}
                  </>
                ) : null}
                {base.blocked ? (
                  <p
                    role="status"
                    className="rounded-lg border border-warn/30 bg-warn/5 p-3 text-xs leading-relaxed text-warn"
                  >
                    {base.blocked}
                  </p>
                ) : null}
              </>
            )}
            {error ? (
              <p role="alert" className="text-sm text-down">
                {error}
              </p>
            ) : null}
            {sending ? (
              <p role="status" className="text-sm text-muted-foreground">
                {t("正在提交，受理后会回到对话展示研究过程…")}
              </p>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
