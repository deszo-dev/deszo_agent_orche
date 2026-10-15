# ADR-0001 sixth review

Date: 2026-10-15  
Subject: [ADR-0001](../adr/0001-external-workflow-authoring-api-and-mcp.md), as amended after the [fifth review](2026-10-15-adr-0001-fifth-review.md)  
Verdict: **Ready for the user's acceptance decision. No open findings.** The two notes below are implementation guidance for Stage 1 and Stage 2; they need no ADR change.

## Status of the fifth-review points

| Point | Status |
| --- | --- |
| ADR5-01 uncaptured runner stdout | Resolved. The first-party token is emitted only with the private `--first-party-token-stdout` option and only to a non-TTY pipe. A hand-started runner omits it by default, and the release scenarios cover an ordinary terminal launch |
| ADR5-02 IPC eligibility | Resolved. Eligibility depends on the loaded bundled frontend in every build profile: `tauri build --debug` qualifies, while `tauri dev` on `devUrl` does not |
| ADR5-03 fixture policy in packaged builds | Resolved. `--dev-test-confirmation-off` is accepted only by the unbundled source runner. `scripts/bundle-runtime.mjs` compiles it out, and a packaged-runner check proves it is rejected. The closed-app residual (a same-account agent launching its own runtime and receiving its first-party token) is now stated, with the OS account and runtime lock named as the limits |
| ADR5-04 "unguessable" request ID | Resolved; the wording is removed |

## Implementation notes

- **Compiling the option out:** [bundle-runtime.mjs](../../scripts/bundle-runtime.mjs) is a plain esbuild bundle today. An esbuild `define` constant (for example, `__DESZO_PACKAGED__: 'true'`) guarding the option parser lets dead-code elimination remove the fixture path. The required packaged-runner rejection check then verifies the result, rather than relying on the absence of a code path.
- **Pipe detection on Windows:** "stdout is a pipe, never a terminal" should be implemented and tested on the shipping platform. `process.stdout.isTTY` reliably excludes consoles. Telling a pipe from a file redirect (`fs.fstatSync(1).isFIFO()`) depends on how libuv reports Windows named pipes. The explicit launcher option is the real control. If file-redirect detection proves unreliable on Windows, document "option and not a TTY" as the enforced rule rather than claiming pipe-only.

## Recommendation

Accept ADR-0001 when you are satisfied with the architecture, and record the acceptance in the [decision register](../DECISIONS.md) (P23). Implementation still requires a separate instruction and starts with the Stage 1 contract package.
