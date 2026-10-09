# Progress

- Added local `ingredient_usage` table (PK household_id+ingredient_name, FK to households) in `src/db/schema.ts`, generated `0004_ingredient_usage.sql` with drizzle-kit, added the table to `resetDb` in `src/test/db.ts`. Tests in `src/db/__tests__/ingredient-usage.test.ts`: insert and read back with defaults, duplicate PK rejected, same key allowed in two households, FK enforced.
