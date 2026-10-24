import { existsSync } from 'node:fs';

// One catalogue for the store, bundle and operator preflight. Never infer support from stray SQL files.
export const MIGRATION_FILES = Object.freeze([
  'm1.sql', 'm2.sql', 'm3.sql', 'm4.sql', 'm5.sql', 'm6.sql',
  'm7.sql', 'm8.sql', 'm9.sql', 'm10.sql', 'm11.sql', 'm12.sql', 'm13.sql', 'm14.sql',
]);
export const MIGRATION_PATHS = MIGRATION_FILES.map((name, index) => {
  if (index === 0 && process.env.DESZO_DDL_PATH) return process.env.DESZO_DDL_PATH;
  const bundled = new URL(`./${name}`, import.meta.url);
  return existsSync(bundled) ? bundled : new URL(`../../docs/storage/${name}`, import.meta.url);
});
