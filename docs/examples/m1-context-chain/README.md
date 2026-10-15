# M1 Context Chain Fixture

This saved core-v1 workflow exercises Text, Prompt Template, Agent, Context, and Result Viewer.

The explicit model string `explicit-test-model` targets the local CLI fixture. Before a later authorized real-provider check, replace each model with a verified explicit ID available on that account and validate the captured workflow. The example does not claim those fixture IDs are real models.

Codex proposal and revision share one run-scoped native Context. Claude has its own Context. Only the selected successful Text answer travels to the next prompt; complete native histories are not copied. The final Codex answer uses its own native history plus Claude's explicit review.

M1 needs the complete journal. M2 supplies read-only Next/Prev. The workflow is documentation data; the existing fixed-graph prototype cannot load it yet.

Capacity comes from application settings, shared with every other workspace; workflow settings contain only nativeConfiguration. New mode maps the two Context declarations to fresh UUID bindings in each run. Switching to Continue requires explicit selection of an existing compatible UUID binding.
