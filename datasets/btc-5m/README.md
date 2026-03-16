# BTC 5M Historical Dataset

Historical trade and order book data from Polymarket's BTC 5-minute "Up or Down" prediction markets.

## Data Source

- **Markets**: `btc-updown-5m-{epoch}` — binary markets resolving on whether BTC price goes up or down in a 5-minute window
- **Trade API**: `data-api.polymarket.com/trades`
- **Order Book API**: `clob.polymarket.com/book`
- **Market Metadata**: `gamma-api.polymarket.com/markets`

## Database Schema

SQLite database: `btc_5m.db`

### `markets`

| Column | Type | Description |
|--------|------|-------------|
| `condition_id` | TEXT PK | Polymarket condition ID (CTF contract) |
| `question` | TEXT | Market question (e.g., "Bitcoin Up or Down - March 16, 9:40AM-9:45AM ET") |
| `slug` | TEXT | URL slug (e.g., `btc-updown-5m-1773668400`) |
| `token_yes_id` | TEXT | CLOB token ID for "Up" outcome |
| `token_no_id` | TEXT | CLOB token ID for "Down" outcome |
| `active` | INTEGER | 1 if market is active |
| `closed` | INTEGER | 1 if market has resolved |
| `accepting_orders` | INTEGER | 1 if currently accepting orders |
| `volume` | REAL | Total volume traded (USDC) |
| `start_date` | TEXT | ISO 8601 market start |
| `end_date` | TEXT | ISO 8601 market end |
| `window_start_epoch` | INTEGER | Unix epoch of the 5-minute window start |
| `fetched_at` | TEXT | When this record was fetched |

### `trades`

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `transaction_hash` | TEXT | On-chain transaction hash |
| `condition_id` | TEXT FK | References `markets.condition_id` |
| `slug` | TEXT | Market slug |
| `side` | TEXT | `BUY` or `SELL` |
| `outcome` | TEXT | `Up` or `Down` |
| `outcome_index` | INTEGER | 0=Up, 1=Down |
| `price` | REAL | Execution price (0–1 probability) |
| `size` | REAL | Trade size in shares |
| `timestamp` | INTEGER | Unix epoch of execution |
| `asset_id` | TEXT | CLOB token ID traded |
| `proxy_wallet` | TEXT | Trader's proxy wallet address |
| `fetched_at` | TEXT | When this record was fetched |

**Unique constraint**: `(transaction_hash, asset_id, side, outcome_index)`

### `order_book_snapshots`

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `condition_id` | TEXT FK | References `markets.condition_id` |
| `asset_id` | TEXT | CLOB token ID |
| `outcome` | TEXT | `Up` or `Down` |
| `snapshot_ts` | INTEGER | Unix epoch of snapshot |
| `fetched_at` | TEXT | When this record was fetched |

### `order_book_levels`

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `snapshot_id` | INTEGER FK | References `order_book_snapshots.id` |
| `side` | TEXT | `bid` or `ask` |
| `price` | REAL | Price level (0–1) |
| `size` | REAL | Size at this level |
| `level_index` | INTEGER | Depth rank (0 = best) |

### `pipeline_runs`

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `started_at` | TEXT | Pipeline start time |
| `finished_at` | TEXT | Pipeline end time |
| `trades_fetched` | INTEGER | New trades this run |
| `markets_fetched` | INTEGER | Markets with trades |
| `snapshots_fetched` | INTEGER | OB snapshots captured |
| `status` | TEXT | `running`, `success`, `validation_warnings`, `error` |

## Validation Checks

The pipeline runs five validation checks:

1. **Trade count**: ≥500 trades required
2. **Timestamp alignment**: No out-of-order timestamps within each market
3. **Gap detection**: Flags missing 5-minute windows (informational)
4. **Spread integrity**: No crossed order books (best bid < best ask)
5. **Price range**: All prices in valid (0,1) range

## Usage

### Run the pipeline

```bash
python3 datasets/btc-5m/pipeline.py
```

The pipeline is idempotent — re-running fetches new trades and appends to the existing database.

### Load in Python

```python
import sqlite3

conn = sqlite3.connect("datasets/btc-5m/btc_5m.db")
conn.row_factory = sqlite3.Row

# Get all trades sorted by time
trades = conn.execute("""
    SELECT t.*, m.question, m.window_start_epoch
    FROM trades t
    JOIN markets m ON t.condition_id = m.condition_id
    ORDER BY t.timestamp
""").fetchall()

# Get order book depth for a specific snapshot
levels = conn.execute("""
    SELECT l.*
    FROM order_book_levels l
    JOIN order_book_snapshots s ON l.snapshot_id = s.id
    WHERE s.condition_id = ?
    ORDER BY l.side, l.level_index
""", (condition_id,)).fetchall()
```

### Load in TypeScript (for paper trading harness)

```typescript
import Database from "better-sqlite3";

const db = new Database("datasets/btc-5m/btc_5m.db", { readonly: true });

const trades = db.prepare(`
  SELECT t.*, m.question, m.window_start_epoch
  FROM trades t
  JOIN markets m ON t.condition_id = m.condition_id
  ORDER BY t.timestamp
`).all();
```

## Data Model Notes

- Each BTC 5M market is a binary prediction market: "Up" (BTC price increases over 5 minutes) vs "Down"
- Prices represent implied probabilities (0.60 Up = market thinks 60% chance BTC goes up)
- The slug encodes the window start epoch: `btc-updown-5m-{epoch}` where epoch is Unix seconds
- Multiple trades can share the same timestamp (batch execution on-chain)
- Order book snapshots are point-in-time captures; the CLOB API only serves current state
