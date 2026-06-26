# Personal Spending Studio

A private, local-only dashboard for analyzing personal bank / credit-card
transactions. Built with **Vite + React + Recharts** ([`spending-studio.jsx`](spending-studio.jsx)).
All data stays on your machine and is **git-ignored** — nothing financial is ever
committed (see [Privacy](#privacy)).

---

## Quick start

```bash
cd spendings
npm install
npm run dev        # http://localhost:5173 (opens automatically)
# npm run build / npm run preview for a production bundle
```

---

## Data layout

All source data lives under **`source/data/`** (git-ignored):

```
spendings/
  source/data/
    accountactivity*.csv        # raw bank exports (one per statement/download)
    all-expenses-source.csv     # the PROCESSED, unified source the app imports
    *.bak / *.bak2              # backups
  category-rules.json           # saved categorization overrides (git-ignored)
  spending-studio.jsx           # the app
  vite.config.js                # dev server + /__rules persistence endpoint
```

> **Note:** the app's source file was moved under the data folder. The app imports
> it via:
> ```js
> import CSV_RAW from "./source/data/all-expenses-source.csv?raw";
> ```
> (previously `./all-expenses-source.csv`). Restart `npm run dev` after changing it
> — Vite inlines it at build time via the `?raw` import.

### Adding new statements

Drop fresh bank exports (`accountactivity*.csv`) into `source/data/`, then:

```bash
npm run consolidate                 # merge new transactions into all-expenses-source.csv
npm run consolidate -- --card="Visa"  # label the new rows' card
```

The merge ([`scripts/consolidate.mjs`](scripts/consolidate.mjs)) is **additive and
non-destructive**: it keeps every existing transaction (and its curated category),
appends only rows not already present (matched by date + description + amount,
tagged `Uncategorized`), backs up the previous file to `.bak`, and is a no-op when
there's nothing new.

### `all-expenses-source.csv` schema

A header row plus one row per transaction:

```
date,card,description,category,flow,debit,credit,running_balance
```

| Column | Meaning |
|---|---|
| `date` | `YYYY-MM-DD` (months are derived from `date.slice(0,7)`) |
| `card` | card/account label (drives the **card filter**) |
| `description` | raw merchant string |
| `category` | default category (overridable in-app) |
| `flow` | debit/credit direction (informational) |
| `debit` | amount spent (→ `amount`) |
| `credit` | amount received |
| `running_balance` | account balance after the txn |

The raw `accountactivity*.csv` exports use the bank's own column order; they're the
inputs you consolidate into `all-expenses-source.csv`.

---

## Features

Six tabs (top nav):

- **Overview** — totals, daily-average spend, balance trend, headline numbers for
  the selected period.
- **Transactions** — searchable/filterable ledger; re-categorize a single
  transaction or a whole provider inline; attach notes.
- **Categories** — spend by category with icons/colors; **mute** categories to
  exclude them from totals.
- **Analyze** — breakdowns and comparisons (category & monthly charts: area / bar /
  pie / line via Recharts).
- **Forecast** — projections from full-month averages (first & last partial months
  excluded; short- vs long-run averages).
- **Lifestyle** — recurring-spend and habit view (merchants appearing in ≥3
  distinct months are flagged as recurring).

Cross-cutting controls:

- **Period window** — inclusive from/to month selectors.
- **Card filter** — limit to one card/account.
- **Category muting** — drop noisy categories from totals.

### Categorization rules

Re-categorizations persist to **`category-rules.json`** via a small dev endpoint in
[`vite.config.js`](vite.config.js):

- `GET /__rules` → current rules
- `POST /__rules` → validated overwrite

Resolution order per transaction: **single-line override → provider rule → CSV
default**. A *provider rule* normalizes merchant variants (e.g. `BC HYDRO R9Q3J8`
and `BC HYDRO L3K5W2` collapse to one provider) so one assignment covers all its
transactions. Notes can be attached per provider or per transaction.

---

## Privacy

This app handles **real financial data**. [`.gitignore`](.gitignore) keeps it out
of git:

- **`*.csv`, `source/data/`** — all bank exports and the processed source.
- **`*.bak` / `*.bak2`** — backups.
- **`category-rules.json`** — derived from your spending (may contain merchant
  notes).
- `node_modules/`, `dist/`, `.claude/settings.local.json`, OS junk.

The application code (`spending-studio.jsx`, `main.jsx`, `index.html`,
`vite.config.js`) contains **no embedded transaction data** — everything is read at
runtime from `source/data/all-expenses-source.csv`. Only that source/config code is
committed.
</content>
