import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()), // usr_... or UUID
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull().unique(),
  whatsappNumber: text("whatsapp_number").notNull(),
  apiKeyHash: text("api_key_hash").notNull().unique(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("users_email_idx").on(table.email),
  uniqueIndex("users_api_key_hash_idx").on(table.apiKeyHash),
]);

export const wallets = sqliteTable("wallets", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type").notNull().default("bank"),
  balance: real("balance").notNull().default(0.0),
  currency: text("currency").notNull().default("IDR"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("wallets_user_id_idx").on(table.userId),
]);

export const categories = sqliteTable("categories", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type").notNull().default("expense"),
  icon: text("icon"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("categories_user_id_idx").on(table.userId),
]);

export const budgets = sqliteTable("budgets", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  categoryId: text("category_id").references(() => categories.id, { onDelete: "set null" }),
  amount: real("amount").notNull(),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("budgets_user_period_idx").on(table.userId, table.periodStart, table.periodEnd),
  index("budgets_category_id_idx").on(table.categoryId),
]);

export const transactions = sqliteTable("transactions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  walletId: text("wallet_id")
    .notNull()
    .references(() => wallets.id, { onDelete: "cascade" }),
  targetWalletId: text("target_wallet_id")
    .references(() => wallets.id, { onDelete: "set null" }),
  categoryId: text("category_id")
    .references(() => categories.id, { onDelete: "set null" }),
  budgetId: text("budget_id").references(() => budgets.id, { onDelete: "set null" }),
  amount: real("amount").notNull(),
  adminFee: real("admin_fee").notNull().default(0.0),
  type: text("type").notNull().default("expense"), // "expense" | "income" | "transfer"
  description: text("description"),
  isPlanned: integer("is_planned").notNull().default(0), // 0 or 1
  transactionDate: text("transaction_date").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("transactions_user_date_idx").on(table.userId, table.transactionDate),
  index("transactions_wallet_id_idx").on(table.walletId),
  index("transactions_target_wallet_id_idx").on(table.targetWalletId),
  index("transactions_category_id_idx").on(table.categoryId),
  index("transactions_budget_id_idx").on(table.budgetId),
]);
