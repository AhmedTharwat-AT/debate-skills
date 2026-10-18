#!/usr/bin/env node
// debate.mjs - one round of a debate with an opponent coding-agent CLI (agy or opencode).
//
// Node built-ins only. No network calls of its own, no credentials, no telemetry.
// It launches the opponent CLI and git, nothing else. It never commits and never
// edits the repository: every run is read-only by construction, and a git
// fingerprint taken before and after the run reports any change the opponent made.
//
//   node debate.mjs discover [--cd <dir>]
//   node debate.mjs run --opponent agy|opencode --brief <file> [options]
//
// Usage errors exit 2 without writing a result file.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, readlinkSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RESULT_SCHEMA = 'debate-relay.result.v1';
const DISCOVER_SCHEMA = 'debate-relay.discover.v1';
const IS_WIN = process.platform === 'win32';
const MAX_AGY_BRIEF_BYTES = 120 * 1024; // the brief rides agy's command line
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const WATCHDOG_GRACE_MS = 60 * 1000;
const MAX_TIMER_MS = 2147483647;
const MAX_HASHED_FILE_BYTES = 5 * 1024 * 1024;

// Defaults for the agy opponent: Gemini Flash 3.8 at high effort.
const AGY_DEFAULT_MODEL = 'gemini flash 3.8';
const AGY_DEFAULT_EFFORT = 'high';
const EFFORT_WORDS = ['minimal', 'low', 'medium', 'high', 'max'];

// Default for the opencode opponent: the strongest free model that is installed.
// This order is a judgment call, not a benchmark, and the free list changes over
// time. Override it per run with --model, or for every run with the
// DEBATE_FREE_MODELS environment variable (comma-separated ids, no provider prefix).
const FREE_MODEL_PREFERENCE = [
  'deepseek-v4-flash-free',
  'nemotron-3-ultra-free',
  'mimo-v2.5-free',
  'north-mini-code-free',
  'laguna-s-2.1-free',
  'longcat-2.0-free',
  'big-pickle',
];

const HELP = `debate.mjs - run one debate round against an opponent CLI (agy or opencode)

Commands:
  discover [--cd <dir>]     Print JSON: which opponents are installed, their models,
                            and the model each would use by default.
  run <options>             Send one brief to the opponent and capture its reply.

run options:
  --opponent <agy|opencode>  Which opponent to ask (required).
  --brief <file>             The brief for this round (required). Keep it outside the repo.
  --cd <dir>                 Repository the opponent should examine (default: cwd).
  --model <id>               agy: a model label (matched loosely against 'agy models').
                             opencode: provider/model. Default: see 'discover'.
  --effort <level>           agy only: low | medium | high. Default with the default model: high.
  --variant <name>           opencode only: provider reasoning variant (e.g. high, max).
  --resume-last              Continue the opponent's most recent conversation/session.
  --conversation <id>        agy only: continue a specific conversation.
  --session <id>             opencode only: continue a specific session (ses_...).
  --debate-dir <dir>         Where rounds and transcript.md are kept (default: new temp dir).
  --round <n>                Round number (default: next free number for this opponent).
  --timeout <dur>            Watchdog, e.g. 90s, 20m, 1h30m (default: 20m).
  --help                     Show this help.

Every run is read-only: agy runs in its sandbox, opencode runs its 'plan' agent
without auto-approval. Environment overrides: DEBATE_AGY_BIN, DEBATE_OPENCODE_BIN,
DEBATE_FREE_MODELS.

Exit codes: 0 completed; 1 failed; 2 usage error (no result file); 3 the opponent
changed the working tree; 124 timeout; 127 opponent CLI not found; 130/143 aborted.`;

// ---------------------------------------------------------------- arguments

const VALUE_FLAGS = new Set([
  'opponent', 'brief', 'cd', 'model', 'effort', 'variant', 'conversation',
  'session', 'debate-dir', 'round', 'timeout',
]);
const BOOL_FLAGS = new Set(['resume-last', 'help']);

function die(msg) {
  console.error(`debate.mjs: ${msg}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let cmd = null;
  if (args[0] && !args[0].startsWith('-')) cmd = args.shift();
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) die(`unexpected argument: ${a}`);
    const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (BOOL_FLAGS.has(k)) {
      if (inline !== undefined) die(`--${k} takes no value`);
      opts[k] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(k)) die(`unknown option --${k} (see --help)`);
    let v = inline;
    if (v === undefined) {
      v = args[++i];
      if (v === undefined || v.startsWith('--')) die(`--${k} needs a value`);
    }
    if (!v.trim()) die(`--${k} needs a non-empty value`);
    opts[k] = v;
  }
  return { cmd, opts };
}

function parseDuration(s, flag) {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
  if (!m || !s) die(`--${flag}: bad duration "${s}" (use e.g. 90s, 20m, 1h30m)`);
  const ms = ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000;
  if (ms <= 0 || ms > MAX_TIMER_MS - WATCHDOG_GRACE_MS) die(`--${flag}: duration out of range`);
  return ms;
}

// ---------------------------------------------------------------- helpers

const stripAnsi = (s) => s.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '');
const tailLines = (s, n = 20) => s.split(/\r?\n/).filter(Boolean).slice(-n);
const nowIso = () => new Date().toISOString();

function binFor(opponent) {
  return process.env[opponent === 'agy' ? 'DEBATE_AGY_BIN' : 'DEBATE_OPENCODE_BIN'] || opponent;
}
// opencode installs as a .cmd shim on Windows, which only resolves through a shell.
// Nothing user-controlled is ever placed in its argv except the model id.
const needsShell = (opponent) => IS_WIN && opponent === 'opencode';

function probe(opponent, args, timeout = 30000) {
  const r = spawnSync(binFor(opponent), args, {
    encoding: 'utf8', timeout, shell: needsShell(opponent), windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) {
    return { ok: false, missing: r.error.code === 'ENOENT', stdout: '', stderr: String(r.error.message) };
  }
  const stderr = stripAnsi(r.stderr || '');
  const missing = r.status === 127 || (IS_WIN && /not recognized|cannot find/i.test(stderr));
  return { ok: r.status === 0, missing, status: r.status, stdout: stripAnsi(r.stdout || ''), stderr };
}

const firstLine = (s) => (s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null);

// ---------------------------------------------------------------- agy models

function probeAgy() {
  let v = probe('agy', ['--version'], 15000);
  const version = v.ok ? firstLine(v.stdout) : null;
  if (!v.ok && !v.missing) v = probe('agy', ['help'], 15000);
  if (!v.ok) return { available: false, version: null, models: [] };
  const m = probe('agy', ['models'], 30000);
  const models = m.ok
    ? m.stdout.split(/\r?\n/)
        .map((l) => l.replace(/^[\s*\-•>]+/, '').trim())
        .filter((l) => l && !l.endsWith(':'))
    : [];
  return { available: true, version, models };
}

const tokenize = (s) => s.toLowerCase().replace(/[()[\]]/g, ' ').split(/[\s_\-/]+/).filter(Boolean);
const isNumeric = (t) => /^\d+(\.\d+)*$/.test(t);
const effortOf = (tokens) => tokens.find((t) => EFFORT_WORDS.includes(t)) || null;

function versionOf(tokens) {
  const t = tokens.find(isNumeric);
  return t ? t.split('.').map(Number) : [0];
}
function cmpVersion(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Match a loose request ("gemini flash 3.8") to a real label from `agy models`.
// An exact-token match is preferred. If the request names a version that is not
// installed, fall back to the newest model with the remaining words and say so.
function resolveAgyModel(labels, requested, effort) {
  const want = tokenize(requested);
  const entries = labels.map((label) => ({ label, tokens: tokenize(label) }));
  const pick = (cands) => {
    if (!cands.length) return null;
    const ranked = [...cands].sort((a, b) => {
      const ea = effort && effortOf(a.tokens) === effort ? 1 : 0;
      const eb = effort && effortOf(b.tokens) === effort ? 1 : 0;
      if (ea !== eb) return eb - ea;
      const v = cmpVersion(versionOf(b.tokens), versionOf(a.tokens));
      return v || a.label.length - b.label.length;
    });
    return ranked[0];
  };
  const exact = pick(entries.filter((e) => want.every((t) => e.tokens.includes(t))));
  if (exact) return { label: exact.label, substituted: false, tokens: exact.tokens };
  const relaxedWant = want.filter((t) => !isNumeric(t));
  if (relaxedWant.length && relaxedWant.length !== want.length) {
    const relaxed = pick(entries.filter((e) => relaxedWant.every((t) => e.tokens.includes(t))));
    if (relaxed) return { label: relaxed.label, substituted: true, tokens: relaxed.tokens };
  }
  return null;
}

// ---------------------------------------------------------------- opencode models

function probeOpencode() {
  const v = probe('opencode', ['--version'], 15000);
  if (!v.ok) return { available: false, version: null, free: [], all: [] };
  const m = probe('opencode', ['models'], 45000);
  const all = m.ok
    ? m.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l))
    : [];
  const free = all.filter((id) => {
    if (!id.startsWith('opencode/')) return false;
    const bare = id.slice('opencode/'.length);
    return bare.endsWith('-free') || bare === 'big-pickle';
  });
  return { available: true, version: firstLine(v.stdout), free, all };
}

function freePreference() {
  const env = process.env.DEBATE_FREE_MODELS;
  return env ? env.split(',').map((s) => s.trim()).filter(Boolean) : FREE_MODEL_PREFERENCE;
}

function pickFreeModel(free) {
  for (const bare of freePreference()) {
    const id = `opencode/${bare}`;
    if (free.includes(id)) return id;
  }
  return free[0] || null;
}

// ---------------------------------------------------------------- git fingerprint

function gitRoot(cwd) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function fileFingerprint(abs) {
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return `link:${readlinkSync(abs)}`;
    if (!st.isFile()) return st.isDirectory() ? 'dir' : 'special';
    if (st.size > MAX_HASHED_FILE_BYTES) return `big:${st.size}`;
    return createHash('sha256').update(readFileSync(abs)).digest('hex');
  } catch {
    return 'missing';
  }
}

// Map of path -> "XY|content-hash" for everything git considers changed or untracked.
// Ignored files are invisible to git status, so they are invisible here too.
function snapshot(root) {
  const r = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) return null;
  const toks = r.stdout.toString('utf8').split('\0').filter(Boolean);
  const map = new Map();
  for (let i = 0; i < toks.length; i++) {
    const xy = toks[i].slice(0, 2);
    const path = toks[i].slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // next token is the original path
    map.set(path, `${xy}|${fileFingerprint(join(root, path))}`);
  }
  return map;
}

function changedBetween(before, after) {
  const out = [];
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(k) !== after.get(k)) out.push(k);
  }
  return out.sort();
}

// ---------------------------------------------------------------- process running

function killTree(child, isClosed) {
  if (!child.pid) return;
  if (IS_WIN) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  setTimeout(() => {
    if (isClosed()) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  }, 3000).unref();
}

function runChild({ bin, args, cwd, input, shell, timeoutMs }) {
  return new Promise((done) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(bin, args, {
        cwd, shell, windowsHide: true, detached: !IS_WIN,
        stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      done({ launchError: e });
      return;
    }
    const CAP = 32 * 1024 * 1024;
    const out = []; const err = [];
    let outLen = 0; let errLen = 0;
    child.stdout.on('data', (d) => { if (outLen < CAP) { out.push(d); outLen += d.length; } });
    child.stderr.on('data', (d) => { if (errLen < CAP) { err.push(d); errLen += d.length; } });
    if (input != null) {
      child.stdin.on('error', () => { /* child exited before reading */ });
      child.stdin.end(input);
    }
    let timedOut = false; let aborted = false; let closed = false; let finished = false;
    const kill = () => killTree(child, () => closed);
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onSignal = () => { aborted = true; kill(); };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      done(value);
    };
    child.on('error', (e) => finish({ launchError: e }));
    child.on('close', (code, signal) => {
      closed = true;
      finish({
        code, signal, timedOut, aborted,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        durationMs: Date.now() - started,
      });
    });
  });
}

// ---------------------------------------------------------------- opencode output

// `opencode run --format json` streams newline-delimited events. The shape is read
// defensively: text from `text` events, the session id from whichever field carries it.
function parseOpencodeEvents(stdout) {
  let sessionId = null; let cost = 0; let sawCost = false;
  const texts = []; const errors = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; }
    sessionId ??= ev.sessionID ?? ev.sessionId ?? ev.part?.sessionID ?? ev.part?.sessionId ?? null;
    if (ev.type === 'text') {
      const tx = ev.part?.text ?? ev.text;
      if (typeof tx === 'string' && tx) texts.push(tx);
    } else if (ev.type === 'step_finish') {
      const c = ev.part?.cost;
      if (typeof c === 'number') { cost += c; sawCost = true; }
    } else if (ev.type === 'error') {
      errors.push(ev.error?.data?.message ?? ev.error?.message ?? ev.message ?? JSON.stringify(ev.error ?? ev));
    }
  }
  return { text: texts.join('\n').trim(), sessionId, cost: sawCost ? cost : null, errors };
}

// ---------------------------------------------------------------- discover

function cmdDiscover(o) {
  const cwd = resolve(o.cd || '.');
  const agy = probeAgy();
  const oc = probeOpencode();
  const out = {
    schema: DISCOVER_SCHEMA,
    gitRepo: existsSync(cwd) ? gitRoot(cwd) !== null : false,
    opponents: {
      agy: { available: agy.available, version: agy.version, models: agy.models, default: null },
      opencode: { available: oc.available, version: oc.version, freeModels: oc.free, default: null },
    },
  };
  if (agy.available) {
    const r = resolveAgyModel(agy.models, AGY_DEFAULT_MODEL, AGY_DEFAULT_EFFORT);
    out.opponents.agy.default = {
      requested: AGY_DEFAULT_MODEL, effort: AGY_DEFAULT_EFFORT,
      resolved: r ? r.label : null, substituted: r ? r.substituted : true,
      note: r ? undefined : 'No match in `agy models`; a run without --model uses agy\'s own default.',
    };
  }
  if (oc.available) out.opponents.opencode.default = pickFreeModel(oc.free);
  console.log(JSON.stringify(out, null, 2));
}

// ---------------------------------------------------------------- run

function nextRound(debateDir, opponent) {
  let n = 0;
  const re = new RegExp(`^round-(\\d+)-${opponent}$`);
  for (const name of readdirSync(debateDir)) {
    const m = re.exec(name);
    if (m) n = Math.max(n, +m[1]);
  }
  return n + 1;
}

function exitCodeFor(result) {
  switch (result.status) {
    case 'completed': return 0;
    case 'read_only_violation': return 3;
    case 'timeout': return 124;
    case 'opponent_unavailable': return 127;
    case 'aborted': return result.signal === 'SIGINT' ? 130 : 143;
    default: return Number.isInteger(result.exitCode) && result.exitCode > 0 ? result.exitCode : 1;
  }
}

async function cmdRun(o) {
  const opponent = o.opponent;
  if (opponent !== 'agy' && opponent !== 'opencode') die('--opponent must be agy or opencode');
  if (!o.brief) die('--brief <file> is required');
  if (o['resume-last'] && (o.session || o.conversation)) die('--resume-last cannot be combined with --session/--conversation');
  if (o.session && opponent !== 'opencode') die('--session is for opencode; use --conversation for agy');
  if (o.conversation && opponent !== 'agy') die('--conversation is for agy; use --session for opencode');
  if (o.effort && opponent !== 'agy') die('--effort is for agy; use --variant for opencode');
  if (o.variant && opponent !== 'opencode') die('--variant is for opencode; use --effort for agy');
  if (o.effort && !EFFORT_WORDS.includes(o.effort.toLowerCase())) die(`--effort must be one of: ${EFFORT_WORDS.join(', ')}`);

  const briefSrc = resolve(o.brief);
  if (!existsSync(briefSrc) || !statSync(briefSrc).isFile()) die(`brief not found: ${o.brief}`);
  const briefText = readFileSync(briefSrc, 'utf8');
  if (!briefText.trim()) die('brief is empty');
  if (opponent === 'agy' && Buffer.byteLength(briefText) > MAX_AGY_BRIEF_BYTES) {
    die(`brief is over ${MAX_AGY_BRIEF_BYTES / 1024} KB; agy takes it on the command line. Point the opponent at files in the repo instead of inlining them.`);
  }

  const timeoutMs = o.timeout ? parseDuration(o.timeout, 'timeout') : DEFAULT_TIMEOUT_MS;
  const cwd = resolve(o.cd || '.');
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) die(`--cd is not a directory: ${o.cd}`);
  if (o.round !== undefined && !/^[1-9]\d*$/.test(o.round)) die('--round must be a positive integer');

  const debateDir = o['debate-dir'] ? resolve(o['debate-dir']) : mkdtempSync(join(tmpdir(), 'debate-request-'));
  mkdirSync(debateDir, { recursive: true });
  const round = o.round ? +o.round : nextRound(debateDir, opponent);
  const roundDir = join(debateDir, `round-${round}-${opponent}`);
  if (existsSync(join(roundDir, 'result.json'))) die(`round already recorded: ${roundDir}`);
  mkdirSync(roundDir, { recursive: true });

  const briefPath = join(roundDir, 'brief.md');
  copyFileSync(briefSrc, briefPath);
  const finalPath = join(roundDir, 'final.md');
  const stderrPath = join(roundDir, 'stderr.txt');
  const eventsPath = join(roundDir, 'events.jsonl');
  const startedAt = nowIso();
  const warnings = [];

  const result = {
    schema: RESULT_SCHEMA, tool: opponent, status: 'failed', exitCode: null, signal: null,
    opponentVersion: null, model: null, modelRequested: o.model || null, modelSubstituted: false,
    effort: null, readOnly: true, readOnlyViolation: null, touchedFiles: null,
    sessionId: null, resumed: Boolean(o['resume-last'] || o.session || o.conversation),
    round, debateDir, roundDir, briefPath, finalPath, stderrPath,
    startedAt, finishedAt: null, durationMs: null, finalMessage: '', warnings,
  };

  const finalize = () => {
    result.finishedAt = nowIso();
    if (result.durationMs == null) result.durationMs = Date.parse(result.finishedAt) - Date.parse(startedAt);
    writeFileSync(finalPath, result.finalMessage || '');
    writeFileSync(join(roundDir, 'result.json'), JSON.stringify(result, null, 2));
    const label = result.model ? ` (${result.model})` : '';
    appendFileSync(join(debateDir, 'transcript.md'),
      `\n## Round ${round} - ${opponent}${label} - host brief\n\n${briefText.trim()}\n` +
      `\n## Round ${round} - ${opponent} - opponent reply [${result.status}]\n\n${(result.finalMessage || '(no reply)').trim()}\n`);
    console.log(`debate-request: round ${round} with ${opponent}${label}: ${result.status}` +
      `${result.durationMs != null ? ` in ${Math.round(result.durationMs / 1000)}s` : ''}`);
    console.log(`debateDir: ${debateDir}`);
    console.log(`result: ${join(roundDir, 'result.json')}`);
    if (result.error) console.log(`error: ${result.error}`);
    if (result.readOnlyViolation) console.log(`READ-ONLY VIOLATION, changed: ${result.touchedFiles.join(', ')}`);
    for (const w of warnings) console.log(`warning: ${w}`);
    if (result.finalMessage) {
      console.log('----- BEGIN OPPONENT REPLY -----');
      console.log(result.finalMessage.trim());
      console.log('----- END OPPONENT REPLY -----');
    }
    process.exit(exitCodeFor(result));
  };

  // ---- preflight
  const info = opponent === 'agy' ? probeAgy() : probeOpencode();
  if (!info.available) {
    result.status = 'opponent_unavailable';
    result.exitCode = 127;
    result.error = `\`${binFor(opponent)}\` was not found or did not run. Install it and sign in, then retry.`;
    finalize();
    return;
  }
  result.opponentVersion = info.version;

  // ---- build the command line
  let args; let input = null;
  if (opponent === 'agy') {
    const requested = o.model || AGY_DEFAULT_MODEL;
    const effort = (o.effort || (o.model ? '' : AGY_DEFAULT_EFFORT)).toLowerCase() || null;
    const resolved = resolveAgyModel(info.models, requested, effort);
    let model = null; let labelEffort = null;
    if (resolved) {
      model = resolved.label;
      labelEffort = effortOf(resolved.tokens);
      result.modelSubstituted = resolved.substituted;
      if (resolved.substituted) warnings.push(`no agy model matched "${requested}"; used "${model}" instead`);
    } else if (o.model) {
      model = o.model; // the person named it; let agy judge it
      warnings.push(`"${o.model}" was not found in \`agy models\`; passing it through unchanged`);
    } else {
      result.modelSubstituted = true;
      warnings.push(`no agy model matched the default "${requested}"; running with agy's own default model`);
    }
    result.model = model;
    result.effort = effort;
    args = [];
    if (o['resume-last']) args.push('--continue');
    else if (o.conversation) args.push('--conversation', o.conversation);
    else args.push('--new-project', '--add-dir', cwd);
    if (!result.resumed || o.model) {
      if (model) args.push('--model', model);
    }
    if (effort && !labelEffort) args.push('--effort', effort);
    // agy's sandbox confines reads and writes to the workspace; approvals are
    // auto-granted inside it so a headless run cannot stall on a prompt.
    args.push('--sandbox', '--dangerously-skip-permissions');
    args.push('--print-timeout', `${Math.ceil(timeoutMs / 1000)}s`);
    args.push(`--print=${briefText}`);
  } else {
    let model = o.model || null;
    if (!model && !result.resumed) {
      model = pickFreeModel(info.free);
      if (!model) {
        result.status = 'failed';
        result.exitCode = 1;
        result.error = 'No free opencode model found in `opencode models`. Pass --model <provider/model> explicitly.';
        finalize();
        return;
      }
    }
    if (o.model && info.all.length && !info.all.includes(o.model)) {
      warnings.push(`"${o.model}" is not listed by \`opencode models\`; passing it through unchanged`);
    }
    if (model && !o.model) warnings.push(`using free model ${model} (default pick); pass --model to choose another`);
    let variantArg = null;
    if (o.variant) {
      const major = parseInt((info.version || '').match(/\d+/)?.[0] || '1', 10);
      if (major >= 2 && model) model = `${model}#${o.variant}`;
      else variantArg = o.variant;
    }
    result.model = model;
    result.effort = o.variant || null;
    args = ['run', '--format', 'json', '--agent', 'plan'];
    if (model) args.push('-m', model);
    if (variantArg) args.push('--variant', variantArg);
    if (o['resume-last']) args.push('--continue');
    else if (o.session) args.push('--session', o.session);
    // No --auto: the plan agent must not be auto-approved into edits.
    input = briefText;
  }

  // ---- run it, fingerprinting the working tree before and after
  const root = gitRoot(cwd);
  const before = root ? snapshot(root) : null;
  // agy enforces its own --print-timeout first; the relay watchdog is the backstop.
  const watchdogMs = timeoutMs + (opponent === 'agy' ? WATCHDOG_GRACE_MS : 0);
  const res = await runChild({
    bin: binFor(opponent), args, cwd, input, shell: needsShell(opponent), timeoutMs: watchdogMs,
  });
  const after = root && before ? snapshot(root) : null;
  if (before && after) {
    result.touchedFiles = changedBetween(before, after);
    result.readOnlyViolation = result.touchedFiles.length > 0;
  }

  if (res.launchError) {
    result.status = 'failed';
    result.error = `could not launch ${opponent}: ${res.launchError.message}`;
    finalize();
    return;
  }

  const stdout = stripAnsi(res.stdout);
  const stderr = stripAnsi(res.stderr);
  writeFileSync(stderrPath, stderr);
  result.exitCode = res.code;
  result.signal = res.signal;
  result.durationMs = res.durationMs;

  let text = '';
  if (opponent === 'opencode') {
    writeFileSync(eventsPath, res.stdout);
    result.eventsPath = eventsPath;
    const parsed = parseOpencodeEvents(stdout);
    text = parsed.text;
    result.sessionId = parsed.sessionId;
    result.cost = parsed.cost;
    if (parsed.errors.length && !text) result.error = `opencode reported: ${parsed.errors.join('; ')}`;
  } else {
    text = stdout.trim();
  }
  result.finalMessage = text;

  if (res.aborted) {
    result.status = 'aborted';
    result.error = 'the relay was interrupted and stopped the opponent';
  } else if (res.timedOut) {
    result.status = 'timeout';
    result.exitCode = result.exitCode && result.exitCode > 0 ? result.exitCode : 124;
    result.error = `the opponent did not finish within ${Math.round(watchdogMs / 1000)}s and was stopped`;
  } else if (res.code !== 0) {
    result.status = 'failed';
    result.error ??= `${opponent} exited with code ${res.code}`;
  } else if (opponent === 'agy' && /auto-denied/i.test(stderr)) {
    result.status = 'failed';
    result.error = 'agy auto-denied a tool permission in headless mode (see references/opponents.md, "Permission traps")';
  } else if (!text) {
    result.status = 'failed';
    result.error ??= `${opponent} exited 0 but returned no text`;
  } else {
    result.status = 'completed';
  }
  if (result.status !== 'completed') result.stderrTail = tailLines(stderr);

  // A changed working tree outranks every other outcome: the debate rules were broken.
  if (result.readOnlyViolation) {
    result.status = 'read_only_violation';
    result.error = `the opponent changed the working tree: ${result.touchedFiles.join(', ')}`;
  }
  finalize();
}

// ---------------------------------------------------------------- main

const { cmd, opts } = parseArgs(process.argv);
if (opts.help || cmd === 'help' || (!cmd && process.argv.length <= 2)) {
  console.log(HELP);
} else if (cmd === 'discover') {
  cmdDiscover(opts);
} else if (cmd === 'run') {
  await cmdRun(opts);
} else {
  die(`unknown command "${cmd ?? ''}" (use discover or run; see --help)`);
}
