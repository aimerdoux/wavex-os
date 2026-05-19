import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const memberships = pgTable("memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id"),
  planType: text("plan_type", { enum: ["annual", "monthly"] }).notNull(),
  status: text("status", { enum: ["active", "cancelled", "past_due"] })
    .notNull()
    .default("active"),
  stripeSubscriptionId: text("stripe_subscription_id").unique(),
  stripeCustomerId: text("stripe_customer_id"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
