# tiergear

A plugin and CLI that lets a decision model (the judge) pick the model and reasoning effort for Claude Code sessions and Orca workers.

- **First turn**: the first prompt goes to the judge, which returns a tier (trivial, quick, standard, deep, max). Tables A and B turn that into a model and effort. The first turn has no cache to lose, so the model changes too.
- **Later turns**: by default the model stays and only effort changes. Raising is easy (confidence 0.5); lowering is hard (confidence 0.85 for 2 turns in a row).
- **Floor**: the tier never drops below one step under the first decision. Sessions started with `tiergear launch`/`orca-spawn` use the launch tier as their floor.
- **`!pin`**: start a prompt with `!pin` to pin the session. tiergear withdraws the model and effort it was applying, and from then on the session's own model and effort (set by startup flags or `/model`, `/effort`) are used as is. The `!pin` prefix is stripped before the prompt reaches the judge and the model.
- **Manual changes pause routing**: changing the model or effort yourself with `/model` or `/effort` mid-session stops adjustment for that session, just like `!pin`, and writes `[tiergear] manual model/effort change — routing paused for this session` to the hook log once. It compares the session values the engine reports between turns, so tiergear's own changes don't trigger it. If the engine switches to a fallback model from the first request of a turn, that can also look like a manual change.

If the judge is slow or fails, that turn proceeds untouched.

### Which prompts are judged

Only prompts the user typed are judged: terminal input (`composer`), Remote Control (`bridge`), and the SDK or `claude -p` (`sdk`). Background task notifications, scheduled tasks and `/loop`, messages from other sessions or SendMessage, observers, auto-continue, plugin-sent prompts, and unknown origins (`unclassified`) pass through unjudged, and the tier and applied values stay as they are. Prompts that enter a running turn (including ones typed and queued while a turn runs) are not judged. Slash commands starting with `/` are not judged.

## Install

Requires Claude Code 2.1.289 or later.

```bash
cd ~/IdeaProjects/tiergear
npm install
npm run build && npm link
ln -s ~/IdeaProjects/tiergear ~/.claude/skills/tiergear
claude plugin list | grep -A3 tiergear
```

You should see `tiergear@skills-dir` and `Status: ✔ loaded`. `which tiergear` should print the CLI path. Plugin hooks load at session start, so open a new session after installing.

## Judges

All three judges use TypeSafe's `<baseUrl>/v1/systemone` contract. The default is `jev`.

| Preset | Address | Model | Key env var | Timeout (first turn / later) |
| --- | --- | --- | --- | --- |
| jev | `https://api.typesafe.ai` | `jev-latest` | `TYPESAFE_API_KEY` (required) | 2000ms / 1200ms |
| laya | `http://localhost:11435` | `laya` | `OLLAYA_API_KEY` (optional) | 3000ms / 2500ms |
| kev | `http://localhost:8009` | `kev-latest` | `KEV_API_KEY` (optional) | 3000ms / 2000ms |

- jev needs a key and sends data to TypeSafe's servers.
- laya runs locally with `ollaya run laya`.
- kev points at a server you run locally or on Modal (change the address with `judgeBaseUrl`).
- After 3 judge failures in a row, the session skips the judge for 5 minutes and keeps its current state instead of falling back to the tables.

## Tables A and B

**Table A: the model each tier starts on**

| Tier | Claude | Codex |
| --- | --- | --- |
| trivial | sonnet | gpt-5.6-luna |
| quick | sonnet | gpt-5.6-terra |
| standard | sonnet | gpt-5.6-terra |
| deep | opus | gpt-5.6-terra |
| max | fable | gpt-5.6-terra |

Claude's trivial tier uses sonnet, not haiku: Claude Code's auto mode doesn't run on haiku, so a haiku session stops to ask for approval on commands. If you run with permission checks off, see [Haiku for trivial](#haiku-for-trivial-bypass-permissions-users).

**Table B: effort per model** (`-` means no effort is sent; the haiku row applies only if you put haiku in Table A)

| Model | trivial | quick | standard | deep | max |
| --- | --- | --- | --- | --- | --- |
| haiku | - | - | - | - | - |
| sonnet | low | low | medium | high | max |
| opus | low | low | medium | xhigh | max |
| fable | low | low | medium | high | xhigh |
| gpt-5.6-luna (Codex) | low | low | medium | high | high |
| gpt-5.6-terra (Codex) | low | low | medium | xhigh | max |

On Codex, deep and max both use `gpt-5.6-terra`; only the effort differs (xhigh vs max).

A session on a model without effort (haiku, if you set it) can't be raised through effort alone, so raising the tier switches to that tier's model even when `switchModelMidSession=false` (the cache breaks once).

### Customizing the tables

Put only the cells you want to change in `~/.config/tiergear/tables.json`; they are merged over the defaults.

```json
{ "claude": { "effort": { "opus": { "deep": "max" } } } }
```

Model cells go under `models`, as in `{"claude":{"models":{"deep":"opus"}}}`. Effort values are low, medium, high, xhigh, max, or `null`. If any value or the JSON itself is invalid, **the whole file is ignored** and the default tables are used (this is noted in the hook log). Hooks read the file once, the first time it's needed after session start, so open a new session after editing it.

### Haiku for trivial (bypass-permissions users)

If you run Claude Code with permission checks off ("yolo" mode), auto mode doesn't matter and haiku is the cheaper choice for trivial work. Put it back with one cell:

```json
{ "claude": { "models": { "trivial": "haiku" } } }
```

Permission checks can be turned off in two ways:

- One session: `claude --dangerously-skip-permissions`.
- Every session, including the workers `orca-spawn` starts: in `~/.claude/settings.json`,

  ```json
  { "permissions": { "defaultMode": "bypassPermissions" } }
  ```

Use the settings file if you start workers with tiergear. `tiergear launch` prints a command with only `--model` and `--effort`, `orca-spawn` starts the agent with that command, and inside a Run Orca's `worker-start` builds the command itself, so none of them adds the flag. With only the flag, a haiku worker asks for approval again.

**Bypass mode runs every tool call without asking.** Use it only where you accept that, such as a sandbox or a throwaway worktree.

## Plugin options

Change these in `/config` (plugin options).

| Option | Default | Description |
| --- | --- | --- |
| `judge` | `jev` | Judge preset: one of jev, laya, kev (shown as a list in `/config`). An unknown value falls back to jev and is noted once in the hook log |
| `judgeBaseUrl` | preset | Leave empty for the preset's address |
| `judgeModel` | preset | Leave empty for the preset's model |
| `judgeApiKey` | preset env var | Leave empty to use TYPESAFE_API_KEY, OLLAYA_API_KEY, or KEV_API_KEY (sensitive) |
| `switchModelMidSession` | `false` | Also change the model after the first turn (breaks the prompt cache). Off: only effort changes |
| `minUpgradeConfidence` | `0.5` | Minimum confidence to raise the tier |
| `minDowngradeConfidence` | `0.85` | Minimum confidence for a turn to count toward lowering |
| `downgradeStreak` | `2` | Consecutive turns needed to lower one step |
| `stuckConfidence` | `0.6` | Raise one step when the judge's stuck probability is at or above this |
| `stuckFailures` | `3` | Raise one step after this many identical tool failures in a row |
| `firstTurnTimeoutMs` | preset | First-turn latency budget. At most 8000ms (the whole hook budget is 10s, so larger values are cut to 8000) |
| `turnTimeoutMs` | preset | Later-turn latency budget. At most 8000ms |

## Status line

Every status line starts with `tiergear ·`.

- Applied: `tiergear · deep 0.91 → opus/xhigh`. When the session model is known it always shows `model/effort`, in the same format even if the model didn't change; a model without effort shows `-`. If the session model isn't known yet, only effort is shown.
- `unset` appears when no tier has been decided yet, and `n/d` takes the place of the confidence when the judge gave no answer.
- Unchanged: `tiergear · standard 0.62 · unchanged (<reason>)`

Reasons for no change: `no answer` (no judge response), `low confidence`, `same tier`, `pinned`, `at floor` (can't go lower), `easier step N/M` (Nth lowering candidate, M needed), `stuck at max`.

## CLI

```bash
tiergear launch "<brief>" [--agent claude|codex] [--worktree <path>] [--judge jev|laya|kev] [--judge-url <url>] [--judge-model <name>]
tiergear orca-spawn "<brief>" --name <task> [--agent claude|codex] [--repo <dir>] [--base-branch <ref>] [--judge ...]
tiergear stats [days]
```

- `launch`: judges the brief and prints the command to run (e.g. `claude --model opus --effort xhigh`). With Claude, `--worktree` writes a floor for that path. The path is stored as an absolute real path (symlinks resolved), so a relative path still works for a session opened in that folder. With `--agent codex`, floors are Claude-only, so none is written and a one-line note is printed instead.
- `orca-spawn`: creates an Orca worktree, writes the floor, and starts the agent there with the judged model and effort. Prints the result as JSON. `--base-branch` picks the ref the worktree starts from; without it Orca uses the repo's default base, which may be a remote branch behind your local one.
  - **Inside an orchestration Run** (run from the coordinator terminal after `orca orchestration run-create`): starts the agent with `orca orchestration worker-start`, so the worker gets Orca's lifecycle preamble and reports `worker_done` to the Run. The JSON includes `dispatch` (`runId`, `taskId`, `dispatchId`, `handle`). A failed `worker-start` exits non-zero with Orca's error; don't rerun it blindly, since Orca may have left resources behind.
  - **Without a Run**: creates a terminal, waits for the agent, then types the brief as is (no preamble, `dispatch` is `null`). If Claude asks whether to trust the folder, **`orca-spawn` does not approve it for you.** Approve it yourself in Orca within 120 seconds. If the agent isn't ready, the brief is **not sent** (exit code 1) and a fallback shell may be left in the worktree.
  - The floor is written before the agent's first prompt in both cases. Without it, the first turn would be judged on Orca's preamble, which usually gives low confidence.
- `stats`: number of recorded decisions, counts by change type, and response rate and average latency per judge (default 7 days).
- A floor is written only when the judge actually decided. If the judge failed, didn't answer, or had low confidence and standard was used instead, no floor is written and a warning is printed.
- The CLI's judge timeout is 5000ms.

The CLI can't read plugin options, so it looks up settings from flags, then environment variables, then the preset.

| Variable | Meaning |
| --- | --- |
| `TIERGEAR_JUDGE` | Judge name (default jev) |
| `TIERGEAR_JUDGE_URL` | Judge address |
| `TIERGEAR_JUDGE_MODEL` | Judge model |
| `TIERGEAR_JUDGE_API_KEY` | Key (falls back to the preset's key env var) |

## Where things are stored

| What | Location |
| --- | --- |
| Tables | `~/.config/tiergear/tables.json` |
| Floors (valid 24 hours) | `~/.local/state/tiergear/floors/<fnv1a(worktree)>.json` |
| Decision log (1000 lines per file) | `~/.local/state/tiergear/decisions/<name>.jsonl` |
| Session records (kept 7 days, newest 200) | Plugin `$.store` under `session:<id>` (the first prompt is truncated to 2000 characters) |

Raw prompt text is never written to the logs.

## Cost

- Changing the model and changing effort mid-session both invalidate the messages prompt cache (per Anthropic's docs). The first turn has no cache, so it costs nothing.
- That's why the default mid-session change is effort only, and lowering only happens after repeated high-confidence turns, to keep changes rare.
- Raising from a model without effort, like haiku if you set it, switches the model and breaks the cache once.
- The judge call itself adds cost and latency to every judged prompt (within the timeouts above).

## Data sent to the judge

- First turn: the first prompt (only the start and end if long).
- Later turns: the first prompt, the last 6 messages (each trimmed to start and end if long, including names of tools used), the next prompt, the number of files edited, the repeated failure count, and the current tier and effort.
- jev sends data externally (TypeSafe). laya and kev stay on your local server (if you run kev on Modal, data goes there).
- See "Which prompts are judged" above. Prompts that aren't judged are never sent to the judge.

## Limitations

- Codex gets its model and effort only at launch (`launch`/`orca-spawn`). Mid-session adjustment works only in Claude Code.
- Hooks are an early-access feature, so the contract can change with Claude Code updates. `types/claude-code.d.ts` is the declaration file generated by Claude Code 2.1.289. After an update, replace it with the `.claude-plugin/types/claude-code/index.d.ts` the engine writes next to the plugin.
- The confidence thresholds (0.5, 0.85, 0.6) are tuned for Jev. For other judges, check response rate and latency with `tiergear stats` and adjust the options.
- Subagent requests are left alone; only main-loop requests are changed.
