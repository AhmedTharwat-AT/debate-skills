# Debate protocol

The mechanics behind the loop in `SKILL.md`: how to keep a claim ledger, what to put in each brief, how to verify, and when to call it agreed or stuck.

## The claim ledger

Keep one numbered list for the whole debate, in a scratch file outside the repo. One row per claim, never renumbered, so both sides can refer to claim 3 across rounds.

```
| # | Claim | Evidence | Host | Opponent |
|---|-------|----------|------|----------|
| 1 | Retry logic lives in src/net/retry.ts and caps at 3 attempts | src/net/retry.ts:41 | confirmed | AGREE (read the file) |
| 2 | The cap was lowered from 5 in commit 9f2c1ab | git show 9f2c1ab | confirmed | DISAGREE: says it was 4 |
| 3 | The cap should be configurable | design opinion | judgment | judgment |
```

Host and Opponent statuses: `confirmed` / `refuted` / `unverifiable` / `judgment` for you; `AGREE` / `DISAGREE` / `UNSURE` for the opponent. Each row carries its evidence, so a status is never just "yes".

Claims the opponent raises get new numbers and enter the ledger the same way.

## Opening brief

The opponent has never seen this skill and has no chat history. The rules must be in the brief.

```
You are taking part in a structured debate with another coding agent. A person
will receive only what we both agree on.

TOPIC: <what to examine or decide>
SCOPE: <files / feature / commit range / branch>

MY CURRENT POSITION (a hypothesis to test, not a fact):
1. <claim> -- evidence: <file:line / commit / output>
2. ...

RULES FOR YOU:
- Do not trust my claims. Verify each one yourself by reading the code and the
  git history before you agree or disagree.
- Do your own investigation too, and raise anything I missed.
- Cite evidence for every claim: file:line, commit hash, or command output.
- Change your position only when evidence or a sound argument requires it.
  Do not agree to be agreeable. Do not hold a position that was refuted.
- This is read-only: do not edit files, commit, install, or change config.
- For each numbered claim of mine, reply AGREE, DISAGREE, or UNSURE, with a
  one-line note saying exactly what you checked.
- Then list your own additional claims, numbered from <next number>, with evidence.
- Keep the reply under about 400 words.
```

If the topic is a diff or a commit range, name the range exactly (`abc123..def456`) so both sides examine the same thing.

## Later-round brief

Each round's brief is complete on its own. Do not rely on the opponent remembering earlier rounds, even if you pass `--resume-last`.

```
DEBATE, ROUND <n>. Same rules as before, repeated here:
- Do not trust my claims or my evidence; verify them yourself.
- Cite evidence for every claim. Change position only on evidence.
- Read-only. Reply AGREE / DISAGREE / UNSURE per numbered claim, with a note of
  what you checked. Under about 400 words.

TOPIC: <topic>      SCOPE: <scope>

WHERE WE STAND
Settled (I verified these myself):
 1. <claim> -- <evidence I checked>
Rejected by me:
 2. <claim> -- why: <my counter-evidence, with file:line / commit / output>
Conceded by me:
 4. <your claim I now accept> -- I checked: <what>
Still open:
 5. <claim> -- this would settle it: <exact check>

NEW FROM ME THIS ROUND
 6. <claim> -- evidence: ...

Please re-check my rejections and my new claims against the code, not against
my say-so.
```

## Verification checklist

Check each kind of claim at the source, never from the opponent's description of it.

| Claim about | Check |
| --- | --- |
| What the code does | Open the cited file and line. Read the surrounding function, not just the line quoted |
| What changed, when, or why | `git show <hash>`, `git log -L`, `git blame` on the cited lines. Check the diff, not the commit message |
| That a test passes or fails | Run it yourself |
| That something is never called or never used | Search for it yourself (several spellings, dynamic uses) before accepting "never" |
| A library or framework behavior | Read the installed version's source or docs, not memory |
| A design preference | There is nothing to verify. Label it a judgment call and argue the trade-offs |

Signs the opponent is not really checking: an AGREE with no note of what it read; evidence with no file or line; quoted code that does not appear in the file; a confident claim about a commit it never cites. Ask for the evidence; if it does not come, mark the claim unverifiable and do not agree to it.

Signs you are drifting: you agreed because the reply was fluent; you softened a position without new evidence; you are splitting the difference to finish. Go back and check.

## Evidence the opponent cannot gather

The opponent runs sandboxed or in a read-only agent, and OpenCode's `plan` agent may be blocked from running shell commands (Codex's read-only sandbox may be too; not verified). If a claim needs command output (a test run, a long `git log`), run it yourself and paste the relevant excerpt into the brief, labelled as your output. The opponent should still check what it can from the files.

## Agreement

Before declaring agreement, send one last brief that lists the proposed consensus points, numbered, and ask for AGREE or DISAGREE on each with a note of what it checked. Agreement holds only when:

- you confirmed each point yourself, and
- the opponent answered AGREE to it explicitly, with a verification note.

A point where either side answers anything else goes into the report as unresolved.

## Stalemate

Stop without agreement when any of these is true:

- you have reached 5 rounds (or the user's limit),
- two consecutive rounds produced no new evidence and no one changed position,
- the remaining disagreement is a judgment call that no further fact can settle.

Report both positions and what would settle each open point. Do not split the difference.

## Report template

```
## Debate result: <topic>

**Agreed**
- <point> (evidence: <file:line / commit>)

**Not agreed**
- <point>: I say X, <opponent> says Y. What would settle it: <check>

**What changed during the debate**
- <who changed their mind about what, and why>

**Details**: <N> rounds with <opponent> (<model actually used>). <any model substitution>.
Nothing in the repo was modified. Transcript: <debateDir>/transcript.md
```

Leave out empty sections. With more than one opponent, give an Agreed/Not agreed list per opponent plus a line on where the opponents disagreed with each other. Make no changes based on the result unless the user asks.
