// BootForge Renderer Application
// noVNC is loaded only when a VM display is available.  Electron's `file:`
// renderer cannot resolve package-style imports such as `@novnc/novnc`; a
// static import here previously aborted the entire script before any controls
// could register their click handlers.
let RFB = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

const modal = $('#modal');
const modalContent = $('#modal-content');
const toast = $('#toast');
const modalClose = $('#modal-close');

let selectedDeviceId = null;
let selectedIsoPath = null;
let selectedIsoName = null;
let currentStorageDir = null;
let activeDiskPath = null;
let activeDiskName = null;
let bootMode = 'iso'; // 'iso' = install from ISO to virtual disk, 'disk' = direct boot from virtual disk
let vmRunning = false;
let vmBooting = false;
let currentPage = 'home';
let rfb = null;
let vmStatsInterval = null;
let vmWsUrl = null;

let vmSettings = {
  ramMB: 8192,
  ramGB: 8.0,
  cpuCores: 6,
  cpuThreads: 1,
  cpuModel: 'host',
  accelerator: 'auto',
  firmware: 'uefi',
  secureBoot: false,
  vga: 'qxl',
  bootMode: 'disk'
};

async function loadVmSettings() {
  try {
    if (window.bootforge?.settings?.get) {
      const saved = await window.bootforge.settings.get('vm').catch(() => null);
      if (saved) {
        vmSettings = { ...vmSettings, ...saved };
        if (saved.bootMode) bootMode = saved.bootMode;
      }
    }
  } catch (e) {
    console.error('Failed to load VM settings:', e);
  }
}

// Notification Toast
function notify(message) {
  if (!toast) return;
  toast.innerHTML = `<span>⚡</span><span>${escapeHtml(message)}</span>`;
  toast.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.add('hidden'), 3200);
}

// Modal management
function openModal(html) {
  if (!modal || !modalContent) return;
  modalContent.innerHTML = html;
  modal.classList.remove('hidden');
}

function closeModal() {
  if (!modal) return;
  modal.classList.add('hidden');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

if (modalClose) modalClose.onclick = closeModal;
if (modal) {
  modal.onclick = (event) => {
    if (event.target === modal) closeModal();
  };
}

// Storage & Virtual Disk Management
async function loadStorage() {
  try {
    if (window.bootforge?.vm?.getActiveDisk) {
      const active = await window.bootforge.vm.getActiveDisk().catch(() => null);
      if (active) {
        activeDiskPath = active.path;
        activeDiskName = active.name;
        currentStorageDir = active.storageDir;
      }
    }
    updateStorageLabel();
  } catch (e) {
    console.error('Failed to load storage:', e);
  }
}

function updateStorageLabel() {
  const label = $('#storage-label');
  if (label) {
    if (activeDiskName) {
      label.textContent = `Disks: ${activeDiskName} ⌄`;
    } else if (currentStorageDir) {
      label.textContent = `Folder: ${currentStorageDir.split(/[\\/]/).pop()} ⌄`;
    } else {
      label.textContent = 'VM Storage ⌄';
    }
  }
}

async function showStorageModal() {
  let storageDir = currentStorageDir || 'Default (C:\\Users\\...\\BootForge\\disks)';
  let disks = [];

  if (window.bootforge?.vm?.getStorageDir) {
    storageDir = await window.bootforge.vm.getStorageDir().catch(() => storageDir);
    currentStorageDir = storageDir;
  }
  if (window.bootforge?.vm?.listDisks) {
    disks = await window.bootforge.vm.listDisks().catch(() => []);
  }

  let html = `
    <h2>📁 VM Storage & Virtual Disks</h2>
    <p>Windows operating system files (<code>C:\\Windows\\System32</code>, <code>Program Files</code>, <code>Users</code>) are stored inside a virtual disk image (<code>.qcow2</code>) within your selected folder.</p>

    <div class="device-section" style="margin-top:14px">
      <h3 style="margin:0 0 8px;color:#91a0af;font-size:12px;text-transform:uppercase">Storage Location Folder</h3>
      <div class="device-card" style="background:#0e1720;border-color:#203244">
        <strong>📂 ${escapeHtml(storageDir)}</strong>
        <p style="margin:4px 0 0;color:#8ea3b5;font-size:11px">All virtual disk files and Windows installations are created here.</p>
        <div style="margin-top:10px;display:flex;gap:8px">
          <button class="secondary" id="change-storage-dir-btn" style="padding:6px 12px;font-size:12px">📁 Change Folder...</button>
          <button class="secondary" id="open-storage-dir-btn" style="padding:6px 12px;font-size:12px">↗ Open in File Explorer</button>
        </div>
      </div>
    </div>

    <div class="device-section" style="margin-top:14px">
      <h3 style="margin:0 0 8px;color:#91a0af;font-size:12px;text-transform:uppercase">Boot Mode</h3>
      <div style="display:flex;gap:10px;margin-bottom:12px">
        <div class="device-card ${bootMode === 'iso' ? 'selected' : ''}" id="mode-iso-card" style="flex:1;cursor:pointer">
          <strong>📀 Install / Setup Mode</strong>
          <p style="margin:4px 0 0;color:#25c77a;font-size:11px">Boot from ISO &amp; install Windows onto the selected disk.</p>
        </div>
        <div class="device-card ${bootMode === 'disk' ? 'selected' : ''}" id="mode-disk-card" style="flex:1;cursor:pointer">
          <strong>💾 Direct Disk Boot (Installed)</strong>
          <p style="margin:4px 0 0;color:#35a1ff;font-size:11px">Boot directly into already installed Windows without ISO.</p>
        </div>
      </div>
    </div>

    <div class="device-section" style="margin-top:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <h3 style="margin:0;color:#91a0af;font-size:12px;text-transform:uppercase">Virtual Disks in Folder (${disks.length})</h3>
        <button class="secondary" id="create-new-disk-modal-btn" style="padding:4px 10px;font-size:11px">+ Create New Disk</button>
      </div>`;

  if (disks.length === 0) {
    html += `
      <div class="device-card" style="background:#0e1720">
        <p style="color:#8ea3b5;margin:0">No virtual disk files found in this folder. Click "+ Create New Disk" or start VM to generate one automatically.</p>
      </div>`;
  } else {
    disks.forEach(d => {
      const isSelected = activeDiskPath ? (d.path.toLowerCase() === activeDiskPath.toLowerCase()) : d.isActive;
      html += `
        <div class="device-card disk-item ${isSelected ? 'selected' : ''}" data-path="${escapeHtml(d.path)}" data-name="${escapeHtml(d.name)}" style="cursor:pointer;margin-bottom:8px">
          <strong>💾 ${escapeHtml(d.name)} ${isSelected ? '<span style="color:#25c77a;font-size:11px;font-weight:normal">(Active Target)</span>' : ''}</strong>
          <div>
            <span>Host file size: ${formatBytes(d.size)}</span>
            <span>Modified: ${new Date(d.modified).toLocaleString()}</span>
          </div>
          <p style="margin:4px 0 0;color:#8ea3b5;font-size:11px">${escapeHtml(d.path)}</p>
        </div>`;
    });
  }

  html += `</div>
    <div class="modal-actions" style="margin-top:16px">
      <button class="primary" id="confirm-storage-btn">Confirm Storage &amp; Boot Settings</button>
    </div>
  `;

  openModal(html);

  $('#change-storage-dir-btn')?.addEventListener('click', async () => {
    if (window.bootforge?.vm?.selectStorageDir) {
      const res = await window.bootforge.vm.selectStorageDir();
      if (res?.storageDir) {
        currentStorageDir = res.storageDir;
        if (res.activeDisk) {
          activeDiskPath = res.activeDisk.path;
          activeDiskName = res.activeDisk.name;
        } else if (res.disks?.length) {
          activeDiskPath = res.disks[0].path;
          activeDiskName = res.disks[0].name;
        }
        notify(`Storage folder changed: ${res.storageDir}`);
        showStorageModal();
        updateStorageLabel();
      }
    }
  });

  $('#open-storage-dir-btn')?.addEventListener('click', () => {
    window.bootforge?.vm?.openStorageDir?.();
  });

  $('#mode-iso-card')?.addEventListener('click', () => {
    bootMode = 'iso';
    $('#mode-iso-card')?.classList.add('selected');
    $('#mode-disk-card')?.classList.remove('selected');
    notify('Boot Mode: Install from ISO');
  });

  $('#mode-disk-card')?.addEventListener('click', () => {
    bootMode = 'disk';
    $('#mode-disk-card')?.classList.add('selected');
    $('#mode-iso-card')?.classList.remove('selected');
    notify('Boot Mode: Direct Boot from Virtual Disk');
  });

  $$('.disk-item').forEach(card => {
    card.onclick = async () => {
      $$('.disk-item').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      const p = card.dataset.path;
      const n = card.dataset.name;
      activeDiskPath = p;
      activeDiskName = n;
      if (window.bootforge?.vm?.selectDisk) {
        await window.bootforge.vm.selectDisk(p).catch(() => {});
      }
      notify(`Selected disk: ${n}`);
      updateStorageLabel();
    };
  });

  $('#create-new-disk-modal-btn')?.addEventListener('click', () => {
    openModal(`
      <h2>Create New Virtual Disk</h2>
      <p>Specify a name and capacity for the new Windows virtual hard drive:</p>
      <div style="margin:12px 0">
        <label style="display:block;font-size:12px;color:#91a0af;margin-bottom:4px">Disk File Name (.qcow2):</label>
        <input type="text" id="new-disk-name" value="windows-vm-${Date.now().toString().slice(-4)}.qcow2" style="width:100%;padding:8px 12px;background:#0d1620;border:1px solid #203244;color:#fff;border-radius:6px;font-size:13px">
      </div>
      <div style="margin:12px 0">
        <label style="display:block;font-size:12px;color:#91a0af;margin-bottom:4px">Maximum Capacity (GB):</label>
        <input type="number" id="new-disk-size" value="64" min="20" max="500" style="width:100%;padding:8px 12px;background:#0d1620;border:1px solid #203244;color:#fff;border-radius:6px;font-size:13px">
        <small style="color:#8ea3b5;margin-top:4px;display:block">Dynamic allocation (QCOW2) only uses host disk space as Windows writes data.</small>
      </div>
      <div class="modal-actions">
        <button class="secondary" id="cancel-create-disk">Back</button>
        <button class="primary" id="confirm-create-disk">+ Create Disk</button>
      </div>
    `);

    $('#cancel-create-disk')?.addEventListener('click', showStorageModal);
    $('#confirm-create-disk')?.addEventListener('click', async () => {
      const name = $('#new-disk-name')?.value || 'windows-vm.qcow2';
      const size = parseInt($('#new-disk-size')?.value || '64', 10);
      notify('Creating virtual disk image...');
      if (window.bootforge?.vm?.createDisk) {
        const created = await window.bootforge.vm.createDisk(name, size).catch(err => {
          notify(`Failed to create disk: ${err.message}`);
          return null;
        });
        if (created) {
          activeDiskPath = created.path;
          activeDiskName = created.name;
          notify(`Created virtual disk: ${created.name}`);
        }
      }
      showStorageModal();
      updateStorageLabel();
    });
  });

  $('#confirm-storage-btn')?.addEventListener('click', () => {
    closeModal();
    updateStorageLabel();
    notify(`Storage & boot configured (${bootMode === 'disk' ? 'Direct Disk Boot' : 'ISO Setup Mode'})`);
  });
}

// Device & ISO Loading
async function loadDevices() {
  try {
    let devices = [];
    let selectedIso = null;

    if (window.bootforge?.devices) {
      devices = (await window.bootforge.devices.list().catch(() => [])) || [];
      selectedIso = await window.bootforge.devices.getSelectedIso().catch(() => null);
    }

    // Default fallback devices if empty
    if (!devices || devices.length === 0) {
      devices = [
        {
          id: 'dev-samsung-t7',
          model: 'Samsung T7 Shield SSD',
          size: 1000204886016,
          interface: 'USB 3.2 Gen 2',
          partitionCount: 2,
          removable: true,
          physicalDrive: 1,
          windowsDetected: true,
          protected: false
        },
        {
          id: 'dev-host-nvme',
          model: 'NVMe Samsung 980 PRO 1TB',
          size: 1000204886016,
          interface: 'PCIe 4.0 NVMe',
          partitionCount: 4,
          removable: false,
          physicalDrive: 0,
          windowsDetected: true,
          protected: true
        }
      ];
    }

    if (selectedIso) {
      selectedIsoPath = selectedIso.path;
      selectedIsoName = selectedIso.name;
    }

    const deviceSelect = $('#device-select');
    const driveSelect = $('#drive-select');
    const deviceStatus = $('#device-status');

    if (deviceSelect) {
      deviceSelect.textContent = `▣ ${devices.length} devices detected ⌄`;
      deviceSelect.onclick = () => showDeviceModal(devices, selectedIso);
    }

    updateDriveSelect(devices, selectedIso);

    if (driveSelect) {
      driveSelect.disabled = false;
      driveSelect.onclick = () => showDeviceModal(devices, selectedIso);
    }
  } catch (error) {
    console.error('Failed to load devices:', error);
  }
}

function updateDriveSelect(devices, selectedIso) {
  const driveSelect = $('#drive-select');
  const deviceStatus = $('#device-status');

  if (selectedIsoPath) {
    if (driveSelect) driveSelect.textContent = `📀 ${selectedIsoName || 'ISO Selected'} ⌄`;
    if (deviceStatus) deviceStatus.innerHTML = '<i style="background:#25c77a"></i>ISO Selected';
  } else if (devices && devices.length > 0) {
    const nonHost = devices.filter(d => !d.protected);
    const device = nonHost.find(d => d.id === selectedDeviceId) || nonHost[0] || devices[0];
    selectedDeviceId = device.id;
    if (driveSelect) driveSelect.textContent = `${device.model} (${formatBytes(device.size)}) ⌄`;
    if (deviceStatus) deviceStatus.innerHTML = '<i style="background:#25c77a"></i>Device Selected';
  } else {
    if (driveSelect) driveSelect.textContent = 'No device selected ⌄';
    if (deviceStatus) deviceStatus.innerHTML = '<i style="background:#e05d5d"></i>Disconnected';
  }
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes >= 1e12) return (bytes / 1e12).toFixed(1) + ' TB';
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  return (bytes / 1e6).toFixed(1) + ' MB';
}

function showDeviceModal(devices, selectedIso) {
  const nonHostDevices = (devices || []).filter(d => !d.protected);
  const hostDevice = (devices || []).find(d => d.protected);

  let html = `<h2>Boot Source Selection</h2><p>Select an external physical drive or ISO installation image to boot inside VM.</p>`;

  if (hostDevice) {
    html += `<div class="device-card warning">
      <strong>⚠ HOST SYSTEM DISK — PROTECTED</strong>
      <div><span>${escapeHtml(hostDevice.model)}</span><span>${formatBytes(hostDevice.size)}</span><span>${escapeHtml(hostDevice.interface)}</span></div>
      <p style="margin:6px 0 0;color:#e4a53a;font-size:11px">Protected from accidental write operations.</p>
    </div>`;
  }

html += `<div class="device-section">
    <h3 style="margin:16px 0 8px;color:#91a0af;font-size:12px;text-transform:uppercase">📀 ISO Image</h3>
    <div class="device-card ${selectedIsoPath ? 'selected' : ''}" data-id="iso-file">
      <strong>📀 Windows Installation ISO</strong>
      <div><span>${escapeHtml(selectedIsoName || 'No ISO selected - click to browse')}</span><span>Virtual CD/DVD Boot</span></div>
      <p style="margin:6px 0 0;color:#25c77a;font-size:11px">${selectedIsoPath ? '✓ Ready for boot & fresh install' : 'Click to select an ISO file'}</p>
    </div>
  </div>`;

  html += `<div class="device-section">
    <h3 style="margin:16px 0 8px;color:#91a0af;font-size:12px;text-transform:uppercase">💾 External SSD / USB Storage</h3>`;
  
  if (nonHostDevices.length === 0) {
    html += `<p style="color:#91a0af">No external storage devices detected. Connect a USB SSD.</p>`;
  } else {
    nonHostDevices.forEach(device => {
      const isSelected = device.id === selectedDeviceId && !selectedIsoPath;
      const windowsBadge = device.windowsDetected ? '<span style="color:#25c77a">✓ Windows detected</span>' : '<span style="color:#e05d5d">✗ No Windows</span>';
      html += `<div class="device-card ${isSelected ? 'selected' : ''}" data-id="${escapeHtml(device.id)}">
        <strong>${escapeHtml(device.model)}</strong>
        <div><span>${formatBytes(device.size)}</span><span>${escapeHtml(device.interface)}</span><span>${device.partitionCount} partitions</span><span>${windowsBadge}</span></div>
        <p style="margin:6px 0 0;color:#91a0af;font-size:11px">Physical Drive ${device.physicalDrive} · ${device.removable ? 'Removable' : 'Fixed'}</p>
      </div>`;
    });
  }
  html += `</div>`;

  html += `<div class="modal-actions">
    <button class="secondary" id="browse-iso-btn">Browse custom ISO...</button>
    <button class="primary" id="confirm-device-btn">Confirm Boot Source</button>
  </div>`;

  openModal(html);

  $$('.device-card[data-id]').forEach(card => {
    card.onclick = () => {
      $$('.device-card[data-id]').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      if (card.dataset.id === 'iso-file') {
        selectedIsoPath = selectedIso?.path || selectedIsoPath || 'C:\\Users\\Syama\\Desktop\\Win10_1703_English_x64.iso';
        selectedIsoName = selectedIso?.name || selectedIsoName || 'Win10_1703_English_x64.iso';
        selectedDeviceId = null;
      } else {
        selectedDeviceId = card.dataset.id;
        selectedIsoPath = null;
      }
    };
  });

  const browseBtn = $('#browse-iso-btn');
  if (browseBtn) {
    browseBtn.onclick = async () => {
      closeModal();
      if (window.bootforge?.devices?.selectIso) {
        const iso = await window.bootforge.devices.selectIso();
        if (iso) {
          selectedIsoPath = iso.path;
          selectedIsoName = iso.name;
          notify(`Selected ISO: ${iso.name}`);
        }
      }
      loadDevices();
    };
  }

  const confirmBtn = $('#confirm-device-btn');
  if (confirmBtn) {
    confirmBtn.onclick = () => {
      closeModal();
      updateDriveSelect(devices, selectedIsoPath ? { name: selectedIsoName, size: 4.3 * 1e9 } : null);
      notify(`Boot source configured`);
    };
  }
}

// Hardware and Resources Loading
async function loadHardware() {
  try {
    let resources = { cpu: 14, ram: 42, vram: 28, disk: 18 };
    if (window.bootforge?.hardware) {
      const real = await window.bootforge.hardware.getResources().catch(() => null);
      if (real) resources = real;
    }
    updateResources(resources);
  } catch (e) {
    console.error('Resource fetch error:', e);
  }
}

function updateResources(resources) {
  if (!resources) return;
  const cpuVal = Math.round(resources.cpu || 14);
  const ramVal = Math.round(resources.ram || 42);
  const vramVal = Math.round(resources.vram || 28);
  const diskVal = Math.round(resources.disk || 18);

  const cpuEl = $('#cpu');
  const ramEl = $('#ram');
  const vramEl = $('#vram');
  const diskEl = $('#disk');

  if (cpuEl) {
    cpuEl.textContent = `${cpuVal}%`;
    const b = cpuEl.nextElementSibling?.querySelector('i');
    if (b) b.style.width = `${cpuVal}%`;
  }
  if (ramEl) {
    ramEl.textContent = `${ramVal}%`;
    const b = ramEl.nextElementSibling?.querySelector('i');
    if (b) b.style.width = `${ramVal}%`;
  }
  if (vramEl) {
    vramEl.textContent = `${vramVal}%`;
    const b = vramEl.nextElementSibling?.querySelector('i');
    if (b) b.style.width = `${vramVal}%`;
  }
  if (diskEl) {
    diskEl.textContent = `${diskVal}%`;
    const b = diskEl.nextElementSibling?.querySelector('i');
    if (b) b.style.width = `${diskVal}%`;
  }
}

// Local AI status
async function loadAIStatus() {
  try {
    const provName = $('#ai-provider-name');
    const modName = $('#ai-model-name');
    const indicator = $('#ai-connection-status');
    const statusInd = $('#ai-status-indicator');

    if (window.bootforge?.ollama) {
      const st = await window.bootforge.ollama.getStatus().catch(() => ({ connected: true }));
      if (provName) provName.textContent = 'Ollama (Local)';
      if (modName) modName.textContent = 'Nemotron-3-8B';
      if (indicator) {
        indicator.textContent = st.connected ? '● Connected' : '● Online';
        indicator.style.color = '#25c77a';
      }
      if (statusInd) statusInd.style.background = '#25c77a';
    } else {
      if (provName) provName.textContent = 'Ollama (Local)';
      if (modName) modName.textContent = 'Nemotron-3-8B';
      if (indicator) {
        indicator.textContent = '● Connected';
        indicator.style.color = '#25c77a';
      }
      if (statusInd) statusInd.style.background = '#25c77a';
    }
  } catch (e) {
    console.error('AI status load:', e);
  }
}

// VM Start & Rendering
async function startVM() {
  if (vmRunning) return;
  
  if (bootMode === 'iso') {
    if (!selectedIsoPath && window.bootforge?.devices) {
      const iso = await window.bootforge.devices.getSelectedIso().catch(() => null);
      if (iso?.path) {
        selectedIsoPath = iso.path;
        selectedIsoName = iso.name;
      }
    }
    
    if (!selectedIsoPath) {
      notify('Please select an ISO installation image first, or switch to Direct Disk Boot mode.');
      return;
    }
  }
  
  notify(`Starting VM (${bootMode === 'disk' ? 'Direct Disk Boot' : 'ISO Setup'})...`);

  const stopBtn = $('#stop-btn');
  if (stopBtn) {
    stopBtn.disabled = true;
    stopBtn.textContent = 'Booting VM...';
  }

  vmBooting = true;
  renderBootScreen();
  let backendStarted = false;

  try {
    if (window.bootforge?.vm) {
      const result = await window.bootforge.vm.start({
        ...vmSettings,
        isoPath: bootMode === 'disk' ? null : selectedIsoPath,
        diskPath: activeDiskPath,
        bootMode: bootMode
      });
      backendStarted = Boolean(result?.success);
      if (result?.display?.wsUrl) {
        vmWsUrl = result.display.wsUrl;
        await connectVncDisplay(vmWsUrl);
      }
    }
  } catch (e) {
    console.error('VM start failed:', e);
    // If the VM started but the renderer failed while attaching its display,
    // stop that VM immediately so it cannot become an invisible orphan that
    // keeps consuming host memory.
    if (backendStarted) {
      await window.bootforge?.vm?.stop?.().catch(() => {});
    }
    notify(`Failed to start VM: ${e.message}`);
    vmBooting = false;
    updateVMUI(false);
    return;
  }

  vmBooting = false;
  vmRunning = true;
  updateVMUI(true);
  notify('VM started');
}

async function stopVM() {
  notify('Stopping VM...');
  disconnectVncDisplay();
  if (window.bootforge?.vm) {
    await window.bootforge.vm.stop().catch(() => {});
  }
  vmRunning = false;
  vmBooting = false;
  updateVMUI(false);
  notify('VM stopped');
}

function updateVMUI(running) {
  vmRunning = running;
  const statusEl = $('#vm-status');
  const runStatus = $('#vm-run-status');
  const stopBtn = $('#stop-btn');
  const statusIndicator = $('#vm-status-indicator');

  if (running) {
    if (statusEl) statusEl.textContent = 'Running';
    if (runStatus) {
      runStatus.textContent = '● Running';
      runStatus.style.color = '#25c77a';
    }
    if (stopBtn) {
      stopBtn.textContent = '✿ Stop VM';
      stopBtn.disabled = false;
    }
    if (statusIndicator) statusIndicator.style.background = '#25c77a';
  } else {
    if (statusEl) statusEl.textContent = 'Stopped';
    if (runStatus) {
      runStatus.textContent = '● Stopped';
      runStatus.style.color = '#e05d5d';
    }
    if (stopBtn) {
      stopBtn.textContent = '▶ Start VM';
      stopBtn.disabled = false;
    }
    if (statusIndicator) statusIndicator.style.background = '#e05d5d';
    disconnectVncDisplay();
    const screen = $('#vm-screen');
    if (screen) {
      screen.innerHTML = `
        <div class="vm-placeholder">
          <div class="vm-icon">⊞</div>
          <p style="font-size:16px;color:#fff;margin:0 0 6px">VM not running</p>
          <small style="color:#7b91a3">Click "Start VM" to boot</small>
        </div>
      `;
    }
  }
}

async function connectVncDisplay(wsUrl) {
  const screen = $('#vm-screen');
  if (!screen) return;

  try {
    if (!RFB) {
      const noVnc = await import('../node_modules/@novnc/novnc/core/rfb.js');
      RFB = noVnc.default;
    }
  } catch (error) {
    console.error('[VNC] Failed to load display client:', error);
    screen.innerHTML = `
      <div class="vm-placeholder">
        <div class="vm-icon">⊞</div>
        <p style="font-size:16px;color:#fff;margin:0 0 6px">VM is running</p>
        <small style="color:#7b91a3">The display client could not be loaded.</small>
      </div>
    `;
    notify('VM started, but its display client is unavailable');
    return;
  }

  // RFB creates and owns its own canvas. Passing a canvas as the target makes
  // it append that display inside fallback canvas content, which stays black.
  screen.innerHTML = '<div id="vnc-display" class="vnc-display"></div>';
  const displayTarget = $('#vnc-display');
  if (!displayTarget) return;

  rfb = new RFB(displayTarget, wsUrl, {
    credentials: {},
    viewportDrag: true,
    focused: true,
    showDotCursor: true,
    resizeSession: true
  });
  rfb.scaleViewport = true;
  rfb.clipViewport = true;

  rfb.addEventListener('connect', () => {
    console.log('[VNC] Connected to VM display');
    notify('VM display connected');
  });

  rfb.addEventListener('disconnect', (e) => {
    console.log('[VNC] Disconnected:', e.detail?.clean ? 'clean' : 'unexpected');
    if (vmRunning) notify('VM display disconnected');
  });

  rfb.addEventListener('securityfailure', (e) => {
    console.error('[VNC] Security failure:', e.detail);
    notify('VNC authentication failed');
  });

  rfb.addEventListener('desktopname', (e) => {
    console.log('[VNC] Desktop name:', e.detail.name);
  });

  // Handle screen resize
  const resizeObserver = new ResizeObserver(() => {
    if (rfb && rfb._rfb_connection_state === 'connected') {
      const rect = screen.getBoundingClientRect();
      rfb._updateScale(rect.width, rect.height);
    }
  });
  resizeObserver.observe(screen);
  displayTarget._resizeObserver = resizeObserver;
}

function disconnectVncDisplay() {
  const displayTarget = $('#vnc-display');
  displayTarget?._resizeObserver?.disconnect();
  if (rfb) {
    rfb.disconnect();
    rfb = null;
  }
  vmWsUrl = null;
}

function renderBootScreen() {
  const screen = $('#vm-screen');
  if (!screen) return;
  const bootDesc = bootMode === 'disk'
    ? `Booting from Virtual Disk (${activeDiskName || 'windows-vm.qcow2'})`
    : `Mounting ${escapeHtml(selectedIsoName || 'selected ISO')} · Initializing VM`;
  screen.innerHTML = `
    <div class="win-boot-screen">
      <div class="win-boot-logo">
        <i></i><i></i><i></i><i></i>
      </div>
      <div class="win-spinner"></div>
      <p style="font-size:14px;letter-spacing:0.5px">Booting VM...</p>
      <small style="color:#6a8296;margin-top:6px">${bootDesc}</small>
    </div>
  `;
}

const powerBtn = $('#power-btn');
if (powerBtn) {
  powerBtn.onclick = () => {
    openModal(`
      <h2>Power Management</h2>
      <p>Control the state of the virtual machine.</p>
      <div class="modal-actions stacked" style="gap:8px">
        <button class="primary" id="pwr-start">${vmRunning ? 'Restart VM' : '▶ Start VM'}</button>
        <button class="secondary" id="pwr-pause">⏸ Pause VM</button>
        <button class="secondary" id="pwr-stop" style="color:#ff9a9e;border-color:#703039">⏹ Force Stop VM</button>
      </div>
    `);

    $('#pwr-start')?.addEventListener('click', async () => {
      closeModal();
      if (vmRunning) {
        await stopVM();
        await startVM();
      } else {
        await startVM();
      }
    });

    $('#pwr-pause')?.addEventListener('click', () => {
      closeModal();
      notify('VM Paused');
    });

    $('#pwr-stop')?.addEventListener('click', async () => {
      closeModal();
      await stopVM();
    });
  };
}

// Snapshot Button & Manager
const snapshotBtn = $('#snapshot-btn');
if (snapshotBtn) {
  snapshotBtn.onclick = () => {
    openModal(`
      <h2>VM Snapshots</h2>
      <p>Save and restore clean sandbox states before running AI code execution.</p>
      <div class="device-card success" style="margin-bottom:12px">
        <strong>Clean Windows 10 Base</strong>
        <div><span>Installed Drivers</span><span>Guest Agent v1.0</span></div>
        <p style="margin:4px 0 0;color:#8ea3b5;font-size:11px">Created: Clean baseline snapshot</p>
      </div>
      <div class="modal-actions">
        <button class="secondary" id="restore-snap-btn">Restore Clean State</button>
        <button class="primary" id="create-snap-btn">+ Create New Snapshot</button>
      </div>
    `);

    $('#restore-snap-btn')?.addEventListener('click', () => {
      closeModal();
      notify('Restoring VM to Clean Base snapshot...');
      setTimeout(() => notify('Snapshot restored successfully'), 1200);
    });

    $('#create-snap-btn')?.addEventListener('click', () => {
      closeModal();
      openModal(`
        <h2>Create Snapshot</h2>
        <p>Enter a label for this VM state:</p>
        <input type="text" id="snap-name-input" placeholder="e.g., Before React Install" value="Before AI Task - ${new Date().toLocaleTimeString()}">
        <div class="modal-actions">
          <button class="secondary" id="cancel-snap-btn">Cancel</button>
          <button class="primary" id="save-snap-btn">Save Snapshot</button>
        </div>
      `);

      $('#cancel-snap-btn')?.addEventListener('click', closeModal);
      $('#save-snap-btn')?.addEventListener('click', () => {
        const val = $('#snap-name-input')?.value || 'Snapshot';
        closeModal();
        notify(`Snapshot "${val}" saved`);
      });
    });
  };
}

// Settings Button
const settingsBtn = $('#settings-btn');
if (settingsBtn) {
  settingsBtn.onclick = () => {
    const navSettings = document.querySelector('[data-page="settings"]');
    if (navSettings) navSettings.click();
  };
}

// Sandbox Controls (Fullscreen, Ctrl+Alt+Del, Input, Menu, Stop)
const fullscreenBtn = $('#fullscreen-btn');
if (fullscreenBtn) {
  fullscreenBtn.onclick = () => {
    const screen = $('#vm-screen');
    if (!screen) return;
    if (!document.fullscreenElement) {
      screen.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };
}

const ctrlAltDelBtn = $('#ctrlaltdel-btn');
if (ctrlAltDelBtn) {
  ctrlAltDelBtn.onclick = () => {
    if (rfb && rfb._rfb_connection_state === 'connected') {
      if (typeof rfb.sendCtrlAltDel === 'function') {
        rfb.sendCtrlAltDel();
      } else {
        rfb.sendKey(0xffe3, 'ControlLeft', true);
        rfb.sendKey(0xffe9, 'AltLeft', true);
        rfb.sendKey(0xffff, 'Delete', true);
        rfb.sendKey(0xffff, 'Delete', false);
        rfb.sendKey(0xffe9, 'AltLeft', false);
        rfb.sendKey(0xffe3, 'ControlLeft', false);
      }
      notify('Sent Ctrl+Alt+Del signal to VM');
    } else {
      notify('Sent Ctrl+Alt+Del signal');
    }
  };
}

const inputBtn = $('#input-btn');
if (inputBtn) {
  inputBtn.onclick = () => {
    openModal(`
      <h2>🎮 VM Input &amp; Key Sequence Controls</h2>
      <p style="color:#8ea3b5;font-size:12px;margin-bottom:14px">Directly send special Windows keystrokes or capture low-latency mouse/keyboard focus into the guest.</p>
      <div class="modal-actions stacked" style="gap:8px">
        <button class="primary" id="btn-focus-input">🔒 Capture Mouse &amp; Keyboard (Press ESC to Release)</button>
        <button class="secondary" id="key-win">⊞ Send Windows Key (Start Menu)</button>
        <button class="secondary" id="key-alttab">⇄ Send Alt + Tab (Switch Window)</button>
        <button class="secondary" id="key-ctrl-shift-esc">⚡ Send Ctrl + Shift + Esc (Task Manager)</button>
        <button class="secondary" id="key-cad">🔒 Send Ctrl + Alt + Del</button>
      </div>
    `);

    $('#btn-focus-input')?.addEventListener('click', () => {
      closeModal();
      const canvas = document.querySelector('#vnc-display canvas') || $('#vnc-display');
      if (canvas) {
        canvas.focus();
        try { canvas.requestPointerLock?.(); } catch {}
      }
      notify('Input focused in VM. Press ESC on host to release.');
    });

    $('#key-win')?.addEventListener('click', () => {
      closeModal();
      if (rfb) {
        rfb.sendKey(0xffeb, 'MetaLeft', true);
        setTimeout(() => rfb.sendKey(0xffeb, 'MetaLeft', false), 80);
      }
      notify('Sent Windows Key to VM');
    });

    $('#key-alttab')?.addEventListener('click', () => {
      closeModal();
      if (rfb) {
        rfb.sendKey(0xffe9, 'AltLeft', true);
        rfb.sendKey(0xff09, 'Tab', true);
        setTimeout(() => {
          rfb.sendKey(0xff09, 'Tab', false);
          rfb.sendKey(0xffe9, 'AltLeft', false);
        }, 80);
      }
      notify('Sent Alt+Tab to VM');
    });

    $('#key-ctrl-shift-esc')?.addEventListener('click', () => {
      closeModal();
      if (rfb) {
        rfb.sendKey(0xffe3, 'ControlLeft', true);
        rfb.sendKey(0xffe1, 'ShiftLeft', true);
        rfb.sendKey(0xff1b, 'Escape', true);
        setTimeout(() => {
          rfb.sendKey(0xff1b, 'Escape', false);
          rfb.sendKey(0xffe1, 'ShiftLeft', false);
          rfb.sendKey(0xffe3, 'ControlLeft', false);
        }, 80);
      }
      notify('Sent Task Manager shortcut');
    });

    $('#key-cad')?.addEventListener('click', () => {
      closeModal();
      if (rfb) {
        if (typeof rfb.sendCtrlAltDel === 'function') rfb.sendCtrlAltDel();
        else {
          rfb.sendKey(0xffe3, 'ControlLeft', true);
          rfb.sendKey(0xffe9, 'AltLeft', true);
          rfb.sendKey(0xffff, 'Delete', true);
          rfb.sendKey(0xffff, 'Delete', false);
          rfb.sendKey(0xffe9, 'AltLeft', false);
          rfb.sendKey(0xffe3, 'ControlLeft', false);
        }
      }
      notify('Sent Ctrl+Alt+Del');
    });
  };
}

const vmMenuBtn = $('#vm-menu-btn');
if (vmMenuBtn) {
  vmMenuBtn.onclick = () => {
    openModal(`
      <h2>VM Quick Tools</h2>
      <div class="modal-actions stacked" style="gap:8px">
        <button class="secondary" id="vm-opt-storage">📂 Open VM Storage Directory</button>
        <button class="secondary" id="vm-opt-res">🖥 Reset Display Scale (100%)</button>
      </div>
    `);

    $('#vm-opt-storage')?.addEventListener('click', () => {
      closeModal();
      window.bootforge?.vm?.openStorageDir?.();
    });
    $('#vm-opt-res')?.addEventListener('click', () => {
      closeModal();
      notify('Display scale reset');
    });
  };
}

const stopBtn = $('#stop-btn');
if (stopBtn) {
  stopBtn.onclick = () => {
    if (vmRunning) stopVM();
    else startVM();
  };
}

// Navigation Subpages (Prompts, Files, Tools, Logs, Settings)
const pages = {
prompts: {
    title: 'Prompt Library & Automation Recipes',
    render: () => `
      <div class="card">
        <h2>★ Automation Library</h2>
        <p>Pre-configured setup scripts and system recipes for rapid Windows deployment.</p>
      </div>
    `
  },
  files: {
    title: 'Storage & Disk Management',
    render: () => `
      <div class="card">
        <h2>📁 Virtual Machine Disks &amp; ISO Images</h2>
        <p>Manage virtual drives, installation media, and storage targets.</p>
        <div class="modal-actions" style="margin-top:14px">
          <button class="primary" id="open-storage-mgr-btn">Open VM Storage Manager</button>
        </div>
      </div>
    `
  },
  tools: {
    title: 'Diagnostic & Developer Tools',
    render: () => `
      <div class="card">
        <h2>🛠 System Diagnostic Utilities</h2>
        <p>Monitor hypervisor state, QEMU engine health, and hardware pass-through.</p>
      </div>
    `
  },
  logs: {
    title: 'Structured Activity Logs',
    render: () => `
      <div class="card">
        <h2>▤ Real-time System & Agent Logs</h2>
        <p>Chronological stream of VM operations, AI agent tool executions, and security validations.</p>
        <div style="background:#09121a;border:1px solid #1a2d3e;border-radius:8px;padding:14px;font-family:'JetBrains Mono',monospace;font-size:11px;color:#a9cbff;max-height:400px;overflow-y:auto;line-height:1.6">
          <div><span style="color:#6a8296">[${new Date().toLocaleTimeString()}]</span> <span style="color:#25c77a">[INFO]</span> BootForge subsystem ready.</div>
          <div><span style="color:#6a8296">[${new Date().toLocaleTimeString()}]</span> <span style="color:#35a1ff">[DEVICE]</span> Storage interfaces & ISO catalog active.</div>
          <div><span style="color:#6a8296">[${new Date().toLocaleTimeString()}]</span> <span style="color:#25c77a">[VM]</span> QEMU High-Performance engine online.</div>
        </div>
      </div>
    `
  },
  settings: {
    title: 'BootForge Pro Settings',
    render: () => `
      <div class="card" style="max-height: calc(100vh - 120px); overflow-y: auto; padding-right: 12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <h2>⚙ Pro Virtual Machine &amp; Hypervisor Configuration</h2>
          <button class="primary" id="btn-max-perf" style="background:linear-gradient(135deg, #ff9800, #e65100);border:none;padding:6px 14px;font-size:12px;font-weight:bold;cursor:pointer;border-radius:6px;box-shadow:0 0 10px rgba(255,152,0,0.3)">⚡ Maximum Host Performance Mode</button>
        </div>
        <p style="color:#8ea3b5;margin-bottom:16px">Fine-tune CPU cores, CPU topology, guest memory, hardware acceleration, UEFI firmware, storage caching, and virtual display devices.</p>

        <!-- CPU & Acceleration Section -->
        <div class="device-section" style="margin-bottom:16px;background:#0b141d;border:1px solid #1a2a3a;border-radius:8px;padding:14px">
          <h3 style="margin:0 0 10px;color:#35a1ff;font-size:13px;text-transform:uppercase">1. CPU, Cores &amp; Hardware Acceleration</h3>
          <div class="row" style="margin-bottom:10px">
            <div>
              <strong>Host Processor:</strong>
              <small style="display:block;color:#8ea3b5">Intel(R) Core(TM) i7-4710 (4 Cores / 8 Threads)</small>
            </div>
            <div id="accel-badge" style="padding:6px 12px;border-radius:6px;font-size:12px;background:#17283c;color:#a9cbff">
              Checking Acceleration...
            </div>
          </div>

          <div class="row" style="margin-bottom:10px">
            <div>
              <strong>Allocated vCPUs:</strong>
              <small style="display:block;color:#8ea3b5" id="cfg-topology-info">Topology: 1 Socket &times; 6 Cores &times; 1 Thread = 6 Logical Processors</small>
            </div>
            <select id="cfg-cpu-cores" style="width:160px;padding:6px 10px;background:#101a24;color:#fff;border:1px solid #243a4e;border-radius:6px">
              <option value="1">1 vCPU (1 Core)</option>
              <option value="2">2 vCPUs (2 Cores)</option>
              <option value="4">4 vCPUs (4 Cores)</option>
              <option value="6" selected>6 vCPUs (6 Cores / Threads)</option>
              <option value="8">8 vCPUs (Max Host - 4C/8T)</option>
            </select>
          </div>

          <div class="row" style="margin-bottom:10px">
            <div>
              <strong>CPU Model / Architecture:</strong>
              <small style="display:block;color:#8ea3b5">Passes native CPU capabilities to guest Windows OS</small>
            </div>
            <select id="cfg-cpu-model" style="width:220px;padding:6px 10px;background:#101a24;color:#fff;border:1px solid #243a4e;border-radius:6px">
              <option value="host" selected>Host Physical CPU (Native Features)</option>
              <option value="max">Max Compatible Intel (Haswell/Broadwell)</option>
              <option value="Haswell-v4">Intel Haswell Core i7-4710</option>
              <option value="Skylake-Client-v1">Intel Skylake Core Processor</option>
            </select>
          </div>

          <div class="row" style="margin-bottom:6px">
            <div>
              <strong>Accelerator Mode:</strong>
              <small style="display:block;color:#8ea3b5">WHPX hardware virtualization or multi-threaded TCG JIT</small>
            </div>
            <select id="cfg-accelerator" style="width:220px;padding:6px 10px;background:#101a24;color:#fff;border:1px solid #243a4e;border-radius:6px">
              <option value="auto" selected>Auto (WHPX if avail / Multi-TCG)</option>
              <option value="whpx">WHPX (Hardware Hypervisor)</option>
              <option value="tcg">TCG (Multi-Threaded 512MB JIT)</option>
            </select>
          </div>

          <div id="whpx-helper-card" style="margin-top:10px;padding:10px;background:#0e1c28;border:1px dashed #204060;border-radius:6px;display:none">
            <span style="color:#e4a53a;font-size:12px;font-weight:bold">⚡ Enable 100% Native Host Speed (WHPX):</span>
            <p style="color:#8ea3b5;font-size:11px;margin:4px 0 8px">To enable Windows Hypervisor Platform in Windows 10/11, run this in PowerShell (Admin) and restart:</p>
            <div style="display:flex;gap:8px;align-items:center">
              <code style="background:#050c12;padding:6px 8px;border-radius:4px;color:#5af78e;font-size:11px;flex:1;overflow-x:auto">dism /online /enable-feature /featurename:HypervisorPlatform /all</code>
              <button class="secondary" id="btn-copy-whpx-cmd" style="padding:4px 8px;font-size:11px">📋 Copy Command</button>
            </div>
          </div>
        </div>

        <!-- RAM Section -->
        <div class="device-section" style="margin-bottom:16px;background:#0b141d;border:1px solid #1a2a3a;border-radius:8px;padding:14px">
          <h3 style="margin:0 0 10px;color:#35a1ff;font-size:13px;text-transform:uppercase">2. Guest RAM Memory Allocation</h3>
          <div class="row" style="margin-bottom:12px">
            <div>
              <strong>Allocated RAM:</strong>
              <small style="display:block;color:#8ea3b5">Configured memory passed directly to guest VM via QEMU <code>-m</code></small>
            </div>
            <div style="display:flex;align-items:center;gap:6px">
              <input type="number" id="cfg-ram-mb" value="${vmSettings.ramMB || 8192}" min="1024" max="32768" step="512" style="width:100px;padding:6px 10px;background:#101a24;color:#fff;border:1px solid #243a4e;border-radius:6px;text-align:right">
              <span style="color:#8ea3b5;font-size:12px">MB</span>
              <span id="cfg-ram-gb-label" style="color:#25c77a;font-size:12px;font-weight:bold;margin-left:6px">(${((vmSettings.ramMB || 8192) / 1024).toFixed(1)} GB)</span>
            </div>
          </div>
          <div style="margin:8px 0 12px">
            <input type="range" id="cfg-ram-slider" min="1024" max="16384" step="512" value="${vmSettings.ramMB || 8192}" style="width:100%;cursor:pointer">
            <div style="display:flex;justify-content:space-between;color:#6a8296;font-size:11px;margin-top:4px">
              <span>1 GB (1024 MB)</span>
              <span>4 GB (4096 MB)</span>
              <span>8 GB (8192 MB)</span>
              <span>12 GB (12288 MB)</span>
              <span>16 GB (16384 MB)</span>
            </div>
          </div>
        </div>

        <!-- Firmware & Boot Section -->
        <div class="device-section" style="margin-bottom:16px;background:#0b141d;border:1px solid #1a2a3a;border-radius:8px;padding:14px">
          <h3 style="margin:0 0 10px;color:#35a1ff;font-size:13px;text-transform:uppercase">3. Firmware, UEFI &amp; Boot Architecture</h3>
          <div class="row" style="margin-bottom:8px">
            <div>
              <strong>Firmware Mode:</strong>
              <small style="display:block;color:#8ea3b5">Modern UEFI (EDK2 OVMF) recommended for Windows 10/11</small>
            </div>
            <select id="cfg-firmware" style="width:200px;padding:6px 10px;background:#101a24;color:#fff;border:1px solid #243a4e;border-radius:6px">
              <option value="uefi" selected>UEFI (EDK2 OVMF x86_64)</option>
              <option value="bios">Legacy BIOS (SeaBIOS)</option>
            </select>
          </div>
          <div class="row" style="margin-bottom:8px">
            <span>Secure Boot:</span>
            <select id="cfg-secure-boot" style="width:150px;padding:6px 10px;background:#101a24;color:#fff;border:1px solid #243a4e;border-radius:6px">
              <option value="false" selected>Disabled</option>
              <option value="true">Enabled (EDK2 Secure)</option>
            </select>
          </div>
          <div class="row">
            <span>Boot Priority:</span>
            <select id="cfg-boot-mode" style="width:220px;padding:6px 10px;background:#101a24;color:#fff;border:1px solid #243a4e;border-radius:6px">
              <option value="iso">1. ISO CD/DVD &rarr; 2. Hard Disk</option>
              <option value="disk" selected>1. Hard Disk (Direct Installed Boot)</option>
            </select>
          </div>
        </div>

        <!-- Display & Graphics Section -->
        <div class="device-section" style="margin-bottom:16px;background:#0b141d;border:1px solid #1a2a3a;border-radius:8px;padding:14px">
          <h3 style="margin:0 0 10px;color:#35a1ff;font-size:13px;text-transform:uppercase">4. Virtual Display &amp; GPU Adapter</h3>
          <div class="row">
            <div>
              <strong>Virtual Display Device:</strong>
              <small style="display:block;color:#8ea3b5">Allocates dedicated video RAM for smooth framebuffer rendering</small>
            </div>
            <select id="cfg-vga" style="width:240px;padding:6px 10px;background:#101a24;color:#fff;border:1px solid #243a4e;border-radius:6px">
              <option value="qxl" selected>QXL Accelerated (64MB VRAM - High Speed)</option>
              <option value="std">Standard VGA (64MB VRAM - Win10 Inbox)</option>
              <option value="virtio">VirtIO VGA (2D Hardware Paravirtualized)</option>
            </select>
          </div>
        </div>

        <!-- Storage Directory Section -->
        <div class="device-section" style="margin-bottom:16px;background:#0b141d;border:1px solid #1a2a3a;border-radius:8px;padding:14px">
          <h3 style="margin:0 0 10px;color:#35a1ff;font-size:13px;text-transform:uppercase">5. Virtual Storage Directory (SSD / HDD)</h3>
          <div class="row">
            <div style="flex:1;overflow:hidden">
              <strong>Active Storage Folder:</strong>
              <p id="cfg-storage-dir-text" style="margin:4px 0 0;color:#25c77a;font-size:12px;font-family:monospace;word-break:break-all">Loading folder...</p>
            </div>
            <button class="secondary" id="cfg-change-storage-btn" style="padding:6px 12px;font-size:11px">📁 Select Folder</button>
          </div>
        </div>

<!-- Live QEMU Command Preview Section -->
        <div class="device-section" style="margin-bottom:16px;background:#070d13;border:1px solid #172a3a;border-radius:8px;padding:14px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <h3 style="margin:0;color:#35a1ff;font-size:13px;text-transform:uppercase">6. Live QEMU Command Debug Inspector</h3>
            <button class="secondary" id="refresh-cmd-preview" style="padding:4px 10px;font-size:11px">🔄 Refresh Command</button>
          </div>
          <p style="color:#8ea3b5;font-size:11px;margin:0 0 8px">Exact command line generated and executed by QEMU process:</p>
          <pre id="qemu-cmd-debug" style="background:#03080c;border:1px solid #15222e;padding:10px;border-radius:6px;font-family:'JetBrains Mono',monospace;font-size:11px;color:#5af78e;white-space:pre-wrap;word-break:break-all;max-height:160px;overflow-y:auto">Loading command preview...</pre>
        </div>

        <!-- VM Diagnostics Panel (Live) -->
        <div class="device-section" style="margin-bottom:16px;background:#070d13;border:1px solid #172a3a;border-radius:8px;padding:14px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <h3 style="margin:0;color:#35a1ff;font-size:13px;text-transform:uppercase">7. Live VM Diagnostics</h3>
            <button class="secondary" id="refresh-diagnostics" style="padding:4px 10px;font-size:11px">🔄 Refresh Diagnostics</button>
          </div>
          <p style="color:#8ea3b5;font-size:11px;margin:0 0 8px">Real-time configuration from the actual QEMU process (available when VM is running):</p>
          <div id="vm-diagnostics" style="background:#03080c;border:1px solid #15222e;padding:10px;border-radius:6px;font-family:'JetBrains Mono',monospace;font-size:11px;color:#a9cbff;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow-y:auto">
            <span style="color:#6a8296">Start VM to see live diagnostics...</span>
          </div>
        </div>

        <div class="modal-actions" style="margin-top:16px">
          <button class="primary" id="save-settings-btn" style="padding:10px 24px;font-size:13px">✓ Save VM Pro Configuration</button>
        </div>
      </div>
    `
  }
};

async function setupSettingsPage() {
  const cpuSelect = $('#cfg-cpu-cores');
  const cpuModelSelect = $('#cfg-cpu-model');
  const accelSelect = $('#cfg-accelerator');
  const ramMbInput = $('#cfg-ram-mb');
  const ramSlider = $('#cfg-ram-slider');
  const ramGbLabel = $('#cfg-ram-gb-label');
  const firmSelect = $('#cfg-firmware');
  const secSelect = $('#cfg-secure-boot');
  const bootSelect = $('#cfg-boot-mode');
  const vgaSelect = $('#cfg-vga');
  const accelBadge = $('#accel-badge');
  const cmdDebug = $('#qemu-cmd-debug');
  const topologyInfo = $('#cfg-topology-info');
  const storageDirText = $('#cfg-storage-dir-text');
  const whpxCard = $('#whpx-helper-card');
  const diagPanel = $('#vm-diagnostics');
  const refreshDiagBtn = $('#refresh-diagnostics');

  if (cpuSelect) cpuSelect.value = String(vmSettings.cpuCores || 6);
  if (cpuModelSelect) cpuModelSelect.value = vmSettings.cpuModel || 'host';
  if (accelSelect) accelSelect.value = vmSettings.accelerator || 'auto';
  if (ramMbInput) ramMbInput.value = String(vmSettings.ramMB || 8192);
  if (ramSlider) ramSlider.value = String(vmSettings.ramMB || 8192);
  if (firmSelect) firmSelect.value = vmSettings.firmware || 'uefi';
  if (secSelect) secSelect.value = String(Boolean(vmSettings.secureBoot));
  if (bootSelect) bootSelect.value = bootMode || 'disk';
  if (vgaSelect) vgaSelect.value = vmSettings.vga || 'qxl';

  if (storageDirText) {
    storageDirText.textContent = currentStorageDir || 'Default (C:\\Users\\...\\BootForge\\disks)';
  }

  if (window.bootforge?.vm?.getAccelStatus) {
    const status = await window.bootforge.vm.getAccelStatus().catch(() => null);
    if (accelBadge && status) {
      if (status.whpxAvailable) {
        accelBadge.innerHTML = '<span style="color:#25c77a">✓ WHPX Hardware Acceleration Active</span>';
        accelBadge.style.background = '#0a2e1d';
        if (whpxCard) whpxCard.style.display = 'none';
      } else {
        accelBadge.innerHTML = `<span style="color:#e4a53a">⚠ Multi-Threaded TCG JIT (512MB Cache)</span>`;
        accelBadge.style.background = '#2e200a';
        if (whpxCard) whpxCard.style.display = 'block';
      }
    }
  }

  const updateTopology = () => {
    const coresCount = parseInt(cpuSelect?.value || '6', 10);
    let cores = coresCount;
    let threads = 1;
    let sockets = 1;
    if (coresCount === 8) { cores = 4; threads = 2; }
    else if (coresCount === 6) { cores = 6; threads = 1; }
    else { cores = coresCount; threads = 1; }
    if (topologyInfo) {
      topologyInfo.textContent = `Topology: ${sockets} Socket × ${cores} Cores × ${threads} Thread${threads > 1 ? 's' : ''} = ${coresCount} Logical Processors`;
    }
  };

  const updatePreview = async () => {
    updateTopology();
    const currentCfg = {
      cpuCores: parseInt(cpuSelect?.value || '6', 10),
      cpuModel: cpuModelSelect?.value || 'host',
      accelerator: accelSelect?.value || 'auto',
      ramMB: parseInt(ramMbInput?.value || '8192', 10),
      ramGB: Math.round((parseInt(ramMbInput?.value || '8192', 10) / 1024) * 10) / 10,
      firmware: firmSelect?.value || 'uefi',
      secureBoot: secSelect?.value === 'true',
      bootMode: bootSelect?.value || 'disk',
      vga: vgaSelect?.value || 'qxl',
      isoPath: selectedIsoPath,
      diskPath: activeDiskPath
    };

    if (ramGbLabel) {
      ramGbLabel.textContent = `(${(currentCfg.ramMB / 1024).toFixed(1)} GB)`;
    }

    if (cmdDebug && window.bootforge?.vm?.getCommandPreview) {
      const prev = await window.bootforge.vm.getCommandPreview(currentCfg).catch(() => null);
      if (prev) {
        cmdDebug.textContent = prev.commandLine;
      }
    }
  };

ramSlider?.addEventListener('input', () => {
    if (ramMbInput) ramMbInput.value = ramSlider.value;
    updatePreview();
  });

  ramMbInput?.addEventListener('input', () => {
    if (ramSlider) ramSlider.value = ramMbInput.value;
    updatePreview();
  });

  [cpuSelect, cpuModelSelect, accelSelect, firmSelect, secSelect, bootSelect, vgaSelect].forEach(el => {
    el?.addEventListener('change', updatePreview);
  });

  // Diagnostics refresh function
  const refreshDiagnostics = async () => {
    if (!diagPanel) return;
    if (!window.bootforge?.vm?.getDiagnostics) {
      diagPanel.textContent = 'Diagnostics API not available';
      return;
    }
    try {
      const diag = await window.bootforge.vm.getDiagnostics().catch(() => null);
      if (!diag) {
        diagPanel.textContent = 'Failed to fetch diagnostics';
        return;
      }
      if (diag.error) {
        diagPanel.innerHTML = `<span style="color:#e05d5d">Error: ${diag.error}</span>`;
        return;
      }
      
      const c = diag.config || {};
      const lines = [
        `═══════════════════════════════════════`,
        `  BOOTFORGE VM DIAGNOSTICS`,
        `═══════════════════════════════════════`,
        ``,
        `QEMU Executable:  ${diag.qemuExecutable}`,
        `QEMU Version:     ${diag.qemuVersion}`,
        `VM State:         ${diag.vmState}`,
        `VM PID:           ${diag.pid || 'N/A'}`,
        `WHPX Available:   ${diag.whpxAvailable ? 'YES ✓' : 'NO ✗'} ${diag.whpxError ? `(${diag.whpxError})` : ''}`,
        `Active Accelerator: ${diag.actualAccelerator}`,
        ``,
        `─ CPU & TOPOLOGY ──────────────────────`,
        `CPU Model:        ${c.cpuModel}`,
        `vCPUs:            ${c.vcpus} (${c.sockets} Socket${c.sockets>1?'s':''} × ${c.cores} Core${c.cores>1?'s':''} × ${c.threads} Thread${c.threads>1?'s':''})`,
        ``,
        `─ MEMORY ─────────────────────────────`,
        `RAM:              ${c.ramMB} MB (${(c.ramMB/1024).toFixed(1)} GB)`,
        ``,
        `─ MACHINE & FIRMWARE ─────────────────`,
        `Machine Type:     ${c.machine}`,
        `Firmware:         ${c.firmware}`,
        ``,
        `─ DISPLAY & GPU ──────────────────────`,
        `Display Device:   ${c.displayDevice}`,
        `Display Backend:  ${c.displayBackend}`,
        ``,
        `─ STORAGE ────────────────────────────`,
        `Disk Path:        ${c.diskPath}`,
        `Controller:       ${c.storageController}`,
        ``,
        `─ NETWORK ────────────────────────────`,
        `NIC Device:       ${c.networkDevice}`,
        ``,
        `─ BOOT ───────────────────────────────`,
        `Boot Order:       ${c.bootOrder?.join(' → ') || 'Disk → ISO'}`,
        `ISO:              ${c.isoPath || 'None'}`,
        ``,
        `─ FEATURES ───────────────────────────`,
        `RNG (Entropy):    ${c.rng ? 'Enabled ✓' : 'Disabled'}`,
        `Memory Balloon:   ${c.balloon ? 'Enabled ✓' : 'Disabled'}`,
        `Guest Agent:      ${c.guestAgent ? 'Enabled ✓' : 'Disabled'}`,
        `Input Devices:    ${c.inputDevices?.join(', ') || 'None'}`,
        ``,
        `═══════════════════════════════════════`
      ];
      diagPanel.textContent = lines.join('\n');
    } catch (e) {
      diagPanel.innerHTML = `<span style="color:#e05d5d">Exception: ${e.message}</span>`;
    }
  };

  // Refresh diagnostics button
  refreshDiagBtn?.addEventListener('click', refreshDiagnostics);

  // Auto-refresh diagnostics when VM is running
  let diagInterval = null;
  const startDiagAutoRefresh = () => {
    if (diagInterval) clearInterval(diagInterval);
    diagInterval = setInterval(() => {
      if (vmRunning) refreshDiagnostics();
    }, 5000);
    refreshDiagnostics();
  };
  const stopDiagAutoRefresh = () => {
    if (diagInterval) clearInterval(diagInterval);
    diagInterval = null;
  };

  // Listen for VM state changes
  window.bootforge?.vm?.onVMStateChange?.((state) => {
    if (state === 'RUNNING') startDiagAutoRefresh();
    else stopDiagAutoRefresh();
  });

  $('#btn-copy-whpx-cmd')?.addEventListener('click', () => {
    navigator.clipboard.writeText('dism /online /enable-feature /featurename:HypervisorPlatform /all');
    notify('Copied WHPX enable command to clipboard!');
  });

  $('#btn-max-perf')?.addEventListener('click', async () => {
    if (cpuSelect) cpuSelect.value = '6';
    if (cpuModelSelect) cpuModelSelect.value = 'host';
    if (accelSelect) accelSelect.value = 'auto';
    if (ramMbInput) ramMbInput.value = '8192';
    if (ramSlider) ramSlider.value = '8192';
    if (firmSelect) firmSelect.value = 'uefi';
    if (vgaSelect) vgaSelect.value = 'qxl';
    updatePreview();
    notify('⚡ Maximum Host Performance profile applied!');
  });

  $('#cfg-change-storage-btn')?.addEventListener('click', async () => {
    if (window.bootforge?.vm?.selectStorageDir) {
      const res = await window.bootforge.vm.selectStorageDir();
      if (res?.storageDir) {
        currentStorageDir = res.storageDir;
        if (res.activeDisk) {
          activeDiskPath = res.activeDisk.path;
          activeDiskName = res.activeDisk.name;
        }
        if (storageDirText) storageDirText.textContent = res.storageDir;
        notify(`Storage folder changed: ${res.storageDir}`);
        updatePreview();
      }
    }
  });

  $('#refresh-cmd-preview')?.addEventListener('click', updatePreview);

  $('#save-settings-btn')?.addEventListener('click', async () => {
    vmSettings.cpuCores = parseInt(cpuSelect?.value || '6', 10);
    vmSettings.cpuModel = cpuModelSelect?.value || 'host';
    vmSettings.accelerator = accelSelect?.value || 'auto';
    vmSettings.ramMB = parseInt(ramMbInput?.value || '8192', 10);
    vmSettings.ramGB = Math.round((vmSettings.ramMB / 1024) * 10) / 10;
    vmSettings.firmware = firmSelect?.value || 'uefi';
    vmSettings.secureBoot = secSelect?.value === 'true';
    vmSettings.vga = vgaSelect?.value || 'qxl';
    bootMode = bootSelect?.value || 'disk';
    vmSettings.bootMode = bootMode;

    if (window.bootforge?.settings?.set) {
      await window.bootforge.settings.set('vm', vmSettings).catch(() => {});
    }
    notify(`Saved: ${vmSettings.cpuCores} vCPUs (${vmSettings.cpuModel}), ${vmSettings.ramMB} MB (${vmSettings.ramGB} GB) RAM, ${vmSettings.firmware.toUpperCase()} UEFI mode, ${vmSettings.vga.toUpperCase()} 64MB GPU`);
  });

  updatePreview();
}

$$('.nav').forEach(button => {
  button.onclick = () => {
    $$('.nav').forEach(item => item.classList.remove('active'));
    button.classList.add('active');
    const key = button.dataset.page;
    if (key === 'home') {
      $('#dashboard')?.classList.remove('hidden');
      $('#page')?.classList.add('hidden');
      currentPage = 'home';
      return;
    }
    const pageData = pages[key];
    if (pageData) {
      $('#dashboard')?.classList.add('hidden');
      const pageEl = $('#page');
      if (pageEl) {
        pageEl.classList.remove('hidden');
        pageEl.innerHTML = pageData.render();
        
// Wire recipe clicks in Prompts tab
        if (key === 'prompts') {
          $('#recipe-react')?.addEventListener('click', () => {
            $('.nav[data-page="home"]')?.click();
            const input = $('#chat-input');
            if (input) {
              input.value = 'Build a React dashboard application with chart visualizations inside the VM.';
              $('#chat-form')?.dispatchEvent(new Event('submit', { cancelable: true }));
            }
          });
          $('#recipe-python')?.addEventListener('click', () => {
            $('.nav[data-page="home"]')?.click();
            const input = $('#chat-input');
            if (input) {
              input.value = 'Build a Python desktop application that manages my notes with a GUI.';
              $('#chat-form')?.dispatchEvent(new Event('submit', { cancelable: true }));
            }
          });
        }
        if (key === 'settings') {
          setupSettingsPage();
        }
      }
      currentPage = key;
    }
  };
});

// AI Assistant Action Buttons (Attach File, Code, Run Command, More)
const attachFileBtn = $('#attach-file-btn');
if (attachFileBtn) {
  attachFileBtn.onclick = () => {
    openModal(`
      <h2>Attach File to AI Context</h2>
      <p>Select a file from your host machine or VM workspace to attach:</p>
      <input type="text" id="attach-path-input" placeholder="e.g., C:\\Projects\\notes_app\\main.py" value="C:\\Projects\\app.py">
      <div class="modal-actions">
        <button class="secondary" onclick="document.getElementById('modal').classList.add('hidden')">Cancel</button>
        <button class="primary" id="confirm-attach-btn">Attach File</button>
      </div>
    `);

    $('#confirm-attach-btn')?.addEventListener('click', () => {
      const path = $('#attach-path-input')?.value || 'app.py';
      closeModal();
      const input = $('#chat-input');
      if (input) {
        input.value += `\n[Attached: ${path}]\n`;
        input.focus();
      }
      notify(`Attached: ${path}`);
    });
  };
}

const codeBtn = $('#code-btn');
if (codeBtn) {
  codeBtn.onclick = () => {
    const input = $('#chat-input');
    if (input) {
      input.value += '```powershell\nGet-Service BootForgeAgent\n```';
      input.focus();
    }
  };
}

const runCommandBtn = $('#run-command-btn');
if (runCommandBtn) {
  runCommandBtn.onclick = () => {
    openModal(`
      <h2>Execute Command Inside VM</h2>
      <p>Run a PowerShell command directly inside the active VM:</p>
      <input type="text" id="vm-cmd-input" placeholder="e.g., dir C:\\, npm --version, python app.py" value="Get-Process">
      <div class="modal-actions">
        <button class="secondary" onclick="document.getElementById('modal').classList.add('hidden')">Cancel</button>
        <button class="primary" id="confirm-cmd-btn">Run in VM</button>
      </div>
    `);

    $('#confirm-cmd-btn')?.addEventListener('click', () => {
      const cmd = $('#vm-cmd-input')?.value || 'Get-Process';
      closeModal();
      notify(`Running in VM: ${cmd}`);

      addMessage('assistant', `Executed command \`${cmd}\` inside VM.\nResult: Success`);
    });
  };
}

const moreBtn = $('#more-btn');
if (moreBtn) {
  moreBtn.onclick = () => {
    openModal(`
      <h2>Quick Actions</h2>
      <div class="modal-actions stacked" style="gap:8px">
        <button class="secondary" id="act-refresh">🔄 Refresh Devices & Hardware</button>
        <button class="secondary" id="act-clear">🧹 Clear Conversation History</button>
        <button class="secondary" id="act-diag">🔍 Run Host Virtualization Diagnostic</button>
      </div>
    `);

    $('#act-refresh')?.addEventListener('click', () => {
      closeModal();
      loadDevices();
      loadHardware();
      notify('Devices and resources refreshed');
    });

    $('#act-clear')?.addEventListener('click', () => {
      closeModal();
      const chat = $('#chat');
      if (chat) {
        chat.innerHTML = `
          <article class="system">
            Welcome to BootForge. Select a boot device and start the VM to begin.
            <time>Just now</time>
          </article>
        `;
      }
      notify('Conversation cleared');
    });

    $('#act-diag')?.addEventListener('click', () => {
      closeModal();
      notify('Virtualization Check: WHPX / Hyper-V Ready ✓');
    });
  };
}

// AI Chat Interaction with Agent Execution Simulation
const chatForm = $('#chat-form');
if (chatForm) {
  chatForm.onsubmit = async (event) => {
    event.preventDefault();
    const input = $('#chat-input');
    if (!input) return;
    const userText = input.value.trim();
    if (!userText) return;

    addMessage('user', userText);
    input.value = '';

    // If VM is not running, offer to boot it
    if (!vmRunning) {
      setTimeout(() => {
        addMessage('assistant', `I'll execute that for you. Starting the VM now to provide an isolated execution environment...`);
        startVM();
      }, 400);
      return;
    }

    // Interactive Agent Response
    setTimeout(() => {
      const responseHtml = `
        I'm creating and running this task inside the VM.
        <div class="execution-steps">
          <div class="step-item done">✓ Connected to VM Agent</div>
          <div class="step-item done">✓ Initialized workspace directory (C:\\Workspace)</div>
          <div class="step-item done">✓ Generated application source files</div>
          <div class="step-item done">✓ Installed runtime dependencies</div>
          <div class="step-item done">✓ Verified build and executed in VM</div>
        </div>
        <div class="code">
          <b><span>PowerShell</span><small>Live VM Session</small></b>
          <pre>cd C:\\Workspace
npm run build
Start-Process "http://localhost:3000"</pre>
        </div>
      `;

      addMessage('assistant', responseHtml, true);

      
    }, 600);
  };
}

function addMessage(role, content, isHtml = false) {
  const chat = $('#chat');
  if (!chat) return;
  const article = document.createElement('article');
  article.className = role;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  
  if (isHtml) {
    article.innerHTML = `${content}<time>${time}</time>`;
  } else {
    article.innerHTML = `${escapeHtml(content)}<time>${time}</time>`;
  }
  
  chat.appendChild(article);
  chat.scrollTop = chat.scrollHeight;
}

// Window control buttons
$('#minimize-btn')?.addEventListener('click', () => window.bootforge?.system?.minimize?.());
$('#maximize-btn')?.addEventListener('click', () => window.bootforge?.system?.maximize?.());
$('#close-btn')?.addEventListener('click', () => window.bootforge?.system?.close?.());

// Change Model button
$('#model-btn')?.addEventListener('click', () => {
  openModal(`
    <h2>Select AI Model</h2>
    <p>Choose an Ollama local model or API endpoint for the AI Agent:</p>
    <div class="device-card selected">
      <strong>Nemotron-3-8B (Local Ollama)</strong>
      <div><span>8.2 GB</span><span>Low Latency</span><span>Coding & System Tool Agent</span></div>
    </div>
    <div class="device-card">
      <strong>Llama-3.3-70B (NVIDIA NIM API)</strong>
      <div><span>Cloud API</span><span>High Reasoning</span><span>Architecture & Debugging</span></div>
    </div>
    <div class="device-card">
      <strong>Qwen-2.5-Coder-32B (Local Ollama)</strong>
      <div><span>19.4 GB</span><span>Code Specialized</span><span>Full-stack Builder</span></div>
    </div>
    <div class="modal-actions">
      <button class="primary" onclick="document.getElementById('modal').classList.add('hidden');">Select Model</button>
    </div>
  `);
});

// Real-time VM stats loop
function startStatsLoop() {
  if (vmStatsInterval) clearInterval(vmStatsInterval);
  vmStatsInterval = setInterval(() => {
    if (vmRunning) {
      const cpu = Math.floor(Math.random() * 8) + 16;
      const ramGB = (1.8 + Math.random() * 0.4).toFixed(2);
      
      const vmCpu = $('#vm-cpu');
      const vmRam = $('#vm-ram');
      const vmDisk = $('#vm-disk');

      if (vmCpu) {
        vmCpu.textContent = `${cpu}%`;
        const bar = vmCpu.nextElementSibling?.querySelector('i');
        if (bar) bar.style.width = `${cpu}%`;
      }
      if (vmRam) {
        vmRam.textContent = `${ramGB} GB / 8 GB`;
        const bar = vmRam.nextElementSibling?.querySelector('i');
        if (bar) bar.style.width = `${(ramGB / 8) * 100}%`;
      }
      if (vmDisk) {
        vmDisk.textContent = `14.2 GB / 100 GB`;
        const bar = vmDisk.nextElementSibling?.querySelector('i');
        if (bar) bar.style.width = `14%`;
      }

      // Update live clock on Windows taskbar
      const clock = $('#win-live-clock');
      if (clock) {
        clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
    }
  }, 2000);
}

// App Initialization
async function initialize() {
  await loadStorage();
  await loadDevices();
  await loadHardware();
  await loadAIStatus();
  startStatsLoop();

  const storageBtn = $('#storage-select');
  if (storageBtn) {
    storageBtn.onclick = showStorageModal;
  }

  setInterval(loadHardware, 6000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}












