const { app } = require('electron');
const fs = require('fs');
const path = require('path');

class LogManager {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.logs = [];
    this.maxLogs = 10000;
    this.logDir = path.join(app.getPath('userData'), 'logs');
    this.logFile = path.join(this.logDir, `bootforge-${new Date().toISOString().split('T')[0]}.log`);
    this.subscribers = new Set();
  }

  async initialize() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    await this.rotateLogs();
    this.startPeriodicRotation();
  }

  async rotateLogs() {
    const files = fs.readdirSync(this.logDir).filter(f => f.startsWith('bootforge-') && f.endsWith('.log'));
    const today = new Date().toISOString().split('T')[0];
    const currentFile = path.join(this.logDir, `bootforge-${today}.log`);

    if (this.logFile !== currentFile) {
      this.logFile = currentFile;
    }

    if (files.length > 30) {
      files.sort().slice(0, files.length - 30).forEach(f => {
        fs.unlinkSync(path.join(this.logDir, f));
      });
    }
  }

  startPeriodicRotation() {
    setInterval(() => this.rotateLogs(), 60 * 60 * 1000);
  }

  formatMessage(level, source, message, meta = {}) {
    const timestamp = new Date().toISOString();
    return {
      timestamp,
      level,
      source,
      message,
      meta,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    };
  }

  write(level, source, message, meta = {}) {
    const entry = this.formatMessage(level, source, message, meta);
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    const logLine = `[${entry.timestamp}] [${level.toUpperCase()}] [${source}] ${message}${meta ? ' ' + JSON.stringify(meta) : ''}\n`;
    fs.appendFileSync(this.logFile, logLine);

    this.notifySubscribers(entry);

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('log:new', entry);
    }

    return entry;
  }

  info(source, message, meta) {
    return this.write('info', source, message, meta);
  }

  warn(source, message, meta) {
    return this.write('warn', source, message, meta);
  }

  error(source, message, meta) {
    return this.write('error', source, message, meta);
  }

  debug(source, message, meta) {
    return this.write('debug', source, message, meta);
  }

  notifySubscribers(entry) {
    this.subscribers.forEach(callback => {
      try {
        callback(entry);
      } catch (e) {
        console.error('Log subscriber error:', e);
      }
    });
  }

  subscribe(callback) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  getLogs(filter = {}) {
    let result = [...this.logs];

    if (filter.level) {
      result = result.filter(l => l.level === filter.level);
    }
    if (filter.source) {
      result = result.filter(l => l.source === filter.source);
    }
    if (filter.since) {
      result = result.filter(l => new Date(l.timestamp) >= new Date(filter.since));
    }
    if (filter.limit) {
      result = result.slice(-filter.limit);
    }

    return result;
  }

  clearLogs() {
    this.logs = [];
    if (fs.existsSync(this.logFile)) {
      fs.writeFileSync(this.logFile, '');
    }
  }

  async shutdown() {
    this.subscribers.clear();
  }
}

module.exports = { LogManager };