# Opponents: agy, opencode and codex

What `scripts/debate.mjs` runs for each opponent, how it picks a model, and what to check when something goes wrong. Run `node scripts/debate.mjs discover` first; it shows what is installed here.

CLI flags change between versions of all three tools. The relay was written against public docs and the open-source `delegate-skills` project, and tested only against fake CLIs. If a real run fails with an unknown-flag error, run `<cli> --help` and tell the user.

## agy (Google Antigravity CLI)

**Install and sign in:** `curl -fsSL https://antigravity.google/cli/install.sh | bash` (Linux/macOS) or `irm https://antigravity.google/cli/install.ps1 | iex` (PowerShell), then run `agy` once to complete first-launch sign-in. `agy models` should list model labels.

**What the relay runs** (roughly):

```
agy --new-project --add-dir <repo> --model "<label>" [--effort <level>] \
    --sandbox --dangerously-skip-permissions --print-timeout <N>s --print=<brief>
agy --continue ... --print=<brief>              # with --resume-last
agy --conversation <id> ... --print=<brief>     # with --conversation <id>
```

**Model.** Default is Gemini Flash 3.8 at high effort. The relay matches the loose request `gemini flash 3.8` against `agy models` by word, preferring a label whose effort suffix matches (for example `(High)`). Effort is usually part of the label, so `--effort` is passed only when the chosen label has no effort suffix. If no 3.8 label exists, it falls back to the newest Flash label, records `modelSubstituted: true`, and adds a warning; report that substitution to the user. If nothing matches at all, it runs without `--model` and agy uses its own default (also warned). `--model` accepts a full label or loose words. A model or effort the user names replaces the default; with `--model` and no `--effort`, no effort is forced.

**Read-only.** The relay always runs agy inside its sandbox, which confines reads and writes to the workspace, with approvals auto-granted inside the sandbox so a headless run cannot stall on a prompt. A write attempt should be discarded by the sandbox. Do not rely on that alone: the relay fingerprints the working tree before and after and reports `read_only_violation` if anything changed. The fingerprint comes from `git status`, so ignored files are not covered, and a directory that is not a git repository gets `readOnlyViolation: null` (unknown).

**The brief rides the command line.** It is visible in the process list, so keep secrets out of it, and the relay rejects briefs over 120 KB. Point the opponent at files in the repo instead of inlining large context.

**Conversation ids are not captured.** `sessionId` is `null` for agy. Use `--resume-last` to continue its most recent conversation, or (better) send a self-contained brief each round, which is what the protocol assumes.

**Permission traps.** If a run reports `agy auto-denied a tool permission`, agy's permission engine blocked a command it could not prompt for. Allow-rule matching and the config file agy actually reads vary by version and platform, so check agy's own documentation, and ask the user before widening any permissions.

## opencode

**Install and sign in:** `npm i -g opencode-ai` (or the installer from opencode.ai). Free models are served through OpenCode Zen; per OpenCode's docs they work without an API key but are rate-limited per IP and may be withdrawn at any time. If a run fails with an auth error, run `opencode auth login`.

**What the relay runs** (roughly, brief on stdin):

```
opencode run --format json --agent plan -m <provider/model> < brief
opencode run --format json --agent plan --continue < brief        # with --resume-last
opencode run --format json --agent plan --session ses_... < brief # with --session
```

**Model.** If the user names none, the relay lists `opencode models`, keeps the free ones, and picks the first available in this order:

1. `opencode/deepseek-v4-flash-free`
2. `opencode/nemotron-3-ultra-free`
3. `opencode/mimo-v2.5-free`
4. `opencode/north-mini-code-free`
5. `opencode/laguna-s-2.1-free`
6. `opencode/longcat-2.0-free`
7. `opencode/big-pickle`

That order is a judgment call, not a benchmark, and the free list changes. To change it for every run, set `DEBATE_FREE_MODELS` to comma-separated ids without the provider prefix, for example `DEBATE_FREE_MODELS=big-pickle,mimo-v2.5-free`. If none of the preferred ids is installed, it takes the first free model listed. If there is no free model at all, the run fails with a message asking for `--model`. The relay treats an id as free when it starts with `opencode/` and ends in `-free`, or is `big-pickle`; OpenCode sometimes lists other zero-price models, which you can use by passing `--model`. The pick appears in `result.json` and in a warning, so tell the user which free model debated.

**Variants.** `--variant <name>` sets the provider's reasoning effort. On opencode 1.x the relay passes `--variant`; on 2.x it joins it to the model as `provider/model#variant`.

**Read-only.** The relay always uses the `plan` agent and never passes `--auto`, so the agent cannot be approved into edits. A consequence: `plan` may be unable to run shell commands in a headless run, so the opponent may be limited to reading files. If a claim needs command output, run the command yourself and paste the excerpt into the brief. As with agy, the working-tree fingerprint is the backstop.

**Sessions.** The session id (`ses_...`) is read from the event stream and returned as `sessionId`. The event format is parsed defensively and has not been checked against a live opencode run.

## codex (OpenAI Codex CLI)

**Install and sign in:** `npm i -g @openai/codex`, then `codex login`. `discover` reports `signedIn` from `codex login status`; treat it as a hint, not proof, because an older codex may not have that subcommand. For one run you can supply an API key with `CODEX_API_KEY`. Check which `codex` is on your PATH (`command -v codex`, `codex --version`): a stale install can shadow a new one, and old versions lack `exec --json`, `-o` and `exec resume`.

**What the relay runs** (brief on stdin, signalled by the trailing `-`):

```
codex exec -s read-only --json -o <round-dir>/codex-last.txt [-m <model>] [-c model_reasoning_effort=<level>] -
codex exec -s read-only resume --last --json -o <file> ...  -        # with --resume-last
codex exec -s read-only resume <thread-id> --json -o <file> ...  -   # with --session <thread-id>
```

The sandbox flag goes before `resume`, matching how the `delegate-skills` project builds the command. Whether `resume <thread-id>` accepts the trailing `-` was not verified.

**Model.** The relay has no default model for Codex. Without `--model` it uses whatever you have configured in Codex, and it cannot report which one that was; a warning says so. `--model <name>` goes to `-m` and `--effort <level>` to `-c model_reasoning_effort=<level>`, both unchanged. Which names and levels are accepted depends on your Codex account and version. The relay checks only that the value is a plain token (letters, digits and `. _ : / # @ + -`).

**Read-only.** The relay passes `-s read-only` explicitly instead of relying on the default, and never passes `workspace-write`, `danger-full-access` or `--full-auto`. Inside that sandbox Codex should be able to read files and run commands that do not write, such as `git log`; that was not verified here. As with the other opponents, the working-tree fingerprint is the backstop.

**Outside a git repository** Codex refuses to run without `--skip-git-repo-check`. The relay adds it when `--cd` is not a git repo, and the tripwire is then unknown (`readOnlyViolation: null`).

**Final message and thread id.** The reply is read from the file written by `-o`; if that is missing, from the last `agent_message` item in the event stream (older releases call it `assistant_message`), never the earlier ones. The thread id from the `thread.started` event comes back as `sessionId`. Error events (`turn.failed`, `error`) are read defensively because their shape is not documented.

**Prefer `--session` to `--resume-last`.** Codex's "most recent session" is global, so another Codex run in between, including your own host session if the host is Codex, can take its place. The relay warns when you use `--resume-last`. Since the protocol sends a self-contained brief every round, resuming is rarely needed at all.

**Same model family as a Codex host.** If the host is also Codex, the two share blind spots. Prefer another opponent or a different `--model`. Whether `codex exec` can run from inside a Codex session at all, given the host's own sandbox, has not been verified.

## When a run fails

| Symptom | Likely cause | Try |
| --- | --- | --- |
| `opponent_unavailable` | CLI not on PATH, or not signed in | Install and sign in; `discover` shows what is found. `DEBATE_AGY_BIN` / `DEBATE_OPENCODE_BIN` point the relay at a binary in a non-standard place |
| `failed`, error mentions an unknown flag | The CLI's flags changed | Run `<cli> --help`; report it to the user |
| `failed`, `agy auto-denied` | agy blocked a command in headless mode | See "Permission traps" above |
| `failed`, empty reply | The model returned nothing, or a tool loop ended without text | Retry once; ask for a shorter, more specific brief |
| `failed`, codex error mentions login or auth | Not signed in | `codex login`, or `CODEX_API_KEY` for one run |
| `failed`, codex complains about the directory or a git repo | Not a git repo, or a stale codex | Pass a git repo as `--cd`; check `codex --version` |
| `failed`, rate limit or auth text in `stderrTail` | Free-tier limit, or not signed in | Wait, pick another free model with `--model`, or sign in |
| `timeout` | The opponent was still working | Narrow the brief; raise `--timeout`; retry once |
| `read_only_violation` | The opponent changed a file | Stop; show the user the files; do not revert on your own |
