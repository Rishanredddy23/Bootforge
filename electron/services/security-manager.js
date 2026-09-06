const { app } = require('electron');
const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execAsync = promisify(exec);

class SecurityManager {
  constructor(settingsManager) {
    this.settingsManager = settingsManager;
    this.adminCache = null;
    this.adminCacheTime = 0;
    this.allowedDevices = new Set();
    this.dangerousOperations = new Map();
  }

  async initialize() {
    await this.checkAdminStatus();
  }

  async checkAdminStatus() {
    try {
      const { stdout } = await execAsync('net session 2>nul', { shell: true });
      this.adminCache = true;
      this.adminCacheTime = Date.now();
      return true;
    } catch {
      this.adminCache = false;
      this.adminCacheTime = Date.now();
      return false;
    }
  }

  async isAdmin() {
    if (Date.now() - this.adminCacheTime > 30000) {
      await this.checkAdminStatus();
    }
    return this.adminCache;
  }

  async requestAdmin() {
    return new Promise((resolve) => {
      const exePath = process.execPath;
      const script = `
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FilePath = "${exePath.replace(/\\/g, '\\\\')}"
        $psi.Arguments = "--admin-elevated"
        $psi.Verb = "runas"
        $psi.UseShellExecute = $true
        [System.Diagnostics.Process]::Start($psi)
      `;
      exec(`powershell -Command "${script}"`, (error) => {
        if (error) {
          resolve({ success: false, error: error.message });
        } else {
          setTimeout(() => this.checkAdminStatus().then(resolve), 1000);
        }
      });
    });
  }

  validateDeviceId(deviceId) {
    return this.allowedDevices.has(deviceId);
  }

  allowDevice(deviceId) {
    this.allowedDevices.add(deviceId);
  }

  revokeDevice(deviceId) {
    this.allowedDevices.delete(deviceId);
  }

  getAllowedDevices() {
    return Array.from(this.allowedDevices);
  }

  registerDangerousOperation(operationId, details) {
    this.dangerousOperations.set(operationId, {
      ...details,
      timestamp: Date.now(),
      status: 'pending'
    });
  }

  getDangerousOperation(operationId) {
    return this.dangerousOperations.get(operationId);
  }

  resolveDangerousOperation(operationId, allowed, session = false) {
    const op = this.dangerousOperations.get(operationId);
    if (op) {
      op.status = allowed ? (session ? 'allowed-session' : 'allowed-once') : 'denied';
      op.resolvedAt = Date.now();
    }
  }

  async validateCommand(command, args = []) {
    const blockedPatterns = [
      /format\s+/i,
      /diskpart/i,
      /fdisk/i,
      /mkfs/i,
      /dd\s+if=/i,
      /wipe/i,
      /del\s+\/f\s+\/q\s+[cC]:/i,
      /rmdir\s+\/s\s+\/q\s+[cC]:/i,
      /bcdedit/i,
      /bootsect/i
    ];

    const fullCommand = `${command} ${args.join(' ')}`;
    for (const pattern of blockedPatterns) {
      if (pattern.test(fullCommand)) {
        return { allowed: false, reason: 'Potentially destructive command blocked' };
      }
    }

    return { allowed: true };
  }

  getPermissionLevel() {
    return this.settingsManager.get('security.permissionLevel') || 'normal';
  }

  setPermissionLevel(level) {
    const validLevels = ['read', 'normal', 'power-user', 'dangerous'];
    if (validLevels.includes(level)) {
      this.settingsManager.set('security.permissionLevel', level);
    }
  }

  isOperationAllowed(operation) {
    const level = this.getPermissionLevel();
    const permissions = {
      read: ['read_file', 'list_directory', 'get_system_info', 'get_processes'],
      normal: ['read_file', 'list_directory', 'get_system_info', 'get_processes', 'write_file', 'create_directory', 'run_command', 'run_powershell', 'run_python', 'install_package', 'open_application', 'close_application', 'build_project', 'run_tests', 'git_status', 'git_diff'],
      'power-user': ['read_file', 'list_directory', 'get_system_info', 'get_processes', 'write_file', 'create_directory', 'run_command', 'run_powershell', 'run_python', 'install_package', 'open_application', 'close_application', 'build_project', 'run_tests', 'git_status', 'git_diff', 'delete_file', 'get_processes'],
      dangerous: ['read_file', 'list_directory', 'get_system_info', 'get_processes', 'write_file', 'create_directory', 'run_command', 'run_powershell', 'run_python', 'install_package', 'open_application', 'close_application', 'build_project', 'run_tests', 'git_status', 'git_diff', 'delete_file', 'capture_screen']
    };

    return permissions[level]?.includes(operation) || false;
  }
}

module.exports = { SecurityManager };