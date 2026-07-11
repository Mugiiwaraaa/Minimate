# Project Rules & Plugins
- Minimize code generation tokens using Ponytail workflows.
- Always cross-reference repository context using the active Graphify MCP server mappings.
- Pull project requirements, context, and documentation directly from the local Obsidian Vault located within this directory.

# Claude-Mem Configuration
- Continuously log conversation highlights, technical decisions, and code blocks to the local `claude-mem` database.
- Read and fetch historical project context from `claude-mem` logs before beginning complex tasks.

# Documentation & Vault Syncing
- Automatically compile and push critical project state documents into the Obsidian Vault for future reference.
- Maintain and update the following dedicated .md files inside the vault:
  1. `project-architecture.md` (System structures, file flows, and maps)
  2. `memory.md` (Background insights, core decisions, and context history)
  3. `handover.md` (Current milestones, remaining tasks, and next action steps)


