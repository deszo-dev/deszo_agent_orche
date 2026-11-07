# Instructions for Coding Agents Working on Deszo v2

## Documentation Language — Mandatory

**Use English for all Deszo v2 documentation.**

- Create and update all documentation inside `v2/` in English only.
- This includes all `README.md` files, ADRs, architecture and system-design documents, specifications, plans, guides, operational instructions, and source-code documentation comments.
- Keep headings, narrative text, explanatory examples, and newly introduced documentation content in English.
- When migrating legacy material into `v2/`, translate its documentation into English as part of that migration.
- Do not change or translate legacy documentation outside `v2/` solely to satisfy this policy.
- When v2 is promoted to the repository root, continue using English for its documentation.

## Workspace Boundaries

- Develop new v2 code and documentation within `v2/`.
- Treat files outside `v2/` as legacy unless an explicit migration decision says otherwise.
- Do not delete, relocate, or rewrite legacy implementation automatically.
- Preserve existing Deszo behavior while v2 is being developed.
- Treat the container-native architecture as a proposal until decisions are explicitly accepted.

See [README.md](./README.md) for the full transition policy.
