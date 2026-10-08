import { defineConfig } from 'drizzle-kit';

// Generate migrations with: yarn drizzle-kit generate
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'sqlite',
  driver: 'expo',
});
