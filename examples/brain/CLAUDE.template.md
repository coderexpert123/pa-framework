<!--
# Agentic Brain Template

Copy this file to YOUR project root as CLAUDE.md. Then enroll it in ~/.pa/brain-files.json:

{
  "root": "<your-project-root>",
  "files": [
    {
      "path": "CLAUDE.md",
      "markers": ["<!-- AUTO:SKILL-INVENTORY -->", "<!-- AUTO:FILE-INVENTORY -->"]
    }
  ]
}

The update-brain skill (examples/skills/update-brain/skill.md) maintains sections
between the AUTO markers. Keep the markers intact — they are how the skill finds
where to insert updates.

For the CLAUDE.md alias convention (AGENTS.md/GEMINI.md as links), see:
https://github.com/coderexpert123/pa-framework/blob/main/docs/CONVENTIONS.md
-->

# <Project> — Agentic Brain

The Agentic Brain is a knowledge management architecture for this project.

## Intelligence layers

Knowledge organized by abstraction level, from raw data at the bottom to synthesized conclusions at the top. Each layer cites the layer below it, creating a traceable chain.

**Example layers:**
- **Layer 1 (raw data):** Inputs, measurements, external sources — time-stamped and verifiable
- **Layer 2 (analysis):** Processing, patterns, intermediate findings — with source citations
- **Layer 3 (decisions):** Conclusions, tradeoffs, chosen directions — traceable to analysis
- **Layer 4 (action):** Implementation notes, execution rationale — linked to decisions

Add, remove, or rename layers to match what your project actually is.

## Brain files

Navigational indexes that help you find knowledge, not hold it. A file is a brain file if removing it would make other content harder to find. Each brain file has a "when to consult" purpose.

**When to add a brain file entry:**
- The file exists and is consulted during work
- It serves as a navigation aid (index, catalog, registry)
- Removing it would make finding information harder

<!-- AUTO:FILE-INVENTORY START -->
<!-- AUTO:FILE-INVENTORY END -->

## Connections

The dependency graph showing how files reference each other and where changes cascade.

Document cross-file dependencies:
- If A changes, what else needs review?
- Where do decisions propagate?
- What files reference each other?

<!-- AUTO:SKILL-INVENTORY START -->
<!-- AUTO:SKILL-INVENTORY END -->

## File inventory

The project's real knowledge locations, wherever they live (not just the local directory).

Track:
- Source code directories and their purposes
- Data directories (raw, processed, exports)
- External systems or services this project integrates with
- Where logs, state, and runtime artifacts live

---

## Alias convention (optional)

For convenience, create filesystem links so agents can find this brain under common names:
- `AGENTS.md` → `CLAUDE.md` (symbolic link preferred, hard link as fallback on Windows)
- `GEMINI.md` → `CLAUDE.md` (same)

This lets tooling that expects one of those names find your brain regardless of which alias it uses.
