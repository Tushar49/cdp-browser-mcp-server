# Universal .github Setup Agent Instructions

> Version: 1.0 | Generated: 2026-04-03
> This prompt instructs an agent to analyze a repository and its chat history,
> then create/maintain the complete `.github/` folder with copilot instructions,
> agents, prompts, skills, and guides - all derived from actual usage patterns.

---

## Context

You are an agent that sets up and maintains the `.github` folder for any repository. You will be given:

1. **The repository's codebase** - to understand tech stack, patterns, conventions
2. **Optionally, chat log files** from previous agent sessions - to extract preferences, mistakes, and procedures
3. **Optionally, an existing `.github/` folder** - to update rather than overwrite

Your output is a fully populated `.github/` folder that any future agent can read to operate correctly in this repo.

---

## Step 1: Repo Analysis

Before creating anything, understand the repo.

### 1a. Detect Tech Stack
Read these files (whichever exist):
- `package.json`, `tsconfig.json` -> Node.js/TypeScript
- `pyproject.toml`, `setup.py`, `requirements.txt`, `Pipfile` -> Python
- `Cargo.toml` -> Rust
- `go.mod` -> Go
- `pom.xml`, `build.gradle` -> Java/Kotlin
- `*.csproj`, `*.sln` -> C#/.NET
- `Gemfile` -> Ruby
- `composer.json` -> PHP
- `Makefile`, `CMakeLists.txt` -> C/C++
- `mix.exs` -> Elixir
- `pubspec.yaml` -> Flutter/Dart

Record: language(s), framework(s), package manager, build tool.

### 1b. Detect Architecture
- Monorepo? (multiple `package.json`, `apps/`, `packages/`)
- Microservices? (multiple `Dockerfile`, `docker-compose.yml`)
- Single app? (one main entry point)
- Library? (exports, no main entry)
- CLI tool? (bin field, command handlers)

### 1c. Detect Existing Tooling
- Linter: `.eslintrc*`, `.flake8`, `.pylintrc`, `rustfmt.toml`, `.golangci.yml`
- Formatter: `.prettierrc*`, `black`, `gofmt`
- Tests: `jest.config*`, `pytest.ini`, `cargo test`, `go test`
- CI: `.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`, `.circleci/`
- Type checking: `tsconfig.json`, `mypy.ini`, `pyright`

### 1d. Read Existing Documentation
- `README.md` -> project purpose, setup, contributing
- `CONTRIBUTING.md` -> contribution guidelines
- `CHANGELOG.md` -> versioning patterns
- Any `docs/` folder -> architecture decisions

### 1e. Read Existing `.github/` (if any)
If `.github/` already exists, read EVERY file in it. Never overwrite existing customizations unless the user explicitly asks. Only add missing files or update with new learnings.

---

## Step 2: Chat Log Analysis (if provided)

Chat logs from previous agent sessions contain the richest source of patterns, mistakes, and preferences. They are often enormous (100MB+) and require hierarchical summarization.

### 2a. Assess the Chat File

```python
import os
file_size = os.path.getsize(chat_file_path)
print(f"File size: {file_size / (1024*1024):.1f} MB")
```

- **< 1 MB**: Read directly with `read_file` in chunks of 500 lines
- **1-50 MB**: Split into 500-line chunks, read sequentially
- **50+ MB**: Use the hierarchical pipeline below

### 2b. Split Large Files (500 lines per chunk)

Create a script and run in background:

```python
# split_lines.py
import os, sys

input_file = sys.argv[1]  # e.g., ".temp/chat.json"
output_dir = sys.argv[2]  # e.g., ".temp/chat_split"
chunk_size = 500

os.makedirs(output_dir, exist_ok=True)
line_count = 0
chunk_num = 1

with open(input_file, 'r', encoding='utf-8', errors='ignore') as f:
    chunk_lines = []
    for line in f:
        chunk_lines.append(line)
        line_count += 1
        if len(chunk_lines) >= chunk_size:
            chunk_path = os.path.join(output_dir, f"chunk_{chunk_num:05d}.txt")
            with open(chunk_path, 'w', encoding='utf-8') as out:
                out.writelines(chunk_lines)
            # Flush immediately so chunks are readable while script runs
            chunk_num += 1
            chunk_lines = []
            if line_count % 100000 == 0:
                print(f"Processed {line_count} lines, {chunk_num-1} chunks", file=sys.stderr)
    # Write remaining lines
    if chunk_lines:
        chunk_path = os.path.join(output_dir, f"chunk_{chunk_num:05d}.txt")
        with open(chunk_path, 'w', encoding='utf-8') as out:
            out.writelines(chunk_lines)

print(f"DONE: {line_count} lines, {chunk_num} chunks", file=sys.stderr)
```

### 2c. Detect Binary Regions

VS Code chat exports contain base64/byte-array screenshots. These are lines of just numbers like `123,` or `255,`. They can span thousands of chunks.

**Detection**: Read the first line of sampled chunks (every 100th). If it matches `/^\d+,?$/` -> binary data (skip).

**Strategy**: Find text-to-binary and binary-to-text boundaries via binary search, then only process text chunks.

Typical structure of a VS Code chat.json:
```
Chunks 1-N:        TEXT (conversation turn 1 - tool calls, responses, user messages)
Chunks N+1-M:      BINARY (screenshot byte arrays from tool results)
Chunks M+1-end:    TEXT (remaining conversation turns)
```

### 2d. Hierarchical Summarization Pipeline

For very large chats (15,000+ chunks), use a layered approach:

```
Layer 0: Raw chunks (500 lines each)
Layer 1: L1 summaries (1 per 10 chunks) - written by subagents
Layer 2: L2 summaries (1 per 10 L1s = 100 chunks) - written by subagents
Layer 3: L3 summaries (1 per 10 L2s = 1000 chunks) - written by subagents
Layer 4: Final master summary - written by you from all L3s
```

**L1 Subagent Prompt Template:**
```
You are a chat analysis subagent. Read these 10 chunk files IN ORDER:
- .temp/chat_split/chunk_XXXXX.txt through chunk_XXXXY.txt

Write a summary to .temp/chat_split/L1/L1_NNNNN.txt containing:

1. USER MESSAGES: Verbatim user requests, corrections, frustrations
2. AGENT THINKING: Key reasoning and decisions
3. AGENT ACTIONS: Tool calls (tool name, key args, success/failure, errors)
4. PAGE STATES: URLs, visible elements, error messages, overlays
5. MISTAKES: Failed clicks, wrong URLs, 403/404, wrong assumptions, retries
6. LEARNINGS: API endpoints, working selectors, workarounds, timing needs
7. PLATFORM INFO: Which platform, quirks, what works/doesn't
8. FILE CHANGES: Tracker updates, file creates/edits
9. DATA: Job IDs, company names, statuses, dates

Be SPECIFIC: include ref numbers, URLs, error codes, exact element text.
If a chunk is binary/metadata only, note it and move on.
```

**Parallelization**: L1 subagents are independent - launch as many in parallel as the system allows. Pipeline L2s as soon as 10 L1s complete. Same for L3s.

**Verification**: Before deleting any lower layer, verify the higher layer captured all findings. Launch a verification subagent that cross-checks.

### 2e. What to Extract from Chat Logs

For each platform/workflow, extract:
- **Working procedures**: Step-by-step actions that succeeded
- **Failure patterns**: Actions that failed, with root cause and fix
- **API endpoints**: Full URLs with parameters, headers, auth patterns
- **DOM selectors**: CSS selectors, accessibility refs, iframe locations
- **User preferences**: Language rules, formatting, naming conventions
- **Timing requirements**: Waits, delays, load detection patterns
- **Account/credential patterns**: Login flows, account creation, 2FA
- **Tool interaction quirks**: CDP vs JS click, React fiber, native setters

---

## Step 3: Generate `.github` Files

Based on repo analysis and chat learnings, create these files:

### 3a. Directory Structure

```
.github/
  copilot-instructions.md       # Repo-wide agent instructions
  agents/                       # Custom agent definitions
    {name}.agent.md             # One per specialized workflow
  prompts/                      # Reusable prompt files
    {workflow}.prompt.md         # One per major workflow
  guides/                       # Reference documentation
    {topic}-guide.md            # Detailed procedure guides
  skills/                       # Skill definitions
    {skill-name}.md             # Quick-reference for capabilities
```

Optional (for code repos with CI/CD):
```
.github/
  ISSUE_TEMPLATE/
    config.yml
    bug_report.yml
    feature_request.yml
  PULL_REQUEST_TEMPLATE.md
  workflows/
    ci.yml
    auto-label.yml
  CODEOWNERS
  dependabot.yml
  FUNDING.yml
  labels.yml
```

### 3b. copilot-instructions.md Template

This is the MOST IMPORTANT file. Every agent reads it first.

```markdown
# Copilot Instructions - {Project Name}

> This file configures GitHub Copilot behavior for the entire {project} workspace.
> All agents and prompts inherit these instructions unless overridden.

---

## Workspace Overview
{One paragraph describing what this repo does, its purpose, and structure.}

## Key Files - Read These Before Any Action
| File | Purpose | When to read |
|---|---|---|
| {file} | {purpose} | {trigger} |

## Critical Constants
{Any fixed values agents need: emails, URLs, credentials references, paths.}

## Human Language Rules
{User's preferences for how text should be written:
- Punctuation style (dashes, quotes, arrows)
- Tone (formal, casual, technical)
- Length constraints
- Forbidden phrases}

## {Domain} Rules
{Domain-specific rules extracted from chat logs. Examples:
- Tracker management rules (for job app repos)
- Code style rules (for code repos)
- API usage rules (for integration repos)
- Data handling rules (for data repos)}

## Browser Automation Rules (if applicable)
{Only if the repo uses CDP/browser automation:
- Viewport requirements
- Export procedures
- Platform-specific quirks
- Tab management}

## Post-Session Protocol
{What to do after every work session:
- Cleanup scripts to run
- Validation checks
- Documentation updates
- Issue logging}
```

### 3c. Agent Definition Template

```markdown
---
name: {agent-name}
description: "{One-line description of what this agent does.}"
---

# {Agent Display Name}

You are the **{Role Name}** for {project description}.

## BEFORE DOING ANYTHING
1. Read `.github/copilot-instructions.md` for workspace rules
2. Read {primary prompt file} for the full workflow
3. Read {guide file} for platform/domain procedures
4. Read {data files} for current state

## Follow the {workflow} prompt
Your primary workflow is defined in `.github/prompts/{workflow}.prompt.md`.
Read it in full and follow every step.

## Key Rules
1. {Rule extracted from chat - most critical first}
2. {Rule extracted from chat}
...
10. {Post-session: cleanup, validate, update docs}
```

### 3d. Prompt File Template

```markdown
# {Workflow Name} - Complete Workflow

## READ THIS EVERY TIME. RE-READ AFTER EVERY ACTION.

> Version: {version} | Created: {date}
> This is the single source of truth for {workflow description}.

---

## Quick Reference - Key Files
| File | What | When to read |
|---|---|---|

---

## FAILURE PATTERNS - MISTAKES TO NEVER REPEAT

{For each failure found in chat logs:}

### {N}. {Short description}
{What happened}: {Specific description of the mistake}
**FIX**: {Specific fix, with code/selectors if applicable}

---

## THE RULES - NON-NEGOTIABLE

### Rule 1: {Name}
{Detailed description with rationale from chat logs}

---

## WORKFLOW - STEP BY STEP

### Phase 0: Preparation
{Setup steps}

### Phase 1: {First major action}
{Detailed steps with platform-specific instructions}

### Phase 2: {Second major action}
{...}

### Phase N: Post-Session Cleanup
{Cleanup, validation, documentation steps}
```

### 3e. Guide File Template

```markdown
# {Topic} Guide - Comprehensive Procedures

> Version: {version} | Created: {date}
> Read the relevant section before interacting with any {domain item}.

---

## Table of Contents
1. [{Item 1}](#{anchor})
2. [{Item 2}](#{anchor})
...

---

## {Item 1}

### Overview
{What it is, when to use it}

### Setup
{Required setup steps, with code blocks}

### Workflow
{Step-by-step procedure}

### Known Issues
| Issue | Cause | Fix |
|---|---|---|

### API Reference (if applicable)
{Endpoints, parameters, auth, response codes}
```

### 3f. Skill File Template

```markdown
---
name: {skill-name}
description: "{When to use this skill and what it covers.}"
---

# {Skill Title}

## When to Use This Skill
{Bullet list of triggers}

## Core Operations
{Code blocks, patterns, quick-reference}

## Critical Rules
{Numbered list of non-negotiable rules}

## Common Patterns
{Named patterns with code examples}
```

### 3g. Issue Template (for code repos)

```yaml
# .github/ISSUE_TEMPLATE/bug_report.yml
name: Bug Report
description: Report a bug or unexpected behavior
title: "[Bug]: "
labels: ["bug", "triage"]
body:
  - type: markdown
    attributes:
      value: "## Bug Report"
  - type: textarea
    id: description
    attributes:
      label: Description
      description: What happened?
    validations:
      required: true
  - type: textarea
    id: steps
    attributes:
      label: Steps to Reproduce
      description: How can we reproduce this?
      value: |
        1.
        2.
        3.
    validations:
      required: true
  - type: textarea
    id: expected
    attributes:
      label: Expected Behavior
  - type: textarea
    id: actual
    attributes:
      label: Actual Behavior
  - type: input
    id: version
    attributes:
      label: Version
  - type: dropdown
    id: os
    attributes:
      label: Operating System
      options:
        - Windows
        - macOS
        - Linux
```

```yaml
# .github/ISSUE_TEMPLATE/feature_request.yml
name: Feature Request
description: Suggest an enhancement or new feature
title: "[Feature]: "
labels: ["enhancement"]
body:
  - type: textarea
    id: problem
    attributes:
      label: Problem
      description: What problem does this solve?
    validations:
      required: true
  - type: textarea
    id: solution
    attributes:
      label: Proposed Solution
    validations:
      required: true
  - type: textarea
    id: alternatives
    attributes:
      label: Alternatives Considered
```

```yaml
# .github/ISSUE_TEMPLATE/config.yml
blank_issues_enabled: true
contact_links: []
```

### 3h. PR Template (for code repos)

```markdown
<!-- .github/PULL_REQUEST_TEMPLATE.md -->
## What

Brief description of changes.

## Why

Link to issue or explain motivation.

## How

Key implementation decisions.

## Testing

- [ ] Unit tests added/updated
- [ ] Manual testing completed
- [ ] No regressions in existing tests

## Checklist

- [ ] Code follows project conventions
- [ ] Documentation updated if needed
- [ ] No sensitive data in commits
```

### 3i. CI Workflow Template (for code repos)

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # --- Language-specific setup ---
      # Node.js:
      # - uses: actions/setup-node@v4
      #   with: { node-version: '20' }
      # - run: npm ci
      # - run: npm test

      # Python:
      # - uses: actions/setup-python@v5
      #   with: { python-version: '3.12' }
      # - run: pip install -r requirements.txt
      # - run: pytest

      # Rust:
      # - uses: dtolnay/rust-toolchain@stable
      # - run: cargo test

      # Go:
      # - uses: actions/setup-go@v5
      #   with: { go-version: '1.22' }
      # - run: go test ./...
```

### 3j. Dependabot Template

```yaml
# .github/dependabot.yml
version: 2
updates:
  # Uncomment the relevant ecosystem:

  # - package-ecosystem: "npm"
  #   directory: "/"
  #   schedule:
  #     interval: "weekly"

  # - package-ecosystem: "pip"
  #   directory: "/"
  #   schedule:
  #     interval: "weekly"

  # - package-ecosystem: "cargo"
  #   directory: "/"
  #   schedule:
  #     interval: "weekly"

  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
```

---

## Step 4: Iterative Improvement

When additional chat files are provided or new sessions are completed:

### 4a. New Chat Files
1. Run the chat analysis pipeline (Step 2) on the new file
2. Compare new findings against existing `.github/` files
3. Add new failure patterns (never remove existing ones)
4. Add new API endpoints, selectors, workarounds
5. Update version numbers in affected files
6. Add new platform sections if new platforms were used

### 4b. After Each Work Session
1. If the agent encountered new errors -> add to failure patterns
2. If the agent found new working procedures -> add to guides
3. If the user corrected the agent -> add the correction as a rule
4. If new accounts were created -> ensure account management docs updated
5. Run any cleanup scripts defined in post-session protocol

### 4c. Conflict Resolution
- **Contradiction between old and new findings**: Keep BOTH with dates. Mark the newer one as "supersedes" the older.
- **User preference changed**: Update to the new preference. Note the change in a comment.
- **Platform behavior changed**: Update the procedure. Keep the old one as a "deprecated" note.

### 4d. Never Remove Without Asking
- Never delete existing failure patterns (they prevent regressions)
- Never remove existing agent definitions
- Never overwrite custom user rules
- Ask the user before removing anything from copilot-instructions.md

---

## Step 5: Quality Checks

After generating all files, verify:

1. **No broken cross-references**: Every file path mentioned in copilot-instructions.md exists
2. **No conflicting rules**: Rules in prompts don't contradict copilot-instructions.md
3. **Agent files have valid YAML frontmatter**: Check `name` and `description` fields
4. **Prompt files have version and date**: Every prompt starts with version info
5. **Guide files have table of contents**: Every section is linked
6. **Skill files have "When to Use" section**: Clear trigger conditions
7. **JSON validation**: If any JSON files were modified, validate them
8. **No AI-sounding language**: Check for and remove "leverage", "synergy", "I am writing to express my keen interest", etc. (if user has this preference)

---

## Appendix A: Patterns Extracted from Real Usage

These patterns were extracted from 300+ hours of agent-assisted job application work across 10+ platforms. They represent battle-tested learnings.

### Browser Automation Patterns

**CDP Tab Management:**
- Each subagent MUST create its own tab (never share)
- Set viewport 1920x1080 on EACH tab before LinkedIn navigation
- New tabs may load different browser profiles - verify logged-in account
- Tab action for creating is `new`, not `create`

**React-Controlled Inputs:**
```javascript
// CDP type/fill doesn't update React state. Use native setter:
const setter = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype, 'value'
).set;
setter.call(element, 'new value');
element.dispatchEvent(new Event('input', {bubbles: true}));
element.dispatchEvent(new Event('change', {bubbles: true}));
```

**Ember.js (LinkedIn):**
```javascript
// CDP interact doesn't work on Ember elements. Use JS click:
document.querySelector('li.msg-conversation-listitem').click();
```

**Radix UI (Turing):**
```javascript
// JS .click() doesn't update data-state. Use React fiber:
el[fiberKey].memoizedProps.onValueChange('value');
```

**Export Before Action:**
```javascript
// Always export page content before clicking Apply/Submit:
const md = await window.__UMD.extractFullPage();
// Fallback:
return document.body.innerText;
```

### 3-Strike Rule
If an element is not found after 3 different approaches:
1. Take a fresh accessibility snapshot
2. Try one more approach based on the new snapshot
3. If still fails -> skip and move on. Do NOT retry endlessly.

### Data Integrity Patterns

**JSON Validation After Every Edit:**
```powershell
python -c "import json; json.load(open('FILE', encoding='utf-8-sig')); print('valid')"
```

**Never Bulk-Edit:** Add/modify max 5 entries at a time. 20+ bulk edits corrupt JSON.

**PowerShell + Python:** NEVER inline multiline Python in PowerShell. Always write a temp `.py` file:
```powershell
$script = @'
import json
# your code
'@
$script | Out-File -Encoding utf8 .temp/_temp.py
python .temp/_temp.py
Remove-Item .temp/_temp.py
```

### Subagent Strategy
- Keep prompts under ~2500 chars (larger prompts cause 400 JSON parse errors)
- One task per subagent (1-3 items max, not 10+)
- Each subagent creates its own browser tab
- If a platform blocks after N actions, report immediately instead of retrying

---

## Appendix B: Platform Integration Reference

When a repo involves browser automation across web platforms, these are common patterns discovered through real usage:

### LinkedIn
- Viewport 1920x1080 MANDATORY per tab
- Never navigate to `/apply/` URL directly - go to job page first, click Easy Apply
- Easy Apply button may be inside `iframe[src*="preload"]`, not main page
- SDUI dialog uses `artdeco-modal` class, NOT `role="dialog"`
- Follow checkbox has opacity:0 - click via label element
- CSRF token: `document.cookie.match(/JSESSIONID="?([^";]+)/)?.[1]`
- Voyager API: `/voyager/api/jobs/jobPostings/{jobId}` for full JD
- After ~10-15 Easy Apply, dialog may stop opening (session-level block)
- Message items: use JS `.click()`, not CDP interact (Ember.js)
- CTC fields: pure numeric only (1200000 not "12 LPA")

### Gmail
- ALWAYS verify URL contains correct account path before composing
- `document.execCommand('insertText')` bypasses TrustedHTML CSP
- Toolbar buttons respond to CDP interact only, not JS `.click()`
- Inline compose has 0x0 elements - use popup compose URL
- Check ALL labels including custom ones

### Google Forms
- File uploads use proprietary Drive Picker - cannot be automated via CDP
- Radio buttons: click `.nWQGrd` container, not input
- POST submit causes tab to disappear - expect "No target with given id"
- Pre-filled drafts may have stale values - verify before submit

### Greenhouse
- React comboboxes don't respond to CDP click/type
- Use React fiber `onChange` handler or keyboard navigation
- Some companies require account creation

### Workday
- Each company = separate instance = separate account
- Multi-step forms (3-5 steps), auto-saves between steps

---

## Usage

To use this prompt:

1. Open a new conversation in VS Code with Copilot
2. Reference this file: `@workspace #file:.github/prompts/setup-github-folder.prompt.md`
3. Provide the repo path and optionally chat files:
   ```
   Set up .github for this repo.
   Chat files: .temp/chat.json, .temp/chat2.json
   ```
4. The agent will analyze the repo and chat files, then create all `.github` files
5. Review the output. Ask for refinements if needed.
6. For future sessions with new chat files: "Update .github with learnings from .temp/new_chat.json"
