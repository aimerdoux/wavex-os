import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const corporateInquiries = pgTable("corporate_inquiries", {
  id: text("id").primaryKey(),
  companyName: text("company_name").notNull(),
  contactName: text("contact_name").notNull(),
  contactEmail: text("contact_email").notNull(),
  headcount: text("headcount").notNull(),
  eventType: text("event_type").notNull(),
  preferredDates: text("preferred_dates"),
  budgetRange: text("budget_range"),
  message: text("message"),
  bookingSource: text("booking_source").notNull().default("corporate"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CorporateInquiry = typeof corporateInquiries.$inferSelect;
export type NewCorporateInquiry = typeof corporateInquiries.$inferInsert;
