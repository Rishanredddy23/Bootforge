const { contextBridge, ipcRenderer } = require('electron');

const validChannels = {
  devices: [
    'list',
    'refresh',
    'select',
    'inspect',
    'get-partitions',
    'get-windows-info',
    'select-iso',
    'get-selected-iso'
  ],
  hardware: [
    'get-info',
    'get-virtualization',
    'get-resources',
    'refresh'
  ],
  vm: [
    'get-status',
    'get-config',
    'update-config',
    'start',
    'stop',
    'pause',
    'resume',
    'restart',
    'get-stats',
    'get-snapshots',
    'create-snapshot',
    'restore-snapshot',
    'delete-snapshot',
    'attach-disk',
    'detach-disk',
    'configure-cpu',
    'configure-ram',
    'configure-network',
    'configure-gpu',
    'get-display-info',
    'get-storage-dir',
    'select-storage-dir',
    'list-disks',
    'create-disk',
    'select-disk',
    'get-active-disk',
    'open-storage-dir',
    'get-command-preview',
    'get-accel-status',
    'get-diagnostics'
  ],
  ai: [
    'get-providers',
    'get-active-provider',
    'set-active-provider',
    'add-provider',
    'remove-provider',
    'update-provider',
    'test-provider',
    'list-models',
    'chat',
    'stream-chat',
    'get-conversation',
    'clear-conversation'
  ],
  ollama: [
    'check-connection',
    'list-models',
    'pull-model',
    'delete-model',
    'get-status'
  ],
  agent: [
    'execute-tool',
    'get-tool-result',
    'cancel-execution',
    'get-permissions',
    'set-permission',
    'request-permission'
  ],
  files: [
    'list-host',
    'list-vm',
    'upload',
    'download',
    'delete',
    'create-share',
    'remove-share',
    'get-shares'
  ],
  network: [
    'get-status',
    'set-mode',
    'get-modes'
  ],
  logs: [
    'get-logs',
    'clear-logs',
    'subscribe',
    'unsubscribe',
    'filter'
  ],
  settings: [
    'get',
    'set',
    'get-all',
    'reset'
  ],
  system: [
    'check-qemu',
    'refresh-qemu',
    'check-ollama',
    'check-admin',
    'request-admin',
    'get-version',
    'minimize',
    'maximize',
    'close',
    'open-external'
  ]
};

function createApi(channelGroup) {
  const channels = validChannels[channelGroup];
  const api = {};

  channels.forEach((channel) => {
    const methodName = channel.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    api[methodName] = (...args) => {
      return ipcRenderer.invoke(`${channelGroup}:${channel}`, ...args);
    };
  });

  return api;
}

const bootforgeAPI = {
  devices: createApi('devices'),
  hardware: createApi('hardware'),
  vm: createApi('vm'),
  ai: createApi('ai'),
  ollama: createApi('ollama'),
  agent: createApi('agent'),
  files: createApi('files'),
  network: createApi('network'),
  logs: createApi('logs'),
  settings: createApi('settings'),
  system: createApi('system'),

  onLog: (callback) => {
    const listener = (_event, log) => callback(log);
    ipcRenderer.on('log:new', listener);
    return () => ipcRenderer.removeListener('log:new', listener);
  },

  onVMStateChange: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('vm:state-change', listener);
    return () => ipcRenderer.removeListener('vm:state-change', listener);
  },

  onResourceUpdate: (callback) => {
    const listener = (_event, resources) => callback(resources);
    ipcRenderer.on('resources:update', listener);
    return () => ipcRenderer.removeListener('resources:update', listener);
  }
};

contextBridge.exposeInMainWorld('bootforge', bootforgeAPI);