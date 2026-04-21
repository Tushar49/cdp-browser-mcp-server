# CDP vs Playwright MCP — Speed & Accuracy Benchmarks

## Methodology

Each benchmark runs the **same task** on both CDP Browser MCP and Playwright MCP servers, measuring:

- **Time to complete** (ms)
- **Tool calls required** (fewer = better for LLM token cost)
- **Success/failure**
- **Output quality** (correct data extracted?)

All tasks use local HTML fixtures served via a static file server to eliminate network
variability. Each task is run multiple times and the median result is reported.

## Tasks

### Task 1: Navigate + Snapshot

- Navigate to a test page
- Take accessibility snapshot
- Measure: time, snapshot size, element count

### Task 2: Form Filling

- Navigate to a form with text, dropdown, checkbox, radio, date
- Fill all fields in minimum calls
- Measure: time, calls needed, fields successfully filled

### Task 3: Click + Navigate

- Navigate to a page with links
- Click a specific link by text
- Wait for navigation
- Measure: time, success rate

### Task 4: Multi-Tab Workflow

- Open 3 tabs with different URLs
- Switch between them
- Take snapshots of each
- Measure: total time, per-tab time

### Task 5: Complex Form (Greenhouse-style)

- Navigate to a form with comboboxes and datalists
- Fill combobox by typing and selecting from dropdown
- Measure: time, calls needed, success rate

## Running

```bash
# Run all benchmarks
npm run benchmark

# Run specific benchmark
npm run benchmark -- --filter "navigate"
```

## Results Format

| Task              | CDP Time | Playwright Time | CDP Calls | PW Calls | Winner |
| ----------------- | -------- | --------------- | --------- | -------- | ------ |
| navigate-snapshot | —        | —               | —         | —        | —      |
| form-fill-simple  | —        | —               | —         | —        | —      |
| click-navigate    | —        | —               | —         | —        | —      |
| multi-tab         | —        | —               | —         | —        | —      |
| complex-form      | —        | —               | —         | —        | —      |
