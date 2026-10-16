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

// Parse output from: ps -o pid=,pgid=,pcpu=,rss=,etime=,command= -p <pids>
function parsePsOutput(stdout = '') {
  const stats = new Map(); // pid -> { pid, pgid, cpu, rssKb, elapsedSeconds, commandLine }
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.,]+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    stats.set(pid, {
      pid,
      pgid: Number(m[2]),
      cpu: Number(m[3].replace(',', '.')) || 0,
      rssKb: Number(m[4]) || 0,
      elapsedSeconds: parseElapsed(m[5]),
      commandLine: m[6].trim(),
    });
  }
  return stats;
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
    const details = [formatCpu(proc.stats.cpu), formatMemory(proc.stats.rssKb)];
    const uptime = formatUptime(proc.stats.elapsedSeconds);
    if (uptime) details.push(uptime);
    label += ` · ${details.join(' · ')}`;
  }
  return label;
}

module.exports = {
  PROCESS_TYPES,
  looksLikeViteProcess,
  parseLsofOutputHuman,
  parseLsofOutputFields,
  classifyCommand,
  parseElapsed,
  parsePsOutput,
  summarizeCommand,
  formatMemory,
  formatCpu,
  formatUptime,
  buildProcessLabel,
};
