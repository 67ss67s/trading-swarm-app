# Contributing

Architecture and security boundaries: `docs/ARCHITECTURE.md`. Runtime API contract: `docs/demo/v3-ui-contract.md`.
Data contracts: `packages/contracts/` (JSON Schema is the single source; the TypeScript and Rust types are generated from
and checked against it).

## Hard boundaries

1. **Exchange credentials stay out of the TypeScript process.** The gateway, web UI and scripts never hold an exchange API
   key/secret, OAuth token or PKCE verifier. Orders are signed by the exchange CLI (`okx`, `binance-cli`) or by the Rust
   executor (`crates/exec-core`, `crates/execd`, `crates/exchange-mcp`).
2. **One writer per account.** Only the execution channel selected in the gateway writes to an exchange account.
3. **Models only propose.** No model gets raw exchange tools; money-moving chat tools stop at a proposal that passes the code
   checks. Size, leverage and whether a trade is allowed are decided by code.
4. **Execution records move only along the transition tables** in `packages/contracts/transitions/*.json`. `clientOrderId`
   is persisted before the call; `execution_unknown` is not terminal and is resolved by reconciliation, never by a blind resend.
5. **No live money by default.** Paper and exchange demo trading are the supported modes; a live OKX profile needs
   `TG_OKX_LIVE=1` set explicitly.
6. **No data or secrets in the repository.** Runtime state lives in `~/.trade-gate/` (`secrets/` is mode 600).

## Getting started

```bash
npm install
npm run dev          # gateway on 127.0.0.1:18800, UI on 127.0.0.1:5180, paper execution
```

## Conventions

- Git: work on branches; add files by path; never commit `target/`, `node_modules/`, databases or keys.
- Node 24 (`node:sqlite` is used; no native sqlite dependency). The root `.npmrc` keeps the npm cache in `~/.cache/npm-trade-gate`.
- Rust: when compiling several crates in parallel use a separate `CARGO_TARGET_DIR=target/<crate>` for each.
- Network: if you run behind a local proxy, keep loopback out of it (`NO_PROXY=localhost,127.0.0.1,::1`).
- Tests: TypeScript uses `vitest` (`npx vitest run` inside a package), Rust uses `cargo test`. Run `npm run check` before a PR.
- Naming: JSON/DB fields `snake_case`; enum values lowercase `snake_case`; amounts, prices and quantities are **decimal
  strings** (never floats); timestamps are **unix milliseconds**.
- Docs: many design notes under `docs/` are in Chinese; code identifiers are in English. Every package has a `README.md`
  describing its role and how to run its tests.
