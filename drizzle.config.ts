import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/infrastructure/sqlite/tables.ts',
  out: './migrations',
  dbCredentials: { url: './runs.sqlite' },
  strict: true,
  verbose: true,
});
