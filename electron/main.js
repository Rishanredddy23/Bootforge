const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { setupIpcHandlers } = require('./ipc');
const { HardwareManager } = require('./services/hardware-manager');
const { DeviceManager } = require('./services/device-manager');
const { VMManager } = require('./services/vm-manager');
const { AIManager } = require('./services/ai-manager');
const { SnapshotManager } = require('./services/snapshot-manager');
const { SecurityManager } = require('./services/security-manager');
const { SettingsManager } = require('./services/settings-manager');
const { LogManager } = require('./services/log-manager');

let mainWindow = null;
let hardwareManager = null;
let deviceManager = null;
let vmManager = null;
let aiManager = null;
let snapshotManager = null;
let securityManager = null;
let settingsManager = null;
let logManager = null;

const isDev = process.argv.includes('--dev');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    title: 'BootForge',
    icon: path.join(__dirname, '../renderer/assets/icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false,
      webSecurity: !isDev
    },
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#070d12'
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // DevTools disabled by default on startup


  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

async function initializeServices() {
  logManager = new LogManager(mainWindow);
  await logManager.initialize();
  logManager.info('BootForge starting...', 'main');

  settingsManager = new SettingsManager();
  await settingsManager.initialize();
  logManager.info('Settings loaded', 'main');

  securityManager = new SecurityManager(settingsManager);
  await securityManager.initialize();
  logManager.info('Security manager initialized', 'main');

  hardwareManager = new HardwareManager(logManager);
  await hardwareManager.initialize();
  logManager.info('Hardware detection complete', 'main');

  deviceManager = new DeviceManager(hardwareManager, securityManager, logManager);
  await deviceManager.initialize();
  logManager.info('Device manager initialized', 'main');

  vmManager = new VMManager(hardwareManager, deviceManager, securityManager, settingsManager, logManager);
  await vmManager.initialize();
  logManager.info('VM manager initialized', 'main');

  snapshotManager = new SnapshotManager(vmManager, settingsManager, logManager);
  await snapshotManager.initialize();
  logManager.info('Snapshot manager initialized', 'main');

  aiManager = new AIManager(settingsManager, logManager);
  await aiManager.initialize();
  logManager.info('AI manager initialized', 'main');

  setupIpcHandlers(
    ipcMain,
    mainWindow,
    hardwareManager,
    deviceManager,
    vmManager,
    aiManager,
    snapshotManager,
    securityManager,
    settingsManager,
    logManager
  );

  logManager.info('All services initialized', 'main');
}

app.whenReady().then(async () => {
  await initializeServices();
  const win = createWindow();
  if (logManager) logManager.mainWindow = win;
  if (hardwareManager) hardwareManager.setMainWindow(win);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const w = createWindow();
      if (logManager) logManager.mainWindow = w;
      if (hardwareManager) hardwareManager.setMainWindow(w);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    shutdown();
    app.quit();
  }
});

app.on('before-quit', () => {
  shutdown();
});

async function shutdown() {
  if (logManager) {
    logManager.info('BootForge shutting down...', 'main');
  }

  if (vmManager) {
    await vmManager.shutdown();
  }

  if (aiManager) {
    await aiManager.shutdown();
  }

  if (logManager) {
    await logManager.shutdown();
  }
}

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  if (logManager) {
    logManager.error(`Uncaught exception: ${error.message}`, 'main', error.stack);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  if (logManager) {
    logManager.error(`Unhandled rejection: ${reason}`, 'main');
  }
});