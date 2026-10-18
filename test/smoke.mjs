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

const bin = join(work, 'bin');
mkdirSync(bin);
const agyBin = join(bin, 'fake-agy');
const ocBin = join(bin, 'fake-opencode');
writeFileSync(agyBin, FAKE_AGY); chmodSync(agyBin, 0o755);
writeFileSync(ocBin, FAKE_OPENCODE); chmodSync(ocBin, 0o755);

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
    env: { ...process.env, DEBATE_AGY_BIN: agyBin, DEBATE_OPENCODE_BIN: ocBin, FAKE_ARGV_LOG: argvLog, ...env },
  });
  const m = /^result: (.+)$/m.exec(r.stdout || '');
  const result = m && existsSync(m[1]) ? JSON.parse(readFileSync(m[1], 'utf8')) : null;
  const runArgv = readFileSync(argvLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((a) => a.some((x) => x.startsWith('--print=')) || a[0] === 'run').pop() || null;
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

for (const opponent of ['agy', 'opencode']) {
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
    const env = opponent === 'agy' ? { DEBATE_AGY_BIN: join(work, 'nope') } : { DEBATE_OPENCODE_BIN: join(work, 'nope') };
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
