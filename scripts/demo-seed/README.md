# Demo seed

`seed.json` is a small, pre-made set of research content that a fresh install loads so the app is not empty on first start:

- **My strategies**: four saved strategies with their full backtest reports (equity curves, trades, in-sample / out-of-sample split, score), so the strategy pages show numbers right away. One of them has three versions from a parameter sweep.
- **Research chats**: two conversations in the research workbench (the Refine step), where the agent compiles a strategy, runs backtests, compares parameter variants against buy & hold, and diagnoses why a strategy lags buy & hold. Charts, tables, reports and the backtest runs they point to are included.

Everything is plain research data. There are no orders, positions, accounts, API keys, model connections or chat history with the trading agents.

## Import

```bash
node scripts/demo-seed/import.mjs --db <state.sqlite> --seed scripts/demo-seed/seed.json
```

| Argument | Meaning |
|---|---|
| `--db <path>` | The gateway's state database (`TG_DEMO_DB`, default `~/.trade-gate/demo/state.sqlite`). Required. |
| `--seed <path>` | The seed file, normally `scripts/demo-seed/seed.json`. Required. |
| `--dry-run` | Do everything inside a transaction, print what would happen, roll back. |
| `--quiet` | Print a one-line summary instead of the per-table table. |
| `--strict` | Treat conflicts (see below) as errors and roll back. |
| `--decision-connection <id>` | Model connection to put where the seed has `mc_redacted_N` placeholders. Defaults to the target's single `decision` role binding, if there is one. The current seed has no placeholders. |

Rules:

- The database must already exist and carry the gateway's migrations: start the gateway once, stop it, then import. `scripts/dev.sh` does this on the first start. Import while the gateway is stopped.
- It is idempotent and safe to run on every start. Rows are matched on their primary key: a row that is already there and identical is skipped; a row that is there with different values (for example a seeded strategy you renamed) is reported as a conflict and left as it is. Nothing in the target is ever overwritten or deleted.
- The whole seed goes in one transaction. Any error other than a conflict rolls everything back.

Exit codes: `0` ok (also for `--dry-run`); `1` bad arguments, unreadable seed, or an import error (rolled back); `2` database missing or schema incompatible (nothing written); `3` conflicts under `--strict` (rolled back).

## Export (maintainers)

`export.mjs` rebuilds `seed.json` from a state database. It opens the source read-only; for a running instance export a copy (`sqlite3 <live db> "VACUUM INTO '<copy>'"`).

```bash
node scripts/demo-seed/export.mjs --db <copy.sqlite> \
  --strategy <rs_id> [--strategy ...] \
  --session <research session id> [--session ...] \
  [--study <ms_id> ...] \
  --translations <translations.json> --deny <deny-words.txt> \
  --out scripts/demo-seed/seed.json
```

- `--strategy`: saved strategies, with all versions, events and linked backtest reports.
- `--session`: research chats, with messages, inquiries, steps, artifacts, the price snapshots and backtest runs they reference.
- `--study`: completed matrix (scout) studies, optional.
- `--translations`: the gateway writes research text in Chinese; this JSON (`{"exact": {...}, "templates": {...}}`, numbers written as `{0}`, `{1}`, …) turns it into English. The export stops (exit 5) if any Chinese is left and writes the remaining templates to `<out>.cjk.json`; `--allow-cjk` overrides.
- `--deny`: a local file with extra words or regexes (one per line) that must not appear in the seed; the export stops (exit 4) if one does.

Scrubbing done by the export: local session / thread / run ids that are not part of the seed are replaced; model connection ids become `mc_redacted_N`; absolute paths, `0x…` addresses, IP addresses, e-mail addresses and marketplace listing ids are replaced; worker leases and marketplace listing columns are cleared. A final gate refuses to write the seed if any of these, a secret-looking value, or a denied word is still present.
