# Contributing

Design reference: `docs/design/trading-swarm-design-v1-2026-09-02.md`; runtime API contract: `docs/demo/v3-ui-contract.md`;
data contracts: `packages/contracts/` (JSON Schema is the single source; the TS and Rust types are generated from and checked against it).

## Hard boundaries

1. **Exchange credentials stay out of the TypeScript process.** The gateway, web UI and scripts never hold an API key/secret,
   OAuth token or PKCE verifier. Order signing is done by the exchange CLI (`okx`, `binance-cli`) or by the Rust executor
   (`crates/exec-core`, `crates/execd`, `crates/exchange-mcp`).
2. **One writer per account.** Only the execution channel selected in the gateway writes to an exchange account.
3. **Models only propose.** No model gets raw exchange tools; money-moving chat tools stop at a proposal that passes the code
   gates. Size, leverage and whether a trade is allowed are decided by code.
4. **Execution records move only along the transition tables** in `packages/contracts/transitions/*.json`. `clientOrderId`
   is persisted before the call; `execution_unknown` is not terminal and is resolved by reconciliation, never by a blind resend.
5. **No live money by default.** Paper and exchange demo/simulated trading are the supported modes; the OKX live flag
   (`TG_OKX_LIVE=1`) must be set explicitly.
6. **No data or secrets in the repository.** Runtime state lives in `~/.trading-swarm/` (`secrets/` is mode 600).

## Conventions

- Git: work on branches; add files by path (not `git add -A`); never commit `target/`, `node_modules/`, databases or keys.
- Node 24 (`node:sqlite` is used; no native sqlite dependency). The root `.npmrc` keeps the npm cache in `~/.cache/npm-trading-swarm`.
- Rust: when compiling several crates in parallel use a separate `CARGO_TARGET_DIR=target/<crate>` for each.
- Network: if you run behind a local proxy, keep loopback out of it (`NO_PROXY=localhost,127.0.0.1,::1`).
- Tests: TypeScript uses `vitest` (`npx vitest run` inside a package), Rust uses `cargo test`. Run `npm run check` before a PR.
- Naming: JSON/DB fields `snake_case`; enum values lowercase `snake_case`; amounts, prices and quantities are **decimal
  strings** (never floats); timestamps are **unix milliseconds**.
- Docs: design notes are mostly in Chinese, code identifiers in English; every package has a `README.md` describing its role
  and how to run its tests.
