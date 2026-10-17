const { app, Menu, Tray, nativeImage, Notification, dialog, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const prefs = require('./prefs');
const {
  PROCESS_TYPES,
  parseLsofOutputHuman,
  parseLsofOutputFields,
  parsePsOutput,
  parseFootprintOutput,
  classifyCommand,
  buildProcessLabel,
  formatTrayTitle,
  parseProcessTable,
  planKill,
  parseLsofCwdOutput,
  describeProject,
  sortProcesses,
} = require('./scanner');
const { REFRESH_CHOICES, DEFAULT_REFRESH_MS } = prefs;

/**
 * ⚡️ Node Killer: a minimal macOS menubar app that hunts down and kills your stray Node.js processes.
 */

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

function readProcessTable() {
  return new Promise((resolve) => {
    const options = { timeout: 3000, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } };
    execFile('ps', ['-Ao', 'pid=,ppid=,stat=,command='], options, (error, stdout) => {
      if (error && !stdout) {
        console.debug('[ps -A] error:', error.message || error);
      }
      resolve(parseProcessTable(stdout || ''));
    });
  });
}

// Returns the PIDs that refused the signal for a reason other than being gone already
function signalAll(pids, signal) {
  const denied = [];
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (err) {
      if (err && err.code === 'EPERM') denied.push(pid);
    }
  }
  return denied;
}

// Zombies answer kill(pid, 0) but are already dead: they only wait for their parent to reap them
async function stillRunning(pids) {
  const alive = pids.filter(isPidAlive);
  if (alive.length === 0) return { alive, table: null };
  const table = await readProcessTable();
  return { alive: alive.filter((pid) => !(table.get(pid)?.stat || '').startsWith('Z')), table };
}

// Stop each server like Ctrl-C would: together with the dev runner that started it
// (npm, next dev, …) and every process they started. SIGTERM first, then SIGKILL.
async function killServers(serverPids) {
  const targets = planKill(await readProcessTable(), serverPids, process.pid);
  const count = targets.length;

  const denied = signalAll(targets, 'SIGTERM');
  await sleep(500);
  let { alive } = await stillRunning(targets);
  if (alive.length === 0) {
    return { ok: true, step: 'SIGTERM', count };
  }

  signalAll(alive, 'SIGKILL');
  await sleep(300);
  const after = await stillRunning(alive);
  alive = after.alive;
  if (alive.length === 0) {
    return { ok: true, step: 'SIGKILL', count };
  }

  let error = `${alive.length} process(es) still alive after SIGKILL (PID ${alive.join(', ')})`;
  if (alive.some((pid) => denied.includes(pid))) {
    error = `Permission denied for PID ${alive.join(', ')} (owned by another user)`;
  } else if (alive.some((pid) => (after.table?.get(pid)?.stat || '').startsWith('U'))) {
    error = `PID ${alive.join(', ')} is stuck waiting on the disk or a driver; only a restart will free it`;
  }
  return { ok: false, step: 'SIGKILL', count, error };
}

function relatedSuffix(count, servers = 1) {
  const related = count - servers;
  return related > 0 ? ` and ${related} related process${related === 1 ? '' : 'es'}` : '';
}

function isNoProcessError(error) {
  return Boolean(error && (error.code === 1 || error.code === '1'));
}

// One ps call for every PID: command line, CPU, memory and uptime
function readProcessStats(pids) {
  return new Promise((resolve) => {
    if (pids.length === 0) {
      resolve(new Map());
      return;
    }
    const args = ['-o', 'pid=,pcpu=,rss=,etime=,command=', '-p', pids.join(',')];
    // LC_ALL=C keeps decimals as "3.5" regardless of the user's locale
    const options = { timeout: 3000, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } };
    execFile('ps', args, options, (error, stdout) => {
      // ps exits 1 when a PID is already gone but still prints the others
      if (error && !stdout) {
        console.debug('[ps] error:', error.message || error);
      }
      try {
        resolve(parsePsOutput(stdout || ''));
      } catch (e) {
        console.error('[parsePsOutput] failed:', e);
        resolve(new Map());
      }
    });
  });
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

// Memory as Activity Monitor reports it (ps RSS misses compressed memory on macOS)
function readMemoryFootprints(pids) {
  return new Promise((resolve) => {
    if (!isMac || pids.length === 0) {
      resolve(new Map());
      return;
    }
    const args = pids.flatMap((pid) => ['-p', String(pid)]);
    const options = { timeout: 3000, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } };
    execFile('footprint', args, options, (error, stdout) => {
      // Processes we can't inspect (other users) are skipped; their RSS is used instead
      if (error && !stdout) {
        console.debug('[footprint] error:', error.message || error);
      }
      resolve(parseFootprintOutput(stdout || ''));
    });
  });
}

// Working folder of each process, with one lsof call
function readWorkingDirs(pids) {
  return new Promise((resolve) => {
    if (pids.length === 0) {
      resolve(new Map());
      return;
    }
    const args = ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')];
    execFile('lsof', args, { timeout: 3000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      // lsof exits 1 when a PID is already gone but still prints the others
      if (error && !stdout && !isNoProcessError(error)) {
        console.debug('[lsof cwd] error:', error.message || error);
      }
      resolve(parseLsofCwdOutput(stdout || ''));
    });
  });
}

// pid + command line -> { cwd, project }. A dev server rarely changes folder, so each
// process is looked up once; entries go away when the process does.
const projectCache = new Map();

async function lookUpProjects(procs) {
  const keyOf = (p) => `${p.pid}\0${p.commandLine}`;
  const liveKeys = new Set(procs.map(keyOf));
  for (const key of projectCache.keys()) {
    if (!liveKeys.has(key)) projectCache.delete(key);
  }

  const missing = procs.filter((p) => !projectCache.has(keyOf(p)));
  if (missing.length > 0) {
    const cwdByPid = await readWorkingDirs(missing.map((p) => p.pid));
    for (const p of missing) {
      const cwd = cwdByPid.get(p.pid) || null;
      // Not cached when lsof gave no folder, so it is tried again on the next refresh
      if (cwd) projectCache.set(keyOf(p), { cwd, project: describeProject(cwd) });
    }
  }
  return procs.map((p) => ({ ...p, ...(projectCache.get(keyOf(p)) || { cwd: null, project: null }) }));
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
  const listeners = [];
  for (const lsofCommand of lsofCommands) {
    const processes = await scanProcessCommand(lsofCommand);
    for (const process of processes) {
      // Skip if we've already seen this PID (deduplication)
      if (seenPids.has(process.pid)) continue;
      seenPids.add(process.pid);
      listeners.push({ ...process, lsofCommand });
    }
  }

  const pids = listeners.map((p) => p.pid);
  const [statsByPid, memoryKbByPid] = await Promise.all([readProcessStats(pids), readMemoryFootprints(pids)]);

  for (const { lsofCommand, ...process } of listeners) {
    const psStats = statsByPid.get(process.pid);
    const stats = psStats ? { ...psStats, memoryKb: memoryKbByPid.get(process.pid) } : null;
    const commandLine = stats ? stats.commandLine : '';
    const processType = classifyCommand(commandLine, lsofCommand);

    // Only include if this type is enabled
    if (enabledTypes[processType]) {
      allProcesses.push({
        ...process,
        type: processType,
        commandLine,
        stats,
      });
    }
  }

  return sortProcesses(await lookUpProjects(allProcesses));
}

function buildMenuAndUpdate(procs = []) {
  latestProcesses = Array.isArray(procs) ? procs : [];
  const count = latestProcesses.length;

  applyDisplayMode(latestProcesses);
  tray?.setToolTip(`Node Killer — active processes: ${count}`);

  const items = [];

  for (const p of latestProcesses) {
    items.push({
      label: buildProcessLabel(p),
      toolTip: [`PID ${p.pid}`, p.cwd, p.commandLine].filter(Boolean).join('\n'),
      click: async () => {
        const res = await killServers([p.pid]);
        if (res.ok) {
          notify('✅ Process terminated', `PID ${p.pid}${relatedSuffix(res.count)} (${res.step})`);
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
          detail: 'Each server is stopped together with the dev tool that started it (npm, next dev, …), like Ctrl-C. Processes get SIGTERM first and SIGKILL if they survive.',
        });
        if (response !== 1) {
          return;
        }
      } catch (e) {
        console.error('Kill all confirmation failed:', e);
        return;
      }
      const snapshot = latestProcesses.map((processInfo) => processInfo.pid);
      const res = await killServers(snapshot);
      if (res.ok) {
        notify('✅ Kill all', `${snapshot.length} processes${relatedSuffix(res.count, snapshot.length)} terminated.`);
      } else {
        notify('⚠️ Kill all with issues', res.error || 'Some processes could not be terminated.');
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

function applyDisplayMode(procs = latestProcesses) {
  if (!tray) return;
  const mode = prefs.getDisplayMode();
  if (isMac) {
    tray.setTitle(formatTrayTitle(mode, procs));
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
    height: 810,
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
  applyDisplayMode(latestProcesses);
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
  applyDisplayMode(latestProcesses);
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
