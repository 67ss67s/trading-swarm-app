/**
 * #connect「接入」页(docs/design/ia-newcomer-audit-2026-09-25.md ②/③-1/③-3/③-4,第二批):
 * 开工前一次性配置按顺序集中在一处——
 *   1 交易所账户(+ 下单通道)→ 2 OKX 账户模式(永续需要非简单模式)→ 3 交易市场 / 单笔风险 / 杠杆 / 保证金模式
 *   (按账户模式联动禁用)→ 4 模型连接(链 #models)→ 5 保护单验证 → 6 网络自检;另附 Agentic 钱包 / MCP(可选)。
 * 以前这些散在 Agent 页右栏「执行」tab(现在只剩只读摘要)、设置页工作流、顶栏账户菜单。
 * 每步右上角的状态灯和 #start 清单同一套判定(components/start/logic.ts)。
 */
import type { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { AccountModeSelect, ACCT_LV_OPTIONS, MarketRiskBlock, NetCheckRow, OkxAccountModeLink, ProtectionVerifyBlock, RefreshAccountModeButton, SimpleModeWarning, TransportLine } from '@/components/connect/blocks';
import { useExecutionQuery } from '@/components/connect/use-execution';
import { McpSection, OkxSection, WalletSection } from '@/components/accounts-menu';
import { ExecutionChannelPanel } from '@/components/execution-panel';
import { brokenRoles, MODEL_ROLE_LABEL, okConnectionCount } from '@/components/models/logic';
import { useModels } from '@/components/models/use-models';
import { Pane, Workspace } from '@/components/pane';
import { ProtectionBlock } from '@/components/protection-status';
import { Skeleton } from '@/components/ui/skeleton';
import type { StartStepState } from '@/components/start/logic';
import { StepStateTag } from '@/components/start/step-state';
import { useStartFull } from '@/components/start/use-start';
import { acctLvLabel } from '@/lib/format';
import { t, listSep } from '@/lib/i18n';

function Step({ n, title, hint, state, children }: { n: number; title: string; hint?: string; state?: StartStepState; children: ReactNode }) {
  return (
    <Workspace className="shrink-0">
      <Pane title={`${n} · ${title}`} hint={hint} actions={state ? <StepStateTag state={state} /> : null}>
        <div className="p-3">{children}</div>
      </Pane>
    </Workspace>
  );
}

export function ConnectPage() {
  const execQ = useExecutionQuery();
  const view = execQ.data;
  const modelsQ = useModels();
  const { steps } = useStartFull();
  const isOkx = view?.exchange === 'okx';
  const okx = view?.okx ?? null;

  if (execQ.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  let n = 0;
  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col gap-3 overflow-y-auto pb-6">
      <p className="shrink-0 text-[11.5px] leading-relaxed text-muted-foreground">
        {t('开工前的一次性配置,从上往下做一遍就能让 agent 在模拟盘上跑起来。每一步的完成状态和「开始」清单是同一套判断。')}
        <a href="#start" className="ml-1 text-primary hover:underline">
          {t('回开始清单 →')}
        </a>
      </p>

      <Step n={++n} title={t('交易所账户')} hint={isOkx ? t('新手先连模拟盘') : undefined} state={steps.exchange}>
        {!view ? (
          <div className="text-[11.5px] text-muted-foreground">
            {t('网关还没提供')} <span className="num">/api/execution</span>{t(',执行后端面板暂时用不了(接好线自动出现)。')}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {isOkx ? (
              <div className="-mx-3 -mt-3 border-b">
                <OkxSection view={view} />
              </div>
            ) : null}
            <div className="text-[10.5px] text-muted-foreground">{t('下单通道')}</div>
            <div className="-mx-3 border-y">
              <ExecutionChannelPanel />
            </div>
          </div>
        )}
      </Step>

      {isOkx ? (
        <Step n={++n} title={t('OKX 账户模式')} hint={t('决定能不能开永续')} state={steps.account_mode}>
          {okx?.available ? (
            <div className="flex flex-col gap-2 text-[11.5px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">{t('当前')}</span>
                <span className="num font-medium">{acctLvLabel(okx.acct_lv, okx.acct_lv_label)}</span>
                {view ? <AccountModeSelect view={view} size="md" /> : null}
                <RefreshAccountModeButton />
              </div>
              <ul className="space-y-0.5 text-[11px] text-muted-foreground">
                {ACCT_LV_OPTIONS.map((o) => (
                  <li key={o.lv}>
                    <span className="text-foreground">{t(o.label)}</span>:{t(o.hint)}
                  </li>
                ))}
              </ul>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t('只做现货选简单模式就行;要做永续,选单币种或跨币种保证金。从简单模式第一次切出只能在 OKX 网页 / App 完成(51070),切完回来点刷新。')} <OkxAccountModeLink />
              </p>
              <SimpleModeWarning view={view} />
            </div>
          ) : (
            <div className="text-[11.5px] text-muted-foreground">{t('先完成上一步:连上 OKX 账户才读得到账户模式。')}</div>
          )}
        </Step>
      ) : null}

      <Step n={++n} title={t('交易市场与风险')} hint={t('永续 / 现货、单笔风险、杠杆、保证金模式')} state={steps.market}>
        <MarketRiskBlock view={view} />
      </Step>

      <Step n={++n} title={t('模型连接')} hint={t('agent 用哪些模型')} state={steps.models}>
        <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
          {modelsQ.data ? (
            <>
              <span>{t('{ok} / {n} 个可用', { ok: okConnectionCount(modelsQ.data), n: modelsQ.data.connections.length })}</span>
              {brokenRoles(modelsQ.data).length > 0 ? (
                <span className="text-destructive">{t('这些角色绑定的连接失效了:{roles}', { roles: brokenRoles(modelsQ.data).map((r) => MODEL_ROLE_LABEL[r]).join(listSep()) })}</span>
              ) : null}
            </>
          ) : (
            <span className="text-muted-foreground">{modelsQ.isError ? t('读不到模型连接(网关可能还没接 /api/models),按本机 CLI 判断') : t('加载中…')}</span>
          )}
          <a href="#models" className="ml-auto inline-flex items-center gap-1 text-primary hover:underline">
            {t('去模型连接')}
            <ArrowRight className="size-3" />
          </a>
        </div>
      </Step>

      <Step n={++n} title={t('保护单验证')} hint={t('不标记,闸门就不放开新开仓')} state={steps.protection}>
        {!view ? null : isOkx ? (
          okx?.available ? (
            <ProtectionVerifyBlock view={view} />
          ) : (
            <div className="text-[11.5px] text-muted-foreground">{t('先连上交易所账户。')}</div>
          )
        ) : (
          <ProtectionBlock protection={view.protection} />
        )}
        {steps.protection === 'skipped' ? <div className="mt-1 text-[10.5px] text-muted-foreground">{t('模拟盘只做现货时用不到;开永续或上实盘前再做。')}</div> : null}
      </Step>

      <Step n={++n} title={t('网络自检')} hint={t('测的就是下单走的那条路')}>
        {view ? <TransportLine view={view} /> : null}
        <NetCheckRow />
      </Step>

      <Workspace className="shrink-0">
        <Pane title={t('其他连接(可选)')} hint={t('信号市场要用钱包;MCP 给 Claude Code 用')}>
          <WalletSection />
          <McpSection show={isOkx} />
        </Pane>
      </Workspace>
    </div>
  );
}
