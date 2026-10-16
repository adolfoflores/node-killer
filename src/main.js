const { app, Menu, Tray, nativeImage, Notification, dialog, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, exec } = require('child_process');
const { promisify } = require('util');
const prefs = require('./prefs');
const { REFRESH_CHOICES, DEFAULT_REFRESH_MS } = prefs;

const execAsync = promisify(exec);

/**
 * ⚡️ Node Killer: a minimal macOS menubar app that hunts down and kills your stray Node.js processes.
 */

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

let tray = null;
let refreshTimeout = null;
let refreshInFlight = false;
let isQuitting = false;
let refreshQueued = false;
let latestProcesses = [];
let prefsWindow = null;

const isMac = process.platform === 'darwin';

const ICON_RELATIVE_PATH = path.join('assets', 'icons', 'node-killer.icns');

prefs.initPrefsFromEnvIfEmpty();

const ONE_BY_ONE_TRANSPARENT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=';

const LIGHTNING_TEMPLATE_DATA_URL =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPScxNicgaGVpZ2h0PScxNicgdmlld0JveD0nMCAwIDE2IDE2Jz48cGF0aCBmaWxsPScjMDAwMDAwJyBkPSdNNy41IDBMMSAxMGg0bC0xIDYgNy0xMGgtNGwwLjUtNnonLz48L3N2Zz4=';

const transparentImage = nativeImage.createFromDataURL(ONE_BY_ONE_TRANSPARENT_PNG);
const lightningImage = nativeImage.createFromDataURL(LIGHTNING_TEMPLATE_DATA_URL);
if (!lightningImage.isEmpty()) {
  lightningImage.setTemplateImage(true);
}
if (!transparentImage.isEmpty()) {
  transparentImage.setTemplateImage(true);
}
const textOnlyImage = transparentImage.resize({ width: 18, height: 18, quality: 'best' });
if (!textOnlyImage.isEmpty()) {
  textOnlyImage.setTemplateImage(true);
}

let cachedTrayIcon = null;

function getTrayIconImage() {
  if (cachedTrayIcon && !cachedTrayIcon.isEmpty()) {
    return cachedTrayIcon;
  }
  const iconPath = getIconPath();
  if (!fs.existsSync(iconPath)) {
    cachedTrayIcon = null;
    return null;
  }
  const image = nativeImage.createFromPath(iconPath);
  if (!image.isEmpty()) {
    image.setTemplateImage(true);
    cachedTrayIcon = image;
    return cachedTrayIcon;
  }
  cachedTrayIcon = null;
  return null;
}

function loadDockIconImage() {
  const iconPath = getIconPath();
  if (!fs.existsSync(iconPath)) return null;
  const image = nativeImage.createFromPath(iconPath);
  if (image && !image.isEmpty()) {
    return image;
  }
  return null;
}

function getIconPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ICON_RELATIVE_PATH);
  }
  return path.join(__dirname, '..', ICON_RELATIVE_PATH);
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body, silent: true }).show();
      return;
    }
  } catch (e) {
    // Fallback to dialog below
  }
  try {
    dialog.showMessageBox({ type: 'info', message: `${title}\n${body}` });
  } catch (e) {
    // As last resort
    console.log(`[Notification] ${title}: ${body}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process; EPERM: no permission but exists
    if (err && (err.code === 'EPERM')) return true; // alive but unauthorized
    return false;
  }
}

async function killPid(pid) {
  // Try SIGTERM then SIGKILL
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    return { pid, ok: false, step: 'SIGTERM', error: err.message || String(err) };
  }

  await sleep(500);
  if (!isPidAlive(pid)) {
    return { pid, ok: true, step: 'SIGTERM' };
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch (err) {
    return { pid, ok: false, step: 'SIGKILL', error: err.message || String(err) };
  }

  await sleep(300);
  if (!isPidAlive(pid)) {
    return { pid, ok: true, step: 'SIGKILL' };
  }

  return { pid, ok: false, step: 'SIGKILL', error: 'Process still alive after SIGKILL' };
}

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

function isNoProcessError(error) {
  return Boolean(error && (error.code === 1 || error.code === '1'));
}

// Helper function to classify process type based on command line
async function classifyProcess(pid, lsofCommand) {
  try {
    const { stdout } = await execAsync(`ps -p ${pid} -o command=`);
    const commandLine = stdout.trim();

    // Try to classify based on each enabled process type
    for (const [typeName, typeConfig] of Object.entries(PROCESS_TYPES)) {
      if (typeConfig.lsofCommand === lsofCommand) {
        const classification = typeConfig.classify(commandLine);
        if (classification) {
          return classification;
        }
      }
    }

    // Default to the lsof command if no classification matches
    return lsofCommand;
  } catch (error) {
    // If we can't get the command line, default to the lsof command
    return lsofCommand;
  }
}

// Scan for a specific process command (node or bun)
function scanProcessCommand(processCommand) {
  return new Promise((resolve) => {
    const user = os.userInfo().username;
    const allUsers = prefs.getAllUsers();
    const onlyMine = !allUsers;
    // Use field format to drastically reduce output size
    const args = ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-c', processCommand, '-F', 'pcPn'];
    if (onlyMine) {
      args.push('-u', user);
    }

    execFile('lsof', args, { timeout: 4000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        if (isNoProcessError(error)) {
          // lsof exit code 1 == no matching processes
          resolve([]);
          return;
        }

        // Fallback to human parse without -F if field mode failed for any reason
        const humanArgs = ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-c', processCommand];
        if (onlyMine) {
          humanArgs.push('-u', user);
        }

        execFile('lsof', humanArgs, { timeout: 3000, maxBuffer: 10 * 1024 * 1024 }, (e2, out2) => {
          if (e2) {
            if (isNoProcessError(e2)) {
              resolve([]);
              return;
            }
            console.debug(`[lsof ${processCommand}] error:`, e2.message || e2);
            resolve([]);
            return;
          }
          try {
            resolve(parseLsofOutputHuman(out2 || '', processCommand));
          } catch (e) {
            console.error(`[parseLsofOutputHuman ${processCommand}] failed:`, e);
            resolve([]);
          }
        });
        return;
      }
      try {
        const results = parseLsofOutputFields(stdout || '', processCommand);
        resolve(results);
      } catch (e) {
        console.error(`[parseLsofOutputFields ${processCommand}] failed:`, e);
        resolve([]);
      }
    });
  });
}

// Main function to scan for all enabled process types
async function scanProcessListeners() {
  const enabledTypes = prefs.getProcessTypes();
  const allProcesses = [];
  const seenPids = new Set();

  // Determine which lsof commands we need to run
  const lsofCommands = new Set();
  for (const [typeName, enabled] of Object.entries(enabledTypes)) {
    if (enabled && PROCESS_TYPES[typeName]) {
      lsofCommands.add(PROCESS_TYPES[typeName].lsofCommand);
    }
  }

  // Run lsof for each unique command
  for (const lsofCommand of lsofCommands) {
    const processes = await scanProcessCommand(lsofCommand);

    // Classify and add processes
    for (const process of processes) {
      // Skip if we've already seen this PID (deduplication)
      if (seenPids.has(process.pid)) continue;
      seenPids.add(process.pid);

      // Classify the process type
      const processType = await classifyProcess(process.pid, lsofCommand);

      // Only include if this type is enabled
      if (enabledTypes[processType]) {
        allProcesses.push({
          ...process,
          type: processType
        });
      }
    }
  }

  return allProcesses;
}

function buildMenuAndUpdate(procs = []) {
  latestProcesses = Array.isArray(procs) ? procs : [];
  const count = latestProcesses.length;

  applyDisplayMode(count);
  tray?.setToolTip(`Node Killer — active processes: ${count}`);

  const items = [];

  for (const p of latestProcesses) {
    const ports = Array.isArray(p.ports) ? p.ports : [];
    let portsLabel = '';
    if (ports.length === 1) {
      portsLabel = ` (port ${ports[0]})`;
    } else if (ports.length > 1) {
      portsLabel = ` (ports ${ports.join(', ')})`;
    }
    const processType = p.type || 'node';
    items.push({
      label: `${processType} ${p.pid}${portsLabel}`,
      click: async () => {
        const res = await killPid(p.pid);
        if (res.ok) {
          notify('✅ Process terminated', `PID ${p.pid} (${res.step})`);
        } else {
          notify('❌ Could not terminate', `PID ${p.pid} — ${res.step} — ${res.error || ''}`);
        }
        await performRefresh();
        scheduleNextRefresh();
      },
    });
  }

  items.push({ type: 'separator' });
  items.push({
    label: `Kill all (${count})`,
    enabled: count > 0,
    click: async () => {
      if (count === 0) return;
      try {
        const { response } = await dialog.showMessageBox({
          type: 'warning',
          buttons: ['Cancel', 'Kill all'],
          defaultId: 1,
          cancelId: 0,
          message: count === 1 ? 'Kill 1 process?' : `Kill ${count} processes?`,
          detail: 'Each listed process will receive SIGTERM. If it survives, SIGKILL is sent next.',
        });
        if (response !== 1) {
          return;
        }
      } catch (e) {
        console.error('Kill all confirmation failed:', e);
        return;
      }
      let ok = 0;
      let fail = 0;
      const failed = [];
      const snapshot = [...latestProcesses];
      for (const processInfo of snapshot) {
        const res = await killPid(processInfo.pid);
        if (res.ok) ok++;
        else {
          fail++;
          failed.push(`${processInfo.pid} (${res.step})`);
        }
      }
      if (fail === 0) {
        notify('✅ Kill all', `${ok} processes terminated.`);
      } else {
        notify('⚠️ Kill all with issues', `${ok} succeeded, ${fail} failed — ${failed.join(', ')}`);
      }
      await performRefresh();
      scheduleNextRefresh();
    },
  });
  items.push({
    label: 'Refresh',
    click: async () => {
      await performRefresh();
      scheduleNextRefresh();
    },
  });
  items.push({
    label: 'Preferences…',
    click: () => {
      openPreferencesWindow();
    },
  });
  items.push({ label: 'Quit', role: 'quit' });

  const menu = Menu.buildFromTemplate(items);
  tray?.setContextMenu(menu);
}

function rebuildMenuFromCache() {
  buildMenuAndUpdate(latestProcesses);
}

function applyDisplayMode(count) {
  if (!tray) return;
  const mode = prefs.getDisplayMode();
  if (isMac) {
    if (mode === 'number') {
      tray.setTitle(` active: ${count} `);
    } else if (mode === 'icon-plus-number') {
      tray.setTitle(`⚡️ ${count}`);
    } else if (mode === 'icon-only') {
      tray.setTitle('');
    } else {
      tray.setTitle(` active: ${count} `);
    }
  }

  if (mode === 'icon-only') {
    const iconImage = getTrayIconImage();
    if (iconImage) {
      tray.setImage(iconImage);
    } else if (!lightningImage.isEmpty()) {
      tray.setImage(lightningImage);
    } else {
      tray.setImage(transparentImage);
      if (isMac) {
        tray.setTitle('⚡️');
      }
    }
  } else {
    tray.setImage(textOnlyImage);
  }
}

function applyAutoLaunchSetting(enabled) {
  if (!isAutoLaunchEditable()) {
    return;
  }
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: app.getPath('exe'),
    });
  } catch (e) {
    console.error('Failed to update auto-launch setting:', e);
  }
}

function isAutoLaunchEditable() {
  return app.isPackaged && isMac && typeof app.setLoginItemSettings === 'function';
}

function createPreferencesWindow() {
  if (prefsWindow) {
    return prefsWindow;
  }

  const window = new BrowserWindow({
    width: 420,
    height: 750,
    title: 'Preferences',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#1c1f26',
    webPreferences: {
      preload: path.join(__dirname, 'preferences', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  window.on('closed', () => {
    prefsWindow = null;
  });

  window.setMenu(null);
  window.loadFile(path.join(__dirname, 'preferences', 'index.html')).catch((err) => {
    console.error('Failed to load preferences window:', err);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  prefsWindow = window;
  return window;
}

function openPreferencesWindow() {
  if (prefsWindow) {
    if (prefsWindow.isMinimized()) prefsWindow.restore();
    prefsWindow.show();
    prefsWindow.focus();
    return;
  }
  createPreferencesWindow();
}

async function performRefresh() {
  if (refreshInFlight) {
    refreshQueued = true;
    return false;
  }
  refreshInFlight = true;
  try {
    const procs = await scanProcessListeners();
    buildMenuAndUpdate(procs);
    return true;
  } catch (e) {
    console.error('Refresh failed:', e);
    return false;
  } finally {
    refreshInFlight = false;
    if (refreshQueued) {
      refreshQueued = false;
      await performRefresh();
    }
  }
}

function createTray() {
  const displayMode = prefs.getDisplayMode();
  let baseImage = textOnlyImage;
  if (displayMode === 'icon-only') {
    baseImage = getTrayIconImage() || (!lightningImage.isEmpty() ? lightningImage : transparentImage);
  }
  try {
    tray = new Tray(baseImage);
  } catch (e) {
    console.error('Failed to create Tray:', e);
    return;
  }
  tray.setToolTip('Node Killer');
  applyDisplayMode(latestProcesses.length);
}

function scheduleNextRefresh() {
  if (isQuitting) return;
  if (refreshTimeout) clearTimeout(refreshTimeout);
  refreshTimeout = null;

  const refreshPref = prefs.getRefreshMs();
  if (refreshPref === 'paused') {
    return;
  }

  let delay = Number(refreshPref);
  if (!Number.isFinite(delay) || delay <= 0) {
    delay = DEFAULT_REFRESH_MS;
    prefs.setRefreshMs(delay);
  }

  refreshTimeout = setTimeout(() => {
    if (isQuitting) return;
    performRefresh()
      .catch((e) => console.error('Auto-refresh failed:', e))
      .finally(() => {
        scheduleNextRefresh();
      });
  }, delay);
}

function buildPreferencesPayload() {
  return {
    values: prefs.getAllPreferences(),
    meta: {
      refreshChoices: REFRESH_CHOICES,
      defaultRefreshMs: DEFAULT_REFRESH_MS,
      autoLaunchEditable: isAutoLaunchEditable(),
      isPackaged: app.isPackaged,
      platform: process.platform,
    },
  };
}

ipcMain.handle('prefs:get', async () => {
  return buildPreferencesPayload();
});

ipcMain.handle('prefs:set-autoLaunch', async (_event, value) => {
  const next = prefs.setAutoLaunch(Boolean(value));
  applyAutoLaunchSetting(next);
  return buildPreferencesPayload();
});

ipcMain.handle('prefs:set-refresh', async (_event, value) => {
  prefs.setRefreshMs(value);
  await performRefresh();
  scheduleNextRefresh();
  rebuildMenuFromCache();
  return buildPreferencesPayload();
});

ipcMain.handle('prefs:set-allUsers', async (_event, value) => {
  const next = prefs.setAllUsers(Boolean(value));
  await performRefresh();
  scheduleNextRefresh();
  rebuildMenuFromCache();
  return buildPreferencesPayload();
});

ipcMain.handle('prefs:set-display', async (_event, value) => {
  prefs.setDisplayMode(value);
  applyDisplayMode(latestProcesses.length);
  rebuildMenuFromCache();
  return buildPreferencesPayload();
});

ipcMain.handle('prefs:set-processType', async (_event, typeName, enabled) => {
  prefs.setProcessType(typeName, enabled);
  await performRefresh();
  scheduleNextRefresh();
  rebuildMenuFromCache();
  return buildPreferencesPayload();
});

ipcMain.handle('prefs:set-processTypes', async (_event, types) => {
  prefs.setProcessTypes(types);
  await performRefresh();
  scheduleNextRefresh();
  rebuildMenuFromCache();
  return buildPreferencesPayload();
});

ipcMain.handle('prefs:openExternal', async (_event, url) => {
  if (typeof url !== 'string' || !url.trim()) {
    return false;
  }
  try {
    await shell.openExternal(url);
    return true;
  } catch (err) {
    console.error('Failed to open external link:', err);
    return false;
  }
});

app.on('window-all-closed', (e) => {
  // Prevent app from quitting (we are menubar-only)
  e.preventDefault();
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    notify('ℹ️ Node Killer', 'Node Killer is already running.');
  });
}

app.whenReady().then(async () => {
  if (isMac && app.dock) {
    const dockIcon = loadDockIconImage();
    if (dockIcon) {
      try {
        app.dock.setIcon(dockIcon);
      } catch (err) {
        if (!app.isPackaged) {
          console.debug('Failed to set dock icon:', err);
        }
      }
    }
    try {
      app.setActivationPolicy('accessory');
    } catch (_) {}
    try { app.dock.hide(); } catch (_) {}
  }

  createTray();
  applyAutoLaunchSetting(prefs.getAutoLaunch());
  await performRefresh();
  scheduleNextRefresh();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (refreshTimeout) clearTimeout(refreshTimeout);
});
