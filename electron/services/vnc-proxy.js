const net = require('net');
const http = require('http');
const { WebSocketServer } = require('ws');

class VncProxy {
  constructor(logManager) {
    this.logManager = logManager;
    this.wss = null;
    this.httpServer = null;
    this.vncPort = 5900;
    this.wsPort = 6080;
    this.activeSockets = new Set();
    this.activeClients = new Set();
  }

  async findFreePort(startPort) {
    return new Promise((resolve) => {
      const checkPort = (port) => {
        const server = net.createServer();
        server.unref();
        server.on('error', () => {
          checkPort(port + 1);
        });
        server.listen(port, '127.0.0.1', () => {
          server.close(() => resolve(port));
        });
      };
      checkPort(startPort);
    });
  }

  async preparePorts() {
    this.vncPort = await this.findFreePort(5900);
    this.wsPort = await this.findFreePort(6080);
    return {
      vncPort: this.vncPort,
      vncDisplayIndex: this.vncPort - 5900,
      wsPort: this.wsPort,
      wsUrl: `ws://127.0.0.1:${this.wsPort}`
    };
  }

  async waitForVncReady(vncPort, timeoutMs = 30000) {
    const startTime = Date.now();
    this.logManager?.info(`[VM] Waiting for QEMU VNC server on port ${vncPort}...`, 'vm');

    while (Date.now() - startTime < timeoutMs) {
      const isReady = await new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(800);
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('error', () => {
          socket.destroy();
          resolve(false);
        });
        socket.once('timeout', () => {
          socket.destroy();
          resolve(false);
        });
        socket.connect(vncPort, '127.0.0.1');
      });

      if (isReady) {
        this.logManager?.info(`[VM] QEMU VNC server is ready on port ${vncPort}`, 'vm');
        return true;
      }
      await new Promise(r => setTimeout(r, 250));
    }

    throw new Error(`Timeout waiting for QEMU VNC server on port ${vncPort}`);
  }

  async start(vncPort, wsPort) {
    this.vncPort = vncPort || this.vncPort;
    this.wsPort = wsPort || this.wsPort;

    await this.stop();

    return new Promise((resolve, reject) => {
      try {
        this.httpServer = http.createServer();
        this.wss = new WebSocketServer({ server: this.httpServer });

        this.wss.on('connection', (ws, req) => {
          this.logManager?.info(`[VM] Connecting renderer... (Client connected from ${req.socket.remoteAddress || '127.0.0.1'})`, 'vm');
          this.activeClients.add(ws);

          const targetSocket = new net.Socket();
          this.activeSockets.add(targetSocket);

          targetSocket.connect(this.vncPort, '127.0.0.1', () => {
            targetSocket.setNoDelay(true);
            targetSocket.setKeepAlive(true, 1000);
            this.logManager?.info('[VM] Display connected with low-latency TCP_NODELAY', 'vm');
          });

          targetSocket.on('data', (data) => {
            if (ws.readyState === ws.OPEN) {
              ws.send(data, { binary: true });
            }
          });

          targetSocket.on('error', (err) => {
            this.logManager?.warn(`[VM] Target VNC socket error: ${err.message}`, 'vm');
            ws.close();
          });

          targetSocket.on('close', () => {
            this.activeSockets.delete(targetSocket);
            ws.close();
          });

          ws.on('message', (msg) => {
            if (targetSocket.writable) {
              targetSocket.write(msg);
            }
          });

          ws.on('error', (err) => {
            this.logManager?.warn(`[VM] WebSocket error: ${err.message}`, 'vm');
            targetSocket.destroy();
          });

          ws.on('close', () => {
            this.logManager?.info('[VM] Display disconnected', 'vm');
            this.activeClients.delete(ws);
            targetSocket.destroy();
          });
        });

        this.httpServer.listen(this.wsPort, '127.0.0.1', () => {
          this.logManager?.info(`[VM] Display backend ready on ws://127.0.0.1:${this.wsPort}`, 'vm');
          resolve({
            wsPort: this.wsPort,
            wsUrl: `ws://127.0.0.1:${this.wsPort}`,
            vncPort: this.vncPort
          });
        });

        this.httpServer.on('error', (err) => {
          this.logManager?.error(`[VM] Display backend error: ${err.message}`, 'vm');
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  async stop() {
    for (const socket of this.activeSockets) {
      try { socket.destroy(); } catch {}
    }
    this.activeSockets.clear();

    for (const client of this.activeClients) {
      try { client.close(); } catch {}
    }
    this.activeClients.clear();

    if (this.wss) {
      try { this.wss.close(); } catch {}
      this.wss = null;
    }

    if (this.httpServer) {
      await new Promise((resolve) => {
        this.httpServer.close(() => resolve());
      });
      this.httpServer = null;
    }
  }
}

module.exports = { VncProxy };
