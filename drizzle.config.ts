import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

// Load env from the same files Next.js uses, in precedence order.
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const url = process.env.DATABASE_URL_MIGRATE ?? process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL_MIGRATE (or DATABASE_URL) must be set. See .env.example."
  );
}

export default defineConfig({
  schema: "./src/lib/db/schema/index.ts",
  out: "./src/lib/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url },
  casing: "snake_case",
  strict: true,
  verbose: true,
});
