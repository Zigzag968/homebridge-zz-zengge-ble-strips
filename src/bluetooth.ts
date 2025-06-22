import { Buffer } from 'buffer';
import noble, { Peripheral } from '@abandonware/noble';
import { Logger, PlatformConfig } from 'homebridge';

export const BLE_SERVICE_UUID = 'ffff';
export const BLE_WRITE_UUID = 'ff01';
export const BLE_NOTIFY_UUID = 'ff02';
export const BLE_CONNECT_RETRIES = 3;
export const BLE_BACKOFF_BASE = 500;
export const BLE_MONITOR_INTERVAL = 5000;
export const BLE_DISCOVERY_DEBOUNCE = 10000;
export const BLE_MONITOR_MAX_RETRIES = 3;

export interface DeviceState {
  peripheral?: Peripheral;
  attempts: number;
  monitorAttempts: number;
  lastDiscovery: number;
  characteristic?: any;
  connectionState: 'disconnected' | 'connecting' | 'connected' | 'disconnecting';
  commandQueue: Buffer[];
}

export class BluetoothCommunicator {
  private readonly log: Logger;
  private readonly config: PlatformConfig;
  private readonly devices: Map<string, DeviceState> = new Map();
  private readonly connecting: Set<string> = new Set();
  private connectionLock = false;
  private isReconnecting: boolean = false;
  private configuredAddresses: string[] = [];

  constructor(log: Logger, config: PlatformConfig) {
    this.log = log;
    this.config = config;
    this.configuredAddresses = (config.devices || []).map((d: any) => d.address.toLowerCase());
    for (const addr of this.configuredAddresses) {
      this.devices.set(addr, {
        attempts: 0,
        monitorAttempts: 0,
        lastDiscovery: 0,
        connectionState: 'disconnected',
        commandQueue: [],
      });
    }
    this.setupNoble();
  }

  // Start scanning for BLE devices
  startBluetoothScanning() {
    noble.startScanning([], false);
  }

  // Connect to a device by address, setup characteristic and notifications
  async connectToDevice(address: string): Promise<void> {
    const addr = address.toLowerCase();

    if (this.connecting.has(addr)) {
      this.log.debug(`Connection already in progress for ${address}, skipping.`);
      return;
    }

    // Wait for lock to be released to ensure sequential connection
    while (this.connectionLock) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    this.connectionLock = true;
    this.connecting.add(addr);

    try {
      const state = this.devices.get(addr);
      if (!state || !state.peripheral) {
        this.log.warn(`Peripheral with address ${address} not found.`);
        return; // finally will release lock
      }
      state.connectionState = 'connecting';

      if (state.peripheral.state === 'connected') {
        this.log.debug(`Device ${address} already connected.`);
        state.connectionState = 'connected';
        return; // finally will release lock
      }

      await this.retryWithBackoff(async () => {
        await state.peripheral!.connectAsync();
      }, BLE_CONNECT_RETRIES, addr);

      this.logDevice(addr, 'Connected');
      await new Promise(r => setTimeout(r, 350));

      state.characteristic = await this.discoverWriteCharacteristic(state.peripheral!, addr);
      if (!state.characteristic) {
        this.log.error(`Failed to discover characteristic for ${addr}, disconnecting.`);
        await state.peripheral?.disconnectAsync();
        return; // finally will release lock
      }
      
      await new Promise(r => setTimeout(r, 200));
      await this.enableNotification(state.peripheral!, addr);

      state.attempts = 0;
      state.monitorAttempts = 0;
      state.connectionState = 'connected';
      // Using optional chaining for a cleaner, more Swift-like syntax.
      (state.peripheral as any)?.removeAllListeners('disconnect');
      state.peripheral?.once('disconnect', (error?: Error) => {
        if (error) {
          this.log.warn(`Device ${addr} disconnected unexpectedly: ${error.message}`);
        }
        this.handleDisconnect(addr);
      });

      this.devices.set(addr, state);
      this.processCommandQueue(addr);

    } catch (e) {
      const state = this.devices.get(addr);
      if (state) {
        state.attempts++;
        this.devices.set(addr, state);
      }
      this.log.error(`Error connecting to ${address}:`, e);
      const peripheral = this.devices.get(addr)?.peripheral;
      if (peripheral && (peripheral.state === 'connected' || peripheral.state === 'connecting')) {
        await peripheral.disconnectAsync().catch((err: Error) => this.log.error(`Error during disconnect after failure: ${err}`));
      }
    } finally {
      this.connecting.delete(addr);
      this.connectionLock = false;
    }
  }

  // Exponential backoff retry helper
  private async retryWithBackoff(fn: () => Promise<void>, retries: number, addr: string): Promise<void> {
    let lastErr;
    for (let i = 0; i < retries; i++) {
      try {
        await fn();
        return;
      } catch (e) {
        lastErr = e;
        this.log.warn(`Retry ${i + 1}/${retries} for ${addr}`);
        await new Promise(r => setTimeout(r, BLE_BACKOFF_BASE * (i + 1)));
      }
    }
    throw lastErr;
  }

  // On device disconnect, clear state and schedule reconnect
  private handleDisconnect(addr: string) {
    const state = this.devices.get(addr);
    if (state) {
      this.logDevice(addr, 'Disconnected');
      state.characteristic = undefined;
      state.connectionState = 'disconnected';
      state.attempts = 0;
      state.monitorAttempts = 0;
      this.devices.set(addr, state);
    }
  }

  // Discover the write characteristic for a device
  private async discoverWriteCharacteristic(peripheral: Peripheral, addr: string): Promise<any | undefined> {
    try {
      const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [BLE_SERVICE_UUID], [BLE_WRITE_UUID]
      );
      if (characteristics.length > 0) {
        this.logDevice(addr, `Write characteristic discovered: ${characteristics[0].uuid}`);
        return characteristics[0];
      }
      this.log.error(`No write characteristic found for ${addr}`);
    } catch (e) {
      this.log.error(`Error discovering write characteristic for ${addr}:`, e);
    }
    return undefined;
  }

  // Enable notification for a device
  private async enableNotification(peripheral: Peripheral, addr: string): Promise<void> {
    try {
      const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [BLE_SERVICE_UUID], [BLE_NOTIFY_UUID]
      );
      if (characteristics.length > 0) {
        const notifyChar = characteristics[0];
        notifyChar.on('data', (data: Buffer) => {
          this.log.debug(`Notification from ${addr}: ${data.toString('hex')}`);
        });
        await new Promise<void>((resolve, reject) => {
          notifyChar.subscribe((err?: Error | string | null) => {
            if (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            } else {
              resolve();
            }
          });
        });
        this.logDevice(addr, 'Notifications enabled');
      } else {
        this.log.error(`No notify characteristic found for ${addr}`);
      }
    } catch (e) {
      this.log.error(`Error enabling notifications for ${addr}:`, e);
    }
  }

  // Utility: log device with address
  private logDevice(addr: string, msg: string) {
    this.log.info(`[BLE][${addr}] ${msg}`);
  }

  // Device discovered event
  private deviceDiscovered(peripheral: Peripheral) {
    const addr = peripheral.address.toLowerCase();
    // Only process configured devices
    if (!this.configuredAddresses.includes(addr)) return;
    const now = Date.now();
    const state = this.devices.get(addr)!;
    // Debounce discoveries
    if (now - state.lastDiscovery < BLE_DISCOVERY_DEBOUNCE) return;
    state.peripheral = peripheral;
    state.lastDiscovery = now;
    this.devices.set(addr, state);
    this.logDevice(addr, 'Discovered');
    if (state.connectionState === 'disconnected' && !this.connecting.has(addr)) {
      this.connectToDevice(addr);
    }
  }

  // Setup noble event listeners and monitoring
  private setupNoble() {
    noble.on('scanStart', () => this.log.debug('Bluetooth scanning started'));
    noble.on('scanStop', () => this.log.debug('Bluetooth scanning stopped'));
    noble.on('stateChange', (state: string) => {
      this.log.info(`Bluetooth adapter state: ${state}`);
      if (state === 'poweredOn') this.startBluetoothScanning();
      else noble.stopScanning();
    });
    noble.on('discover', (peripheral: Peripheral) => this.deviceDiscovered(peripheral));
    setInterval(() => this.monitorConnections(), BLE_MONITOR_INTERVAL);
  }

  // Monitor and reconnect to any lost devices
  private async monitorConnections() {
    if (this.isReconnecting) {
      return;
    }
    const toConnect: string[] = [];
    for (const addr of this.configuredAddresses) {
      const state = this.devices.get(addr);
      if (!state || this.connecting.has(addr)) {
        continue;
      }
      if (state.connectionState === 'disconnected') {
        if (!state.peripheral) {
          if (state.monitorAttempts > 5) {
            this.log.debug(`Still waiting for device ${addr} to be discovered...`);
          }
          state.monitorAttempts++;
          continue;
        }
        if (state.monitorAttempts < BLE_MONITOR_MAX_RETRIES) {
          this.log.debug(`Device ${addr} is disconnected, scheduling reconnect (Attempt ${state.monitorAttempts + 1})`);
          state.monitorAttempts++;
          toConnect.push(addr);
        } else {
          this.log.warn(`Max monitor retries for ${addr}. Forgetting peripheral to force re-discovery.`);
          state.peripheral = undefined;
          state.monitorAttempts = 0;
        }
      }
    }
    if (toConnect.length > 0) {
      this.isReconnecting = true;
      try {
        for (const addr of toConnect) {
          await this.connectToDevice(addr);
        }
      } finally {
        this.isReconnecting = false;
      }
    }
  }

  // Send a command to a BLE device
  public async sendCommand(address: string, command: Buffer): Promise<void> {
    const addr = address.toLowerCase();
    const state = this.devices.get(addr);

    if (!state) {
      this.log.error(`Device ${address} not configured.`);
      return;
    }

    // Queue only the latest command.
    state.commandQueue = [command];
    this.devices.set(addr, state);

    if (state.connectionState === 'connected' && state.characteristic) {
      await this.processCommandQueue(addr);
    } else if (state.connectionState === 'disconnected' && !this.connecting.has(addr)) {
      this.log.warn(`Device ${address} is disconnected. Queuing command and attempting to connect.`);
      await this.connectToDevice(address);
    } else {
      this.log.debug(`Device ${address} is busy (${state.connectionState}). Command queued.`);
    }
  }

  private async processCommandQueue(addr: string): Promise<void> {
    const state = this.devices.get(addr);
    if (!state || state.commandQueue.length === 0 || state.connectionState !== 'connected' || !state.characteristic) {
      return;
    }

    const command = state.commandQueue.shift(); // Get the latest command
    if (!command) {
      return;
    }

    try {
      this.log.debug(`Sending command to ${addr}: ${command.toString('hex')}`);
      await state.characteristic.write(command, true);
      this.log.debug(`Command sent to ${addr}`);
      // Clear queue after successful send.
      state.commandQueue = [];
      this.devices.set(addr, state);
    } catch (e) {
      this.log.error(`Failed to write command to ${addr}:`, e);
      // Re-queue the failed command. The disconnect handler will manage reconnection.
      state.commandQueue.unshift(command);
      this.devices.set(addr, state);
    }
  }
}