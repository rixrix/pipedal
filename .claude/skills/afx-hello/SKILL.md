---
name: afx-hello
description: Verify AFX installation and environment — detect the AI provider, confirm skill availability, and show a project health snapshot. Use for onboarding, troubleshooting, or a quick multi-provider vibe check. Triggers on "is AFX working?", "hello AFX", "vibe check", or "verify AFX install".
license: MIT
allowed-tools: Read Grep Glob Bash
metadata:
  afx-owner: "@rix"
  afx-tags: "workflow,diagnostics,environment,onboarding"
---

# /afx-hello

Environment diagnostics and AFX installation verification. Useful for onboarding, troubleshooting, and confirming the framework is correctly configured.

## Usage

```bash
/afx-hello
```

## Execution Contract (STRICT)

### Allowed

- Read/list/search files anywhere in workspace
- Read `.afx.yaml` configuration
- Check for presence of skill files, templates, and spec directories

### Forbidden

- Create/modify/delete any files
- Run build/test/deploy/migration commands

If changes are requested, return:

```text
Out of scope for /afx-hello (read-only diagnostics mode). Use /afx-scaffold to scaffold or /afx-spec to manage specs.
```

### Timestamp Format (MANDATORY)

When writing execution reports or creating journal entries, all timestamps MUST use ISO 8601 with millisecond precision: `YYYY-MM-DDTHH:MM:SS.mmmZ` (e.g., `2025-12-17T14:30:00.000Z`). Never write short formats like `2025-12-17 14:30`. **To get the current timestamp**, run `date -u +"%Y-%m-%dT%H:%M:%S.000Z"` via the Bash tool — do NOT guess or use midnight (`T00:00:00.000Z`).

## Post-Action Checklist (MANDATORY)

Since this is a read-only diagnostics skill, no files are modified. However, after executing, you MUST:

1. Verify all checks are completed as listed in the Output Format.

### Surfacing Notable Findings

`/afx-hello` is read-only and never writes `journal.md` or any file. When it finds a critical environment configuration gap, surface it in the diagnostics output and recommend `/afx-session note` so the user can capture it. Do not write the journal directly.

---

## Agent Instructions

### Trailing Parameters

When trailing arguments are passed (e.g., `/afx-hello tools only`, `/afx-hello skip auth`), treat them as keyword filters to scope the diagnostic output. This command is context-agnostic — it does not infer feature context from IDE state or cwd.

### Next Command Suggestion (MANDATORY)

**CRITICAL**: After EVERY `/afx-hello` action, suggest the most appropriate next command based on context (e.g., `/afx-next` or `/afx-scaffold`).

### Diagnostics Process

When invoked, perform these checks and report results:

1. **AI Provider Detection**
   - Identify which AI agent is running (Claude Code, Copilot, Cursor, Cline, Codex, etc.)
   - Report model name if available

2. **AFX Installation Check**
   - `.afx.yaml` exists and is parseable
   - `.claude/skills/` directory exists with skill files
   - `.agents/skills/` directory exists (if multi-agent)
   - `CLAUDE.md` exists and references AFX

   **Detect the install method.** AFX skills reach a project two ways, and the expected file layout differs:

   | Signal                                                             | Install method     | Expected                                                  |
   | ------------------------------------------------------------------ | ------------------ | --------------------------------------------------------- |
   | Skills present in `.claude/skills/` or `.agents/skills/`           | `afx-cli`          | `.afx.yaml`, `CLAUDE.md`/`AGENTS.md`, `docs/` all present |
   | Skills running but absent from those dirs (loaded from the plugin) | Claude Code plugin | Skills only — no `.afx.yaml`, no `CLAUDE.md` wiring       |

   A plugin install with no `.afx.yaml` is **not a broken install** — the plugin ships skills only. Report it as an actionable gap, not an error, and recommend `/afx-scaffold init` to write a minimal config. Do not create the file yourself; this skill is read-only.

3. **Skill Availability**
   - List all installed AFX skills (scan skill directories)
   - Flag any expected skills that are missing

4. **Project Health Snapshot**
   - Count specs under `docs/specs/` (total, by status if parseable)
   - Check for `.afx.yaml` config completeness
   - Report any obvious issues (missing templates dir, broken paths)

### Output Format

```markdown
## AFX Environment Check

**Agent**: Claude Code (claude-opus-4-6)
**Workspace**: /path/to/project
**Install method**: afx-cli

### Installation

| Component       | Status | Path                        |
| --------------- | ------ | --------------------------- |
| .afx.yaml       | ✓      | .afx.yaml                   |
| CLAUDE.md       | ✓      | CLAUDE.md                   |
| Skills (Claude) | ✓      | .claude/skills/ (14 skills) |
| Skills (Agents) | ✓      | .agents/skills/ (14 skills) |
| Templates       | ✓      | Bundled in skill assets/    |

### Project Health

| Metric      | Value |
| ----------- | ----- |
| Total Specs | 12    |
| Draft       | 3     |
| Approved    | 9     |
| Superseded  | 0     |

### Quick Start

Ready to go! Try:
/afx-next # What should I do now?
/afx-spec create <name> # Start a new feature
/afx-discover capabilities # Explore the project
```

**Plugin install with no config** — report the gap and the one-step fix:

```markdown
## AFX Environment Check

**Agent**: Claude Code (claude-opus-4-6)
**Workspace**: /path/to/project
**Install method**: Claude Code plugin (afx@afx)

### Installation

| Component  | Status | Note                                       |
| ---------- | ------ | ------------------------------------------ |
| Skills     | ✓      | 18 loaded from plugin                      |
| Templates  | ✓      | Bundled in skill assets/                   |
| .afx.yaml  | ✗      | Not created — the plugin ships skills only |
| docs/specs | ✗      | Not created                                |

### Next Step

Run `/afx-scaffold init` to write a minimal `.afx.yaml` and create `docs/specs/` + `docs/adr/`.

For full project setup (CLAUDE.md wiring, framework docs, multi-agent skills),
use the installer instead: `curl -sL https://raw.githubusercontent.com/AgenticFlowX/afx/main/afx-cli | bash -s -- .`
```
