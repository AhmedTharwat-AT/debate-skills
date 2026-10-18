#!/usr/bin/env node
// Smoke tests for skills/debate-request/scripts/debate.mjs.
//
// These run the real relay against FAKE `agy` and `opencode` executables, so they
// prove the relay's own contract: argv it builds, how it parses replies, the
// read-only tripwire, timeouts, exit codes, and the files it writes. They do NOT
// prove anything about the real CLIs. See "Verification status" in the README.
//
//   node test/smoke.mjs

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  console.log('smoke: skipped on native Windows (the fakes are POSIX shebang scripts).');
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const RELAY = resolve(here, '../skills/debate-request/scripts/debate.mjs');
const work = mkdtempSync(join(tmpdir(), 'debate-smoke-'));

// ---------------------------------------------------------------- fakes

const FAKE_AGY = `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
if (process.env.FAKE_ARGV_LOG) fs.appendFileSync(process.env.FAKE_ARGV_LOG, JSON.stringify(argv) + '\\n');
const mode = process.env.FAKE_MODE || 'normal';
if (argv[0] === '--version') { console.log('agy 1.2.4'); process.exit(0); }
if (argv[0] === 'help') { console.log('help'); process.exit(0); }
if (argv[0] === 'models') {
  console.log(process.env.FAKE_AGY_MODELS || 'Gemini 3.8 Flash (High)\\nGemini 3.8 Flash (Low)\\nGemini 3.1 Pro\\nGemini 3.1 Flash (High)\\nClaude Sonnet 4.6');
  process.exit(0);
}
const print = argv.find((a) => a.startsWith('--print='));
if (!print) { console.error('no --print'); process.exit(2); }
if (mode === 'write') fs.writeFileSync(process.env.FAKE_WRITE_PATH, 'changed by opponent');
if (mode === 'sleep') setInterval(() => {}, 1000);
else if (mode === 'empty') process.exit(0);
else if (mode === 'denied') { console.error('no output produced: tool call auto-denied'); console.log('x'); process.exit(0); }
else { console.log('AGREE 1: checked. brief_chars=' + (print.length - '--print='.length)); process.exit(0); }
`;

const FAKE_OPENCODE = `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
if (process.env.FAKE_ARGV_LOG) fs.appendFileSync(process.env.FAKE_ARGV_LOG, JSON.stringify(argv) + '\\n');
const mode = process.env.FAKE_MODE || 'normal';
if (argv[0] === '--version') { console.log(process.env.FAKE_OC_VERSION || '1.4.0'); process.exit(0); }
if (argv[0] === 'models') {
  console.log(process.env.FAKE_OC_MODELS || 'opencode/big-pickle\\nopencode/gpt-5-nano\\nopencode/nemotron-3-ultra-free\\nopencode/mimo-v2.5-free\\nopenrouter/some/paid-model');
  process.exit(0);
}
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  if (mode === 'write') fs.writeFileSync(process.env.FAKE_WRITE_PATH, 'changed by opponent');
  if (mode === 'sleep') { setInterval(() => {}, 1000); return; }
  if (mode === 'empty') process.exit(0);
  const ev = (o) => console.log(JSON.stringify(o));
  ev({ type: 'step_start', sessionID: 'ses_fake1', part: {} });
  if (mode === 'error') { ev({ type: 'error', sessionID: 'ses_fake1', error: { data: { message: 'model exploded' } } }); process.exit(0); }
  ev({ type: 'text', sessionID: 'ses_fake1', part: { type: 'text', text: 'AGREE 1: checked. stdin_chars=' + stdin.length } });
  ev({ type: 'step_finish', sessionID: 'ses_fake1', part: { cost: 0 } });
});
`;

// Emits the event shapes `codex exec --json` documents: thread.started, item.completed
// with agent_message items (a preamble first, then the final answer), turn.completed.
// The final answer is also written to the -o file, as real codex does.
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
if (process.env.FAKE_ARGV_LOG) fs.appendFileSync(process.env.FAKE_ARGV_LOG, JSON.stringify(argv) + '\\n');
const mode = process.env.FAKE_MODE || 'normal';
if (argv[0] === '--version') { console.log('codex-cli 0.150.1'); process.exit(0); }
if (argv[0] === 'login' && argv[1] === 'status') {
  if (process.env.FAKE_CODEX_LOGGED_OUT) { console.error('Not logged in'); process.exit(1); }
  console.log('Logged in using ChatGPT'); process.exit(0);
}
if (argv[0] !== 'exec') { console.error('unexpected: ' + argv.join(' ')); process.exit(2); }
const oi = argv.indexOf('-o');
const outFile = oi >= 0 ? argv[oi + 1] : null;
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  if (mode === 'write') fs.writeFileSync(process.env.FAKE_WRITE_PATH, 'changed by opponent');
  if (mode === 'sleep') { setInterval(() => {}, 1000); return; }
  if (mode === 'empty') process.exit(0);
  const ev = (o) => console.log(JSON.stringify(o));
  ev({ type: 'thread.started', thread_id: 'thr-fake-1' });
  ev({ type: 'turn.started' });
  if (mode === 'error') { ev({ type: 'turn.failed', error: { message: 'model exploded' } }); process.exit(1); }
  ev({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'preamble: let me look' } });
  const final = 'AGREE 1: checked. stdin_chars=' + stdin.length;
  ev({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: final } });
  ev({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
  if (outFile && mode !== 'nofile') fs.writeFileSync(outFile, final);
});
`;

const bin = join(work, 'bin');
mkdirSync(bin);
const agyBin = join(bin, 'fake-agy');
const ocBin = join(bin, 'fake-opencode');
const codexBin = join(bin, 'fake-codex');
writeFileSync(agyBin, FAKE_AGY); chmodSync(agyBin, 0o755);
writeFileSync(ocBin, FAKE_OPENCODE); chmodSync(ocBin, 0o755);
writeFileSync(codexBin, FAKE_CODEX); chmodSync(codexBin, 0o755);

// A throwaway git repo with one committed file.
const repo = join(work, 'repo');
mkdirSync(repo);
const git = (...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });
git('init', '-q');
writeFileSync(join(repo, 'a.txt'), 'hello\n');
git('add', '.');
git('commit', '-q', '-m', 'init');
const plainDir = join(work, 'not-a-repo');
mkdirSync(plainDir);

// ---------------------------------------------------------------- harness

let passed = 0; let failed = 0;
const argvLog = join(work, 'argv.log');

function relay(args, env = {}, cwd = repo) {
  writeFileSync(argvLog, '');
  const r = spawnSync(process.execPath, [RELAY, ...args], {
    cwd, encoding: 'utf8', timeout: 60000,
    env: {
      ...process.env, DEBATE_AGY_BIN: agyBin, DEBATE_OPENCODE_BIN: ocBin, DEBATE_CODEX_BIN: codexBin,
      FAKE_ARGV_LOG: argvLog, ...env,
    },
  });
  const m = /^result: (.+)$/m.exec(r.stdout || '');
  const result = m && existsSync(m[1]) ? JSON.parse(readFileSync(m[1], 'utf8')) : null;
  const runArgv = readFileSync(argvLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((a) => a.some((x) => x.startsWith('--print=')) || a[0] === 'run' || a[0] === 'exec').pop() || null;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, result, runArgv };
}

function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(c, msg) { if (!c) throw new Error(msg); }
const has = (arr, x) => arr.includes(x);

let briefN = 0;
function brief(text = 'TOPIC: does a.txt say hello?\nMY POSITION: 1. yes') {
  const p = join(work, `brief-${++briefN}.md`);
  writeFileSync(p, text);
  return p;
}
const dd = () => mkdtempSync(join(work, 'debate-'));

// ---------------------------------------------------------------- tests

test('discover: reports both opponents and their defaults', () => {
  const r = relay(['discover']);
  eq(r.code, 0, 'exit');
  const d = JSON.parse(r.stdout);
  eq(d.opponents.agy.available, true, 'agy available');
  eq(d.opponents.agy.default.resolved, 'Gemini 3.8 Flash (High)', 'agy default model');
  eq(d.opponents.agy.default.substituted, false, 'agy substituted');
  eq(d.opponents.opencode.default, 'opencode/nemotron-3-ultra-free', 'best free model installed');
  ok(!d.opponents.opencode.freeModels.includes('opencode/gpt-5-nano'), 'paid model must not be listed as free');
  eq(d.gitRepo, true, 'gitRepo');
});

test('discover: DEBATE_FREE_MODELS reorders the free pick', () => {
  const d = JSON.parse(relay(['discover'], { DEBATE_FREE_MODELS: 'mimo-v2.5-free,big-pickle' }).stdout);
  eq(d.opponents.opencode.default, 'opencode/mimo-v2.5-free', 'override pick');
});

test('discover: agy falls back to newest flash and says it substituted', () => {
  const d = JSON.parse(relay(['discover'], { FAKE_AGY_MODELS: 'Gemini 3.1 Flash (High)\nGemini 3.0 Flash (High)\nGemini 3.1 Pro' }).stdout);
  eq(d.opponents.agy.default.resolved, 'Gemini 3.1 Flash (High)', 'fallback model');
  eq(d.opponents.agy.default.substituted, true, 'substituted flag');
});

test('discover: unavailable opponent is reported, not fatal', () => {
  const d = JSON.parse(relay(['discover'], { DEBATE_AGY_BIN: join(work, 'nope') }).stdout);
  eq(d.opponents.agy.available, false, 'agy available');
  eq(d.opponents.opencode.available, true, 'opencode available');
});

test('agy: default model, read-only flags, brief delivered', () => {
  const r = relay(['run', '--opponent', 'agy', '--brief', brief(), '--cd', repo, '--debate-dir', dd()]);
  eq(r.code, 0, 'exit');
  eq(r.result.status, 'completed', 'status');
  eq(r.result.model, 'Gemini 3.8 Flash (High)', 'model');
  eq(r.result.readOnlyViolation, false, 'violation');
  const a = r.runArgv;
  ok(has(a, '--new-project') && has(a, '--add-dir'), 'fresh project + workspace');
  ok(has(a, '--sandbox') && has(a, '--dangerously-skip-permissions'), 'sandboxed read-only');
  ok(!has(a, '--effort'), 'effort is already in the model label');
  eq(a[a.indexOf('--model') + 1], 'Gemini 3.8 Flash (High)', '--model value');
  ok(/AGREE 1/.test(r.result.finalMessage), 'reply captured');
  ok(/brief_chars=\d+/.test(r.result.finalMessage), 'brief reached the opponent');
});

test('agy: explicit model without an effort suffix gets --effort', () => {
  const r = relay(['run', '--opponent', 'agy', '--brief', brief(), '--cd', repo, '--debate-dir', dd(), '--model', 'gemini 3.1 pro', '--effort', 'high']);
  eq(r.result.model, 'Gemini 3.1 Pro', 'model');
  eq(r.runArgv[r.runArgv.indexOf('--effort') + 1], 'high', '--effort value');
});

test('agy: --resume-last maps to --continue; --conversation passes through', () => {
  const a = relay(['run', '--opponent', 'agy', '--brief', brief(), '--cd', repo, '--debate-dir', dd(), '--resume-last']);
  ok(has(a.runArgv, '--continue') && !has(a.runArgv, '--new-project'), '--continue');
  eq(a.result.resumed, true, 'resumed');
  const b = relay(['run', '--opponent', 'agy', '--brief', brief(), '--cd', repo, '--debate-dir', dd(), '--conversation', 'conv-9']);
  eq(b.runArgv[b.runArgv.indexOf('--conversation') + 1], 'conv-9', '--conversation');
});

test('opencode: picks best free model, plan agent, no --auto, brief on stdin', () => {
  const r = relay(['run', '--opponent', 'opencode', '--brief', brief(), '--cd', repo, '--debate-dir', dd()]);
  eq(r.code, 0, 'exit');
  eq(r.result.status, 'completed', 'status');
  eq(r.result.model, 'opencode/nemotron-3-ultra-free', 'model');
  eq(r.result.sessionId, 'ses_fake1', 'session id');
  const a = r.runArgv;
  eq(a[0], 'run', 'subcommand');
  eq(a[a.indexOf('--agent') + 1], 'plan', 'plan agent');
  ok(!has(a, '--auto'), 'must not auto-approve');
  eq(a[a.indexOf('-m') + 1], 'opencode/nemotron-3-ultra-free', '-m value');
  ok(/stdin_chars=\d+/.test(r.result.finalMessage), 'brief arrived on stdin');
  ok(r.result.warnings.some((w) => /free model/.test(w)), 'tells the host which free model was picked');
});

test('opencode: explicit --model wins; --session and --resume-last map through', () => {
  const a = relay(['run', '--opponent', 'opencode', '--brief', brief(), '--cd', repo, '--debate-dir', dd(), '--model', 'opencode/big-pickle', '--session', 'ses_x']);
  eq(a.result.model, 'opencode/big-pickle', 'model');
  eq(a.runArgv[a.runArgv.indexOf('--session') + 1], 'ses_x', '--session');
  const b = relay(['run', '--opponent', 'opencode', '--brief', brief(), '--cd', repo, '--debate-dir', dd(), '--resume-last']);
  ok(has(b.runArgv, '--continue'), '--continue');
  ok(!has(b.runArgv, '-m'), 'a resumed session keeps its own model');
});

test('opencode: --variant is a flag on 1.x and part of the model id on 2.x', () => {
  const v1 = relay(['run', '--opponent', 'opencode', '--brief', brief(), '--cd', repo, '--debate-dir', dd(), '--variant', 'high']);
  eq(v1.runArgv[v1.runArgv.indexOf('--variant') + 1], 'high', '1.x passes --variant');
  ok(!v1.runArgv.some((x) => x.includes('#')), '1.x leaves the model id alone');
  const v2 = relay(['run', '--opponent', 'opencode', '--brief', brief(), '--cd', repo, '--debate-dir', dd(), '--variant', 'high'], { FAKE_OC_VERSION: '2.0.11' });
  eq(v2.runArgv[v2.runArgv.indexOf('-m') + 1], 'opencode/nemotron-3-ultra-free#high', '2.x joins model#variant');
  ok(!has(v2.runArgv, '--variant'), '2.x has no --variant flag');
});

test('opencode: no free model installed -> failed, asks for --model', () => {
  const r = relay(['run', '--opponent', 'opencode', '--brief', brief(), '--cd', repo, '--debate-dir', dd()], { FAKE_OC_MODELS: 'openrouter/some/paid-model' });
  eq(r.code, 1, 'exit');
  eq(r.result.status, 'failed', 'status');
  ok(/--model/.test(r.result.error), 'error names the fix');
});

test('opencode: an error event with no text is a failure, not a completed run', () => {
  const r = relay(['run', '--opponent', 'opencode', '--brief', brief(), '--cd', repo, '--debate-dir', dd()], { FAKE_MODE: 'error' });
  eq(r.result.status, 'failed', 'status');
  ok(/model exploded/.test(r.result.error), 'error carries the opponent message');
});

const codexRun = (extra = [], env = {}, cwd = repo) =>
  relay(['run', '--opponent', 'codex', '--brief', brief(), '--cd', cwd, '--debate-dir', dd(), ...extra], env, cwd);

test('discover: reports codex with no default model and its login state', () => {
  const d = JSON.parse(relay(['discover']).stdout);
  eq(d.opponents.codex.available, true, 'available');
  eq(d.opponents.codex.signedIn, true, 'signedIn');
  eq(d.opponents.codex.default.model, null, 'no model default');
  const out = JSON.parse(relay(['discover'], { FAKE_CODEX_LOGGED_OUT: '1' }).stdout);
  eq(out.opponents.codex.signedIn, false, 'signed-out state is reported');
});

test('codex: read-only exec, brief on stdin, final message from -o, thread id captured', () => {
  const r = codexRun();
  eq(r.code, 0, 'exit');
  eq(r.result.status, 'completed', 'status');
  const a = r.runArgv;
  eq(a[0], 'exec', 'subcommand');
  eq(a[a.indexOf('-s') + 1], 'read-only', 'sandbox must be read-only');
  ok(has(a, '--json'), '--json');
  ok(a[a.indexOf('-o') + 1].endsWith('codex-last.txt'), '-o file');
  eq(a[a.length - 1], '-', 'brief is read from stdin');
  ok(!has(a, '-m') && !has(a, '-c'), 'no model or effort unless asked');
  ok(!has(a, '--skip-git-repo-check'), 'not needed inside a git repo');
  ok(!a.some((x) => /workspace-write|danger-full-access|full-auto|dangerously/.test(x)), 'no write-capable flag');
  ok(/AGREE 1/.test(r.result.finalMessage), 'final message');
  ok(!/preamble/.test(r.result.finalMessage), 'only the last agent message, not the preamble');
  ok(/stdin_chars=\d+/.test(r.result.finalMessage), 'brief arrived on stdin');
  eq(r.result.sessionId, 'thr-fake-1', 'thread id');
  eq(r.result.usage.output_tokens, 5, 'usage');
  eq(r.result.readOnlyViolation, false, 'violation');
  ok(r.result.warnings.some((w) => /configured model/.test(w)), 'says it used the configured model');
});

test('codex: --model and --effort map to -m and -c model_reasoning_effort', () => {
  const r = codexRun(['--model', 'my-model.v2', '--effort', 'High']);
  eq(r.runArgv[r.runArgv.indexOf('-m') + 1], 'my-model.v2', '-m');
  eq(r.runArgv[r.runArgv.indexOf('-c') + 1], 'model_reasoning_effort=high', '-c');
  eq(r.result.model, 'my-model.v2', 'model recorded');
  eq(r.result.effort, 'high', 'effort recorded');
  ok(!r.result.warnings.some((w) => /configured model/.test(w)), 'no configured-model warning when a model is named');
});

test('codex: --resume-last and --session resume, with the sandbox set before `resume`', () => {
  const a = codexRun(['--resume-last']);
  const i = a.runArgv.indexOf('resume');
  ok(i > 0 && a.runArgv.indexOf('-s') < i, '-s comes before resume');
  eq(a.runArgv[i + 1], '--last', '--last');
  eq(a.runArgv[a.runArgv.indexOf('-s') + 1], 'read-only', 'still read-only on resume');
  eq(a.result.resumed, true, 'resumed');
  ok(a.result.warnings.some((w) => /prefer --session/.test(w)), '--resume-last warns that "most recent" is global');
  const b = codexRun(['--session', 'thr-9']);
  ok(!b.result.warnings.some((w) => /prefer --session/.test(w)), 'an explicit --session does not warn');
  eq(b.runArgv[b.runArgv.indexOf('resume') + 1], 'thr-9', 'thread id');
  eq(b.runArgv[b.runArgv.length - 1], '-', 'brief on stdin');
});

test('codex: outside a git repo it passes --skip-git-repo-check and reports the tripwire as unknown', () => {
  const r = codexRun([], {}, plainDir);
  eq(r.result.status, 'completed', 'status');
  ok(has(r.runArgv, '--skip-git-repo-check'), 'flag');
  eq(r.result.readOnlyViolation, null, 'tripwire unknown');
});

test('codex: falls back to the last agent_message when -o wrote nothing', () => {
  const r = codexRun([], { FAKE_MODE: 'nofile' });
  eq(r.result.status, 'completed', 'status');
  ok(/AGREE 1/.test(r.result.finalMessage) && !/preamble/.test(r.result.finalMessage), 'last agent_message only');
});

test('codex: a turn.failed event is a failure that carries the message', () => {
  const r = codexRun([], { FAKE_MODE: 'error' });
  eq(r.code, 1, 'exit');
  eq(r.result.status, 'failed', 'status');
  ok(/model exploded/.test(r.result.error), 'error carries the opponent message');
});

test('codex: not being signed in warns but does not block the run', () => {
  const r = codexRun([], { FAKE_CODEX_LOGGED_OUT: '1' });
  eq(r.result.status, 'completed', 'status');
  ok(r.result.warnings.some((w) => /login status/.test(w)), 'warns');
});

test('codex: watchdog kills a hung run and reports timeout (exit 124)', () => {
  const r = codexRun(['--timeout', '2s'], { FAKE_MODE: 'sleep' });
  eq(r.code, 124, 'exit');
  eq(r.result.status, 'timeout', 'status');
});

for (const opponent of ['agy', 'opencode', 'codex']) {
  test(`${opponent}: a write to the repo is caught as a read-only violation`, () => {
    const target = join(repo, 'a.txt');
    const r = relay(['run', '--opponent', opponent, '--brief', brief(), '--cd', repo, '--debate-dir', dd()], { FAKE_MODE: 'write', FAKE_WRITE_PATH: target });
    eq(r.code, 3, 'exit');
    eq(r.result.status, 'read_only_violation', 'status');
    eq(r.result.readOnlyViolation, true, 'flag');
    ok(r.result.touchedFiles.includes('a.txt'), 'touchedFiles names the file');
    git('checkout', '--', 'a.txt');
  });

  test(`${opponent}: a file that was already dirty and stays untouched is not a violation`, () => {
    writeFileSync(join(repo, 'a.txt'), 'dirty before the run\n');
    const r = relay(['run', '--opponent', opponent, '--brief', brief(), '--cd', repo, '--debate-dir', dd()]);
    eq(r.result.readOnlyViolation, false, 'flag');
    eq(r.result.touchedFiles.length, 0, 'touchedFiles');
    git('checkout', '--', 'a.txt');
  });

  test(`${opponent}: a new untracked file is caught`, () => {
    const target = join(repo, 'new-file.txt');
    const r = relay(['run', '--opponent', opponent, '--brief', brief(), '--cd', repo, '--debate-dir', dd()], { FAKE_MODE: 'write', FAKE_WRITE_PATH: target });
    eq(r.result.status, 'read_only_violation', 'status');
    ok(r.result.touchedFiles.includes('new-file.txt'), 'touchedFiles names the new file');
    spawnSync('rm', ['-f', target]);
  });

  test(`${opponent}: empty reply is a failure`, () => {
    const r = relay(['run', '--opponent', opponent, '--brief', brief(), '--cd', repo, '--debate-dir', dd()], { FAKE_MODE: 'empty' });
    eq(r.code, 1, 'exit');
    eq(r.result.status, 'failed', 'status');
  });

  test(`${opponent}: missing binary writes a result and exits 127`, () => {
    const binVar = { agy: 'DEBATE_AGY_BIN', opencode: 'DEBATE_OPENCODE_BIN', codex: 'DEBATE_CODEX_BIN' }[opponent];
    const env = { [binVar]: join(work, 'nope') };
    const r = relay(['run', '--opponent', opponent, '--brief', brief(), '--cd', repo, '--debate-dir', dd()], env);
    eq(r.code, 127, 'exit');
    eq(r.result.status, 'opponent_unavailable', 'status');
  });
}

test('agy: headless permission denial is reported as failed', () => {
  const r = relay(['run', '--opponent', 'agy', '--brief', brief(), '--cd', repo, '--debate-dir', dd()], { FAKE_MODE: 'denied' });
  eq(r.result.status, 'failed', 'status');
  ok(/auto-denied/.test(r.result.error), 'error explains it');
});

test('opencode: watchdog kills a hung run and reports timeout (exit 124)', () => {
  const r = relay(['run', '--opponent', 'opencode', '--brief', brief(), '--cd', repo, '--debate-dir', dd(), '--timeout', '2s'], { FAKE_MODE: 'sleep' });
  eq(r.code, 124, 'exit');
  eq(r.result.status, 'timeout', 'status');
});

test('rounds are numbered per opponent and logged to transcript.md', () => {
  const d = dd();
  const r1 = relay(['run', '--opponent', 'agy', '--brief', brief('ROUND ONE BRIEF'), '--cd', repo, '--debate-dir', d]);
  const r2 = relay(['run', '--opponent', 'agy', '--brief', brief('ROUND TWO BRIEF'), '--cd', repo, '--debate-dir', d]);
  const r3 = relay(['run', '--opponent', 'opencode', '--brief', brief('OC ROUND ONE'), '--cd', repo, '--debate-dir', d]);
  eq(r1.result.round, 1, 'agy round 1');
  eq(r2.result.round, 2, 'agy round 2');
  eq(r3.result.round, 1, 'opencode has its own numbering');
  const t = readFileSync(join(d, 'transcript.md'), 'utf8');
  ok(/ROUND ONE BRIEF/.test(t) && /ROUND TWO BRIEF/.test(t) && /OC ROUND ONE/.test(t), 'transcript has every brief');
  ok(existsSync(join(d, 'round-2-agy', 'final.md')), 'final.md written');
});

test('a non-git directory runs fine and reports the tripwire as unknown', () => {
  const r = relay(['run', '--opponent', 'agy', '--brief', brief(), '--cd', plainDir, '--debate-dir', dd()], {}, plainDir);
  eq(r.result.status, 'completed', 'status');
  eq(r.result.readOnlyViolation, null, 'violation unknown');
  eq(r.result.touchedFiles, null, 'touchedFiles unknown');
});

test('usage errors exit 2 and write no result file', () => {
  const b = brief();
  const cases = [
    [['run', '--brief', b], '--opponent'],
    [['run', '--opponent', 'gemini', '--brief', b], '--opponent'],
    [['run', '--opponent', 'agy'], '--brief'],
    [['run', '--opponent', 'agy', '--brief', join(work, 'missing.md')], 'not found'],
    [['run', '--opponent', 'agy', '--brief', b, '--timeout', 'soon'], 'duration'],
    [['run', '--opponent', 'agy', '--brief', b, '--session', 's'], '--conversation'],
    [['run', '--opponent', 'opencode', '--brief', b, '--conversation', 'c'], '--session'],
    [['run', '--opponent', 'opencode', '--brief', b, '--effort', 'high'], '--variant'],
    [['run', '--opponent', 'agy', '--brief', b, '--resume-last', '--conversation', 'c'], 'cannot be combined'],
    [['run', '--opponent', 'agy', '--brief', b, '--round', '0'], '--round'],
    [['run', '--opponent', 'agy', '--brief', b, '--bogus'], 'unknown option'],
    [['run', '--opponent', 'codex', '--brief', b, '--variant', 'high'], '--effort'],
    [['run', '--opponent', 'codex', '--brief', b, '--conversation', 'c'], '--session'],
    [['run', '--opponent', 'codex', '--brief', b, '--effort', 'hi gh'], '--effort'],
    [['run', '--opponent', 'codex', '--brief', b, '--model', 'a b'], 'may only contain'],
    [['run', '--opponent', 'opencode', '--brief', b, '--model', 'm;rm -rf'], 'may only contain'],
    [['run', '--opponent', 'opencode', '--brief', b, '--session', 'ses_$(x)'], 'may only contain'],
    [['frobnicate'], 'unknown command'],
  ];
  for (const [args, needle] of cases) {
    const r = relay(args);
    eq(r.code, 2, `exit for ${args.join(' ')}`);
    ok(r.stderr.includes(needle), `stderr for ${args.join(' ')} should mention "${needle}", got: ${r.stderr.trim()}`);
    eq(r.result, null, 'no result file');
  }
});

test('empty brief and oversized agy brief are rejected up front', () => {
  eq(relay(['run', '--opponent', 'agy', '--brief', brief('   \n')]).code, 2, 'empty brief');
  const big = relay(['run', '--opponent', 'agy', '--brief', brief('x'.repeat(130 * 1024))]);
  eq(big.code, 2, 'oversized brief');
  ok(/KB/.test(big.stderr), 'explains the limit');
  const okForOpencode = relay(['run', '--opponent', 'opencode', '--brief', brief('x'.repeat(130 * 1024)), '--cd', repo, '--debate-dir', dd()]);
  eq(okForOpencode.code, 0, 'opencode takes briefs on stdin, so size is fine');
});

test('a round that already has a result is never overwritten', () => {
  const d = dd();
  eq(relay(['run', '--opponent', 'agy', '--brief', brief(), '--cd', repo, '--debate-dir', d, '--round', '1']).code, 0, 'first');
  eq(relay(['run', '--opponent', 'agy', '--brief', brief(), '--cd', repo, '--debate-dir', d, '--round', '1']).code, 2, 'second');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
