// P6-DECISION-C: runs inside an AppContainer through `node -e` (the main-module path walk fails there; see the report). It reports
// only outcomes, never a secret value. It writes node-ac.json in the granted folder, which is the process working directory.
const fs = require('node:fs');
const path = require('node:path');
const dir = process.cwd();
const out = { tests: [], envKeyCount: Object.keys(process.env).length };
function attempt(name, action) {
  try { out.tests.push({ name, result: 'allowed', detail: String(action()) }); }
  catch (error) { out.tests.push({ name, result: 'denied', detail: String(error.code || error.message).slice(0, 160) }); }
}
attempt('write_granted_folder', () => { fs.writeFileSync(path.join(dir, 'node-ac-probe.txt'), 'ok'); return 'written'; });
attempt('read_granted_folder', () => fs.readFileSync(path.join(dir, 'probe.js'), 'utf8').length);
attempt('read_private_not_granted', () => fs.readFileSync(path.join(process.env.DECISION_C_PRIVATE, 'secret.txt'), 'utf8').length);
attempt('write_private_not_granted', () => { fs.appendFileSync(path.join(process.env.DECISION_C_PRIVATE, 'store-probe-node.txt'), 'x'); return 'written'; });
attempt('node_sqlite_open_private_store', () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(process.env.DECISION_C_PRIVATE, 'store.sqlite'));
  db.close();
  return 'opened';
});
fs.writeFileSync(path.join(dir, 'node-ac.json'), JSON.stringify(out));
