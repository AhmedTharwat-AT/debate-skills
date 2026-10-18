# Contributing

Thanks for helping. Read [AGENTS.md](AGENTS.md) first: it holds the vocabulary and house rules, and you can point your coding agent at it too.

## Adding an opponent

An opponent is another coding agent CLI that can read a repository and answer a brief. To qualify, it must:

- run non-interactively and print its reply (or stream events the relay can parse),
- be restrictable to read-only, either by its own mode or by a sandbox,
- need nothing from the relay except a command line and, optionally, the brief on stdin.

Changes needed:

1. **`scripts/debate.mjs`:** add a probe (is it installed, its version, its models), model resolution, the argument builder, and reply parsing, next to the `agy` and `opencode` branches. Keep the read-only tripwire running. Use only Node built-ins.
2. **`test/smoke.mjs`:** add a fake CLI and cover argument building, a normal reply, a write attempt (must report `read_only_violation`), an empty reply, and a missing binary.
3. **`references/opponents.md`:** a section with install and sign-in, what the relay runs, how it picks a model, and how read-only is enforced.
4. **`SKILL.md` and README:** a row in the "Choose the opponent" tables.
5. **README "Verification status":** state exactly what you ran. If you only ran the fakes, say so.

Please open an issue to claim an opponent before you start.

## Changing the protocol

The protocol (verify every claim, explicit consensus, honest stalemates) is the point of the package. Changes that make either side easier to persuade, or make agreement easier to reach without evidence, will not be accepted. Changes that make verification stricter or clearer are welcome.

## Before opening a pull request

Run through the checklist in [AGENTS.md](AGENTS.md#before-publishing-a-change).
