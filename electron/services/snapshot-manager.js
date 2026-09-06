class SnapshotManager {
  constructor(vmManager, settingsManager, logManager) {
    this.vmManager = vmManager;
    this.settingsManager = settingsManager;
    this.logManager = logManager;
    this.snapshots = new Map();
  }

  async initialize() {
    this.logManager.info('Snapshot manager initialized', 'snapshot');
  }

  async createSnapshot(name, description = '') {
    const backend = this.vmManager.getBackend();
    if (!backend) {
      throw new Error('No VM backend available');
    }

    const snapshotId = `snapshot-${Date.now()}`;
    const snapshot = {
      id: snapshotId,
      name,
      description,
      timestamp: new Date().toISOString(),
      vmState: await this.vmManager.getStatus(),
      vmConfig: this.vmManager.getConfig()
    };

    try {
      await backend.createSnapshot(snapshotId);
      this.snapshots.set(snapshotId, snapshot);
      this.logManager.info('Snapshot created', 'snapshot', snapshot);
      return snapshot;
    } catch (error) {
      this.logManager.error('Snapshot creation failed', 'snapshot', error.message);
      throw error;
    }
  }

  async restoreSnapshot(snapshotId) {
    const backend = this.vmManager.getBackend();
    if (!backend) {
      throw new Error('No VM backend available');
    }

    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) {
      throw new Error('Snapshot not found');
    }

    try {
      await backend.restoreSnapshot(snapshotId);
      this.logManager.info('Snapshot restored', 'snapshot', { snapshotId });
      return { success: true };
    } catch (error) {
      this.logManager.error('Snapshot restore failed', 'snapshot', error.message);
      throw error;
    }
  }

  async deleteSnapshot(snapshotId) {
    const backend = this.vmManager.getBackend();
    if (!backend) {
      throw new Error('No VM backend available');
    }

    try {
      await backend.deleteSnapshot?.(snapshotId);
      this.snapshots.delete(snapshotId);
      this.logManager.info('Snapshot deleted', 'snapshot', { snapshotId });
      return { success: true };
    } catch (error) {
      this.logManager.error('Snapshot deletion failed', 'snapshot', error.message);
      throw error;
    }
  }

  listSnapshots() {
    return Array.from(this.snapshots.values()).sort((a, b) => 
      new Date(b.timestamp) - new Date(a.timestamp)
    );
  }

  getSnapshot(snapshotId) {
    return this.snapshots.get(snapshotId);
  }
}

module.exports = { SnapshotManager };