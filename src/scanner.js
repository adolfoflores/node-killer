// Pure helpers for finding and describing dev-server processes.
// Nothing here touches Electron, so it can be unit tested with `npm test`.

const VITE_PATTERN = /(?:^|[=\/@\s"'`])vite(?:\.js)?(?=$|[\s"'`/:@])/;

function looksLikeViteProcess(commandLine = '') {
  if (!commandLine) return false;
  const normalized = commandLine.toLowerCase().replace(/\\/g, '/');
  return VITE_PATTERN.test(normalized);
}

// Process type configuration
const PROCESS_TYPES = {
  node: {
    label: 'node',
    lsofCommand: 'node',
    classify: (commandLine) => {
      // If it contains vite, classify as vite instead
      if (looksLikeViteProcess(commandLine)) {
        return null;
      }
      return 'node';
    }
  },
  vite: {
    label: 'vite',
    lsofCommand: 'node', // Vite runs as node process
    classify: (commandLine) => {
      if (looksLikeViteProcess(commandLine)) {
        return 'vite';
      }
      return null;
    }
  },
  bun: {
    label: 'bun',
    lsofCommand: 'bun',
    classify: () => 'bun'
  }
};

function parseLsofOutputHuman(stdout, processCommand) {
  const lines = stdout.split(/\r?\n/);
  const processes = new Map(); // pid -> { pid, ports: Set<number>, user, command }

  for (const line of lines) {
    if (!line || line.startsWith('COMMAND') || !/LISTEN/.test(line)) continue;

    const compact = line.trim().replace(/\s+/g, ' ');
    const parts = compact.split(' ');
    if (parts.length < 2) continue;

    const command = parts[0];
    const pidNum = Number(parts[1]);
    const user = parts[2] || '';

    // Keep processes based on the command filter
    if (processCommand === 'node') {
      if (!(command === 'node' || /\bnode(js)?\b/.test(command))) continue;
    } else if (processCommand === 'bun') {
      if (!(command === 'bun' || /\bbun\b/.test(command))) continue;
    }
    if (!Number.isFinite(pidNum)) continue;

    // Extract port(s)
    const m = line.match(/TCP [^\s]*:(\d+) \(LISTEN\)/);
    const port = m ? Number(m[1]) : null;

    if (!processes.has(pidNum)) {
      processes.set(pidNum, { pid: pidNum, user, ports: new Set(), command: processCommand });
    }
    if (port) processes.get(pidNum).ports.add(port);
  }

  return Array.from(processes.values()).map((p) => ({
    pid: p.pid,
    user: p.user,
    ports: Array.from(p.ports).sort((a, b) => a - b),
    command: p.command,
  }));
}

function parseLsofOutputFields(stdout, processCommand) {
  // Parse output from: lsof -F pcPn ...
  const processes = new Map(); // pid -> { pid, ports: Set<number>, user?: string, command }
  let currentPid = null;
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    const key = line[0];
    const val = line.slice(1);
    if (key === 'p') {
      const pid = Number(val);
      if (!Number.isFinite(pid)) { currentPid = null; continue; }
      currentPid = pid;
      if (!processes.has(pid)) processes.set(pid, { pid, ports: new Set(), command: processCommand });
    } else if (key === 'n') {
      // e.g., "*:3000", "127.0.0.1:5173" or "[::1]:3200" (field mode has no "(LISTEN)" suffix)
      const m = val.match(/:(\d+)$/);
      const port = m ? Number(m[1]) : null;
      if (currentPid && port) {
        processes.get(currentPid).ports.add(port);
      }
    }
  }
  return Array.from(processes.values()).map((p) => ({
    pid: p.pid,
    ports: Array.from(p.ports).sort((a, b) => a - b),
    command: p.command,
  }));
}

// Pick the process type for a command line found through `lsof -c <lsofCommand>`
function classifyCommand(commandLine, lsofCommand) {
  if (commandLine) {
    for (const typeConfig of Object.values(PROCESS_TYPES)) {
      if (typeConfig.lsofCommand !== lsofCommand) continue;
      const classification = typeConfig.classify(commandLine);
      if (classification) return classification;
    }
  }
  return lsofCommand;
}

// ps etime format: [[dd-]hh:]mm:ss
function parseElapsed(etime = '') {
  const m = String(etime).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, days = 0, hours = 0, minutes, seconds] = m;
  return Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

// Parse output from: ps -o pid=,pcpu=,rss=,etime=,command= -p <pids>
function parsePsOutput(stdout = '') {
  const stats = new Map(); // pid -> { pid, cpu, rssKb, elapsedSeconds, commandLine }
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+([\d.,]+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    stats.set(pid, {
      pid,
      cpu: Number(m[2].replace(',', '.')) || 0,
      rssKb: Number(m[3]) || 0,
      elapsedSeconds: parseElapsed(m[4]),
      commandLine: m[5].trim(),
    });
  }
  return stats;
}

const FOOTPRINT_UNITS = { B: 1 / 1024, KB: 1, MB: 1024, GB: 1024 * 1024 };

// Parse output from: footprint -p <pid> -p <pid> …
// e.g. "node [84988]: 64-bit    Footprint: 361 MB (16384 bytes per page)"
// This is the memory Activity Monitor shows; ps RSS leaves out compressed memory.
function parseFootprintOutput(stdout = '') {
  const memoryKbByPid = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/\[(\d+)\]:.*Footprint:\s*([\d.,]+)\s*(B|KB|MB|GB)\b/);
    if (!m) continue;
    const value = Number(m[2].replace(',', '.'));
    if (Number.isFinite(value)) memoryKbByPid.set(Number(m[1]), value * FOOTPRINT_UNITS[m[3]]);
  }
  return memoryKbByPid;
}

// Prefer the footprint, fall back to RSS when footprint couldn't read the process
function memoryKbOf(stats) {
  if (!stats) return 0;
  return Number.isFinite(stats.memoryKb) ? stats.memoryKb : stats.rssKb || 0;
}

const INTERPRETERS = new Set(['node', 'nodejs', 'bun']);
const FLAGS_WITH_VALUE = new Set(['-r', '--require', '--import', '--loader', '-e', '--eval']);
const SCRIPT_EXTENSION = /\.(?:c|m)?[jt]s$/;

// Name a script path the way you would type it: "vite", "next", "server.js"
function scriptName(token) {
  const normalized = token.replace(/\\/g, '/');
  const pkg = normalized.match(/\/node_modules\/((?:@[^/]+\/)?[^/.][^/]*)\//);
  if (pkg) return pkg[1];
  const base = normalized.split('/').filter(Boolean).pop() || normalized;
  // Installed binaries ("…/.bin/vite.js") read better without the extension
  return /\/(?:node_modules|bin)\//.test(normalized) ? base.replace(SCRIPT_EXTENSION, '') : base;
}

function truncate(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

// "/…/bin/node /…/node_modules/.bin/vite dev --port 5173" -> "vite dev --port 5173"
function summarizeCommand(commandLine = '', maxLength = 40) {
  const tokens = String(commandLine).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';

  let index = 0;
  if (INTERPRETERS.has(scriptName(tokens[0]))) {
    index = 1;
    while (index < tokens.length && tokens[index].startsWith('-')) {
      index += FLAGS_WITH_VALUE.has(tokens[index]) ? 2 : 1;
    }
    if (index >= tokens.length) {
      return truncate(scriptName(tokens[0]), maxLength);
    }
  }

  const words = [scriptName(tokens[index]), ...tokens.slice(index + 1)];
  return truncate(words.join(' '), maxLength);
}

function formatMemory(rssKb) {
  const mb = rssKb / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(mb))} MB`;
}

function formatCpu(cpu) {
  return `${Math.round(cpu)}%`;
}

function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

// "vite :5173 — vite dev · 3% · 120 MB · 2h"
function buildProcessLabel(proc) {
  const ports = Array.isArray(proc.ports) ? proc.ports : [];
  const where = ports.length > 0 ? ports.map((port) => `:${port}`).join(' ') : `pid ${proc.pid}`;
  let label = `${proc.type || 'node'} ${where}`;

  const summary = proc.commandLine ? summarizeCommand(proc.commandLine) : '';
  if (summary) label += ` — ${summary}`;

  if (proc.stats) {
    const details = [formatCpu(proc.stats.cpu), formatMemory(memoryKbOf(proc.stats))];
    const uptime = formatUptime(proc.stats.elapsedSeconds);
    if (uptime) details.push(uptime);
    label += ` · ${details.join(' · ')}`;
  }
  return label;
}

// Parse output from: ps -Ao pid=,ppid=,stat=,command=
function parseProcessTable(stdout = '') {
  const table = new Map(); // pid -> { pid, ppid, stat, commandLine }
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    table.set(pid, { pid, ppid: Number(m[2]), stat: m[3], commandLine: m[4].trim() });
  }
  return table;
}

// Tools that start (and often restart) the actual dev server as a child process.
// Killing only the child would let them bring it right back.
const DEV_RUNNERS = new Set([
  'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bunx',
  'next', 'nuxt', 'nuxi', 'astro', 'remix', 'vite', 'nodemon', 'tsx', 'ts-node-dev', 'node-dev',
]);

function isDevRunner(commandLine = '') {
  const tokens = String(commandLine).trim().split(/\s+/);
  // "bun run dev" / "bun x vite": bun acting as the package runner
  if (scriptName(tokens[0] || '') === 'bun' && ['run', 'x'].includes(tokens[1])) return true;
  const firstWord = summarizeCommand(commandLine, Infinity).split(' ')[0];
  return DEV_RUNNERS.has(firstWord);
}

// Climb from the server through parents that are dev runners (npm → next dev → next-server)
// and stop at anything else: a shell, an editor, an agent, launchd.
function findKillRoot(table, pid, protectedPids = new Set()) {
  let root = pid;
  let parent = table.get(table.get(root)?.ppid);
  while (parent && parent.pid > 1 && !protectedPids.has(parent.pid) && isDevRunner(parent.commandLine)) {
    root = parent.pid;
    parent = table.get(parent.ppid);
  }
  return root;
}

function collectSubtree(table, rootPid) {
  const children = new Map();
  for (const proc of table.values()) {
    if (!children.has(proc.ppid)) children.set(proc.ppid, []);
    children.get(proc.ppid).push(proc.pid);
  }
  const pids = [];
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length > 0) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    pids.push(pid);
    queue.push(...(children.get(pid) || []));
  }
  return pids;
}

// Every PID to signal so each server goes away the way Ctrl-C would take it down:
// the server, the dev runners that started it, and everything they started.
// Node Killer itself and its ancestors are never included.
function planKill(table, serverPids, ownPid) {
  const protectedPids = new Set();
  for (let proc = table.get(ownPid); proc && proc.pid > 1; proc = table.get(proc.ppid)) {
    if (protectedPids.has(proc.pid)) break;
    protectedPids.add(proc.pid);
  }

  const targets = new Set();
  for (const pid of serverPids) {
    if (!table.has(pid)) {
      targets.add(pid); // already gone or not visible; signalling it is harmless
      continue;
    }
    for (const member of collectSubtree(table, findKillRoot(table, pid, protectedPids))) {
      if (member > 1 && !protectedPids.has(member)) targets.add(member);
    }
  }
  return Array.from(targets).sort((a, b) => a - b);
}

// Status bar text for each display mode (icon-only shows no text)
function formatTrayTitle(mode, procs = []) {
  const count = procs.length;
  const totalCpu = procs.reduce((total, p) => total + (p.stats ? p.stats.cpu : 0), 0);
  const totalMemoryKb = procs.reduce((total, p) => total + memoryKbOf(p.stats), 0);
  switch (mode) {
    case 'icon-plus-number':
      return `⚡️ ${count}`;
    case 'number-plus-memory':
      return count > 0 ? `⚡️ ${count} · ${formatMemory(totalMemoryKb)}` : `⚡️ ${count}`;
    case 'number-plus-cpu':
      return count > 0 ? `⚡️ ${count} · ${formatCpu(totalCpu)}` : `⚡️ ${count}`;
    case 'icon-only':
      return '';
    default:
      return ` active: ${count} `;
  }
}

module.exports = {
  PROCESS_TYPES,
  looksLikeViteProcess,
  parseLsofOutputHuman,
  parseLsofOutputFields,
  classifyCommand,
  parseElapsed,
  parsePsOutput,
  parseFootprintOutput,
  summarizeCommand,
  formatMemory,
  formatCpu,
  formatUptime,
  buildProcessLabel,
  formatTrayTitle,
  parseProcessTable,
  isDevRunner,
  findKillRoot,
  planKill,
};
