import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { run } from '../src/cli.js';
import { daemonFilePath } from '../src/clients/http.js';
import { getVersion } from '../src/version.js';
import { startFakeDaemon, tempConfigDir, type FakeDaemon } from './helpers/fake-daemon.js';

const daemons: FakeDaemon[] = [];

afterEach(async () => {
  while (daemons.length > 0) {
    const d = daemons.pop();
    if (d !== undefined) await d.stop();
  }
});

async function daemon(): Promise<FakeDaemon> {
  const d = await startFakeDaemon();
  daemons.push(d);
  return d;
}

interface Result {
  code: number;
  out: string;
  err: string;
}

async function cli(argv: string[], configDir?: string): Promise<Result> {
  let out = '';
  let err = '';
  const code = await run(argv, {
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
    ...(configDir === undefined ? {} : { configDir }),
    stdin: '{}',
  });
  return { code, out, err };
}

describe('dispatch', () => {
  it('prints help for help, --help, -h and no args', async () => {
    for (const argv of [[], ['help'], ['--help'], ['-h']]) {
      const r = await cli(argv);
      expect(r.code, JSON.stringify(argv)).toBe(0);
      expect(r.out).toContain('claude-usage — local usage service');
      expect(r.out).toContain('serve');
      expect(r.out).toContain('Not affiliated with');
    }
  });

  it('prints the package version', async () => {
    const r = await cli(['--version']);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(getVersion());
  });

  it('exits 1 on an unknown subcommand', async () => {
    const r = await cli(['frobnicate']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('unknown subcommand "frobnicate"');
    expect(r.out).toBe('');
  });

  // sessions/pause/resume (W3), install/configure/uninstall (W6) and mcp (W7) are
  // covered by their own suites. Every subcommand is implemented; nothing is PLANNED.
});

describe('status', () => {
  it('reports a running daemon with the limits table and today totals', async () => {
    const d = await daemon();
    d.setPercents({ session: 84 });
    const r = await cli(['status'], d.configDir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('daemon: running');
    expect(r.out).toContain(`port ${d.port}`);
    expect(r.out).toContain('overall: warn');
    expect(r.out).toMatch(/session\s+84%\s+warn/);
    expect(r.out).toMatch(/weekly_scoped:fable/);
    expect(r.out).toContain('today: 8 messages');
  });

  it('exits 1 when there is no daemon.json', async () => {
    const r = await cli(['status'], tempConfigDir());
    expect(r.code).toBe(1);
    expect(r.out).toContain('daemon: not running (no daemon.json)');
  });

  it('detects a stale daemon.json', async () => {
    const dir = tempConfigDir();
    writeFileSync(daemonFilePath(dir), JSON.stringify({ pid: 2 ** 30, port: 1, version: '1' }));
    const r = await cli(['status'], dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain('stale daemon.json');
  });

  it('reports a daemon that is listed but not answering', async () => {
    const d = await startFakeDaemon();
    const dir = d.configDir;
    await d.stop();
    // Repoint daemon.json at a closed port while keeping our own live pid.
    writeFileSync(daemonFilePath(dir), JSON.stringify({ pid: process.pid, port: 1, version: '9.9.9' }));
    const r = await cli(['status'], dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain('not answering');
  });

  it('reports "scanning transcripts" before the store is ready', async () => {
    const d = await startFakeDaemon({ tokensReady: false });
    daemons.push(d);
    const r = await cli(['status'], d.configDir);
    expect(r.out).toContain('today: scanning transcripts');
  });

  it('surfaces a limits error code', async () => {
    const d = await daemon();
    d.limits.set({
      ...d.limits.snapshot(),
      stale: true,
      error: { code: 'unauthorized', message: 'rejected with 401', hint: 'run `claude` to re-login' },
    });
    const r = await cli(['status'], d.configDir);
    expect(r.out).toContain('(stale)');
    expect(r.out).toContain('limits error: unauthorized');
  });
});

describe('tokens', () => {
  it('prints a table with totals', async () => {
    const d = await daemon();
    const r = await cli(['tokens'], d.configDir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('grouped by project');
    expect(r.out).toContain('/Users/me/code/foo');
    expect(r.out).toContain('TOTAL');
    expect(r.out).toContain('1,234');
  });

  it('passes --since and --by through', async () => {
    const d = await daemon();
    const r = await cli(['tokens', '--since', '7d', '--by', 'model'], d.configDir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('grouped by model');
  });

  it('accepts --by=day form', async () => {
    const d = await daemon();
    expect((await cli(['tokens', '--by=day'], d.configDir)).out).toContain('grouped by day');
  });

  it('rejects an invalid --by locally, without calling the daemon', async () => {
    const r = await cli(['tokens', '--by', 'galaxy'], tempConfigDir());
    expect(r.code).toBe(1);
    expect(r.err).toContain('--by must be one of');
  });

  it('exits 1 with a clear message when the daemon is down', async () => {
    const r = await cli(['tokens'], tempConfigDir());
    expect(r.code).toBe(1);
    expect(r.err).toContain('daemon not running');
  });

  it('reports the initial scan instead of an empty table', async () => {
    const d = await startFakeDaemon({ tokensReady: false });
    daemons.push(d);
    const r = await cli(['tokens'], d.configDir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('initial scan still running');
  });
});

describe('hook and statusline subcommands', () => {
  it('hook always exits 0, printing when not ok', async () => {
    const d = await daemon();
    d.setPercents({ session: 96 });
    const r = await cli(['hook'], d.configDir);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^🛑/);
  });

  it('hook exits 0 and prints nothing with no daemon', async () => {
    const r = await cli(['hook'], tempConfigDir());
    expect(r).toMatchObject({ code: 0, out: '' });
  });

  it('statusline prints the compact line', async () => {
    const d = await daemon();
    const r = await cli(['statusline'], d.configDir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('5h 5%');
    expect(r.out).toContain('7d 13%');
  });

  it('statusline prints nothing with no daemon', async () => {
    const r = await cli(['statusline'], tempConfigDir());
    expect(r).toMatchObject({ code: 0, out: '' });
  });
});

describe('config subcommand', () => {
  it('prints the effective config', async () => {
    const r = await cli(['config'], tempConfigDir());
    expect(r.code).toBe(0);
    expect((JSON.parse(r.out) as { port: number }).port).toBe(47291);
  });
});
