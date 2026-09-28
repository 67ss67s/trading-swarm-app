// cli-launch.ts: how a configured launch command becomes a real spawn. Jacky never runs `claude` — his
// shell has `alias claudeproxy='HTTP_PROXY=… claude'`, which exists nowhere but inside an interactive
// zsh. So these tests run a REAL zsh with ZDOTDIR pointed at a temp .zshrc (never the user's own) and
// prove the alias is expanded, argv survives the shell verbatim, and stdin still reaches the program.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cliLaunchStatus, cliSpawnArgs, commandWord, defaultCliCommand, defaultCliCommands, loginShell, resetCliLaunchStatusCache, resolveCliLaunch, stripShellNoise } from '../../src/demo/cli-launch.js';
import { claudeBrain, makeBrain, piBrain } from '../../src/demo/brain.js';

const HAS_ZSH = existsSync('/bin/zsh');

let dir = '';
let zdot = '';
let echoScript = '';
let directBin = '';

/** Prints back everything the launch path delivered: argv after our prefix, stdin, and one env var. */
const ECHO = `
let d = '';
process.stdin.on('data', (c) => (d += c));
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin: d, http_proxy: process.env.TG_TEST_PROXY ?? null }));
});
`;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'tgate-cli-launch-'));
  writeFileSync(path.join(dir, 'echo.cjs'), ECHO);
  echoScript = path.join(dir, 'echo.cjs');
  // A temp ZDOTDIR so the real ~/.zshrc is never sourced by a test.
  zdot = path.join(dir, 'zdot');
  mkdirSync(zdot, { recursive: true });
  writeFileSync(path.join(zdot, '.zshrc'), `alias tgfake='${process.execPath} "${echoScript}" --from-alias'\n`);
  // A directly-executable file (shebang) for the `via: 'direct'` path.
  directBin = path.join(dir, 'tgdirect');
  writeFileSync(directBin, `#!${process.execPath}\n${ECHO}`);
  chmodSync(directBin, 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Runs a configured command through the resolver, with our temp zsh rc in place of the user's. */
function runCommand(cmd: string, args: string[], stdin = ''): { argv: string[]; stdin: string; http_proxy: string | null } {
  const launch = cliSpawnArgs(cmd, args);
  const r = spawnSync(launch.file, launch.args, { input: stdin, encoding: 'utf8', env: { ...process.env, ZDOTDIR: zdot, SHELL: '/bin/zsh' }, timeout: 30_000 });
  const out = stripShellNoise(String(r.stdout ?? '')).trim();
  if (!out) throw new Error(`no output (code ${r.status}): ${String(r.stderr ?? '').slice(-300)}`);
  return JSON.parse(out) as { argv: string[]; stdin: string; http_proxy: string | null };
}

describe('resolveCliLaunch', () => {
  it('a bare executable on PATH is spawned directly (no shell in the way)', () => {
    const l = resolveCliLaunch('sh');
    expect(l).toEqual({ file: 'sh', argsPrefix: [], via: 'direct' });
  });

  it('an absolute path to an executable is direct; a path that is not executable falls back to the shell', () => {
    expect(resolveCliLaunch(directBin).via).toBe('direct');
    expect(resolveCliLaunch(path.join(dir, 'echo.cjs')).via).toBe('shell'); // exists but not +x
    expect(resolveCliLaunch(path.join(dir, 'nope-does-not-exist')).via).toBe('shell');
  });

  it('an alias-only command (claudeproxy) goes through the login+interactive shell', () => {
    const l = resolveCliLaunch('claudeproxy');
    expect(l.via).toBe('shell');
    expect(l.file).toBe(loginShell());
    expect(l.argsPrefix).toEqual(['-ilc', 'claudeproxy "$@"', '--']);
  });

  it('an env-prefixed line goes through the shell, keeping the prefix verbatim', () => {
    const l = resolveCliLaunch('  HTTP_PROXY=http://127.0.0.1:7897 claude  ');
    expect(l.via).toBe('shell');
    expect(l.argsPrefix[1]).toBe('HTTP_PROXY=http://127.0.0.1:7897 claude "$@"');
  });

  it('cliSpawnArgs puts our argv after the prefix, never inside the shell string', () => {
    const a = cliSpawnArgs('claudeproxy', ['-p', '--model', 'sonnet']);
    expect(a.args).toEqual(['-ilc', 'claudeproxy "$@"', '--', '-p', '--model', 'sonnet']);
  });

  it('commandWord skips env prefixes so the status probe looks up the program, not the variable', () => {
    expect(commandWord('HTTP_PROXY=x ALL_PROXY=y claudeproxy')).toBe('claudeproxy');
    expect(commandWord('claude')).toBe('claude');
    expect(commandWord('FOO=1')).toBe('');
  });

  it('defaults come from TG_DEMO_CLI_<NAME>, else the bare CLI name', () => {
    expect(defaultCliCommand('codex')).toBe(process.env['TG_DEMO_CLI_CODEX']?.trim() || 'codex');
    process.env['TG_DEMO_CLI_CLAUDE'] = 'claudeproxy';
    try {
      expect(defaultCliCommand('claude')).toBe('claudeproxy');
      expect(defaultCliCommands().claude).toBe('claudeproxy');
    } finally {
      delete process.env['TG_DEMO_CLI_CLAUDE'];
    }
  });
});

describe('stripShellNoise', () => {
  it('drops the login shell’s ~/.zlogout chatter and keeps everything else', () => {
    const raw = 'Saving session...\n...copying shared history...\n...saving history...truncating history files...\n...completed.\nreal error: boom';
    expect(stripShellNoise(raw)).toBe('real error: boom');
    expect(stripShellNoise('nothing to strip')).toBe('nothing to strip');
  });
});

describe.skipIf(!HAS_ZSH)('running through the shell for real (temp ZDOTDIR, never ~/.zshrc)', () => {
  it('expands an alias that exists only in the interactive shell, and passes argv + stdin through', () => {
    const r = runCommand('tgfake', ['-p', 'a b', '--model', 'sonnet'], 'the prompt');
    expect(r.argv).toEqual(['--from-alias', '-p', 'a b', '--model', 'sonnet']);
    expect(r.stdin).toBe('the prompt');
  });

  it('an env prefix in the command reaches the child process', () => {
    const r = runCommand(`TG_TEST_PROXY=socks5://127.0.0.1:7897 ${process.execPath} "${echoScript}"`, ['--flag'], 'x');
    expect(r.http_proxy).toBe('socks5://127.0.0.1:7897');
    expect(r.argv).toEqual(['--flag']);
  });

  it('a direct command gets the exact same argv and stdin (no shell involved)', () => {
    const r = runCommand(directBin, ['--flag', 'v'], 'y');
    expect(resolveCliLaunch(directBin).via).toBe('direct');
    expect(r.argv).toEqual(['--flag', 'v']);
    expect(r.stdin).toBe('y');
  });
});

describe('cliLaunchStatus', () => {
  it('direct commands are ok without probing anything', () => {
    resetCliLaunchStatusCache();
    const s = cliLaunchStatus('sh');
    expect(s.via).toBe('direct');
    expect(s.ok).toBe(true);
  });

  it.skipIf(!HAS_ZSH)('a shell-only alias resolves via the shell; an unknown word does not', () => {
    const prevShell = process.env['SHELL'];
    const prevZdot = process.env['ZDOTDIR'];
    process.env['SHELL'] = '/bin/zsh';
    process.env['ZDOTDIR'] = zdot;
    resetCliLaunchStatusCache();
    try {
      const ok = cliLaunchStatus('tgfake');
      expect(ok.via).toBe('shell');
      expect(ok.ok).toBe(true);
      const bad = cliLaunchStatus('tg-definitely-not-a-command');
      expect(bad.via).toBe('shell');
      expect(bad.ok).toBe(false);
    } finally {
      resetCliLaunchStatusCache();
      if (prevShell === undefined) delete process.env['SHELL'];
      else process.env['SHELL'] = prevShell;
      if (prevZdot === undefined) delete process.env['ZDOTDIR'];
      else process.env['ZDOTDIR'] = prevZdot;
    }
  });
});

describe('brains spawn the configured command', () => {
  it('pi runs the configured command (shell form) and still gets its own flags + the user prompt on stdin', async () => {
    const brain = piBrain({ model: 'zai/glm-5.3', command: `${process.execPath} "${echoScript}"` });
    const r = await brain.complete('SYS', 'USER', { timeoutMs: 30_000 });
    const seen = JSON.parse(r.text) as { argv: string[]; stdin: string };
    expect(seen.stdin).toBe('USER');
    expect(seen.argv[seen.argv.indexOf('--model') + 1]).toBe('glm-5.3');
    expect(seen.argv[seen.argv.indexOf('--provider') + 1]).toBe('zai');
    expect(seen.argv[seen.argv.indexOf('--system-prompt') + 1]).toBe('SYS');
    expect(r.model).toBe('pi:zai/glm-5.3');
  });

  it('claude runs a directly-executable configured command', async () => {
    const brain = claudeBrain({ model: 'sonnet', command: directBin });
    const r = await brain.complete('SYS', 'USER', { timeoutMs: 30_000 });
    const seen = JSON.parse(r.text) as { argv: string[]; stdin: string };
    expect(seen.stdin).toBe('USER');
    expect(seen.argv[seen.argv.indexOf('--model') + 1]).toBe('sonnet');
  });

  it('makeBrain threads the command down to the spawn', async () => {
    const brain = makeBrain('claude', 'haiku', { command: directBin });
    const r = await brain.complete('S', 'U', { timeoutMs: 30_000 });
    expect((JSON.parse(r.text) as { argv: string[] }).argv).toContain('haiku');
  });
});
