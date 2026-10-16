const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseLsofOutputFields,
  parseLsofOutputHuman,
  classifyCommand,
  parseElapsed,
  parsePsOutput,
  parseFootprintOutput,
  summarizeCommand,
  formatMemory,
  formatUptime,
  buildProcessLabel,
  formatTrayTitle,
  parseProcessTable,
  isDevRunner,
  planKill,
} = require('../src/scanner');

test('parseLsofOutputFields reads ports from field mode names', () => {
  // Real `lsof -F pcPn` output: names have no "(LISTEN)" suffix (regression for v0.2.2)
  const stdout = ['p101', 'cnode', 'f22', 'PTCP', 'n*:3000', 'f23', 'PTCP', 'n[::1]:3200',
    'p202', 'cnode', 'f10', 'PTCP', 'n127.0.0.1:5173', ''].join('\n');
  assert.deepEqual(parseLsofOutputFields(stdout, 'node'), [
    { pid: 101, ports: [3000, 3200], command: 'node' },
    { pid: 202, ports: [5173], command: 'node' },
  ]);
});

test('parseLsofOutputHuman reads ports from the default lsof table', () => {
  const stdout = [
    'COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
    'node    84988 adolfo   22u  IPv6 0x1      0t0  TCP [::1]:3200 (LISTEN)',
    'bun      9001 adolfo   12u  IPv4 0x2      0t0  TCP *:4000 (LISTEN)',
  ].join('\n');
  assert.deepEqual(parseLsofOutputHuman(stdout, 'node'), [
    { pid: 84988, user: 'adolfo', ports: [3200], command: 'node' },
  ]);
});

test('classifyCommand tells vite apart from plain node', () => {
  assert.equal(classifyCommand('node /app/node_modules/.bin/vite dev', 'node'), 'vite');
  assert.equal(classifyCommand('node server.js', 'node'), 'node');
  assert.equal(classifyCommand('bun run dev', 'bun'), 'bun');
  assert.equal(classifyCommand('', 'node'), 'node');
});

test('parseElapsed handles every ps etime shape', () => {
  assert.equal(parseElapsed('00:07'), 7);
  assert.equal(parseElapsed('05:12'), 312);
  assert.equal(parseElapsed('02:03:04'), 7384);
  assert.equal(parseElapsed('3-04:05:06'), 3 * 86400 + 4 * 3600 + 5 * 60 + 6);
  assert.equal(parseElapsed('garbage'), null);
});

test('parsePsOutput keeps command lines with spaces and comma decimals', () => {
  const stdout = [
    '84988   3.5 122880 1-03:00:00 /usr/local/bin/node /app/node_modules/.bin/vite dev --port 3200',
    '  901   0,4   2048     00:42 bun run dev',
  ].join('\n');
  const stats = parsePsOutput(stdout);
  assert.deepEqual(stats.get(84988), {
    pid: 84988,
    cpu: 3.5,
    rssKb: 122880,
    elapsedSeconds: 97200,
    commandLine: '/usr/local/bin/node /app/node_modules/.bin/vite dev --port 3200',
  });
  assert.equal(stats.get(901).cpu, 0.4);
  assert.equal(stats.get(901).commandLine, 'bun run dev');
});

test('parseFootprintOutput reads the memory Activity Monitor shows', () => {
  const stdout = [
    'node [84988]: 64-bit    Footprint: 361 MB (16384 bytes per page)',
    'node [4815]: 64-bit    Footprint: 1.5 GB (16384 bytes per page)',
    'node [4817]: 64-bit    Footprint: 640 KB (16384 bytes per page)',
    '',
    'Summary Footprint: 2 GB',
  ].join('\n');
  const memory = parseFootprintOutput(stdout);
  assert.equal(memory.size, 3);
  assert.equal(memory.get(84988), 361 * 1024);
  assert.equal(memory.get(4815), 1.5 * 1024 * 1024);
  assert.equal(memory.get(4817), 640);
});

test('summarizeCommand names what you would have typed', () => {
  assert.equal(summarizeCommand('/Users/me/.nvm/versions/node/v24.0.0/bin/node /app/node_modules/.bin/vite dev'), 'vite dev');
  assert.equal(summarizeCommand('node /app/node_modules/next/dist/bin/next dev'), 'next dev');
  assert.equal(summarizeCommand('node /app/node_modules/.pnpm/vite@5.0.0/node_modules/vite/bin/vite.js'), 'vite');
  assert.equal(summarizeCommand('node --inspect=9229 -r dotenv/config server.js'), 'server.js');
  assert.equal(summarizeCommand('bun run dev'), 'run dev');
  assert.equal(summarizeCommand('next-server (v15.1.0)'), 'next-server (v15.1.0)');
  assert.equal(summarizeCommand('node'), 'node');
  assert.equal(summarizeCommand('node app.js ' + 'x'.repeat(60)).length, 40);
});

test('formatMemory and formatUptime stay short', () => {
  assert.equal(formatMemory(120 * 1024), '120 MB');
  assert.equal(formatMemory(1.4 * 1024 * 1024), '1.4 GB');
  assert.equal(formatMemory(200), '1 MB');
  assert.equal(formatUptime(42), '42s');
  assert.equal(formatUptime(12 * 60), '12m');
  assert.equal(formatUptime(2 * 3600), '2h');
  assert.equal(formatUptime(2 * 3600 + 5 * 60), '2h 5m');
  assert.equal(formatUptime(2 * 86400 + 5 * 3600), '2d 5h');
  assert.equal(formatUptime(null), '');
});

test('buildProcessLabel shows ports, command and stats', () => {
  const stats = { cpu: 3.2, rssKb: 3 * 1024, memoryKb: 120 * 1024, elapsedSeconds: 7200 };
  assert.equal(
    buildProcessLabel({ pid: 1, type: 'vite', ports: [5173], commandLine: 'node /app/node_modules/.bin/vite dev', stats }),
    'vite :5173 — vite dev · 3% · 120 MB · 2h',
  );
  assert.equal(
    buildProcessLabel({ pid: 7, type: 'bun', ports: [4000], commandLine: 'bun run dev', stats: { cpu: 0, rssKb: 50 * 1024, elapsedSeconds: 30 } }),
    'bun :4000 — run dev · 0% · 50 MB · 30s',
  );
  assert.equal(buildProcessLabel({ pid: 42, type: 'node', ports: [], commandLine: '', stats: null }), 'node pid 42');
});

test('formatTrayTitle sums the stats of every listed process', () => {
  const procs = [
    { stats: { cpu: 10.4, rssKb: 5 * 1024, memoryKb: 1024 * 1024 } },
    { stats: { cpu: 2, rssKb: 400 * 1024 } },
    { stats: null },
  ];
  assert.equal(formatTrayTitle('number', procs), ' active: 3 ');
  assert.equal(formatTrayTitle('icon-plus-number', procs), '⚡️ 3');
  assert.equal(formatTrayTitle('number-plus-memory', procs), '⚡️ 3 · 1.4 GB');
  assert.equal(formatTrayTitle('number-plus-cpu', procs), '⚡️ 3 · 12%');
  assert.equal(formatTrayTitle('number-plus-memory', []), '⚡️ 0');
  assert.equal(formatTrayTitle('icon-only', procs), '');
});

// Build a process table from [pid, ppid, command] rows
function table(rows) {
  return parseProcessTable(rows.map(([pid, ppid, command, stat = 'S']) => `${pid} ${ppid} ${stat} ${command}`).join('\n'));
}

test('parseProcessTable keeps the full command line', () => {
  const parsed = parseProcessTable(' 6937  6936 S    next-server (v16.3.8) \n    1     0 Ss   /sbin/launchd\n');
  assert.deepEqual(parsed.get(6937), { pid: 6937, ppid: 6936, stat: 'S', commandLine: 'next-server (v16.3.8)' });
  assert.equal(parsed.get(1).commandLine, '/sbin/launchd');
});

test('isDevRunner recognizes package managers and dev tools only', () => {
  assert.equal(isDevRunner('npm run dev'), true);
  assert.equal(isDevRunner('node /opt/homebrew/bin/npm run dev'), true);
  assert.equal(isDevRunner('node /app/node_modules/.bin/next dev'), true);
  assert.equal(isDevRunner('bun run dev'), true);
  assert.equal(isDevRunner('/bin/zsh -l'), false);
  assert.equal(isDevRunner('claude --output-format stream-json'), false);
  assert.equal(isDevRunner('/Applications/Claude.app/Contents/Helpers/disclaimer -- /opt/homebrew/bin/npm run dev'), false);
  assert.equal(isDevRunner('node scripts/agent.js'), false);
});

test('planKill takes down the runner that would restart the server', () => {
  // Real tree: Next.js started from the Claude app (wrapper → npm → next dev → next-server)
  const t = table([
    [93922, 1, '/Applications/Claude.app/Contents/MacOS/Claude'],
    [6908, 93922, '/Applications/Claude.app/Contents/Helpers/disclaimer -- /opt/homebrew/bin/npm run dev'],
    [6911, 6908, 'npm run dev'],
    [6936, 6911, 'node /app/node_modules/.bin/next dev'],
    [6937, 6936, 'next-server (v16.3.8)'],
    [6938, 6937, 'node /app/node_modules/next/dist/compiled/jest-worker/processChild.js'],
  ]);
  assert.deepEqual(planKill(t, [6937], 500), [6911, 6936, 6937, 6938]);
});

test('planKill never climbs past a shell, an editor or an agent', () => {
  const t = table([
    [100, 1, '/bin/zsh -l'],
    [200, 100, 'npm run dev'],
    [201, 200, 'sh -c vite'],
    [202, 201, 'node /app/node_modules/.bin/vite'],
    [203, 202, '/app/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.21.5 --ping'],
    [300, 1, 'claude'],
    [301, 300, '/bin/bash -c npm run dev'],
    [302, 301, 'npm run dev'],
    [303, 302, 'node /web/node_modules/.bin/vite'],
    [400, 1, '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)'],
    [401, 400, 'node /ext/server.js --port 6009'],
  ]);
  assert.deepEqual(planKill(t, [202], 999), [202, 203]); // npm exits by itself once its script ends
  assert.deepEqual(planKill(t, [303], 999), [302, 303]); // claude and its shell survive
  assert.deepEqual(planKill(t, [401], 999), [401]); // VS Code survives
});

test('planKill never includes Node Killer or its ancestors', () => {
  // Developing Node Killer itself: npm run dev → electron (us), next to another server under the same npm
  const t = table([
    [600, 1, 'npm run dev'],
    [601, 600, '/app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .'],
    [602, 600, 'node /app/node_modules/.bin/next dev'],
    [603, 602, 'next-server (v16.3.8)'],
  ]);
  assert.deepEqual(planKill(t, [603], 601), [602, 603]);
});

test('planKill merges servers that share a runner and keeps unknown PIDs', () => {
  const t = table([
    [700, 1, 'pnpm dev'],
    [701, 700, 'node /app/node_modules/.bin/vite'],
    [702, 700, 'node /app/node_modules/.bin/vite --port 5174'],
  ]);
  assert.deepEqual(planKill(t, [701, 702, 9999], 1), [700, 701, 702, 9999]);
});
