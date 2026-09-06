const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);

class DeviceManager {
  constructor(hardwareManager, securityManager, logManager) {
    this.hardwareManager = hardwareManager;
    this.securityManager = securityManager;
    this.logManager = logManager;
    this.devices = [];
    this.selectedDevice = null;
    this.hostDisk = null;
    this.selectedIso = null;
  }

  async initialize() {
    try {
      await this.detectHostDisk();
    } catch (e) {
      this.logManager?.warn('Host disk detection warning', 'device', e.message);
    }
    try {
      await this.refreshDevices();
    } catch (e) {
      this.logManager?.warn('Initial device refresh warning', 'device', e.message);
    }
  }

  async detectHostDisk() {
    try {
      const psCommand = `powershell -NoProfile -ExecutionPolicy Bypass -Command "[PSCustomObject]@{ Disks = @(Get-Disk | Select-Object Number, FriendlyName, Size, BusType, PartitionStyle, NumberOfPartitions, IsBoot, IsSystem) } | ConvertTo-Json"`;
      const { stdout } = await execAsync(psCommand, { timeout: 8000 });
      const data = JSON.parse(stdout.trim());
      const disks = Array.isArray(data.Disks) ? data.Disks : (data.Disks ? [data.Disks] : []);

      const host = disks.find(d => d.IsBoot || d.IsSystem) || disks.find(d => d.Number === 0) || disks[0];
      if (host) {
        this.hostDisk = {
          physicalDrive: host.Number,
          model: host.FriendlyName || `PhysicalDrive${host.Number}`,
          size: host.Size || 0,
          interface: host.BusType || 'Internal',
          protected: true
        };
        this.logManager?.info('Host disk detected and protected', 'device', this.hostDisk);
      }
    } catch (error) {
      this.logManager?.warn('Host disk detection failed, defaulting to PhysicalDrive0', 'device', error.message);
      this.hostDisk = {
        physicalDrive: 0,
        model: 'Host Primary Disk',
        size: 0,
        interface: 'Internal',
        protected: true
      };
    }
  }

  async refreshDevices() {
    try {
      const psScript = `[PSCustomObject]@{ Disks = @(Get-Disk | Select-Object Number, FriendlyName, Size, BusType, NumberOfPartitions, IsBoot, IsSystem); Partitions = @(Get-Partition | Select-Object DiskNumber, PartitionNumber, DriveLetter, Size, Type, IsBoot, IsHidden, Offset); Volumes = @(Get-Volume | Select-Object DriveLetter, FileSystemLabel, FileSystem, Size, SizeRemaining) } | ConvertTo-Json -Depth 4`;
      const psCommand = `powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript}"`;
      
      const { stdout } = await execAsync(psCommand, { timeout: 12000 });
      const data = JSON.parse(stdout.trim());

      const rawDisks = Array.isArray(data.Disks) ? data.Disks : (data.Disks ? [data.Disks] : []);
      const rawPartitions = Array.isArray(data.Partitions) ? data.Partitions : (data.Partitions ? [data.Partitions] : []);
      const rawVolumes = Array.isArray(data.Volumes) ? data.Volumes : (data.Volumes ? [data.Volumes] : []);

      this.devices = rawDisks.map(disk => {
        const driveIndex = disk.Number;
        const diskPartitions = rawPartitions.filter(p => p.DiskNumber === driveIndex);

        const partitionDetails = diskPartitions.map(p => {
          const letter = p.DriveLetter ? `${p.DriveLetter}:` : null;
          const vol = letter ? rawVolumes.find(v => v.DriveLetter === p.DriveLetter) : null;
          return {
            index: p.PartitionNumber,
            offset: p.Offset || 0,
            size: p.Size || 0,
            type: p.Type || 'Unknown',
            bootable: p.IsBoot || false,
            hidden: p.IsHidden || false,
            driveLetter: letter,
            label: vol?.FileSystemLabel || null,
            filesystem: vol?.FileSystem || null,
            capacity: vol?.Size || p.Size || 0,
            freeSpace: vol?.SizeRemaining || 0
          };
        });

        const isHost = (this.hostDisk && this.hostDisk.physicalDrive === driveIndex) || disk.IsBoot || disk.IsSystem;
        const hasWindows = this.detectWindowsOnDisk(partitionDetails);

        return {
          id: `physical-drive-${driveIndex}`,
          physicalDrive: driveIndex,
          model: disk.FriendlyName || `PhysicalDrive${driveIndex}`,
          size: disk.Size || 0,
          interface: disk.BusType || 'Storage',
          mediaType: disk.BusType === 'USB' ? 'External USB Media' : 'Fixed Hard Disk',
          partitions: partitionDetails,
          partitionCount: disk.NumberOfPartitions || diskPartitions.length || 0,
          bytesPerSector: 512,
          windowsDetected: hasWindows,
          protected: !!isHost,
          removable: disk.BusType === 'USB' || disk.BusType === 'SD'
        };
      });

      this.logManager?.info(`Detected ${this.devices.length} physical storage devices`, 'device');
      return this.devices;
    } catch (error) {
      this.logManager?.error('Device refresh failed via PowerShell', 'device', error.message);
      // Fallback: don't crash, return current or minimal fallback list
      if (!this.devices.length) {
        this.devices = [
          {
            id: 'physical-drive-0',
            physicalDrive: 0,
            model: this.hostDisk?.model || 'System Disk',
            size: 0,
            interface: 'Internal',
            mediaType: 'Fixed Hard Disk',
            partitions: [],
            partitionCount: 1,
            bytesPerSector: 512,
            windowsDetected: true,
            protected: true,
            removable: false
          }
        ];
      }
      return this.devices;
    }
  }

  detectWindowsOnDisk(partitions) {
    for (const partition of partitions) {
      if (partition.driveLetter) {
        try {
          const rootPath = `${partition.driveLetter}\\`;
          const winDir = `${partition.driveLetter}\\Windows`;
          const ntoskrnl = `${partition.driveLetter}\\Windows\\System32\\ntoskrnl.exe`;
          const explorer = `${partition.driveLetter}\\Windows\\explorer.exe`;

          if (fs.existsSync(ntoskrnl) || fs.existsSync(explorer) || fs.existsSync(winDir)) {
            return true;
          }
        } catch {
          // Ignore permission or drive not ready errors
        }
      }
    }
    return false;
  }

  async getDevices() {
    return this.devices;
  }

  async selectDevice(deviceId) {
    const device = this.devices.find(d => d.id === deviceId);
    if (!device) {
      throw new Error('Device not found');
    }

    if (device.protected) {
      throw new Error('Cannot select host system disk. This disk is protected.');
    }

    this.selectedDevice = device;
    this.securityManager?.allowDevice(deviceId);
    this.logManager?.info('Device selected for VM boot', 'device', { deviceId, model: device.model });
    return device;
  }

  getSelectedDevice() {
    return this.selectedDevice;
  }

  async inspectDevice(deviceId) {
    const device = this.devices.find(d => d.id === deviceId);
    if (!device) throw new Error('Device not found');

    const windowsInfo = await this.getWindowsInfo(device);
    return { ...device, windowsInfo };
  }

  async getWindowsInfo(device) {
    if (!device.windowsDetected) return null;

    for (const partition of device.partitions) {
      if (partition.driveLetter) {
        try {
          const explorerPath = `${partition.driveLetter}\\Windows\\explorer.exe`;
          if (fs.existsSync(explorerPath)) {
            const escapedPath = explorerPath.replace(/'/g, "''");
            const psCmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "[System.Diagnostics.FileVersionInfo]::GetVersionInfo('${escapedPath}') | Select-Object ProductVersion, FileVersion | ConvertTo-Json"`;
            const { stdout } = await execAsync(psCmd, { timeout: 5000 });
            const info = JSON.parse(stdout.trim());
            return {
              version: `Windows (Build ${info.ProductVersion || info.FileVersion || '10+'})`,
              build: info.ProductVersion || 'Unknown',
              architecture: 'x64',
              edition: 'Windows Sandbox / OS',
              systemPartition: partition.driveLetter,
              bootDetected: partition.bootable
            };
          }
        } catch {
          // Fallback if FileVersionInfo fails
          return {
            version: 'Windows (Detected)',
            build: 'Detected',
            architecture: 'x64',
            edition: 'OS',
            systemPartition: partition.driveLetter,
            bootDetected: partition.bootable
          };
        }
      }
    }
    return null;
  }

  async getPartitions(deviceId) {
    const device = this.devices.find(d => d.id === deviceId);
    if (!device) throw new Error('Device not found');
    return device.partitions;
  }

  getHostDisk() {
    return this.hostDisk;
  }

  async selectIsoFile() {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog({
      title: 'Select Windows ISO File',
      filters: [
        { name: 'ISO Files', extensions: ['iso'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    });

    if (result.canceled || !result.filePaths.length) {
      return null;
    }

    const isoPath = result.filePaths[0];
    return await this.validateAndSelectIso(isoPath);
  }

  async validateAndSelectIso(isoPath) {
    try {
      const stats = fs.statSync(isoPath);
      if (!stats.isFile()) {
        throw new Error('Selected path is not a file');
      }

      if (!isoPath.toLowerCase().endsWith('.iso')) {
        throw new Error('Selected file is not an ISO file');
      }

      const size = stats.size;
      if (size < 100 * 1024 * 1024) {
        this.logManager?.warn('ISO file seems too small for Windows installation', 'device', { path: isoPath, size });
      }

      this.selectedIso = {
        id: `iso-${Date.now()}`,
        path: isoPath,
        name: path.basename(isoPath),
        size: size,
        type: 'iso'
      };

      this.logManager?.info('ISO file selected for VM boot', 'device', this.selectedIso);
      return this.selectedIso;
    } catch (error) {
      this.logManager?.error('ISO validation failed', 'device', error.message);
      throw new Error(`Invalid ISO file: ${error.message}`);
    }
  }

  autoDetectIso() {
    if (this.selectedIso && fs.existsSync(this.selectedIso.path)) {
      return this.selectedIso;
    }

    const os = require('os');
    const searchDirs = [
      path.join(os.homedir(), 'Desktop'),
      path.join(os.homedir(), 'Downloads'),
      path.join(os.homedir(), 'Documents'),
      path.join(__dirname, '../../'),
      process.cwd()
    ];

    for (const dir of searchDirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir);
        const isoFiles = files.filter(f => f.toLowerCase().endsWith('.iso'));
        if (isoFiles.length > 0) {
          const winIso = isoFiles.find(f => f.toLowerCase().includes('win')) || isoFiles[0];
          const fullPath = path.join(dir, winIso);
          const stats = fs.statSync(fullPath);
          this.selectedIso = {
            id: `iso-${Date.now()}`,
            path: fullPath,
            name: winIso,
            size: stats.size,
            type: 'iso'
          };
          this.logManager?.info('Auto-detected ISO file', 'device', this.selectedIso);
          return this.selectedIso;
        }
      } catch {}
    }
    return null;
  }

  getSelectedIso() {
    if (!this.selectedIso || !fs.existsSync(this.selectedIso.path)) {
      this.autoDetectIso();
    }
    return this.selectedIso;
  }

  clearSelectedIso() {
    this.selectedIso = null;
  }
}

module.exports = { DeviceManager };