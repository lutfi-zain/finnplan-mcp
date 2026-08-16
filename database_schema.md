# Eve Financial Agent Expert - Database Schema & Relationship Documentation

This document describes the SQLite database architecture, schema definitions, relationships, and data modeling for the **Eve Financial Agent Expert** app.

---

## 1. Architecture & Tech Choice

- **Database Engine**: SQLite 3 (via `better-sqlite3` native C++ bindings with WAL mode enabled).
- **ORM Framework**: Drizzle ORM (`drizzle-orm/better-sqlite3`).
- **Database Path**: Stored locally at `storage/finance.db`.
- **Media Storage**: Attachment files (receipts, audio, PDFs, spreadsheets) are stored on disk under `storage/uploads/<type>/YYYY-MM/` and referenced via the `file_path` column in `transactions`.

---

## 2. Entity Relationship Diagram (ERD)

```mermaid
erDiagram
    WALLETS ||--o{ TRANSACTIONS : "1-N (Required)"
    CATEGORIES ||--o{ TRANSACTIONS : "1-N (Required)"
    BUDGETS ||--o{ TRANSACTIONS : "1-N (Nullable)"
    CATEGORIES }|--o| BUDGETS : "1-N (Nullable)"

    WALLETS {
        integer id PK
        text name
        text type
        real balance
        text currency
        text created_at
    }

    CATEGORIES {
        integer id PK
        text name
        text type
        text icon
        text created_at
    }

    BUDGETS {
        integer id PK
        text name
        integer category_id FK "Nullable"
        real amount
        text period_start
        text period_end
        text created_at
    }

    TRANSACTIONS {
        integer id PK
        integer wallet_id FK "Required"
        integer category_id FK "Required"
        integer budget_id FK "Nullable"
        real amount
        text type
        text description
        text file_path
        integer is_planned "Boolean 0/1"
        text transaction_date
        text created_at
    }
```

---

## 3. Detailed Table Schemas

### 3.1. `wallets` Table
Represents accounts or physical wallets (e.g. Cash, Bank Accounts, E-Wallets, Credit Cards).

| Column Name | SQLite Data Type | Constraints | Default | Description |
|---|---|---|---|---|
| `id` | `INTEGER` | `PRIMARY KEY AUTOINCREMENT` | - | Unique wallet identifier |
| `name` | `TEXT` | `NOT NULL` | - | Wallet name (e.g., "Cash", "Main Bank", "GoPay") |
| `type` | `TEXT` | `NOT NULL` | `'bank'` | Wallet type (`bank`, `cash`, `e-wallet`, `credit`) |
| `balance` | `REAL` | `NOT NULL` | `0.0` | Current account balance |
| `currency` | `TEXT` | `NOT NULL` | `'IDR'` | Currency code (default: Indonesian Rupiah) |
| `created_at` | `TEXT` | `NOT NULL` | - | ISO-8601 creation timestamp |

---

### 3.2. `categories` Table
Represents classification categories for financial transactions.

| Column Name | SQLite Data Type | Constraints | Default | Description |
|---|---|---|---|---|
| `id` | `INTEGER` | `PRIMARY KEY AUTOINCREMENT` | - | Unique category identifier |
| `name` | `TEXT` | `NOT NULL` | - | Category name (e.g., "Food & Beverage", "Salary") |
| `type` | `TEXT` | `NOT NULL` | `'expense'` | Category type (`expense`, `income`) |
| `icon` | `TEXT` | `NULLABLE` | - | Emoji or icon representation (e.g., 🍔, 🚗, 💰) |
| `created_at` | `TEXT` | `NOT NULL` | - | ISO-8601 creation timestamp |

---

### 3.3. `budgets` Table
Represents spending limits bounded strictly by active date windows (`period_start` to `period_end`).

| Column Name | SQLite Data Type | Constraints | Default | Description |
|---|---|---|---|---|
| `id` | `INTEGER` | `PRIMARY KEY AUTOINCREMENT` | - | Unique budget identifier |
| `name` | `TEXT` | `NOT NULL` | - | Budget name (e.g., "August Grocery Budget") |
| `category_id` | `INTEGER` | `FOREIGN KEY (categories.id) NULLABLE` | `NULL` | Linked category (Optional N-1 relationship) |
| `amount` | `REAL` | `NOT NULL` | - | Target budget limit |
| `period_start` | `TEXT` | `NOT NULL` | - | Start date of active window (YYYY-MM-DD) |
| `period_end` | `TEXT` | `NOT NULL` | - | End date of active window (YYYY-MM-DD) |
| `created_at` | `TEXT` | `NOT NULL` | - | ISO-8601 creation timestamp |

---

### 3.4. `transactions` Table
Represents individual financial transactions (actual spent/received or planned/projected items).

| Column Name | SQLite Data Type | Constraints | Default | Description |
|---|---|---|---|---|
| `id` | `INTEGER` | `PRIMARY KEY AUTOINCREMENT` | - | Unique transaction identifier |
| `wallet_id` | `INTEGER` | `FOREIGN KEY (wallets.id) NOT NULL` | - | Linked wallet ID (1-N Required) |
| `category_id` | `INTEGER` | `FOREIGN KEY (categories.id) NOT NULL` | - | Linked category ID (1-N Required) |
| `budget_id` | `INTEGER` | `FOREIGN KEY (budgets.id) NULLABLE` | `NULL` | Linked budget ID (Auto-linked or explicit) |
| `amount` | `REAL` | `NOT NULL` | - | Transaction amount (positive number) |
| `type` | `TEXT` | `NOT NULL` | `'expense'` | Transaction type (`expense`, `income`, `transfer`) |
| `description` | `TEXT` | `NULLABLE` | `NULL` | Transaction notes or description |
| `file_path` | `TEXT` | `NULLABLE` | `NULL` | Local path to receipt image, PDF, audio, or CSV |
| `is_planned` | `INTEGER` | `NOT NULL` | `0` | Financial planning flag (`0` = Actual, `1` = Planned) |
| `transaction_date` | `TEXT` | `NOT NULL` | - | Date of transaction (YYYY-MM-DD) |
| `created_at` | `TEXT` | `NOT NULL` | - | ISO-8601 creation timestamp |

---

## 4. Key Business Logic & Cardinality Rules

1. **Wallet Balance Auto-Update**:
   - When a transaction is recorded with `is_planned = 0`:
     - `type = 'expense'` subtracts `amount` from `wallets.balance`.
     - `type = 'income'` adds `amount` to `wallets.balance`.
   - When `is_planned = 1` (Planned Transaction), the wallet balance remains unchanged.

2. **Active Budget Date Windowing**:
   - Budget utilization is calculated strictly within `period_start` and `period_end`:
     $$\text{period\_start} \le \text{transaction\_date} \le \text{period\_end}$$
   - Transactions recorded outside a budget's active window are excluded from that budget's spending total.

3. **File Attachments (`file_path`)**:
   - Stores local relative or absolute path on disk for receipt images, voice notes, PDFs, or CSV exports.
   - Used by `send_attachment` tool to resend files back to Telegram upon user request.

4. **Default Seeding**:
   - Automatic DDL execution creates tables if not present on startup.
   - Auto-seeds default Cash and Bank wallets, plus 11 standard expense & income categories on first run.
