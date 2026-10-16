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

module.exports = {
  PROCESS_TYPES,
  looksLikeViteProcess,
  parseLsofOutputHuman,
  parseLsofOutputFields,
};
