# Deszo v2 — Next-Generation Agent Orchestrator

> **Status: early development / isolated workspace.**  
> This directory is where the next version of Deszo is designed and developed. Its existence does not mean that v2 is complete or has replaced the current implementation.

## Purpose

The `v2/` directory is a dedicated development workspace within the existing repository. New v2 components, configuration, tests, and documentation belong here so they remain separate from the implementation currently located at the repository root.

The proposed direction is a **container-native Agent Orchestrator** with a Rust control plane, local and potentially remote Execution Nodes, Docker Runtime Pools for Codex/Claude/AGY, separate Agent / Session / CLI Invocation / Container concepts, and Workspaces whose lifetime does not depend on containers. This is a **design direction under evaluation**, not a declaration that these decisions are final or already implemented.

The overview diagram and related design notes live in the separate System Design repository:

- [deszo_agent_orche_SD / container_native_architecture.excalidraw](https://github.com/deszo-dev/deszo_apps_system_design/blob/main/deszo_agent_orche_SD/container_native_architecture.excalidraw)
- [deszo_agent_orche_SD / README.md](https://github.com/deszo-dev/deszo_apps_system_design/blob/main/deszo_agent_orche_SD/README.md)

## Documentation language policy

**English is the required language for all Deszo v2 documentation.**

- Write all new and revised documentation under `v2/` **in English only**, including `README.md` files, architecture and system-design documents, ADRs, specifications, implementation plans, developer guides, operational instructions, and documentation embedded in source code.
- Use English for documentation titles, headings, descriptions, examples, and explanatory text.
- Do not introduce Russian-language documentation into `v2/`. If existing material is brought into v2 from the legacy codebase, translate its documentation to English as part of that migration.
- This rule applies to documentation authored by both humans and coding agents. It does **not** require translating the legacy documentation outside `v2/` before it is migrated.
- The same English-only rule remains in force after the contents of `v2/` are promoted to the repository root.

See [AGENTS.md](./AGENTS.md) for the agent-facing instruction.

## Rules During the Transition

1. **Create new v2 implementation inside `v2/`.** Do not add v2 code to the existing root-level `runtime/`, `src/`, `src-tauri/`, `lifecycle-host/`, or other legacy directories without an explicit, justified decision.
2. **Treat everything outside `v2/` as the current or legacy implementation** until it has been inventoried and migrated. Do not automatically consider it part of v2.
3. **Assess each existing component individually.** Either move it into `v2/` (and redesign it where needed), or mark it as unnecessary and remove it later. Migration does not mean copying the old architecture without review.
4. **Do not automatically delete anything outside `v2/`.** Before removing or moving files, check dependencies, required data, tests, documentation, and recovery options. Make changes deliberately and in separately verifiable steps.
5. **Do not break the current implementation for the sake of v2.** The legacy and v2 workspaces may coexist temporarily. Any shared dependencies must be explicit and temporary.
6. **Until v2 is ready, the repository root remains the current workspace.** Development inside `v2/` alone does not switch the project to the new version.

## End State

When v2 is complete, validated, and explicitly approved to replace the current implementation:

1. Confirm the scope of the new version and an approved migration plan.
2. Move any remaining required components and data into `v2/`; exclude obsolete legacy components.
3. Validate the build, tests, startup, data recovery, and essential end-to-end behavior of the new version.
4. **Promote the contents of `v2/` to the repository root**, making them the new primary Deszo workspace. Do not retain `v2/` as a required permanent application directory.
5. Remove obsolete root-level files only after confirming their replacements; update paths, CI/CD, documentation, build tooling, and startup instructions as necessary.
6. Preserve Git history and perform the promotion as a separate, verifiable change.

After the transition, **the new Deszo implementation lives directly at the root of `deszo_agent_orche`**, and the temporary `v2/` directory is no longer required.

## Important

This README defines the development workspace and future migration strategy. It does not authorize mass deletion of existing code, production changes, automatic file moves, or replacement of accepted architectural decisions. The specific ADRs, contracts, dependencies, and v2 acceptance criteria must be established during the design process.
