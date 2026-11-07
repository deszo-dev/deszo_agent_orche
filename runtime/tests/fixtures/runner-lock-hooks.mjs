// Test-only module hooks for runner.lock proofs (loaded with --import ./runner-lock-register.mjs; never by the runtime itself). For runtime/lock.mjs
// only, `node:sqlite` resolves to a wrapper that can hold every contender at the lock database until all of them have arrived, and `node:fs` to
// one that records each marker operation. The lock's own logic is unchanged.
export async function resolve(specifier, context, next) {
  if (/\/runtime\/lock\.mjs$/.test(context.parentURL ?? '')) {
    if (specifier === 'node:sqlite') return { url: new URL('./runner-lock-sqlite.mjs', import.meta.url).href, shortCircuit: true };
    if (specifier === 'node:fs') return { url: new URL('./runner-lock-fs.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
