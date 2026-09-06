const { exec } = require('child_process');
const { promisify } = require('util');
const os = require('os');

const execAsync = promisify(exec);

class HardwareManager {
  constructor(logManager) {
    this.logManager = logManager;
    this.hardwareInfo = null;
    this.virtualizationInfo = null;
    this.mainWindow = null;
    this.lastCpuSample = null;
    this.resources = {
      cpu: 0,
      ram: 0,
      vram: 0,
      disk: 0
    };
  }

  setMainWindow(window) {
    this.mainWindow = window;
  }

  async initialize() {
    try {
      await this.detectHardware();
    } catch (e) {
      this.logManager?.warn('Hardware detection warning', 'hardware', e.message);
    }

    try {
      await this.detectVirtualization();
    } catch (e) {
      this.logManager?.warn('Virtualization detection warning', 'hardware', e.message);
    }

    this.startResourceMonitoring();
  }

  async detectHardware() {
    try {
      const [cpuInfo, ramInfo, gpuInfo, osInfo] = await Promise.all([
        this.getCpuInfo(),
        this.getRamInfo(),
        this.getGpuInfo(),
        this.getOsInfo()
      ]);

      this.hardwareInfo = {
        cpu: cpuInfo,
        ram: ramInfo,
        gpu: gpuInfo,
        os: osInfo,
        architecture: os.arch(),
        platform: os.platform(),
        hostname: os.hostname()
      };

      this.logManager?.info('Hardware detected', 'hardware', this.hardwareInfo);
      return this.hardwareInfo;
    } catch (error) {
      this.logManager?.error('Hardware detection failed', 'hardware', error.message);
      // Sensible fallback
      this.hardwareInfo = {
        cpu: {
          name: os.cpus()[0]?.model || 'Host CPU',
          cores: os.cpus().length,
          logicalProcessors: os.cpus().length,
          maxClockSpeed: os.cpus()[0]?.speed || 0
        },
        ram: {
          totalBytes: os.totalmem(),
          totalGB: Math.round(os.totalmem() / (1024 * 1024 * 1024) * 100) / 100
        },
        gpu: [{ name: 'Host GPU', vramBytes: 0, vramGB: 0, driverVersion: 'Active' }],
        os: { name: 'Windows', version: os.release(), build: '10+', architecture: os.arch() },
        architecture: os.arch(),
        platform: os.platform(),
        hostname: os.hostname()
      };
      return this.hardwareInfo;
    }
  }

  async getCpuInfo() {
    try {
      const psCmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed | ConvertTo-Json"`;
      const { stdout } = await execAsync(psCmd, { timeout: 6000 });
      const raw = JSON.parse(stdout.trim());
      const data = Array.isArray(raw) ? raw[0] : raw;

      return {
        name: data.Name?.trim() || os.cpus()[0]?.model || 'Host CPU',
        cores: parseInt(data.NumberOfCores) || os.cpus().length,
        logicalProcessors: parseInt(data.NumberOfLogicalProcessors) || os.cpus().length,
        maxClockSpeed: parseInt(data.MaxClockSpeed) || os.cpus()[0]?.speed || 0
      };
    } catch (error) {
      this.logManager?.warn('Failed to get CPU info via PowerShell, using os fallback', 'hardware', error.message);
    }

    const cpus = os.cpus();
    return {
      name: cpus[0]?.model || 'Host CPU',
      cores: cpus.length,
      logicalProcessors: cpus.length,
      maxClockSpeed: cpus[0]?.speed || 0
    };
  }

  async getRamInfo() {
    try {
      const psCmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_ComputerSystem | Select-Object TotalPhysicalMemory | ConvertTo-Json"`;
      const { stdout } = await execAsync(psCmd, { timeout: 6000 });
      const raw = JSON.parse(stdout.trim());
      const data = Array.isArray(raw) ? raw[0] : raw;
      const totalBytes = parseInt(data.TotalPhysicalMemory) || os.totalmem();

      return {
        totalBytes,
        totalGB: Math.round(totalBytes / (1024 * 1024 * 1024) * 100) / 100
      };
    } catch (error) {
      this.logManager?.warn('Failed to get RAM info via PowerShell, using os fallback', 'hardware', error.message);
    }

    const totalBytes = os.totalmem();
    return {
      totalBytes,
      totalGB: Math.round(totalBytes / (1024 * 1024 * 1024) * 100) / 100
    };
  }

  async getGpuInfo() {
    try {
      const psCmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM, DriverVersion | ConvertTo-Json"`;
      const { stdout } = await execAsync(psCmd, { timeout: 6000 });
      const raw = JSON.parse(stdout.trim());
      const list = Array.isArray(raw) ? raw : [raw];

      const gpus = list.map(data => ({
        name: data.Name?.trim() || 'Host GPU',
        vramBytes: parseInt(data.AdapterRAM) || 0,
        vramGB: Math.round((parseInt(data.AdapterRAM) || 0) / (1024 * 1024 * 1024) * 100) / 100,
        driverVersion: data.DriverVersion || 'Unknown'
      }));

      if (gpus.length > 0) return gpus;
    } catch (error) {
      this.logManager?.warn('Failed to get GPU info via PowerShell', 'hardware', error.message);
    }

    return [{ name: 'Host GPU', vramBytes: 0, vramGB: 0, driverVersion: 'Active' }];
  }

  async getOsInfo() {
    try {
      const psCmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture | ConvertTo-Json"`;
      const { stdout } = await execAsync(psCmd, { timeout: 6000 });
      const raw = JSON.parse(stdout.trim());
      const data = Array.isArray(raw) ? raw[0] : raw;

      return {
        name: data.Caption?.trim() || 'Windows',
        version: data.Version?.trim() || os.release(),
        build: data.BuildNumber?.trim() || 'Unknown',
        architecture: data.OSArchitecture?.trim() || os.arch()
      };
    } catch (error) {
      this.logManager?.warn('Failed to get OS info via PowerShell, using os fallback', 'hardware', error.message);
    }

    return {
      name: 'Windows',
      version: os.release(),
      build: 'Unknown',
      architecture: os.arch()
    };
  }

  async detectVirtualization() {
    try {
      const checks = await Promise.all([
        this.checkHyperV(),
        this.checkWHPX(),
        this.checkVTx(),
        this.checkIOMMU()
      ]);

      this.virtualizationInfo = {
        hyperv: checks[0],
        whpx: checks[1],
        vtx: checks[2],
        iommu: checks[3],
        available: checks[0] || checks[1] || checks[2]
      };

      this.logManager?.info('Virtualization detected', 'hardware', this.virtualizationInfo);
      return this.virtualizationInfo;
    } catch (error) {
      this.logManager?.error('Virtualization detection failed', 'hardware', error.message);
      this.virtualizationInfo = { available: true, error: error.message };
      return this.virtualizationInfo;
    }
  }

  async checkHyperV() {
    try {
      const { stdout } = await execAsync('powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V | Select-Object State"', { timeout: 4000 });
      return stdout.includes('Enabled');
    } catch {
      return false;
    }
  }

  async checkWHPX() {
    try {
      const { stdout } = await execAsync('powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform | Select-Object State"', { timeout: 4000 });
      return stdout.includes('Enabled');
    } catch {
      return true; // Default WHPX capability
    }
  }

  async checkVTx() {
    try {
      const { stdout } = await execAsync('powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-CimInstance Win32_Processor | Select-Object -First 1).VirtualizationFirmwareEnabled"', { timeout: 4000 });
      return stdout.toLowerCase().includes('true');
    } catch {
      return true;
    }
  }

  async checkIOMMU() {
    try {
      const { stdout } = await execAsync('powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-CimInstance Win32_Processor | Select-Object -First 1).SecondLevelAddressTranslationExtensions"', { timeout: 4000 });
      return stdout.toLowerCase().includes('true');
    } catch {
      return true;
    }
  }

  startResourceMonitoring() {
    setInterval(() => this.updateResources(), 2000);
    this.updateResources();
  }

  updateResources() {
    try {
      // High-performance, zero-process-spawn CPU & Memory calculation via os module
      const cpus = os.cpus();
      let totalIdle = 0;
      let totalTick = 0;

      for (const cpu of cpus) {
        for (const type in cpu.times) {
          totalTick += cpu.times[type];
        }
        totalIdle += cpu.times.idle;
      }

      if (this.lastCpuSample) {
        const idleDelta = totalIdle - this.lastCpuSample.idle;
        const totalDelta = totalTick - this.lastCpuSample.total;
        if (totalDelta > 0) {
          const usage = 100 - Math.round(100 * idleDelta / totalDelta);
          this.resources.cpu = Math.max(0, Math.min(100, usage));
        }
      }

      this.lastCpuSample = { idle: totalIdle, total: totalTick };

      const freeMem = os.freemem();
      const totalMem = os.totalmem();
      this.resources.ram = Math.round((1 - freeMem / totalMem) * 100);

      // Estimate VRAM & Disk load
      this.resources.vram = Math.min(100, Math.round(this.resources.ram * 0.8));
      this.resources.disk = Math.min(100, Math.round(this.resources.cpu * 0.5));

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('resources:update', this.resources);
      }
    } catch (error) {
      this.logManager?.debug('Resource update error', 'hardware', error.message);
    }
  }

  getHardwareInfo() {
    return this.hardwareInfo;
  }

  getVirtualizationInfo() {
    return this.virtualizationInfo;
  }

  getResources() {
    return this.resources;
  }

  async refresh() {
    await this.detectHardware();
    await this.detectVirtualization();
    return { hardware: this.hardwareInfo, virtualization: this.virtualizationInfo };
  }

  calculateRecommendedVmConfig() {
    if (!this.hardwareInfo) {
      return {
        cpuCores: 2,
        ramGB: 2,
        network: 'nat',
        gpu: 'auto',
        warnings: []
      };
    }

    const ramGB = this.hardwareInfo.ram?.totalGB || 8;
    const logical = this.hardwareInfo.cpu?.logicalProcessors || 4;

    // Windows Setup runs reliably with 2 GB.  Start conservatively so a
    // desktop with 16 GB does not fail to reserve a large contiguous guest
    // memory block when hardware acceleration is unavailable.
    let recommendedRam = 2;
    if (ramGB >= 32) recommendedRam = 8;
    else if (ramGB >= 16) recommendedRam = 4;

    let recommendedCores = 2;
    if (logical >= 16) recommendedCores = 8;
    else if (logical >= 8) recommendedCores = 4;
    else if (logical >= 4) recommendedCores = 2;

    return {
      cpuCores: recommendedCores,
      ramGB: recommendedRam,
      network: 'nat',
      gpu: 'auto',
      warnings: []
    };
  }
}

module.exports = { HardwareManager };
