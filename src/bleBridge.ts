import { spawn, ChildProcessWithoutNullStreams, exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { Buffer } from 'buffer';
import {
  Logger,
  PlatformConfig
} from 'homebridge';
import { VENV_DIR, DIST_DIR, PYTHON_BIN } from './settings';

// Constants from original bluetooth.ts
export const BLE_SERVICE_UUID = 'ffff';
export const BLE_WRITE_UUID = 'ff01';
export const BLE_NOTIFY_UUID = 'ff02';
export const BLE_CONNECT_RETRIES = 3;
export const BLE_BACKOFF_BASE = 500;
export const BLE_MONITOR_INTERVAL = 5000;
export const BLE_DISCOVERY_DEBOUNCE = 10000;
export const BLE_MAX_CONNECTION_ATTEMPTS = 5;
export const BLE_COOL_DOWN_PERIOD = 5 * 60 * 1000; // 5 minutes
export const BLE_COMMAND_TIMEOUT = 10000; // 10 seconds

// Proactive connection constants
export const BLE_PROACTIVE_CONNECTION = true;
export const BLE_CONNECTION_HEALTH_CHECK = true;
export const BLE_KEEP_ALIVE_INTERVAL = 60000; // 1 minute
export const BLE_MAX_RECONNECT_ATTEMPTS = 5;

type PendingRequest = {
  device: string;
  command: string;
};

export interface DeviceState {
  address: string;
  attempts: number;
  lastDiscovery: number;
  lastAttempt: number;
  connectionState: 'disconnected' | 'connecting' | 'connected' | 'disconnecting';
  commandQueue: Buffer[];
  lastActivity: number;
  retryCount: number;
}

export interface CommandResult {
  success: boolean;
  error?: string;
  device: string;
  command: string;
}

export class BleBridge {
  private pythonProcess: ChildProcessWithoutNullStreams | null = null;
  private ready: boolean = false;
  private log: Logger;
  private config: PlatformConfig;
  private devices: Map<string, DeviceState> = new Map();
  private configuredAddresses: string[] = [];
  private connecting: Set<string> = new Set();
  private connectionLock = false;
  private monitorInProgress = false;
  private monitorInterval?: NodeJS.Timeout;
  private pendingCommands: Map<string, { resolve: Function; reject: Function; timeout: NodeJS.Timeout }> = new Map();
  private commandCounter = 0;

  constructor(log: Logger, config?: PlatformConfig) {
    this.log = log;
    this.config = config || { devices: [], platform: 'BleBridge' } as PlatformConfig;
    this.configuredAddresses = (this.config.devices || []).map((d: any) => d.address.toLowerCase());
    
    // Initialize device states
    for (const addr of this.configuredAddresses) {
      this.devices.set(addr, {
        address: addr,
        attempts: 0,
        lastDiscovery: 0,
        lastAttempt: 0,
        connectionState: 'disconnected',
        commandQueue: [],
        lastActivity: 0,
        retryCount: 0,
      });
    }
  }

  /**
   * Initialize the bridge and start monitoring
   */
  private async initialize(): Promise<void> {
    this.startMonitoring();
    
    // Connexion proactive de tous les devices configurés si activée
    if (BLE_PROACTIVE_CONNECTION) {
      await this.connectAllConfiguredDevices();
    }
  }

  /**
   * Connect proactively to all configured devices
   */
  private async connectAllConfiguredDevices(): Promise<void> {
    this.log.info('[BLE Bridge] Initiating proactive connections to all configured devices');
    
    const connectionPromises = this.configuredAddresses.map(async (addr) => {
      try {
        await this.connectToDevice(addr);
      } catch (error) {
        this.log.warn(`[BLE Bridge][${addr}] Initial connection failed, will retry later:`, error);
      }
    });
    
    await Promise.allSettled(connectionPromises);
    this.log.info('[BLE Bridge] Proactive connection attempts completed');
  }

  private startMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }
    
    this.monitorInterval = setInterval(() => {
      this.monitorConnections();
    }, BLE_MONITOR_INTERVAL);
    
    this.log.debug('[BLE Bridge] Connection monitoring started');
  }

  private async monitorConnections(): Promise<void> {
    if (this.monitorInProgress) {
      return;
    }
    
    this.monitorInProgress = true;

    try {
      for (const addr of this.configuredAddresses) {
        const state = this.devices.get(addr);
        if (!state) continue;

        // Reconnexion proactive pour devices déconnectés
        if (state.connectionState === 'disconnected' && !this.connecting.has(addr)) {
          // Vérifier la période de cool-down
          if (state.retryCount >= BLE_MAX_RECONNECT_ATTEMPTS) {
            const timeSinceLastAttempt = Date.now() - state.lastAttempt;
            if (timeSinceLastAttempt < BLE_COOL_DOWN_PERIOD) {
              continue; // Still in cool-down
            } else {
              this.log.info(`[BLE Bridge][${addr}] Cool-down period over, resetting retry count`);
              state.retryCount = 0;
              state.attempts = 0;
            }
          }

          // Reconnexion proactive (pas seulement si commandes en queue)
          if (BLE_PROACTIVE_CONNECTION) {
            this.log.debug(`[BLE Bridge][${addr}] Proactive reconnection attempt`);
            await this.connectToDevice(addr);
          } else {
            // Comportement original : reconnexion seulement si commandes en queue
            if (state.commandQueue.length > 0) {
              this.log.debug(`[BLE Bridge][${addr}] Initiating reconnection for queued commands`);
              await this.connectToDevice(addr);
            }
          }
        }

        // Health check pour connexions établies
        if (state.connectionState === 'connected' && BLE_CONNECTION_HEALTH_CHECK) {
          const timeSinceActivity = Date.now() - state.lastActivity;
          if (timeSinceActivity > BLE_KEEP_ALIVE_INTERVAL) {
            this.log.debug(`[BLE Bridge][${addr}] Connection inactive for ${Math.round(timeSinceActivity/1000)}s, checking health`);
            // Optionnel : envoyer une commande de ping ou vérifier l'état
            // Pour l'instant, on met juste à jour lastActivity
            state.lastActivity = Date.now();
            this.devices.set(addr, state);
          }
        }

        // Update last activity for connected devices (comportement original)
        if (state.connectionState === 'connected') {
          this.devices.set(addr, state);
        }
      }
    } catch (error) {
      this.log.error('[BLE Bridge] Error during proactive monitoring:', error);
    } finally {
      this.monitorInProgress = false;
    }
  }

  /**
   * Connect to a specific device (compatible with bluetooth.ts interface)
   */
  async connectToDevice(address: string): Promise<void> {
    const addr = address.toLowerCase();

    if (this.connecting.has(addr)) {
      this.log.debug(`[BLE Bridge][${addr}] Connection already in progress`);
      return;
    }

    if (!this.ready) {
      this.log.warn(`[BLE Bridge][${addr}] Cannot connect: Python process not ready`);
      return;
    }

    // Wait for connection lock
    while (this.connectionLock) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    this.connectionLock = true;
    this.connecting.add(addr);

    try {
      const state = this.devices.get(addr);
      if (!state) {
        this.log.error(`[BLE Bridge][${addr}] Device not found in configuration`);
        return;
      }

      state.lastAttempt = Date.now();
      state.connectionState = 'connecting';
      state.attempts++;

      this.log.info(`[BLE Bridge][${addr}] Initiating connection (attempt ${state.attempts})`);

      // Send connection command to Python backend
      const connectCommand = {
        action: "connect",
        device: addr.toUpperCase()
      };
      
      this.pythonProcess!.stdin.write(JSON.stringify(connectCommand) + '\n');
      this.log.info(`[BLE Bridge][${addr}] Connection request sent to Python backend`);

      // Wait for connection confirmation from Python
      await this.waitForConnectionConfirmation(addr);

      // Process any queued commands
      await this.processCommandQueue(addr);

    } catch (error) {
      this.log.error(`[BLE Bridge][${addr}] Connection failed:`, error);
      const state = this.devices.get(addr);
      if (state) {
        state.connectionState = 'disconnected';
        state.retryCount++;
        this.devices.set(addr, state);
      }
    } finally {
      this.connecting.delete(addr);
      this.connectionLock = false;
    }
}
/**
 * Wait for connection confirmation from Python backend
 */
private async waitForConnectionConfirmation(addr: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Connection timeout for ${addr}`));
    }, 30000); // 30 seconds timeout
    
    const checkConnection = () => {
      const state = this.devices.get(addr);
      if (state?.connectionState === 'connected') {
        clearTimeout(timeout);
        clearInterval(interval);
        resolve();
      }
    };
    
    // Check every 500ms for connection confirmation
    const interval = setInterval(checkConnection, 500);
  });
}
 

  /**
   * Start Bluetooth scanning (compatible with bluetooth.ts interface)
   */
  startBluetoothScanning(): void {
    if (!this.ready) {
      this.log.warn('[BLE Bridge] Cannot start scanning: Python process not ready');
      return;
    }
    
    this.log.debug('[BLE Bridge] Bluetooth scanning managed by Python backend');
    // The Python backend handles scanning automatically
  }

  /**
   * Enable bluetooth
   */
  enableBluetooth(callback?: () => void): void {
    this.log.info('[BLE] Enabling Bluetooth...');
    
    exec('rfkill unblock bluetooth', (error) => {
      if (error) {
        this.log.warn('[BLE] Bluetooth enable failed:', error.message);
      } else {
        this.log.info('[BLE] Bluetooth enabled');
      }
      
      if (callback) {
        callback();
      }
    });
  }

  /**
   * Disable bluetooth
   */
  disableBluetooth(callback?: () => void): void {
    this.log.info('[BLE] Disabling Bluetooth...');
    
    exec('rfkill block bluetooth', (error) => {
      if (error) {
        this.log.warn('[BLE] Bluetooth disable failed:', error.message);
      } else {
        this.log.info('[BLE] Bluetooth disabled');
      }
      
      if (callback) {
        callback();
      }
    });
  }

  /**
   * Simple bluetooth restart function using existing methods
   */
  restartBluetooth(callback?: () => void): void {
    this.log.info('[BLE] Restarting Bluetooth...');
    
    this.disableBluetooth(() => {
      setTimeout(() => {
        this.enableBluetooth(callback);
      }, 2000);
    });
  }


  private getPythonExecutable(): string {
    if (fs.existsSync(PYTHON_BIN)) {
      this.log.info('[BLE] Using virtual environment Python');
      return PYTHON_BIN;
    }

    this.log.info('[BLE] Using system Python');
    return 'python3';
  }

  start(devices: string[]): void {
    if (this.pythonProcess) return;

    // Force disconnect all devices to prevent connection issues
    this.restartBluetooth(() => {
      // Start Python process after bluetooth restart is complete
      setTimeout(() => {
        this.startPythonProcess(devices);
      }, 2000);
    });
  }

  private startPythonProcess(devices: string[]): void {
    const pyPath = path.join(DIST_DIR, 'bleDispatcher.py');
    const pythonExec = this.getPythonExecutable();
    const args = [pyPath, ...devices.map(d => d.toUpperCase())];

    this.pythonProcess = spawn(pythonExec, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });

    this.pythonProcess.stdout.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          try {
            // Essayer de parser comme JSON pour les messages de feedback
            const message = JSON.parse(trimmed);
            if (message.device && message.status) {
              const deviceAddr = message.device.toLowerCase();
              
              if (message.status === 'success') {
                this.log.info(`[BLE PYTHON SUCCESS] Command sent to ${message.device}: ${message.command}`);
                this.handleCommandSuccess(deviceAddr, message.command);
              } else if (message.status === 'error') {
                this.log.error(`[BLE PYTHON ERROR] Failed to send command to ${message.device}: ${message.error}`);
                this.handleCommandError(deviceAddr, message.command, message.error);
              } else if (message.status === 'queued') {
                this.log.warn(`[BLE PYTHON QUEUED] Command queued for ${message.device}: ${message.command}`);
              } else if (message.status === 'connected') {
                this.log.info(`[BLE PYTHON CONNECTED] Device ${message.device} connected`);
                this.handleConnectionEvent(deviceAddr, 'connected', message.event);
              } else if (message.status === 'disconnected') {
                this.log.info(`[BLE PYTHON DISCONNECTED] Device ${message.device} disconnected`);
                this.handleConnectionEvent(deviceAddr, 'disconnected', message.event);
              }
            } else {
              // Message de notification normale
              this.log.info(`[BLE PYTHON OUT] ${trimmed}`);
            }
          } catch (e) {
            // Pas un JSON, traiter comme message normal
            this.log.info(`[BLE PYTHON OUT] ${trimmed}`);
          }
        }
      }
    });

    this.pythonProcess.stderr.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          this.log.error(`[BLE PYTHON ERR] ${trimmed}`);
        }
      }
    });

    this.pythonProcess.on('error', (error) => {
      this.log.error('[BLE] Failed to start Python process:', error.message);
      this.log.error('[BLE] Error details:', error);
      this.pythonProcess = null;
      this.ready = false;
    });

    this.pythonProcess.on('exit', (code, signal) => {
      this.log.warn(`[BLE Python exited] code=${code}, signal=${signal}`);
      if (code !== 0) {
        this.log.error(`[BLE] Python process exited with non-zero code: ${code}`);
      }
      this.pythonProcess = null;
      this.ready = false;
      
      // Try to restart after a delay if there are configured devices
      if (this.configuredAddresses.length > 0) {
        this.log.info('[BLE] Attempting to restart Python process in 5 seconds...');
        setTimeout(() => {
          this.start(devices);
        }, 5000);
      }
    });

    setTimeout(async () => {
      if (this.pythonProcess && this.pythonProcess.pid) {
        this.log.info(`[BLE] Python process started successfully with PID: ${this.pythonProcess.pid}`);
        this.ready = true;
        await this.initialize(); // Start monitoring and proactive connections
      } else {
        this.log.error('[BLE] Python process failed to start within timeout');
        this.ready = false;
      }
    }, 2000);
  }

  private handleCommandSuccess(deviceAddr: string, command: string): void {
    const commandId = `${deviceAddr}-${command}`;
    const pending = this.pendingCommands.get(commandId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve({ success: true, device: deviceAddr, command });
      this.pendingCommands.delete(commandId);
    }

    // Update device state
    const state = this.devices.get(deviceAddr);
    if (state) {
      state.connectionState = 'connected';
      state.lastActivity = Date.now();
      state.retryCount = 0;
      this.devices.set(deviceAddr, state);
    }
  }

  private handleCommandError(deviceAddr: string, command: string, error: string): void {
    const commandId = `${deviceAddr}-${command}`;
    const pending = this.pendingCommands.get(commandId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(error));
      this.pendingCommands.delete(commandId);
    }

    // Update device state
    const state = this.devices.get(deviceAddr);
    if (state) {
      state.connectionState = 'disconnected';
      state.retryCount++;
      this.devices.set(deviceAddr, state);
    }
  }
/**
   * Handle connection events from Python backend
   */
  private handleConnectionEvent(deviceAddr: string, status: 'connected' | 'disconnected', event?: string): void {
    const state = this.devices.get(deviceAddr);
    if (!state) {
      return;
    }

    if (status === 'connected') {
      state.connectionState = 'connected';
      state.lastActivity = Date.now();
      state.attempts = 0;
      state.retryCount = 0;
      this.log.info(`[BLE Bridge][${deviceAddr}] Connection confirmed by Python backend (${event || 'unknown'})`);
    } else if (status === 'disconnected') {
      state.connectionState = 'disconnected';
      this.log.info(`[BLE Bridge][${deviceAddr}] Disconnection confirmed by Python backend (${event || 'unknown'})`);
    }

    this.devices.set(deviceAddr, state);
  }

  /**
   * Send command with Promise support (internal method)
   */
  private async sendCommandWithPromise(device: string, command: string): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      if (!this.pythonProcess || !this.ready) {
        reject(new Error('Python process not started'));
        return;
      }

      const commandId = `${device.toLowerCase()}-${command}`;
      
      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(commandId);
        reject(new Error(`Command timeout for ${device}`));
      }, BLE_COMMAND_TIMEOUT);

      // Store pending command
      this.pendingCommands.set(commandId, { resolve, reject, timeout });

      // Send command to Python
      const payload: PendingRequest = { device: device.toUpperCase(), command };
      this.pythonProcess!.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  /**
   * Original sendCommand method (for backward compatibility)
   */
  sendCommand(device: string, command: string): void {
    if (!this.pythonProcess || !this.ready) {
      this.log.error('[BLE] Python process not started.');
      return;
    }

    const payload: PendingRequest = { device: device.toUpperCase(), command };
    this.pythonProcess.stdin.write(JSON.stringify(payload) + '\n');
  }

  /**
   * New sendCommand method compatible with bluetooth.ts interface (Buffer support)
   * Optimized for proactive connections to eliminate latency
   */
  async sendCommandBuffer(address: string, command: Buffer): Promise<void> {
    const addr = address.toLowerCase();
    const state = this.devices.get(addr);

    if (!state) {
      this.log.warn(`[BLE Bridge][${addr}] Cannot send command: device not found`);
      return;
    }

    if (!this.ready) {
      this.log.warn(`[BLE Bridge][${addr}] Cannot send command: Python process not ready`);
      return;
    }

    const commandHex = command.toString('hex');
    this.log.debug(`[BLE Bridge][${addr}] Sending command: ${commandHex}`);

    // Mise en queue de la commande
    state.commandQueue = [command];
    state.lastActivity = Date.now();
    this.devices.set(addr, state);

    if (state.connectionState === 'connected') {
      // Envoi immédiat si connecté - pas de latence
      await this.processCommandQueue(addr);
    } else {
      // Avec la connexion proactive, on évite la connexion à la demande
      if (BLE_PROACTIVE_CONNECTION) {
        this.log.info(`[BLE Bridge][${addr}] Command queued, device will reconnect automatically via monitoring`);
        // La reconnexion se fera automatiquement via monitorConnections()
      } else {
        // Comportement original : connexion à la demande
        this.log.info(`[BLE Bridge][${addr}] Device not connected, queuing command and initiating connection`);
        if (!this.connecting.has(addr)) {
          await this.connectToDevice(address);
        }
      }
    }
  }

  /**
   * Process command queue for a device
   */
  private async processCommandQueue(addr: string): Promise<void> {
    const state = this.devices.get(addr);
    if (!state || state.commandQueue.length === 0) {
      return;
    }

    if (state.connectionState !== 'connected') {
      this.log.debug(`[BLE Bridge][${addr}] Device not connected, skipping command processing`);
      return;
    }

    const command = state.commandQueue.shift();
    if (!command) {
      return;
    }

    try {
      const commandHex = command.toString('hex');
      this.log.debug(`[BLE Bridge][${addr}] Sending command: ${commandHex}`);

      await this.sendCommandWithPromise(addr, commandHex);
      
      this.log.info(`[BLE Bridge][${addr}] Command sent successfully`);
      state.lastActivity = Date.now();
      state.retryCount = 0;
      
      // Clear remaining queue on success
      state.commandQueue = [];
      this.devices.set(addr, state);

    } catch (error) {
      this.log.error(`[BLE Bridge][${addr}] Failed to send command:`, error);
      
      // Put command back at front of queue
      state.commandQueue.unshift(command);
      state.connectionState = 'disconnected';
      state.retryCount++;
      this.devices.set(addr, state);

      // Trigger reconnection if not too many retries
      if (state.retryCount < BLE_MAX_CONNECTION_ATTEMPTS && !this.connecting.has(addr)) {
        setTimeout(() => {
          this.connectToDevice(addr);
        }, BLE_BACKOFF_BASE * Math.pow(2, state.retryCount));
      }
    }
  }

  /**
   * Get current device states for debugging
   */
  getDeviceStates(): Map<string, DeviceState> {
    return new Map(this.devices);
  }

  /**
   * Get connection statistics
   */
  getConnectionStats(): { [address: string]: any } {
    const stats: { [address: string]: any } = {};
    
    for (const [addr, state] of this.devices) {
      stats[addr] = {
        connectionState: state.connectionState,
        attempts: state.attempts,
        retryCount: state.retryCount,
        queueLength: state.commandQueue.length,
        lastActivity: new Date(state.lastActivity).toISOString(),
        lastAttempt: new Date(state.lastAttempt).toISOString(),
      };
    }
    
    return stats;
  }

  /**
   * Force reconnection for a device
   */
  async forceReconnect(address: string): Promise<void> {
    const addr = address.toLowerCase();
    const state = this.devices.get(addr);
    
    if (!state) {
      this.log.error(`[BLE Bridge][${addr}] Cannot force reconnect: device not found`);
      return;
    }

    this.log.info(`[BLE Bridge][${addr}] Forcing reconnection`);
    state.connectionState = 'disconnected';
    state.retryCount = 0;
    state.attempts = 0;
    this.devices.set(addr, state);

    await this.connectToDevice(address);
  }

  /**
   * Check if bridge is ready
   */
  isReady(): boolean {
    return this.ready && this.pythonProcess !== null;
  }

  /**
   * Get configured device addresses
   */
  getConfiguredAddresses(): string[] {
    return [...this.configuredAddresses];
  }

  /**
   * Stop the bridge and cleanup resources
   */
  stop(): void {
    // Clear monitoring
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = undefined;
    }

    // Clear pending commands
    for (const [commandId, pending] of this.pendingCommands) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Bridge stopped'));
    }
    this.pendingCommands.clear();

    // Stop Python process
    if (this.pythonProcess) {
      this.pythonProcess.kill('SIGTERM');
      this.pythonProcess = null;
      this.ready = false;
    }

    // Reset device states
    for (const [addr, state] of this.devices) {
      state.connectionState = 'disconnected';
      state.commandQueue = [];
      this.devices.set(addr, state);
    }

    this.log.info('[BLE Bridge] Stopped and cleaned up');
  }

  /**
   * Destroy the bridge (alias for stop for compatibility)
   */
  destroy(): void {
    this.stop();
  }
}

