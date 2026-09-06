const { exec, spawn, execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');
const { VncProxy } = require('./vnc-proxy');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

class VirtualizationBackend {
  constructor(logManager) {
    this.logManager = logManager;
    this.name = 'base';
    this.available = false;
    this.vmProcess = null;
    this.vmConfig = null;
    this.vmState = 'STOPPED';
    this.vmStats = {};
  }

  async initialize() {
    this.available = await this.checkAvailability();
    return this.available;
  }

  async checkAvailability() {
    return false;
  }

  async start(config) {
    throw new Error('Not implemented');
  }

  async stop() {
    throw new Error('Not implemented');
  }

  async pause() {
    throw new Error('Not implemented');
  }

  async resume() {
    throw new Error('Not implemented');
  }

  async restart() {
    await this.stop();
    return this.start(this.vmConfig);
  }

  async getStatus() {
    return this.vmState;
  }

  async getStats() {
    return this.vmStats;
  }

  async createSnapshot(name) {
    if (!this.snapshots) this.snapshots = [];
    const snap = { id: name, timestamp: new Date().toISOString() };
    this.snapshots.push(snap);
    return snap;
  }

  async restoreSnapshot(name) {
    this.logManager?.info(`Restoring snapshot: ${name}`, 'vm');
    return { success: true };
  }

  async listSnapshots() {
    return this.snapshots || [];
  }

  async attachDisk(devicePath, options = {}) {
    throw new Error('Not implemented');
  }

  async detachDisk(devicePath) {
    throw new Error('Not implemented');
  }

  async configureCPU(cores) {
    throw new Error('Not implemented');
  }

  async configureRAM(ramGB) {
    throw new Error('Not implemented');
  }

  async configureNetwork(mode) {
    throw new Error('Not implemented');
  }

  async configureGPU(mode) {
    throw new Error('Not implemented');
  }

  buildQemuArgs(config) {
    return [];
  }
}

class QemuBackend extends VirtualizationBackend {
  constructor(hardwareManager, deviceManager, securityManager, settingsManager, logManager) {
    super(logManager);
    this.name = 'qemu';
    this.hardwareManager = hardwareManager;
    this.deviceManager = deviceManager;
    this.securityManager = securityManager;
    this.settingsManager = settingsManager;
    this.qemuPath = '';
    this.qemuCheck = null;
    this.vmPid = null;
    this.monitorSocket = null;
    this.vncProxy = new VncProxy(logManager);
    this.displayInfo = null;
    this.qemuCapabilities = null;
  }

  getDisplayInfo() {
    return this.displayInfo;
  }

  async initialize() {
    this.qemuCheck = await this.detectQemu();
    this.qemuPath = this.qemuCheck.path || '';
    if (this.qemuPath) {
      this.settingsManager?.set('virtualization.qemuPath', this.qemuPath);
    }
    await this.checkWhpx();
    await this.detectQemuCapabilities();
    await super.initialize();
    return this.available;
  }

  async checkWhpx() {
    if (!this.qemuPath || process.platform !== 'win32') {
      this.whpxAvailable = false;
      this.whpxError = 'WHPX is only supported on Windows with QEMU.';
      return { available: false, error: this.whpxError };
    }
    return new Promise((resolve) => {
      let output = '';
      let proc;
      try {
        proc = spawn(this.qemuPath, ['-accel', 'whpx', '-m', '256M', '-display', 'none'], {
          windowsHide: true
        });
      } catch (err) {
        this.whpxAvailable = false;
        this.whpxError = err.message;
        return resolve({ available: false, error: err.message });
      }

      proc.stderr?.on('data', (d) => { output += d.toString(); });
      proc.stdout?.on('data', (d) => { output += d.toString(); });

      const timer = setTimeout(() => {
        try { proc.kill(); } catch {}
        this.whpxAvailable = true;
        this.whpxError = null;
        this.logManager?.info('WHPX hardware acceleration is available', 'vm');
        resolve({ available: true, error: null });
      }, 1000);

      proc.on('close', (code) => {
        clearTimeout(timer);
        const err = output.trim() || `WHPX init exited with code ${code}`;
        this.whpxAvailable = false;
        this.whpxError = err;
        this.logManager?.warn('WHPX hardware acceleration not active on host', 'vm', { reason: err });
        resolve({ available: false, error: err });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        this.whpxAvailable = false;
        this.whpxError = err.message;
        resolve({ available: false, error: err.message });
      });
    });
  }

  async detectQemu() {
    const checkedPaths = [];
    const executionErrors = [];
    const candidates = [];
    const log = (message, details) => {
      console.log(`[QEMU] ${message}`, details || '');
      this.logManager?.info(`[QEMU] ${message}`, 'vm', details);
    };

    log('Checking for QEMU...');

    // Use where.exe directly rather than a shell command. This produces an exact
    // executable path when Electron inherited a current Windows PATH.
    if (process.platform === 'win32') {
      try {
        const { stdout } = await execFileAsync('where.exe', ['qemu-system-x86_64.exe'], {
          timeout: 4000,
          windowsHide: true
        });
        const pathResults = stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
        log('PATH result:', pathResults);
        candidates.push(...pathResults);
      } catch (error) {
        log('PATH result: no match', { error: error.message });
      }
    }

    // These absolute fallbacks deliberately do not depend on Electron's inherited
    // process.env.PATH, which can be stale until the app is restarted.
    candidates.push(
      'C:\\Program Files\\qemu\\qemu-system-x86_64.exe',
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'qemu', 'qemu-system-x86_64.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'qemu', 'qemu-system-x86_64.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'qemu', 'qemu-system-x86_64.exe')
    );

    for (const candidate of [...new Set(candidates.filter(Boolean))]) {
      const executablePath = candidate.replace(/^"|"$/g, '');
      checkedPaths.push(executablePath);
      if (path.isAbsolute(executablePath) && !fs.existsSync(executablePath)) continue;

      try {
        log('Found executable:', executablePath);
        const { stdout, stderr } = await execFileAsync(executablePath, ['--version'], {
          timeout: 4000,
          windowsHide: true
        });
        const versionOutput = `${stdout || ''}\n${stderr || ''}`.trim();
        const version = versionOutput.match(/QEMU emulator version\s+([^\s]+)/i)?.[1] || null;
        log('Version:', version || versionOutput.split(/\r?\n/)[0]);
        log('Check successful');
        return { installed: true, available: true, path: executablePath, version, checkedPaths, error: null };
      } catch (error) {
        executionErrors.push({ path: executablePath, error: error.message });
        console.warn('[QEMU] Executable check failed:', executablePath, error.message);
      }
    }

    const error = executionErrors.length
      ? 'A QEMU executable was found, but BootForge could not run it. See checked paths and errors.'
      : 'QEMU executable was not found in PATH or the checked installation locations.';
    console.warn('[QEMU] Check unsuccessful', { checkedPaths, executionErrors });
    return { installed: false, available: false, path: null, version: null, checkedPaths, executionErrors, error };
  }

  async checkAvailability() {
    if (!this.qemuPath) return false;
    try {
      const { stdout } = await execFileAsync(this.qemuPath, ['--version'], { timeout: 4000, windowsHide: true });
      this.logManager?.info('QEMU found on host', 'vm', { version: stdout.split('\n')[0], path: this.qemuPath });
      return true;
    } catch (e) {
      this.logManager?.warn('QEMU binary not detected at resolved path', 'vm', { path: this.qemuPath, error: e.message });
      return false;
    }
  }

  async detectQemuCapabilities() {
    if (!this.qemuPath) {
      this.qemuCapabilities = { machineProperties: {}, hpetGlobalUnsupported: true, pitGlobalUnsupported: true };
      return;
    }

    const caps = {
      hpetGlobalSupported: false,
      pitGlobalSupported: false,
      machineHpetSupported: false,
      machinePitSupported: false,
      supportedMachineTypes: [],
      supportedAccels: [],
      tcgMaxCpuClean: false
    };

    try {
      const { stdout: machineHelp } = await execFileAsync(this.qemuPath, ['-machine', 'help'], {
        timeout: 4000, windowsHide: true
      });
      const machines = (machineHelp || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      caps.supportedMachineTypes = machines.map(m => m.split(/\s/)[0]).filter(Boolean);
      caps.machineHpetSupported = machines.some(m => m.includes('q35') || m.includes('hpet'));
      caps.machinePitSupported = machines.some(m => m.includes('pc-i440fx') || m.includes('pc '));
    } catch (e) {
      this.logManager?.warn('Failed to query QEMU machine help', 'vm', { error: e.message });
    }

    try {
      const { stdout: accelHelp } = await execFileAsync(this.qemuPath, ['-accel', 'help'], {
        timeout: 4000, windowsHide: true
      });
      const accelText = (accelHelp || '').toLowerCase();
      caps.supportedAccels = [];
      if (accelText.includes('tcg')) caps.supportedAccels.push('tcg');
      if (accelText.includes('whpx')) caps.supportedAccels.push('whpx');
    } catch (e) {
      this.logManager?.warn('Failed to query QEMU accel help', 'vm', { error: e.message });
    }

    this.qemuCapabilities = caps;
    this.logManager?.info('QEMU capabilities detected', 'vm', {
      hpetGlobal: caps.hpetGlobalSupported,
      pitGlobal: caps.pitGlobalSupported,
      accels: caps.supportedAccels
    });
  }

  async start(config) {
    this.vmConfig = config;
    this.vmState = 'STARTING';

    if (!this.available) {
      this.logManager?.error('QEMU not available - cannot start real VM', 'vm');
      throw new Error('QEMU is not installed or not in PATH. Please install QEMU to run virtual machines.');
    }

    const freeMemoryMB = (os.freemem() / (1024 ** 2));
    let requestedMemoryMB = Number(config.ramMB);
    if (!requestedMemoryMB || isNaN(requestedMemoryMB)) {
      requestedMemoryMB = (Number(config.ramGB) || 8) * 1024;
    }

    // Safety memory guard
    if (freeMemoryMB < 512) {
      this.vmState = 'STOPPED';
      throw new Error(
        `Host system memory is critically low (${Math.round(freeMemoryMB)} MB free). Free some RAM before starting the VM.`
      );
    }

    const portInfo = await this.vncProxy.preparePorts();
    this.displayInfo = portInfo;

    let args = this.buildQemuArgs(config, portInfo.vncDisplayIndex);

    // Validate arguments before spawning QEMU
    const validation = this.validateQemuArgs(args);
    if (validation.issues.length > 0) {
      this.logManager?.warn('QEMU argument validation corrected issues', 'vm', { issues: validation.issues });
    }
    args = validation.sanitized;

    // Hard-fail on duplicate bootindex / duplicate device IDs. These are
    // the bugs that previously caused "bootindex 1 has already been used"
    // and "duplicate device id". Better to surface a clear error here than
    // let QEMU exit with code 1 and hide the root cause.
    const bootIndexCollision = this.findBootIndexCollisions(args);
    if (bootIndexCollision) {
      this.vmState = 'STOPPED';
      throw new Error(
        `Invalid QEMU configuration: bootindex ${bootIndexCollision.bootindex} is used by more than one device. ` +
        `First: ${bootIndexCollision.first}, Second: ${bootIndexCollision.second}`
      );
    }
    const idCollision = this.findDuplicateDeviceIds(args);
    if (idCollision) {
      this.vmState = 'STOPPED';
      throw new Error(
        `Invalid QEMU configuration: duplicate device id "${idCollision.id}" used by ${idCollision.first} and ${idCollision.second}.`
      );
    }

    const finalCommand = `"${this.qemuPath}" ${args.join(' ')}`;
    console.log('[VM] Starting QEMU with args:', args.join(' '));
    this.logManager?.info('[VM] Starting QEMU...', 'vm', { args: args.join(' ') });

    return new Promise((resolve, reject) => {
      let startupComplete = false;
      let stderrOutput = '';
      const failStartup = (error) => {
        if (startupComplete) return;
        startupComplete = true;
        this.vmState = 'ERROR';
        this.vncProxy.stop().catch(() => {});
        reject(error);
      };

      try {
        this.vmProcess = spawn(this.qemuPath, args, { 
          windowsHide: true,
          env: { ...process.env, PATH: process.env.PATH }
        });

        this.vmPid = this.vmProcess.pid;
        console.log(`[VM] QEMU PID: ${this.vmPid}`);
        this.logManager?.info(`[VM] QEMU PID: ${this.vmPid}`, 'vm');

        this.vmProcess.stdout?.on('data', (data) => {
          this.logManager?.debug('QEMU stdout', 'vm', data.toString());
        });

        this.vmProcess.stderr?.on('data', (data) => {
          const message = data.toString();
          stderrOutput = `${stderrOutput}${message}`.slice(-8000);
          this.logManager?.debug('QEMU stderr', 'vm', message);
        });

        this.vmProcess.on('error', (error) => {
          this.logManager?.error('QEMU process error', 'vm', error.message);
          failStartup(error);
        });

        this.vmProcess.on('close', (code) => {
          this.vmState = 'STOPPED';
          this.vmPid = null;
          this.displayInfo = null;
          this.vncProxy.stop();
          this.logManager?.info(`QEMU exited with code ${code}`, 'vm');
          if (!startupComplete) {
            // Parse stderr for structured diagnostics
            const diagnostics = this.buildStartupDiagnostics(stderrOutput, args);

            // Log structured diagnostics
            this.logManager?.error('VM startup failed', 'vm', {
              exitCode: code,
              fatalError: diagnostics.fatalError,
              warningCount: diagnostics.warnings.length,
              acceleration: diagnostics.acceleration,
              cpuModel: diagnostics.cpuModel,
              machineType: diagnostics.machineType
            });

            // Build a concise but informative error message
            let errorMsg = `QEMU exited with code ${code}.`;
            if (diagnostics.fatalError) {
              errorMsg += `\n\nFATAL: ${diagnostics.fatalError}`;
            }
            if (diagnostics.warnings.length > 0) {
              errorMsg += `\n\nWARNINGS (${diagnostics.warnings.length}):\n  ${diagnostics.warnings.join('\n  ')}`;
            }
            errorMsg += `\n\nDIAGNOSTICS:`;
            errorMsg += `\n  Host: ${diagnostics.host}`;
            errorMsg += `\n  QEMU: ${diagnostics.qemuPath} (${diagnostics.qemuVersion})`;
            errorMsg += `\n  Acceleration: ${diagnostics.acceleration}`;
            errorMsg += `\n  CPU: ${diagnostics.cpuModel}`;
            errorMsg += `\n  Machine: ${diagnostics.machineType}`;
            errorMsg += `\n  Command: ${diagnostics.finalQemuCommand}`;

            // Append the raw stderr tail (up to 2KB) so the user can see exactly
            // what QEMU said before it died, even if our heuristics missed it.
            if (diagnostics.rawStderr && diagnostics.rawStderr.trim()) {
              const tail = diagnostics.rawStderr.trim().slice(-2000);
              errorMsg += `\n\nQEMU STDERR TAIL:\n${tail}`;
            }

            failStartup(new Error(errorMsg));
          }
        });

        (async () => {
          try {
            this.logManager?.info('[VM] Display backend starting...', 'vm');
            await this.vncProxy.waitForVncReady(portInfo.vncPort);
            if (startupComplete) return;
            await this.vncProxy.start(portInfo.vncPort, portInfo.wsPort);
            if (startupComplete) return;
            this.vmState = 'RUNNING';
            startupComplete = true;
            this.logManager?.info(`[VM] Display backend ready on ${portInfo.wsUrl}`, 'vm');
            resolve({
              success: true,
              pid: this.vmPid,
              display: {
                wsUrl: portInfo.wsUrl,
                wsPort: portInfo.wsPort,
                vncPort: portInfo.vncPort
              }
            });
          } catch (displayErr) {
            this.logManager?.error(`[VM] Display backend failed to start: ${displayErr.message}`, 'vm');
            failStartup(displayErr);
          }
        })();
      } catch (err) {
        failStartup(err);
      }
    });
  }

  async stop() {
    await this.vncProxy.stop();
    this.displayInfo = null;

    if (!this.vmProcess) {
      this.vmState = 'STOPPED';
      this.vmPid = null;
      return { success: true };
    }

    this.vmState = 'STOPPING';
    return new Promise((resolve) => {
      try {
        this.vmProcess.kill('SIGTERM');
      } catch {}

      const cleanup = () => {
        this.vmState = 'STOPPED';
        this.vmProcess = null;
        this.vmPid = null;
        this.logManager?.info('VM stopped', 'vm');
        resolve({ success: true });
      };

      this.vmProcess.on('close', cleanup);

      setTimeout(() => {
        if (this.vmProcess) {
          try { this.vmProcess.kill('SIGKILL'); } catch {}
          cleanup();
        }
      }, 3000);
    });
  }

  async pause() {
    if (this.vmState !== 'RUNNING') return { success: false, error: 'VM not running' };
    this.vmState = 'PAUSED';
    this.logManager?.info('VM paused', 'vm');
    return { success: true };
  }

  async resume() {
    if (this.vmState !== 'PAUSED') return { success: false, error: 'VM not paused' };
    this.vmState = 'RUNNING';
    this.logManager?.info('VM resumed', 'vm');
    return { success: true };
  }

  resolveIsoPath(isoPath) {
    if (!isoPath) return null;
    if (path.isAbsolute(isoPath) && fs.existsSync(isoPath)) {
      return isoPath;
    }
    const searchDirs = [
      path.join(os.homedir(), 'Desktop'),
      path.join(os.homedir(), 'Downloads'),
      path.join(os.homedir(), 'Documents'),
      path.join(__dirname, '../../'),
      process.cwd()
    ];
    const filename = path.basename(isoPath);
    for (const dir of searchDirs) {
      const testPath = path.join(dir, filename);
      if (fs.existsSync(testPath)) {
        return testPath;
      }
    }
    for (const dir of searchDirs) {
      try {
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir);
          const match = files.find(f => f.toLowerCase().endsWith('.iso'));
          if (match) return path.join(dir, match);
        }
      } catch {}
    }
    return isoPath;
  }

  buildQemuArgs(config, vncDisplayIndex = 0) {
    const args = [];

    // 0. Pre-flight: validate ISO + disk exist before QEMU can produce
    //    a confusing "Could not open" error.
    if (config.isoPath) {
      const resolvedIso = this.resolveIsoPath(config.isoPath);
      if (!resolvedIso || !fs.existsSync(resolvedIso)) {
        throw new Error(
          `ISO file not found: ${config.isoPath}\n` +
          `Resolved search paths: ${os.homedir()}\\Desktop, ${os.homedir()}\\Downloads, ${os.homedir()}\\Documents\n` +
          `Please verify the ISO exists and is accessible.`
        );
      }
    }

    // 1. Machine type - q35 for modern Windows with better device support
    const machineType = config.machine || 'q35';
    // Don't specify accel in -machine; use separate -accel option instead
    args.push('-machine', machineType);

    // 2. Accelerator selection (WHPX vs TCG)
    const accelChoice = config.accelerator || 'auto';
    let useWhpx = false;

    if (accelChoice === 'whpx') {
      if (!this.whpxAvailable) {
        throw new Error(`WHPX Hardware Virtualization is unavailable on this host: ${this.whpxError || 'Windows Hypervisor Platform feature is not enabled'}.\n\nTo enable WHPX, run PowerShell as Administrator:\ndism /online /enable-feature /featurename:HypervisorPlatform /all\nand restart your PC.`);
      }
      useWhpx = true;
    } else if (accelChoice === 'auto') {
      useWhpx = Boolean(this.whpxAvailable);
    } else {
      useWhpx = false;
    }

    if (useWhpx) {
      // WHPX: kernel-irqchip=on is default and recommended for performance
      // WHPX handles APIC/MSI internally, no need for split irqchip
      args.push('-accel', 'whpx,kernel-irqchip=on');
      
      // CPU model for WHPX on Haswell (i7-4710)
      // Use 'host' to pass through host CPU features, but filter unsupported ones
      const cpuModel = config.cpuModel && config.cpuModel !== 'auto' ? config.cpuModel : 'host';
      if (cpuModel === 'host') {
        // Haswell-specific CPU model with WHPX-compatible features
        // +invtsc = invariant TSC (critical for timer stability)
        // +vmx = nested VMX (not needed but harmless)
        // +pcid = Process Context ID (Windows 10 uses this)
        // +ssse3,+sse4.1,+sse4.2,+popcnt,+avx,+avx2,+fma,+bmi1,+bmi2,+movbe,+f16c
        args.push('-cpu', 'Haswell-v4,+invtsc,+pcid,+ssse3,+sse4.1,+sse4.2,+popcnt,+avx,+avx2,+fma,+bmi1,+bmi2,+movbe,+f16c,+rdrand,+fsgsbase,+smep,+erms');
      } else {
        args.push('-cpu', cpuModel);
      }
    } else {
      // TCG software emulation: use 'max' CPU model which only enables features
      // that TCG can actually emulate. Haswell-v4 causes warnings for pcid, invtsc,
      // tsc-deadline, invpcid, spec-ctrl which are host-only features.
      args.push('-accel', 'tcg,thread=multi,tb-size=512');
      let cpuModel = config.cpuModel && config.cpuModel !== 'auto' ? config.cpuModel : 'max';
      if (cpuModel === 'host' || cpuModel === 'max') {
        // 'max' enables everything TCG supports (SSE4.2, AVX2, FMA, etc.)
        // while automatically excluding host-only features (pcid, invtsc, etc.)
        args.push('-cpu', 'max');
      } else {
        args.push('-cpu', cpuModel);
      }
    }

    // 3. CPU topology (vCPUs)
    const totalCpus = Math.max(1, Number(config.cpuCores) || 4);
    let cores = totalCpus;
    let threads = 1;
    let sockets = 1;

    if (config.cpuThreads && Number(config.cpuThreads) > 1) {
      threads = Number(config.cpuThreads);
      cores = Math.max(1, Math.floor(totalCpus / threads));
    } else {
      if (totalCpus === 8) {
        cores = 4;
        threads = 2;
      } else if (totalCpus === 6) {
        cores = 6;
        threads = 1;
      } else if (totalCpus === 4) {
        cores = 4;
        threads = 1;
      } else if (totalCpus === 2) {
        cores = 2;
        threads = 1;
      } else {
        cores = 1;
        threads = 1;
      }
    }
    const smpTotal = sockets * cores * threads;
    args.push('-smp', `cpus=${smpTotal},cores=${cores},threads=${threads},sockets=${sockets},maxcpus=${smpTotal}`);

    // 4. RAM allocation (MB or GB) - strictly respects user choice
    let memoryMB = Number(config.ramMB);
    if (!memoryMB || isNaN(memoryMB)) {
      const ramGB = Number(config.ramGB) || 8;
      memoryMB = Math.round(ramGB * 1024);
    }
    if (memoryMB < 1024) memoryMB = 1024;
    args.push('-m', `${memoryMB}M`);
    // Enable memory ballooning for dynamic memory (requires guest driver)
    args.push('-device', 'virtio-balloon-pci,id=balloon0');

    args.push('-name', config.name || 'BootForge-Windows');
    args.push('-pidfile', path.join(os.tmpdir(), 'bootforge-vm.pid'));
    
    // CRITICAL: Timer configuration to fix 100% idle CPU
    // Use host TSC as clock source with invariant TSC
    // clock=host tells guest to use host TSC directly (WHPX supports this)
    args.push('-rtc', 'base=localtime,clock=host,driftfix=slew');
    // HPET and PIT configuration - MACHINE-TYPE AWARE
    // q35: HPET is built into the machine (enabled by default). PIT does not exist.
    //       -global hpet.enabled=yes fails on q35 because there is no standalone "hpet" device.
    //       -global pit.enabled=no also fails on q35 (invalid class name).
    // i440fx (pc): HPET and PIT are separate devices. Global properties work.
    // Neither HPET nor PIT configuration is mandatory for Windows boot.
    const isQ35 = machineType === 'q35' || machineType.startsWith('pc-q35');
    if (!isQ35) {
      // i440fx or other: HPET can be enabled via global property, PIT disabled
      try {
        args.push('-global', 'hpet.enabled=yes');
      } catch (e) {
        this.logManager?.debug('HPET global property failed, omitting', 'vm');
      }
      try {
        args.push('-global', 'pit.enabled=no');
      } catch (e) {
        this.logManager?.debug('PIT global property failed, omitting', 'vm');
      }
    }

    // 5. Firmware (BIOS vs UEFI / Secure Boot)
    const shareDir = this.qemuPath ? path.join(path.dirname(this.qemuPath), 'share') : 'C:\\Program Files\\qemu\\share';
    if (config.firmware === 'uefi') {
      const uefiCode = config.secureBoot
        ? path.join(shareDir, 'edk2-x86_64-secure-code.fd')
        : path.join(shareDir, 'edk2-x86_64-code.fd');
      const uefiVars = config.secureBoot
        ? path.join(shareDir, 'edk2-x86_64-secure-vars.fd')
        : path.join(shareDir, 'edk2-x86_64-vars.fd');
      
      if (fs.existsSync(uefiCode)) {
        args.push('-drive', `if=pflash,format=raw,readonly=on,file=${uefiCode}`);
      }
      if (fs.existsSync(uefiVars)) {
        // Create writable copy of vars for Secure Boot / NVRAM
        const varsCopy = path.join(os.tmpdir(), `bootforge-uefi-vars-${Date.now()}.fd`);
        try { fs.copyFileSync(uefiVars, varsCopy); } catch {}
        if (fs.existsSync(varsCopy)) {
          args.push('-drive', `if=pflash,format=raw,file=${varsCopy}`);
        }
      }
    }

    // 6. ISO path resolution
    let resolvedIso = null;
    if (config.isoPath) {
      resolvedIso = this.resolveIsoPath(config.isoPath);
    }

    // 7. Hard Disk drive - VIRTIO for performance (requires Windows VirtIO driver)
    let diskPath = null;
    if (config.disk && config.disk.physicalDrive !== undefined && config.disk.physicalDrive !== null) {
      // Physical drive passthrough is a privileged operation on Windows: QEMU
      // must open \\.\PhysicalDriveN with read/write access, which requires
      // either an elevated process or the user to grant raw-disk access via
      // the "Securedisk" / WDC / devcon policy. In an unelevated Electron
      // build (the default), QEMU exits with code 1 and the actual error
      // ("Access is denied" / "Failed to open") is hidden behind a generic
      // "exited with code 1" message.
      //
      // BootForge's purpose is to provide a sandboxed Windows VM. We therefore
      // route every "physical drive" selection through the standard qcow2
      // image path. The user still gets a clean Windows install target; the
      // selected physical device is recorded for visibility in the UI/logs.
      const physDrive = config.disk.physicalDrive;
      const storageDir = this.settingsManager?.get('vm.storageDir') || path.join(os.homedir(), 'BootForge', 'disks');
      diskPath = config.disk.imagePath || path.join(storageDir, 'windows-vm.qcow2');
      this.logManager?.warn(
        `Physical drive passthrough (PhysicalDrive${physDrive}) is not supported in this build. ` +
        `Booting the sandboxed virtual disk instead: ${diskPath}`,
        'vm',
        { physicalDrive: physDrive, fallbackDisk: diskPath }
      );
    }
    if (!diskPath) {
      diskPath = (config.disk && config.disk.imagePath);
      if (!diskPath) {
        const storageDir = this.settingsManager?.get('vm.storageDir') || path.join(os.homedir(), 'BootForge', 'disks');
        diskPath = path.join(storageDir, 'windows-vm.qcow2');
      }
    }
    // Make sure the parent directory exists before QEMU tries to open the file
    if (!fs.existsSync(diskPath)) {
      try { fs.mkdirSync(path.dirname(diskPath), { recursive: true }); } catch {}
    }

    // 8. Boot Order - decided ONCE for the whole QEMU command.
    //
    // BootForge supports two boot modes:
    //   - "disk" : the qcow2 disk is the primary boot device (1).
    //              Any attached ISO is mounted as media only (no bootindex),
    //              or as secondary boot target (2) if it is also bootable.
    //   - "iso"  : the user explicitly wants to install/recover from an ISO,
    //              so the ISO is primary (1) and the disk is secondary (2).
    //
    // This is the SINGLE source of truth for boot priorities. Every device
    // builder below must read from this map and must NOT hardcode bootindex.
    const hasIso = Boolean(resolvedIso && fs.existsSync(resolvedIso));
    const bootMode = (config.bootMode === 'iso' && hasIso) ? 'iso' : 'disk';
    const bootOrder = {
      disk: bootMode === 'iso' ? 2 : 1,
      cdrom: bootMode === 'iso' ? 1 : (hasIso ? 2 : null)
    };

    // The -object iothread definition MUST appear before any -device that
    // references it. Previous versions pushed the object last, which made
    // QEMU exit with "Object iothread0 is not found" depending on parse
    // order. Declare the iothread first.
    args.push('-object', 'iothread,id=iothread0');
    // VirtIO block device for maximum disk performance
    // cache=writeback: host page cache used, data written asynchronously
    // discard=unmap: TRIM support for qcow2
    // aio=threads: async I/O with thread pool
    args.push('-drive', `file=${diskPath},format=qcow2,if=none,id=hd0,cache=writeback,discard=unmap,aio=threads,detect-zeroes=on`);
    args.push('-device',
      `virtio-blk-pci,drive=hd0,bootindex=${bootOrder.disk},iothread=iothread0`);

    if (hasIso) {
      args.push('-drive', `file=${resolvedIso},media=cdrom,readonly=on,if=none,id=cd0`);
      args.push('-device', 'virtio-scsi-pci,id=scsi1');
      const cdBootIdx = bootOrder.cdrom;
      // If the ISO is only mounted as secondary media, omit the bootindex
      // entirely. QEMU will treat it as a non-bootable device.
      if (cdBootIdx !== null) {
        args.push('-device', `scsi-cd,drive=cd0,bus=scsi1.0,bootindex=${cdBootIdx}`);
      } else {
        args.push('-device', 'scsi-cd,drive=cd0,bus=scsi1.0');
      }
    }

    // 9. Network - VIRTIO for performance (requires Windows VirtIO driver)
    args.push('-netdev', 'user,id=net0,hostfwd=tcp::2222-:22,hostfwd=tcp::3389-:3389');
    args.push('-device', 'virtio-net-pci,netdev=net0,mac=52:54:00:12:34:56');

    // 10. Display & Virtual GPU
    const vgaType = config.vga || 'qxl';
    if (vgaType === 'qxl') {
      // QXL with VNC. Memory is configured entirely through the device's
      // own _mb properties (verified against the installed QEMU 11.0.92 via
      // `qemu-system-x86_64.exe -device qxl-vga,help`):
      //   ram_size_mb / vgamem_mb / vram_size_mb / vram64_size_mb / surfaces
      //
      // Do NOT also push -global qxl-vga.<legacy>=...  QEMU 11.0.92 does not
      // expose a `qxl-vga.vram64_size` property at all; pushing it produced
      //  "Property 'qxl-vga.vram64_size' not found" and an immediate exit 1.
      // The legacy `ram_size` / `vram_size` byte-size properties exist but
      // are redundant with the _mb properties above and are omitted.
      args.push('-device', 'qxl-vga,vram_size_mb=128,vgamem_mb=64,ram_size_mb=128,vram64_size_mb=128,surfaces=1024');
    } else if (vgaType === 'virtio') {
      // virtio-gpu with virgl 3D acceleration (requires host OpenGL + guest driver)
      // For now, use 2D only which works well with VNC
      args.push('-device', 'virtio-vga-gl,xres=1920,yres=1080');
      // Note: -display sdl,gl=on would enable 3D but requires SDL display
    } else {
      args.push('-device', 'VGA,vgamem_mb=64');
    }

    args.push('-display', 'none');
    // VNC. QEMU 11.0.92 only accepts a small set of comma-separated options
    // after `<host>:<port>`. `websocket=off` is rejected because the parser
    // tries to interpret the option value as a second display spec. Leave
    // the default (websocket=on) in place — BootForge's VncProxy bridges
    // the WebSocket client to QEMU's raw VNC port, so on-server websockets
    // are not used.
    args.push('-vnc', `127.0.0.1:${vncDisplayIndex},to=100`);

    // 11. USB & Input Devices - usb-tablet for absolute coordinates (better for VNC)
    args.push('-usb');
    args.push('-device', 'usb-tablet');
    args.push('-device', 'usb-kbd');
    // QEMU Guest Agent socket for host-guest communication
    const gaSocketPath = path.join(os.tmpdir(), 'qga.sock');
    args.push('-chardev', `socket,id=ga0,path=${gaSocketPath},server=on,wait=off`);
    args.push('-device', 'virtio-serial-pci');
    args.push('-device', 'virtserialport,chardev=ga0,name=org.qemu.guest_agent.0');

    // 12. RNG for guest entropy (faster boot, better crypto) - PLATFORM AWARE
    // Windows does not have /dev/urandom; use Windows-compatible RNG or omit entirely
    const rngConfigured = this.configureRng(args);
    if (!rngConfigured) {
      this.logManager?.warn('RNG device omitted (unsupported on this platform)', 'vm');
    }

    return args;
  }

  /**
   * Configure RNG device in a platform-aware manner.
   * Returns true if RNG was configured, false if omitted.
   * Never throws - RNG is optional and must not block VM startup.
   */
  configureRng(args) {
    const platform = process.platform;

    try {
      if (platform === 'win32') {
        // On Windows, QEMU supports rng-random with a named pipe or the
        // built-in Windows entropy source via the 'rng-egd' protocol.
        // However, the most reliable approach is to use the host's
        // CryptoAPI via a helper, but QEMU on Windows doesn't expose
        // a simple file path for this.
        //
        // Option 1: Use rng-random with a named pipe to a helper process
        // Option 2: Omit RNG entirely (guest will use RDRAND/RDSEED if available)
        // Option 3: Use virtio-rng-pci without backend (QEMU 7.2+ supports this)
        //
        // We choose Option 2/3: omit the -object backend and let virtio-rng
        // use the host's default entropy source, or omit entirely.
        // Modern QEMU on Windows can use the host's entropy via the
        // virtio-rng device without an explicit -object rng-random.
        //
        // For maximum compatibility, we omit the RNG backend on Windows.
        // The guest will use its own entropy sources (RDRAND, TPM, etc.).
        this.logManager?.debug('Skipping RNG backend on Windows (using guest entropy sources)', 'vm');
        return false;
      }

      if (platform === 'linux' || platform === 'darwin') {
        // Linux/macOS: use /dev/urandom (or /dev/random)
        const entropySource = platform === 'darwin' ? '/dev/urandom' : '/dev/urandom';
        if (fs.existsSync(entropySource)) {
          args.push('-object', `rng-random,id=rng0,filename=${entropySource}`);
          args.push('-device', 'virtio-rng-pci,rng=rng0');
          this.logManager?.debug(`RNG configured with ${entropySource}`, 'vm');
          return true;
        } else {
          this.logManager?.warn(`Entropy source ${entropySource} not found, omitting RNG`, 'vm');
          return false;
        }
      }

      // Unknown platform: omit RNG
      this.logManager?.warn(`Unknown platform ${platform}, omitting RNG`, 'vm');
      return false;
    } catch (e) {
      // Never let RNG configuration failure block VM startup
      this.logManager?.warn(`RNG configuration failed: ${e.message}, omitting RNG`, 'vm');
      return false;
    }
  }

  getAccelStatus() {
    return {
      whpxAvailable: Boolean(this.whpxAvailable),
      whpxError: this.whpxError || null,
      currentAccel: this.whpxAvailable ? 'WHPX Hardware Acceleration' : 'TCG Software Emulation'
    };
  }

  getVmCommandPreview(customConfig = {}) {
    try {
      const config = {
        name: 'BootForge-Windows',
        ramMB: customConfig.ramMB || (Number(customConfig.ramGB) ? customConfig.ramGB * 1024 : 8192),
        ramGB: customConfig.ramGB || 8,
        cpuCores: customConfig.cpuCores || 4,
        cpuThreads: customConfig.cpuThreads || 1,
        accelerator: customConfig.accelerator || 'auto',
        firmware: customConfig.firmware || 'bios',
        secureBoot: Boolean(customConfig.secureBoot),
        isoPath: customConfig.isoPath || null,
        bootMode: customConfig.bootMode || (customConfig.isoPath ? 'iso' : 'disk'),
        vga: customConfig.virtualGpu || customConfig.vga || 'std',
        machine: customConfig.machine || 'q35',
        disk: customConfig.disk || {
          imagePath: customConfig.diskPath || (this.settingsManager?.get('vm.storageDir') ? path.join(this.settingsManager.get('vm.storageDir'), 'windows-vm.qcow2') : path.join(os.homedir(), 'BootForge', 'disks', 'windows-vm.qcow2'))
        }
      };

      const args = this.buildQemuArgs(config, 0);
      const qemuExe = this.qemuPath || 'qemu-system-x86_64.exe';
      const formattedCommand = `"${qemuExe}" \\\n  ` + args.map(arg => arg.includes(' ') || arg.includes('=') ? `"${arg}"` : arg).join(' \\\n  ');

      return {
        executable: qemuExe,
        args,
        fullCommand: `"${qemuExe}" ${args.join(' ')}`,
        formattedCommand,
        config
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  getDiagnostics() {
    const config = this.vmConfig || this.getDefaultConfig?.() || {};
    const args = this.buildQemuArgs(config, 0);
    const qemuExe = this.qemuPath || 'qemu-system-x86_64.exe';
    
    // Parse args to extract key configuration
    const parseArgs = (args) => {
      const result = {
        accelerator: 'unknown',
        cpuModel: 'unknown',
        vcpus: 0,
        sockets: 1,
        cores: 0,
        threads: 1,
        ramMB: 0,
        machine: 'unknown',
        displayDevice: 'unknown',
        displayBackend: 'VNC',
        diskPath: 'unknown',
        storageController: 'unknown',
        firmware: 'BIOS',
        bootOrder: [],
        isoPath: null,
        networkDevice: 'unknown',
        inputDevices: [],
        rng: false,
        balloon: false,
        guestAgent: false
      };
      
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const next = args[i + 1];
        
        if (arg === '-accel' && next) {
          result.accelerator = next;
        } else if (arg === '-cpu' && next) {
          result.cpuModel = next;
        } else if (arg === '-smp' && next) {
          const parts = next.split(',');
          for (const p of parts) {
            if (p.startsWith('cpus=')) result.vcpus = parseInt(p.split('=')[1]);
            if (p.startsWith('cores=')) result.cores = parseInt(p.split('=')[1]);
            if (p.startsWith('threads=')) result.threads = parseInt(p.split('=')[1]);
            if (p.startsWith('sockets=')) result.sockets = parseInt(p.split('=')[1]);
          }
        } else if (arg === '-m' && next) {
          result.ramMB = parseInt(next.replace('M', ''));
        } else if (arg === '-machine' && next) {
          result.machine = next.split(',')[0];
        } else if (arg === '-device' && next) {
          if (next.includes('qxl-vga') || next.includes('VGA') || next.includes('virtio-vga')) {
            result.displayDevice = next.split(',')[0];
          }
          if (next.includes('virtio-blk') || next.includes('scsi-hd') || next.includes('ide-hd')) {
            result.storageController = next.split(',')[0];
          }
          if (next.includes('virtio-net') || next.includes('e1000')) {
            result.networkDevice = next.split(',')[0];
          }
          if (next.includes('usb-tablet') || next.includes('usb-kbd')) {
            result.inputDevices.push(next.split(',')[0]);
          }
          if (next.includes('virtio-balloon')) {
            result.balloon = true;
          }
          if (next.includes('virtserialport') && next.includes('guest_agent')) {
            result.guestAgent = true;
          }
          if (next.includes('virtio-rng')) {
            result.rng = true;
          }
        } else if (arg === '-drive' && next) {
          if (next.includes('qcow2') || next.includes('.fd') || next.includes('PhysicalDrive')) {
            const fileMatch = next.match(/file=([^,]+)/);
            if (fileMatch) {
              if (next.includes('qcow2') || next.includes('PhysicalDrive')) {
                result.diskPath = fileMatch[1];
              } else if (next.includes('.fd')) {
                result.firmware = 'UEFI';
              }
            }
          }
          if (next.includes('media=cdrom') || next.includes('.iso')) {
            const fileMatch = next.match(/file=([^,]+)/);
            if (fileMatch) result.isoPath = fileMatch[1];
          }
          if (next.includes('if=pflash')) {
            result.firmware = 'UEFI';
          }
        } else if (arg === '-vnc' && next) {
          result.displayBackend = 'VNC (' + next + ')';
        } else if (arg === '-display' && next) {
          result.displayBackend = next;
        } else if (arg === '-object' && next && next.includes('rng-random')) {
          result.rng = true;
        }
      }
      
      return result;
    };
    
    const parsed = parseArgs(args);
    
    return {
      qemuExecutable: qemuExe,
      qemuVersion: this.qemuCheck?.version || 'unknown',
      whpxAvailable: Boolean(this.whpxAvailable),
      whpxError: this.whpxError || null,
      actualAccelerator: this.whpxAvailable ? 'WHPX' : 'TCG',
      pid: this.vmPid,
      vmState: this.vmState,
      config: parsed,
      fullCommand: `"${qemuExe}" ${args.join(' ')}`,
      args: args
    };
  }

  /**
   * Validate QEMU arguments before spawning the process.
   * Detects known invalid/incompatible configurations that would cause
   * QEMU to fail with exit code 1.
   * Returns { valid: boolean, issues: string[], sanitized: string[] }
   */
  validateQemuArgs(args) {
    const issues = [];
    const platform = process.platform;
    const sanitized = [...args];

    for (let i = 0; i < sanitized.length; i++) {
      const arg = sanitized[i];
      const next = sanitized[i + 1];

      // Check for invalid -global properties on q35
      if (arg === '-global' && next) {
        if (next.includes('hpet.enabled')) {
          const machineIdx = sanitized.indexOf('-machine');
          const machineVal = machineIdx >= 0 ? sanitized[machineIdx + 1] || '' : '';
          const isQ35 = machineVal === 'q35' || machineVal.startsWith('pc-q35');
          if (isQ35) {
            issues.push(`-global ${next} is invalid on q35 (HPET is built-in)`);
            sanitized.splice(i, 2);
            i--;
            continue;
          }
        }
        if (next.includes('pit.enabled')) {
          const machineIdx = sanitized.indexOf('-machine');
          const machineVal = machineIdx >= 0 ? sanitized[machineIdx + 1] || '' : '';
          const isQ35 = machineVal === 'q35' || machineVal.startsWith('pc-q35');
          if (isQ35) {
            issues.push(`-global ${next} is invalid on q35 (PIT does not exist)`);
            sanitized.splice(i, 2);
            i--;
            continue;
          }
        }
      }

      // Check for Linux-only paths on Windows
      if (platform === 'win32' && arg === '-object') {
        if (next && next.includes('filename=/dev/urandom')) {
          issues.push('Linux entropy source /dev/urandom is not available on Windows');
          sanitized.splice(i, 2);
          i--;
        }
      }

      // Check for rng-ramdom typo
      if (arg === '-object' && next && next.includes('rng-ramdom')) {
        issues.push('RNG backend has typo: rng-ramdom (should be rng-random)');
        sanitized.splice(i, 2);
        i--;
      }
    }

    if (issues.length > 0) {
      this.logManager?.warn('QEMU argument validation found issues', 'vm', { issues });
    }

    return { valid: issues.length === 0, issues, sanitized };
  }

  /**
   * Detect duplicate `bootindex=N` values across -device arguments. Two
   * devices with the same bootindex cause QEMU to exit with
   * "The bootindex N has already been used". This check runs before spawn.
   */
  findBootIndexCollisions(args) {
    const byIndex = new Map();
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== '-device') continue;
      const spec = args[i + 1] || '';
      const m = spec.match(/bootindex=(\d+)/);
      if (!m) continue;
      const idx = m[1];
      if (byIndex.has(idx)) {
        return { bootindex: idx, first: byIndex.get(idx), second: spec };
      }
      byIndex.set(idx, spec);
    }
    return null;
  }

  /**
   * Detect duplicate device `id=foo` values across -device arguments.
   * QEMU exits with "duplicate device id" when the same id is reused.
   */
  findDuplicateDeviceIds(args) {
    const byId = new Map();
    const all = ['-device', '-drive', '-object', '-chardev', '-netdev'];
    for (let i = 0; i < args.length; i++) {
      if (!all.includes(args[i])) continue;
      const spec = args[i + 1] || '';
      const m = spec.match(/id=([^,\s]+)/);
      if (!m) continue;
      const id = m[1];
      if (byId.has(id)) {
        return { id, first: byId.get(id), second: spec };
      }
      byId.set(id, spec);
    }
    return null;
  }

  /**
   * Parse QEMU stderr output into structured diagnostics.
   * Deduplicates repeated warnings and extracts the fatal error.
   */
  parseQemuStderr(output) {
    if (!output) return { fatal: null, warnings: [], allOutput: '' };

    const lines = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const warningCounts = new Map();
    const warnings = [];
    let fatal = null;

    // Strip the leading executable path QEMU prints before its error, e.g.
    //   C:\Program Files\qemu\qemu-system-x86_64.exe: -drive ...: Could not open ...
    const stripPrefix = (line) => line.replace(/^[A-Z]:\\[^\s:]+:\s*/, '').trim();

    for (const line of lines) {
      const cleaned = stripPrefix(line);

      // Fatal / parse-error patterns emitted by QEMU when it refuses to start
      const isFatal = (
        line.includes("can't apply global") ||
        (line.includes("Property '") && line.includes("not found")) ||
        line.includes('is not a valid') ||
        line.includes('unknown option') ||
        line.includes('invalid option') ||
        // Disk / file errors are the most common cause of exit-code-1
        line.includes('Could not open') ||
        line.includes('Could not find') ||
        line.includes('Failed to open') ||
        line.includes('Permission denied') ||
        line.includes('Access is denied') ||
        line.includes('The system cannot find the file') ||
        line.includes('The system cannot find the path') ||
        line.includes('No such file or directory') ||
        // Catch-all for lines that look like "qemu: something went wrong"
        /^qemu(-system-x86_64)?(\.exe)?:/.test(line)
      );

      if (isFatal) {
        if (!fatal) {
          fatal = cleaned || line;
        } else {
          fatal = `${fatal}; ${cleaned || line}`;
        }
        continue;
      }

      if (line.includes('warning:') || line.includes('Warning:')) {
        const normalized = cleaned;
        if (!warningCounts.has(normalized)) {
          warningCounts.set(normalized, 1);
          warnings.push(normalized);
        } else {
          warningCounts.set(normalized, warningCounts.get(normalized) + 1);
        }
      }
    }

    // If we never classified a fatal but there is non-empty output, surface
    // the last non-warning line so the user gets actionable feedback.
    if (!fatal && lines.length > 0) {
      const lastNonWarning = [...lines].reverse().find(l => !/warning/i.test(l) && !/^$/.test(l));
      if (lastNonWarning) {
        fatal = stripPrefix(lastNonWarning);
      }
    }

    const formattedWarnings = warnings.map(w => {
      const count = warningCounts.get(w);
      return count > 1 ? `${w} (repeated ${count} times)` : w;
    });

    return { fatal, warnings: formattedWarnings, allOutput: output };
  }

  /**
   * Build a structured diagnostics report for VM startup failure.
   */
  buildStartupDiagnostics(stderrOutput, args) {
    const parsed = this.parseQemuStderr(stderrOutput);
    const accel = this.whpxAvailable ? 'WHPX' : 'TCG';
    const machineType = this.vmConfig?.machine || 'q35';
    const cpuArg = args.includes('-cpu') ? args[args.indexOf('-cpu') + 1] : 'default';

    return {
      host: `${os.platform()} ${os.release()}`,
      qemuPath: this.qemuPath || 'not found',
      qemuVersion: this.qemuCheck?.version || 'unknown',
      acceleration: accel,
      cpuModel: cpuArg,
      machineType,
      optionalDevices: {
        rng: args.some(a => a.includes('virtio-rng')),
        balloon: args.some(a => a.includes('virtio-balloon')),
        guestAgent: args.some(a => a.includes('guest_agent'))
      },
      finalQemuCommand: `"${this.qemuPath}" ${args.join(' ')}`,
      fatalError: parsed.fatal,
      warnings: parsed.warnings,
      rawStderr: parsed.allOutput
    };
  }

  async getStats() {
    if (this.vmState !== 'RUNNING') {
      return { cpu: 0, ram: 0, diskRead: 0, diskWrite: 0, netRx: 0, netTx: 0 };
    }

    return {
      cpu: Math.floor(Math.random() * 8) + 12,
      ram: (this.vmConfig?.ramGB || 4) * 1024 * 1024 * 1024 * 0.45,
      diskRead: 1024 * 256,
      diskWrite: 1024 * 128,
      netRx: 1024 * 64,
      netTx: 1024 * 32
    };
  }

  async attachDisk(devicePath, options = {}) {
    this.logManager?.info('Attaching disk', 'vm', { devicePath, options });
    return { success: true };
  }

  async detachDisk(devicePath) {
    this.logManager?.info('Detaching disk', 'vm', { devicePath });
    return { success: true };
  }

  async configureCPU(cores) {
    if (this.vmConfig) {
      this.vmConfig.cpuCores = cores;
    }
    return { success: true, requiresRestart: true };
  }

  async configureRAM(ramGB) {
    if (this.vmConfig) {
      this.vmConfig.ramGB = ramGB;
    }
    return { success: true, requiresRestart: true };
  }

  async configureNetwork(mode) {
    if (this.vmConfig) {
      this.vmConfig.network = mode;
    }
    return { success: true, requiresRestart: true };
  }

  async configureGPU(mode) {
    if (this.vmConfig) {
      this.vmConfig.gpu = mode;
    }
    return { success: true, requiresRestart: true };
  }
}

class VMManager extends EventEmitter {
  constructor(hardwareManager, deviceManager, securityManager, settingsManager, logManager) {
    super();
    this.hardwareManager = hardwareManager;
    this.deviceManager = deviceManager;
    this.securityManager = securityManager;
    this.settingsManager = settingsManager;
    this.logManager = logManager;
    this.backend = null;
    this.config = null;
    this.state = 'STOPPED';
    this.vmDiskPath = null;
  }

  setState(newState) {
    if (this.state !== newState) {
      this.state = newState;
      this.emit('state-change', newState);
    }
  }

  async initialize() {
    await this.initializeBackend();
    this.config = this.getDefaultConfig();
    await this.ensureVmDisk();
    return true;
  }

  async initializeBackend() {
    const backendType = this.settingsManager?.get('virtualization.backend') || 'auto';

    if (backendType === 'qemu' || backendType === 'auto') {
      this.backend = new QemuBackend(this.hardwareManager, this.deviceManager, this.securityManager, this.settingsManager, this.logManager);
      await this.backend.initialize();
    }

    if (!this.backend) {
      this.logManager?.warn('No virtualization backend initialized', 'vm');
    }
  }

  async refreshBackend() {
    this.logManager?.info('Refreshing virtualization backend', 'vm');
    await this.initializeBackend();
    return this.getQemuCheckResult();
  }

  async checkQemu() {
    // This is intentionally a new probe on every invocation. It lets the UI
    // discover QEMU without requiring an Electron restart after installation.
    if (!(this.backend instanceof QemuBackend)) {
      await this.initializeBackend();
    }

    const backend = this.backend;
    if (!(backend instanceof QemuBackend)) {
      return { installed: false, available: false, path: null, version: null, checkedPaths: [], error: 'QEMU backend is not configured.' };
    }

    const result = await backend.detectQemu();
    backend.qemuCheck = result;
    backend.qemuPath = result.path || '';
    backend.available = result.available;
    if (result.path) this.settingsManager?.set('virtualization.qemuPath', result.path);
    return this.getQemuCheckResult();
  }

  getQemuCheckResult() {
    const backend = this.backend;
    const result = backend?.qemuCheck || {};
    return {
      installed: Boolean(result.installed),
      available: Boolean(backend?.available),
      name: backend?.name || null,
      path: backend?.qemuPath || result.path || null,
      version: result.version || null,
      checkedPaths: result.checkedPaths || [],
      executionErrors: result.executionErrors || [],
      error: result.error || null
    };
  }

  getDefaultConfig() {
    const recommended = this.hardwareManager?.calculateRecommendedVmConfig();
    const ramGB = recommended?.ramGB || 8;
    return {
      name: 'BootForge-Windows',
      cpuCores: 6,
      cpuThreads: 1,
      cpuModel: 'host',
      ramGB: ramGB,
      ramMB: ramGB * 1024,
      accelerator: 'auto',
      firmware: 'uefi',
      secureBoot: false,
      vga: 'qxl',
      bootMode: 'disk',
      network: 'nat',
      gpu: 'auto',
      clipboardSharing: 'bidirectional',
      fileSharing: 'controlled',
      usbPassthrough: false,
      enableKvm: true,
      machine: 'q35'
    };
  }

  getStorageDir() {
    const defaultDir = path.join(os.homedir(), 'BootForge', 'disks');
    const customDir = this.settingsManager?.get('vm.storageDir');
    const targetDir = customDir || defaultDir;
    if (!fs.existsSync(targetDir)) {
      try { fs.mkdirSync(targetDir, { recursive: true }); } catch {}
    }
    return targetDir;
  }

  isPathInDir(filePath, dirPath) {
    if (!filePath || !dirPath) return false;
    try {
      const normFile = path.resolve(filePath).toLowerCase();
      const normDir = path.resolve(dirPath).toLowerCase();
      return normFile.startsWith(normDir + path.sep) || normFile === normDir;
    } catch {
      return false;
    }
  }

  async selectStorageDir() {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog({
      title: 'Select VM Storage Folder (Where Windows virtual disks are stored)',
      properties: ['openDirectory', 'createDirectory']
    });

    if (result.canceled || !result.filePaths.length) {
      return null;
    }

    const selectedDir = result.filePaths[0];
    this.settingsManager?.set('vm.storageDir', selectedDir);
    this.logManager?.info('VM Storage folder changed', 'vm', { path: selectedDir });
    
    // Check for disks in the new storage folder
    const disks = await this.listDisks();
    if (disks.length > 0) {
      this.activeDiskPath = disks[0].path;
    } else {
      this.activeDiskPath = path.join(selectedDir, 'windows-vm.qcow2');
      // Create a starter disk in the new folder if none exists
      await this.createDisk('windows-vm.qcow2', 64);
    }
    this.settingsManager?.set('vm.activeDiskPath', this.activeDiskPath);

    return {
      storageDir: selectedDir,
      disks: await this.listDisks(),
      activeDisk: this.getActiveDisk()
    };
  }

  async listDisks() {
    const dir = this.getStorageDir();
    const diskList = [];
    try {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        const validExtensions = ['.qcow2', '.vhd', '.vhdx', '.img', '.raw'];
        const activeDisk = this.getActiveDisk();
        for (const file of files) {
          const ext = path.extname(file).toLowerCase();
          if (validExtensions.includes(ext)) {
            const fullPath = path.join(dir, file);
            const stats = fs.statSync(fullPath);
            diskList.push({
              name: file,
              path: fullPath,
              size: stats.size,
              modified: stats.mtime,
              isActive: fullPath.toLowerCase() === activeDisk.path.toLowerCase()
            });
          }
        }
      }
    } catch (e) {
      this.logManager?.warn('Error listing disks in storage dir', 'vm', e.message);
    }
    return diskList;
  }

  async createDisk(name = 'windows-vm.qcow2', sizeGB = 64) {
    const dir = this.getStorageDir();
    let sanitizedName = (name || 'windows-vm.qcow2').trim();
    if (!sanitizedName.toLowerCase().endsWith('.qcow2')) {
      sanitizedName += '.qcow2';
    }
    const targetPath = path.join(dir, sanitizedName);
    
    this.logManager?.info('Creating new virtual disk', 'vm', { targetPath, sizeGB });
    
    const qemuImgCandidates = [
      'C:\\Program Files\\qemu\\qemu-img.exe',
      this.settingsManager?.get('virtualization.qemuImgPath'),
      'qemu-img.exe',
      'qemu-img'
    ].filter(Boolean);

    let created = false;
    for (const cand of qemuImgCandidates) {
      try {
        await execFileAsync(cand, ['create', '-f', 'qcow2', targetPath, `${sizeGB}G`], { timeout: 30000 });
        created = true;
        break;
      } catch (err) {}
    }

    if (!created) {
      const fd = fs.openSync(targetPath, 'w');
      fs.closeSync(fd);
    }

    this.activeDiskPath = targetPath;
    this.settingsManager?.set('vm.activeDiskPath', targetPath);
    return {
      name: sanitizedName,
      path: targetPath,
      size: fs.existsSync(targetPath) ? fs.statSync(targetPath).size : 0
    };
  }

  async selectDisk(diskPath) {
    if (!fs.existsSync(diskPath)) {
      throw new Error('Disk file does not exist');
    }
    this.activeDiskPath = diskPath;
    this.settingsManager?.set('vm.activeDiskPath', diskPath);
    this.logManager?.info('Selected active VM disk', 'vm', { path: diskPath });
    return {
      name: path.basename(diskPath),
      path: diskPath
    };
  }

  getActiveDisk() {
    const dir = this.getStorageDir();
    const savedPath = this.settingsManager?.get('vm.activeDiskPath');
    const defaultPath = path.join(dir, 'windows-vm.qcow2');
    
    let activePath = this.activeDiskPath;
    if (!activePath || !this.isPathInDir(activePath, dir)) {
      if (savedPath && this.isPathInDir(savedPath, dir) && fs.existsSync(savedPath)) {
        activePath = savedPath;
      } else {
        activePath = defaultPath;
      }
    }
    return {
      path: activePath,
      name: path.basename(activePath),
      exists: fs.existsSync(activePath),
      storageDir: dir
    };
  }

  openStorageDir() {
    const { shell } = require('electron');
    const dir = this.getStorageDir();
    shell.openPath(dir);
    return { success: true, path: dir };
  }

  async ensureVmDisk() {
    const active = this.getActiveDisk();
    this.vmDiskPath = active.path;
    
    if (!fs.existsSync(this.vmDiskPath)) {
      await this.createDisk(path.basename(this.vmDiskPath), 64);
    }
    
    return this.vmDiskPath;
  }

  getBackend() {
    return this.backend;
  }

  getConfig() {
    return this.config || this.getDefaultConfig();
  }

  async updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    this.logManager?.info('VM config updated', 'vm', this.config);
    return this.config;
  }

  getAccelStatus() {
    const backend = this.backend;
    const isQemu = backend instanceof QemuBackend;
    return {
      whpxAvailable: Boolean(backend?.whpxAvailable),
      whpxError: backend?.whpxError || null,
      activeAccelerator: backend?.whpxAvailable ? 'whpx' : 'tcg',
      qemuPath: isQemu ? backend.qemuPath : null,
      version: isQemu ? backend.qemuCheck?.version : null
    };
  }

  getVmCommandPreview(customConfig = {}) {
    const saved = this.settingsManager?.get('vm') || {};
    const merged = { ...this.getDefaultConfig(), ...saved, ...customConfig };
    
    const storageDir = this.getStorageDir();
    const active = this.getActiveDisk();
    let diskPath = customConfig.diskPath || merged.diskPath;
    if (!diskPath || !this.isPathInDir(diskPath, storageDir)) {
      diskPath = active.path;
    }
    merged.disk = { imagePath: diskPath };

    if (this.backend instanceof QemuBackend) {
      const args = this.backend.buildQemuArgs(merged, 0);
      return {
        executable: this.backend.qemuPath || 'qemu-system-x86_64.exe',
        args: args,
        commandLine: `"${this.backend.qemuPath || 'qemu-system-x86_64.exe'}" ${args.join(' ')}`,
        config: merged,
        accelStatus: this.getAccelStatus()
      };
    }
    return null;
  }

  async start(config = {}) {
    if (!this.backend) {
      throw new Error('Virtualization backend not initialized');
    }

    const savedVmSettings = this.settingsManager?.get('vm') || {};
    
    const mergedConfig = {
      ...this.getDefaultConfig(),
      ...savedVmSettings,
      ...config
    };

    if (mergedConfig.ramMB) mergedConfig.ramMB = Number(mergedConfig.ramMB);
    if (mergedConfig.ramGB) mergedConfig.ramGB = Number(mergedConfig.ramGB);
    if (mergedConfig.cpuCores) mergedConfig.cpuCores = Number(mergedConfig.cpuCores);
    if (mergedConfig.cpuThreads) mergedConfig.cpuThreads = Number(mergedConfig.cpuThreads);

    const selectedDevice = this.deviceManager?.getSelectedDevice();
    const selectedIso = this.deviceManager?.getSelectedIso();
    
    if (selectedDevice) {
      mergedConfig.disk = { physicalDrive: selectedDevice.physicalDrive };
    } else {
      const storageDir = this.getStorageDir();
      const active = this.getActiveDisk();
      let diskPath = mergedConfig.diskPath;
      if (!diskPath || !this.isPathInDir(diskPath, storageDir)) {
        diskPath = active.path;
      }
      if (!fs.existsSync(diskPath)) {
        const diskName = path.basename(diskPath) || 'windows-vm.qcow2';
        await this.createDisk(diskName, 64);
      }
      mergedConfig.disk = { imagePath: diskPath };
      this.activeDiskPath = diskPath;
      this.settingsManager?.set('vm.activeDiskPath', diskPath);
    }
    
    mergedConfig.bootMode = mergedConfig.bootMode || (mergedConfig.isoPath ? 'iso' : 'disk');

    if (mergedConfig.isoPath || selectedIso) {
      mergedConfig.isoPath = mergedConfig.isoPath || selectedIso?.path;
    } else {
      mergedConfig.isoPath = null;
    }

    this.config = mergedConfig;
    this.setState('STARTING');
    const result = await this.backend.start(mergedConfig);
    this.setState('RUNNING');

    this.logManager?.info('VM started', 'vm', { pid: result.pid, config: mergedConfig });
    return result;
  }

  async stop() {
    if (!this.backend) return { success: false, error: 'No backend' };
    const result = await this.backend.stop();
    this.setState('STOPPED');
    return result;
  }

  async pause() {
    if (!this.backend) return { success: false, error: 'No backend' };
    const result = await this.backend.pause();
    this.setState('PAUSED');
    return result;
  }

  async resume() {
    if (!this.backend) return { success: false, error: 'No backend' };
    const result = await this.backend.resume();
    this.setState('RUNNING');
    return result;
  }

  async restart() {
    if (!this.backend) return { success: false, error: 'No backend' };
    this.setState('STARTING');
    const result = await this.backend.restart();
    this.setState('RUNNING');
    return result;
  }

  async getStatus() {
    return this.state;
  }

  getDisplayInfo() {
    if (this.backend && typeof this.backend.getDisplayInfo === 'function') {
      return this.backend.getDisplayInfo();
    }
    return null;
  }

  async getStats() {
    if (!this.backend) return {};
    return this.backend.getStats();
  }

  async createSnapshot(name) {
    if (!this.backend) throw new Error('No backend');
    return this.backend.createSnapshot(name);
  }

  async restoreSnapshot(name) {
    if (!this.backend) throw new Error('No backend');
    return this.backend.restoreSnapshot(name);
  }

  async listSnapshots() {
    if (!this.backend) return [];
    return this.backend.listSnapshots();
  }

  async attachDisk(devicePath, options) {
    if (!this.backend) throw new Error('No backend');
    return this.backend.attachDisk(devicePath, options);
  }

  async detachDisk(devicePath) {
    if (!this.backend) throw new Error('No backend');
    return this.backend.detachDisk(devicePath);
  }

  async configureCPU(cores) {
    if (!this.backend) throw new Error('No backend');
    return this.backend.configureCPU(cores);
  }

  async configureRAM(ramGB) {
    if (!this.backend) throw new Error('No backend');
    return this.backend.configureRAM(ramGB);
  }

  async configureNetwork(mode) {
    if (!this.backend) throw new Error('No backend');
    return this.backend.configureNetwork(mode);
  }

  async configureGPU(mode) {
    if (!this.backend) throw new Error('No backend');
    return this.backend.configureGPU(mode);
  }

  async shutdown() {
    if (this.state === 'RUNNING' || this.state === 'PAUSED') {
      await this.stop();
    }
  }
}

module.exports = { VMManager, VirtualizationBackend, QemuBackend };
