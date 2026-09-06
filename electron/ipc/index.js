function setupIpcHandlers(ipcMain, mainWindow, hardwareManager, deviceManager, vmManager, aiManager, snapshotManager, securityManager, settingsManager, logManager) {
  ipcMain.handle('devices:list', async () => {
    return deviceManager.getDevices();
  });

  ipcMain.handle('devices:refresh', async () => {
    return deviceManager.refreshDevices();
  });

  ipcMain.handle('devices:select', async (_, deviceId) => {
    return deviceManager.selectDevice(deviceId);
  });

  ipcMain.handle('devices:inspect', async (_, deviceId) => {
    return deviceManager.inspectDevice(deviceId);
  });

  ipcMain.handle('devices:get-partitions', async (_, deviceId) => {
    return deviceManager.getPartitions(deviceId);
  });

  ipcMain.handle('devices:get-windows-info', async (_, deviceId) => {
    const device = deviceManager.getDevices().find(d => d.id === deviceId);
    if (!device) throw new Error('Device not found');
    return deviceManager.getWindowsInfo(device);
  });

  ipcMain.handle('devices:select-iso', async () => {
    return deviceManager.selectIsoFile();
  });

  ipcMain.handle('devices:get-selected-iso', async () => {
    return deviceManager.getSelectedIso();
  });

  ipcMain.handle('hardware:get-info', async () => {
    return hardwareManager.getHardwareInfo();
  });

  ipcMain.handle('hardware:get-virtualization', async () => {
    return hardwareManager.getVirtualizationInfo();
  });

  ipcMain.handle('hardware:get-resources', async () => {
    return hardwareManager.getResources();
  });

  ipcMain.handle('hardware:refresh', async () => {
    return hardwareManager.refresh();
  });

  ipcMain.handle('vm:get-status', async () => {
    return vmManager.getStatus();
  });

  ipcMain.handle('vm:get-config', async () => {
    return vmManager.getConfig();
  });

  ipcMain.handle('vm:get-display-info', async () => {
    return vmManager.getDisplayInfo();
  });

  ipcMain.handle('vm:get-storage-dir', async () => {
    return vmManager.getStorageDir();
  });

  ipcMain.handle('vm:select-storage-dir', async () => {
    return vmManager.selectStorageDir();
  });

  ipcMain.handle('vm:list-disks', async () => {
    return vmManager.listDisks();
  });

  ipcMain.handle('vm:create-disk', async (_, name, sizeGB) => {
    return vmManager.createDisk(name, sizeGB);
  });

  ipcMain.handle('vm:select-disk', async (_, diskPath) => {
    return vmManager.selectDisk(diskPath);
  });

  ipcMain.handle('vm:get-active-disk', async () => {
    return vmManager.getActiveDisk();
  });

  ipcMain.handle('vm:open-storage-dir', async () => {
    return vmManager.openStorageDir();
  });

  ipcMain.handle('vm:get-command-preview', async (_, customConfig) => {
    return vmManager.getVmCommandPreview(customConfig);
  });

  ipcMain.handle('vm:get-accel-status', async () => {
    return vmManager.getAccelStatus();
  });

  ipcMain.handle('vm:get-diagnostics', async () => {
    const backend = vmManager.getBackend();
    if (backend && typeof backend.getDiagnostics === 'function') {
      return backend.getDiagnostics();
    }
    return { error: 'Diagnostics not available' };
  });

  // Forward VM state changes to renderer
  vmManager.on('state-change', (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('vm:state-change', state);
    }
  });

  ipcMain.handle('vm:update-config', async (_, config) => {
    return vmManager.updateConfig(config);
  });

  ipcMain.handle('vm:start', async (_, config) => {
    return vmManager.start(config);
  });

  ipcMain.handle('vm:stop', async () => {
    return vmManager.stop();
  });

  ipcMain.handle('vm:pause', async () => {
    return vmManager.pause();
  });

  ipcMain.handle('vm:resume', async () => {
    return vmManager.resume();
  });

  ipcMain.handle('vm:restart', async () => {
    return vmManager.restart();
  });

  ipcMain.handle('vm:get-stats', async () => {
    return vmManager.getStats();
  });

  ipcMain.handle('vm:get-snapshots', async () => {
    return snapshotManager.listSnapshots();
  });

  ipcMain.handle('vm:create-snapshot', async (_, name, description) => {
    return snapshotManager.createSnapshot(name, description);
  });

  ipcMain.handle('vm:restore-snapshot', async (_, snapshotId) => {
    return snapshotManager.restoreSnapshot(snapshotId);
  });

  ipcMain.handle('vm:delete-snapshot', async (_, snapshotId) => {
    return snapshotManager.deleteSnapshot(snapshotId);
  });

  ipcMain.handle('vm:attach-disk', async (_, devicePath, options) => {
    if (!securityManager.validateDeviceId(devicePath)) {
      throw new Error('Device not authorized');
    }
    return vmManager.attachDisk(devicePath, options);
  });

  ipcMain.handle('vm:detach-disk', async (_, devicePath) => {
    return vmManager.detachDisk(devicePath);
  });

  ipcMain.handle('vm:configure-cpu', async (_, cores) => {
    return vmManager.configureCPU(cores);
  });

  ipcMain.handle('vm:configure-ram', async (_, ramGB) => {
    return vmManager.configureRAM(ramGB);
  });

  ipcMain.handle('vm:configure-network', async (_, mode) => {
    return vmManager.configureNetwork(mode);
  });

  ipcMain.handle('vm:configure-gpu', async (_, mode) => {
    return vmManager.configureGPU(mode);
  });

  ipcMain.handle('ai:get-providers', async () => {
    return aiManager.getProviders();
  });

  ipcMain.handle('ai:get-active-provider', async () => {
    const provider = aiManager.getActiveProvider();
    return provider ? { id: 'active', ...provider.getConfig() } : null;
  });

  ipcMain.handle('ai:set-active-provider', async (_, id) => {
    return aiManager.setActiveProvider(id);
  });

  ipcMain.handle('ai:add-provider', async (_, id, config) => {
    return aiManager.addProvider(id, config);
  });

  ipcMain.handle('ai:remove-provider', async (_, id) => {
    return aiManager.removeProvider(id);
  });

  ipcMain.handle('ai:update-provider', async (_, id, config) => {
    return aiManager.updateProvider(id, config);
  });

  ipcMain.handle('ai:test-provider', async (_, id) => {
    return aiManager.testProvider(id);
  });

  ipcMain.handle('ai:list-models', async () => {
    return aiManager.listModels();
  });

  ipcMain.handle('ai:chat', async (_, messages, options) => {
    return aiManager.chat(messages, options);
  });

  ipcMain.handle('ai:stream-chat', async (_, messages, options) => {
    return aiManager.streamChat(messages, options);
  });

  ipcMain.handle('ai:get-conversation', async (_, id) => {
    return aiManager.getConversation(id);
  });

  ipcMain.handle('ai:clear-conversation', async (_, id) => {
    return aiManager.clearConversation(id);
  });

  ipcMain.handle('ollama:check-connection', async () => {
    return aiManager.checkOllama();
  });

  ipcMain.handle('ollama:list-models', async () => {
    const ollama = aiManager.providers.get('ollama');
    if (!ollama) throw new Error('Ollama not configured');
    return ollama.listModels();
  });

  ipcMain.handle('ollama:pull-model', async (_, modelName) => {
    const ollama = aiManager.providers.get('ollama');
    if (!ollama) throw new Error('Ollama not configured');
    return ollama.pullModel(modelName);
  });

  ipcMain.handle('ollama:delete-model', async (_, modelName) => {
    const ollama = aiManager.providers.get('ollama');
    if (!ollama) throw new Error('Ollama not configured');
    return ollama.deleteModel(modelName);
  });

  ipcMain.handle('ollama:get-status', async () => {
    return aiManager.checkOllama();
  });

  ipcMain.handle('agent:execute-tool', async (_, tool, args) => {
    if (!securityManager.isOperationAllowed(tool)) {
      throw new Error(`Operation not allowed: ${tool}`);
    }
    logManager.info('Agent tool executed', 'agent', { tool, args });
    return { success: true, tool, args, result: 'Tool execution not yet implemented' };
  });

  ipcMain.handle('agent:get-tool-result', async (_, executionId) => {
    return { success: true, executionId, result: 'Not implemented' };
  });

  ipcMain.handle('agent:cancel-execution', async (_, executionId) => {
    return { success: true };
  });

  ipcMain.handle('agent:get-permissions', async () => {
    return { level: securityManager.getPermissionLevel() };
  });

  ipcMain.handle('agent:set-permission', async (_, level) => {
    securityManager.setPermissionLevel(level);
    return { success: true };
  });

  ipcMain.handle('agent:request-permission', async (_, operation, details) => {
    const operationId = `perm-${Date.now()}`;
    securityManager.registerDangerousOperation(operationId, { operation, details });
    return { operationId, status: 'pending' };
  });

  ipcMain.handle('files:list-host', async (_, path) => {
    return { success: true, files: [], path: path || 'C:\\' };
  });

  ipcMain.handle('files:list-vm', async (_, path) => {
    return { success: true, files: [], path: path || 'C:\\' };
  });

  ipcMain.handle('files:upload', async (_, filePath, destination) => {
    return { success: true, message: 'Not implemented' };
  });

  ipcMain.handle('files:download', async (_, filePath, destination) => {
    return { success: true, message: 'Not implemented' };
  });

  ipcMain.handle('files:delete', async (_, filePath) => {
    return { success: true, message: 'Not implemented' };
  });

  ipcMain.handle('files:create-share', async (_, hostPath, vmPath) => {
    return { success: true, message: 'Not implemented' };
  });

  ipcMain.handle('files:remove-share', async (_, shareId) => {
    return { success: true };
  });

  ipcMain.handle('files:get-shares', async () => {
    return settingsManager.get('files.sharedFolders') || [];
  });

  ipcMain.handle('network:get-status', async () => {
    return { mode: settingsManager.get('network.mode'), internetEnabled: settingsManager.get('network.internetEnabled') };
  });

  ipcMain.handle('network:set-mode', async (_, mode) => {
    settingsManager.set('network.mode', mode);
    return { success: true };
  });

  ipcMain.handle('network:get-modes', async () => {
    return ['nat', 'disabled', 'host-only', 'restricted'];
  });

  ipcMain.handle('logs:get-logs', async (_, filter) => {
    return logManager.getLogs(filter);
  });

  ipcMain.handle('logs:clear-logs', async () => {
    logManager.clearLogs();
    return { success: true };
  });

  ipcMain.handle('logs:filter', async (_, filter) => {
    return logManager.getLogs(filter);
  });

  ipcMain.handle('settings:get', async (_, key) => {
    return settingsManager.get(key);
  });

  ipcMain.handle('settings:set', async (_, key, value) => {
    settingsManager.set(key, value);
    return { success: true };
  });

  ipcMain.handle('settings:get-all', async () => {
    return settingsManager.getAll();
  });

  ipcMain.handle('settings:reset', async () => {
    settingsManager.reset();
    return { success: true };
  });

  ipcMain.handle('system:check-qemu', async () => {
    return vmManager.checkQemu();
  });

  ipcMain.handle('system:refresh-qemu', async () => {
    return await vmManager.refreshBackend();
  });

  ipcMain.handle('system:check-ollama', async () => {
    return aiManager.checkOllama();
  });

  ipcMain.handle('system:check-admin', async () => {
    return { isAdmin: await securityManager.isAdmin() };
  });

  ipcMain.handle('system:request-admin', async () => {
    return securityManager.requestAdmin();
  });

  ipcMain.handle('system:get-version', async () => {
    return { version: '1.0.0', electron: process.versions.electron, node: process.versions.node };
  });

  ipcMain.handle('system:minimize', async (event) => {
    const { BrowserWindow } = require('electron');
    const win = (event && BrowserWindow.fromWebContents(event.sender)) || mainWindow || BrowserWindow.getFocusedWindow();
    win?.minimize();
    return { success: true };
  });

  ipcMain.handle('system:maximize', async (event) => {
    const { BrowserWindow } = require('electron');
    const win = (event && BrowserWindow.fromWebContents(event.sender)) || mainWindow || BrowserWindow.getFocusedWindow();
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    }
    return { success: true };
  });

  ipcMain.handle('system:close', async (event) => {
    const { BrowserWindow } = require('electron');
    const win = (event && BrowserWindow.fromWebContents(event.sender)) || mainWindow || BrowserWindow.getFocusedWindow();
    win?.close();
    return { success: true };
  });

  ipcMain.handle('system:open-external', async (_, url) => {
    const { shell } = require('electron');
    await shell.openExternal(url);
    return { success: true };
  });
}

module.exports = { setupIpcHandlers };
