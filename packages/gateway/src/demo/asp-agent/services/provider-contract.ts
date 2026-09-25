/** provider 轮询接口的类型,来自 asp-agent/provider-tasks.ts(唯一接单方)。本目录只依赖类型,registerProviderHandler 由调用方注入。 */
import type { ProviderHandler } from '../provider-tasks.js';
export type { ProviderTaskKind, ProviderTask, ProviderContext, ProviderDecision, ProviderOutput, ProviderHandler } from '../provider-tasks.js';
export type RegisterProviderHandler = (key: string, handler: ProviderHandler) => () => void;
