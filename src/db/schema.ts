import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  userId: text("user_id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userFirstName: text("user_first_name").notNull(),
  userLastName: text("user_last_name").notNull(),
  userEmail: text("user_email").notNull().unique(),
  userWhatsappNumber: text("user_whatsapp_number").notNull(),
  userApiKeyHash: text("user_api_key_hash").notNull().unique(),
  userCreatedAt: text("user_created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("users_email_idx").on(table.userEmail),
  uniqueIndex("users_api_key_hash_idx").on(table.userApiKeyHash),
]);

export const wallets = sqliteTable("wallets", {
  walletId: text("wallet_id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  walletUserId: text("wallet_user_id")
    .notNull()
    .references(() => users.userId, { onDelete: "cascade" }),
  walletName: text("wallet_name").notNull(),
  walletInstitution: text("wallet_institution").notNull().default("General"),
  walletType: text("wallet_type").notNull().default("bank"),
  walletBalance: real("wallet_balance").notNull().default(0.0),
  walletCurrency: text("wallet_currency").notNull().default("IDR"),
  walletCreatedAt: text("wallet_created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("wallets_user_id_idx").on(table.walletUserId),
  index("wallets_institution_idx").on(table.walletInstitution),
]);

export const categories = sqliteTable("categories", {
  categoryId: text("category_id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  categoryUserId: text("category_user_id")
    .notNull()
    .references(() => users.userId, { onDelete: "cascade" }),
  categoryName: text("category_name").notNull(),
  categoryType: text("category_type").notNull().default("expense"),
  categoryIcon: text("category_icon"),
  categoryCreatedAt: text("category_created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("categories_user_id_idx").on(table.categoryUserId),
]);

export const budgets = sqliteTable("budgets", {
  budgetId: text("budget_id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  budgetUserId: text("budget_user_id")
    .notNull()
    .references(() => users.userId, { onDelete: "cascade" }),
  budgetName: text("budget_name").notNull(),
  budgetCategoryId: text("budget_category_id").references(() => categories.categoryId, { onDelete: "set null" }),
  budgetAmount: real("budget_amount").notNull(),
  budgetPeriodStart: text("budget_period_start").notNull(),
  budgetPeriodEnd: text("budget_period_end").notNull(),
  budgetCreatedAt: text("budget_created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("budgets_user_period_idx").on(table.budgetUserId, table.budgetPeriodStart, table.budgetPeriodEnd),
  index("budgets_category_id_idx").on(table.budgetCategoryId),
]);

export const transactions = sqliteTable("transactions", {
  transactionId: text("transaction_id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  transactionUserId: text("transaction_user_id")
    .notNull()
    .references(() => users.userId, { onDelete: "cascade" }),
  transactionWalletId: text("transaction_wallet_id")
    .notNull()
    .references(() => wallets.walletId, { onDelete: "cascade" }),
  transactionTargetWalletId: text("transaction_target_wallet_id")
    .references(() => wallets.walletId, { onDelete: "set null" }),
  transactionCategoryId: text("transaction_category_id")
    .references(() => categories.categoryId, { onDelete: "set null" }),
  transactionBudgetId: text("transaction_budget_id").references(() => budgets.budgetId, { onDelete: "set null" }),
  transactionAmount: real("transaction_amount").notNull(),
  transactionAdminFee: real("transaction_admin_fee").notNull().default(0.0),
  transactionType: text("transaction_type").notNull().default("expense"), // "expense" | "income" | "transfer"
  transactionDescription: text("transaction_description"),
  transactionIsPlanned: integer("transaction_is_planned").notNull().default(0), // 0 or 1
  transactionDate: text("transaction_date").notNull(), // ISO-8601 string with timezone
  transactionCreatedAt: text("transaction_created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("transactions_user_date_idx").on(table.transactionUserId, table.transactionDate),
  index("transactions_wallet_id_idx").on(table.transactionWalletId),
  index("transactions_target_wallet_id_idx").on(table.transactionTargetWalletId),
  index("transactions_category_id_idx").on(table.transactionCategoryId),
  index("transactions_budget_id_idx").on(table.transactionBudgetId),
]);
