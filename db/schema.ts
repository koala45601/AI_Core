import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const appSettings = sqliteTable("app_settings", {
  id: text("id").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const memories = sqliteTable(
  "memories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    content: text("content").notNull(),
    normalizedContent: text("normalized_content").notNull().unique(),
    source: text("source").notNull().default("manual"),
    category: text("category").notNull().default("general"),
    sourceChatId: text("source_chat_id"),
    confidence: integer("confidence").notNull().default(80),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    lastUsedAt: integer("last_used_at"),
    updatedAt: integer("updated_at").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_memories_created_at").on(table.createdAt), index("idx_memories_pinned").on(table.pinned)],
);

export const chats = sqliteTable(
  "chats",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    rollingSummary: text("rolling_summary").notNull().default(""),
    status: text("status").notNull().default("active"),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    messageCount: integer("message_count").notNull().default(0),
    lastPreview: text("last_preview").notNull().default(""),
    summarizedMessageCount: integer("summarized_message_count").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_chats_updated_at").on(table.updatedAt), index("idx_chats_status_pinned").on(table.status, table.pinned)],
);

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    responseTokens: integer("response_tokens").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_chat_messages_chat_sequence").on(table.chatId, table.sequence)],
);

export const messageFeedback = sqliteTable(
  "message_feedback",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id").notNull().references(() => chatMessages.id, { onDelete: "cascade" }),
    rating: integer("rating").notNull(),
    correction: text("correction").notNull().default(""),
    rememberCorrection: integer("remember_correction", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_message_feedback_message").on(table.messageId)],
);
