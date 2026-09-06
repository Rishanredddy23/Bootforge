const { app } = require('electron');
const Store = require('electron-store');
const path = require('path');

class SettingsManager {
  constructor() {
    this.store = new Store({
      name: 'settings',
      cwd: app.getPath('userData'),
      defaults: {
        virtualization: {
          backend: 'auto',
          qemuPath: '',
          whpxEnabled: true
        },
        vm: {
          defaultCpuCores: 4,
          defaultRamGB: 8,
          defaultNetwork: 'nat',
          defaultGpu: 'auto',
          clipboardSharing: 'bidirectional',
          fileSharing: 'controlled'
        },
        ai: {
          activeProvider: 'ollama',
          providers: {},
          ollama: {
            endpoint: 'http://localhost:11434',
            model: ''
          }
        },
        network: {
          mode: 'nat',
          internetEnabled: true
        },
        security: {
          adminRequired: false,
          permissionLevel: 'normal',
          allowDangerous: false
        },
        appearance: {
          theme: 'dark',
          compactMode: false
        },
        snapshots: {
          autoSnapshot: false,
          maxSnapshots: 10
        },
        files: {
          sharedFolders: []
        }
      }
    });
  }

  async initialize() {
    return this.store.store;
  }

  get(key) {
    return this.store.get(key);
  }

  set(key, value) {
    this.store.set(key, value);
  }

  getAll() {
    return this.store.store;
  }

  reset() {
    this.store.clear();
  }

  has(key) {
    return this.store.has(key);
  }

  delete(key) {
    this.store.delete(key);
  }
}

module.exports = { SettingsManager };