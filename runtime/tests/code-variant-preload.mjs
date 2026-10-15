// Test-only provider variation (follow-up review F2): a second implementation writes different, valid source bytes.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.writeFileSync;
fs.writeFileSync = (path, data, ...rest) => {
  if (/src[\\/](auth|resume)\.mjs$/.test(String(path))) data = Buffer.concat([Buffer.from(data), Buffer.from('\n// Second accepted implementation for the provenance audit.\n')]);
  return original(path, data, ...rest);
};
syncBuiltinESMExports();
