/** 矩阵研究 matrix study(契约 §9.53 B「2026-09-25 matrix study 修订」)对外入口。 */
export * from './types.js';
export { normalizeSpec, prefillFromRecommendation, defaultJudge, DEFAULT_PROTOCOL, DEFAULT_WINDOW_DAYS } from './spec.js';
export { buildManifest, estimate, expandCells, segmentsFor, manifestHash, type MatrixEstimate } from './manifest.js';
export { MatrixStudyStore } from './store.js';
export { MatrixStudyService, staticPreflight, CANDIDATE_KEY, candidateKey, type MatrixServiceDeps, type AdoptResult, type CandidateAdoptResult, type PreflightLike } from './service.js';
export { scorecardOf, tierOf, tierBoard, luckOf, oneSidedP, SAMPLE_GATE, SIGNIFICANCE_GATE, type TierBoard } from './scorecard.js';
export { accountReplay, PORTFOLIO_DEFAULTS, type PortfolioSummary } from './portfolio.js';
export { holm, blockBootstrapP, selectionGates, causeOf } from './stats.js';
export { judgeRuntimeFor, judgeBudgetId, type MatrixJudgeDeps } from './evaluate.js';
