// Development runtime with deterministic fixture CLIs: exercises the UI without real provider quota.
import { join, resolve } from 'node:path';
import { startRunner } from '../runtime/runner.mjs';
import { fixtureAdapters } from '../runtime/tests/helpers.mjs';

const root = resolve(process.env.DESZO_FIXTURE_ROOT || resolve(import.meta.dirname, '../.deszo-fixture'));
// An isolated preview may use another dev-server port (development fixture runtime only).
const extraOrigins = process.env.DESZO_FIXTURE_ROOT ? ['http://127.0.0.1:1431', 'http://localhost:1431'] : [];
const runner = await startRunner({ root, adapters: fixtureAdapters(join(root, 'fixture-state')), extraOrigins, devTestConfirmationOff: true });
console.log(`Fixture runtime on 127.0.0.1:${runner.connection.port}. Models named fixture-echo, fixture-slow-5, fixture-fail, fixture-bad-json select scenarios.`);
const shutdown = async () => { await runner.close(); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
