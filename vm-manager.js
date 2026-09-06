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

    const args = this.buildQemuArgs(config, portInfo.vncDisplayIndex);
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
          const launchError = stderrOutput.trim();
          this.vmState = 'STOPPED';
          this.vmPid = null;
          this.displayInfo = null;
          this.vncProxy.stop();
          this.logManager?.info(`QEMU exited with code ${code}`, 'vm');
          if (!startupComplete) {
            failStartup(new Error(
              `QEMU exited before the VM display was ready (code ${code}).${launchError ? ` ${launchError}` : ''}`
            ));
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
      // High-performance Multi-threaded TCG execution with 512MB JIT translation block cache
      args.push('-accel', 'tcg,thread=multi,tb-size=512');
      let cpuModel = config.cpuModel && config.cpuModel !== 'auto' ? config.cpuModel : 'max';
      if (cpuModel === 'host' || cpuModel === 'max') {
        args.push('-cpu', 'Haswell-v4,+invtsc,+pcid,+ssse3,+sse4.1,+sse4.2,+popcnt,+avx,+avx2,+fma,+bmi1,+bmi2,+movbe,+f16c,+rdrand,+fsgsbase,+smep,+erms');
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
    // HPET timer for Windows (better than PIT)
    args.push('-global', 'hpet.enabled=yes');
    // Disable PIT (legacy timer) to reduce interrupts
    args.push('-global', 'pit.enabled=no');

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
    if (config.disk && config.disk.physicalDrive !== undefined) {
      // Physical drive passthrough - use VirtIO SCSI for better performance
      args.push('-drive', `file=\\\\.\\PhysicalDrive${config.disk.physicalDrive},format=raw,if=none,id=hd0,cache=writeback,discard=unmap,aio=threads`);
      args.push('-device', 'virtio-scsi-pci,id=scsi0');
      args.push('-device', 'scsi-hd,drive=hd0,bus=scsi0.0,bootindex=1');
    } else {
      diskPath = (config.disk && config.disk.imagePath);
      if (!diskPath) {
        const storageDir = this.settingsManager?.get('vm.storageDir') || path.join(os.homedir(), 'BootForge', 'disks');
        diskPath = path.join(storageDir, 'windows-vm.qcow2');
      }
      if (!fs.existsSync(diskPath)) {
        try { fs.mkdirSync(path.dirname(diskPath), { recursive: true }); } catch {}
      }
      // VirtIO block device for maximum disk performance
      // cache=writeback: host page cache used, data written asynchronously
      // discard=unmap: TRIM support for qcow2
      // aio=threads: async I/O with thread pool
      args.push('-drive', `file=${diskPath},format=qcow2,if=none,id=hd0,cache=writeback,discard=unmap,aio=threads,detect-zeroes=on`);
      args.push('-device', 'virtio-blk-pci,drive=hd0,bootindex=1,iothread=iothread0');
      // Dedicated I/O thread for disk
      args.push('-object', 'iothread,id=iothread0');
    }

    // 8. Boot Order Configuration
    const isDirectDiskBoot = config.bootMode === 'disk' || !resolvedIso || !fs.existsSync(resolvedIso);

    if (isDirectDiskBoot) {
      // Primary boot from the virtual disk where Windows is installed
      // Already configured via bootindex=1 on virtio-blk-pci
      if (resolvedIso && fs.existsSync(resolvedIso)) {
        args.push('-drive', `file=${resolvedIso},media=cdrom,readonly=on,if=none,id=cd0`);
        args.push('-device', 'virtio-scsi-pci,id=scsi1');
        args.push('-device', 'scsi-cd,drive=cd0,bus=scsi1.0,bootindex=2');
      }
    } else {
      // Primary boot from ISO (Installer mode), disk as secondary target
      args.push('-drive', `file=${resolvedIso},media=cdrom,readonly=on,if=none,id=cd0`);
      args.push('-device', 'virtio-scsi-pci,id=scsi1');
      args.push('-device', 'scsi-cd,drive=cd0,bus=scsi1.0,bootindex=1');
      // Disk already has bootindex=1, but ISO takes priority
    }

    // 9. Network - VIRTIO for performance (requires Windows VirtIO driver)
    args.push('-netdev', 'user,id=net0,hostfwd=tcp::2222-:22,hostfwd=tcp::3389-:3389');
    args.push('-device', 'virtio-net-pci,netdev=net0,mac=52:54:00:12:34:56');

    // 10. Display & Virtual GPU
    const vgaType = config.vga || 'qxl';
    if (vgaType === 'qxl') {
      // QXL with SPICE would be better but we use VNC
      // Optimal QXL settings for VNC
      args.push('-device', 'qxl-vga,vram_size_mb=128,vgamem_mb=64,ram_size_mb=128,vram64_size_mb=128');
      // Enable QXL rendering commands for better 2D performance
      args.push('-global', 'qxl-vga.ram_size=134217728');
      args.push('-global', 'qxl-vga.vram_size=67108864');
      args.push('-global', 'qxl-vga.vram64_size=134217728');
    } else if (vgaType === 'virtio') {
      // virtio-gpu with virgl 3D acceleration (requires host OpenGL + guest driver)
      // For now, use 2D only which works well with VNC
      args.push('-device', 'virtio-vga-gl,xres=1920,yres=1080');
      // Note: -display sdl,gl=on would enable 3D but requires SDL display
    } else {
      args.push('-device', 'VGA,vgamem_mb=64');
    }

    args.push('-display', 'none');
    // VNC with better encoding for performance
    args.push('-vnc', `127.0.0.1:${vncDisplayIndex},websocket=off,to=100`);

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
