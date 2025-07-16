import { Buffer } from 'buffer';
import noble, { Peripheral } from '@abandonware/noble';
import { Logger, PlatformConfig } from 'homebridge';
import { exec } from 'child_process';

export const BLE_SERVICE_UUID = 'ffff';
export const BLE_WRITE_UUID = 'ff01';
export const BLE_NOTIFY_UUID = 'ff02';
export const BLE_CONNECT_RETRIES = 3;
export const BLE_BACKOFF_BASE = 500;
export const BLE_MONITOR_INTERVAL = 5000;
export const BLE_DISCOVERY_DEBOUNCE = 10000;
export const BLE_MAX_CONNECTION_ATTEMPTS = 5;
export const BLE_COOL_DOWN_PERIOD = 5 * 60 * 1000; // 5 minutes

export interface DeviceState {
  peripheral?: Peripheral;
  attempts: number;
  lastDiscovery: number;
  lastAttempt: number;
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
  private monitorInProgress = false;
  private configuredAddresses: string[] = [];
  private bleState = 'unknown';
  private isScanning = false;

  constructor(log: Logger, config: PlatformConfig) {
    this.log = log;
    this.config = config;
    this.configuredAddresses = (config.devices || []).map((d: any) => d.address.toLowerCase());
    for (const addr of this.configuredAddresses) {
      this.devices.set(addr, {
        attempts: 0,
        lastDiscovery: 0,
        lastAttempt: 0,
        connectionState: 'disconnected',
        commandQueue: [],
      });
    }
    this.setupNoble();
  }

  startBluetoothScanning() {
    if (this.bleState === 'poweredOn' && !this.isScanning) {
      this.log.debug('Starting Bluetooth scan...');
      noble.startScanning([], true);
    }
  }

  async connectToDevice(address: string): Promise<void> {
    const addr = address.toLowerCase();

    if (this.connecting.has(addr)) {
      return;
    }

    while (this.connectionLock) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    this.connectionLock = true;
    this.connecting.add(addr);

    try {
      const state = this.devices.get(addr);
      if (!state) {
        return;
      }

      state.lastAttempt = Date.now();

      if (!state.peripheral) {
        this.log.warn(`[BLE][${addr}] Cannot connect: peripheral not discovered yet.`);
        this.startBluetoothScanning();
        return;
      }

      state.connectionState = 'connecting';
      this.log.info(`[BLE][${addr}] Connecting... (Attempt ${state.attempts + 1})`);

      if (state.peripheral.state === 'connected') {
        state.connectionState = 'connected';
        return;
      }

      await this.retryWithBackoff(async () => {
        await state.peripheral!.connectAsync();
      }, BLE_CONNECT_RETRIES, addr);

      this.logDevice(addr, 'Connected');
      state.attempts = 0;
      state.connectionState = 'connected';

      state.characteristic = await this.discoverWriteCharacteristic(state.peripheral!, addr);
      if (!state.characteristic) {
        await state.peripheral?.disconnectAsync();
        return;
      }
      
      await this.enableNotification(state.peripheral!, addr);

      state.peripheral?.removeAllListeners('disconnect');
      state.peripheral?.once('disconnect', () => this.handleDisconnect(addr));

      this.devices.set(addr, state);
      this.processCommandQueue(addr);

    } catch (e) {
      this.log.error(`Error connecting to ${address}:`, e);
      const state = this.devices.get(addr);
      if (state) {
        state.attempts++;
        const oldPeripheral = state.peripheral; // Garder une référence temporaire
        
        // Invalider l'état actuel
        state.peripheral = undefined;
        state.connectionState = 'disconnected';
        this.devices.set(addr, state);
        this.startBluetoothScanning(); // S'assurer que le scan est actif

        // Tenter une déconnexion propre de l'ancien objet
        if (oldPeripheral && (oldPeripheral.state === 'connected' || oldPeripheral.state === 'connecting')) {
          await oldPeripheral.disconnectAsync().catch((err: Error) => this.log.error(`Error during disconnect after failure: ${err}`));
        }
      }
    } finally {
      this.connecting.delete(addr);
      this.connectionLock = false;
    }
  }

  private async retryWithBackoff(fn: () => Promise<void>, retries: number, addr: string): Promise<void> {
    for (let i = 0; i < retries; i++) {
      try {
        await fn();
        return;
      } catch (e) {
        if (i === retries - 1) {
          throw e;
        }
        await new Promise(r => setTimeout(r, BLE_BACKOFF_BASE * (i + 1)));
      }
    }
  }

  private handleDisconnect(addr: string) {
    const state = this.devices.get(addr);
    if (state) {
      this.logDevice(addr, 'Disconnected.');
      state.characteristic = undefined;
      state.connectionState = 'disconnected';
      state.peripheral = undefined;
      this.devices.set(addr, state);
      this.startBluetoothScanning();
    }
  }

  private async discoverWriteCharacteristic(peripheral: Peripheral, addr: string): Promise<any | undefined> {
    try {
      const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [BLE_SERVICE_UUID], [BLE_WRITE_UUID]
      );
      if (characteristics.length > 0) {
        return characteristics[0];
      }
    } catch (e) {
      this.log.error(`Error discovering write characteristic for ${addr}:`, e);
    }
    return undefined;
  }

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
        await notifyChar.subscribeAsync();
        this.logDevice(addr, 'Notifications enabled');
      }
    } catch (e) {
      this.log.error(`Error enabling notifications for ${addr}:`, e);
    }
  }

  private logDevice(addr: string, msg: string) {
    this.log.info(`[BLE][${addr}] ${msg}`);
  }

  private deviceDiscovered(peripheral: Peripheral) {
    const addr = peripheral.address.toLowerCase();
    if (this.configuredAddresses.includes(addr)) {
      const state = this.devices.get(addr)!;
      state.peripheral = peripheral;
      state.lastDiscovery = Date.now();
      this.devices.set(addr, state);
    }
  }

  private setupNoble() {
    noble.on('scanStart', () => { this.isScanning = true; });
    noble.on('scanStop', () => { this.isScanning = false; });
    noble.on('stateChange', (state: string) => {
      this.bleState = state;
      if (state === 'poweredOn') {
        this.startBluetoothScanning();
      }
    });
    noble.on('discover', (p: Peripheral) => this.deviceDiscovered(p));
    setInterval(() => this.monitorConnections(), BLE_MONITOR_INTERVAL);
  }

  private async monitorConnections() {
    if (this.monitorInProgress) {
      return;
    }
    this.monitorInProgress = true;

    for (const addr of this.configuredAddresses) {
      const state = this.devices.get(addr);
      if (state && state.connectionState === 'disconnected' && !this.connecting.has(addr)) {
        if (state.attempts >= BLE_MAX_CONNECTION_ATTEMPTS) {
          const timeSinceLastAttempt = Date.now() - state.lastAttempt;
          if (timeSinceLastAttempt < BLE_COOL_DOWN_PERIOD) {
            continue; // In cool-down period
          } else {
            this.log.info(`[BLE][${addr}] Cool-down period over. Resuming connection attempts.`);
            state.attempts = 0; // Reset attempts after cool-down
          }
        }
        this.connectToDevice(addr);
      }
    }
    this.monitorInProgress = false;
  }

  public async sendCommand(address: string, command: Buffer): Promise<void> {
    const addr = address.toLowerCase();
    const state = this.devices.get(addr);

    if (!state) {
      this.log.warn(`[BLE][${addr}] Cannot send command: device not found.`);
      return;
    }

    this.log.debug(`[BLE][${addr}] Adding command to queue: ${command.toString('hex')}`);
    state.commandQueue = [command];
    this.devices.set(addr, state);

    if (state.connectionState === 'connected' && state.characteristic) {
      this.log.debug(`[BLE][${addr}] Device is connected. Processing command queue.`);
      await this.processCommandQueue(addr);
    } else if (state.connectionState === 'disconnected' && !this.connecting.has(addr)) {
      this.log.info(`[BLE][${addr}] Device is disconnected. Initiating connection.`);
      this.connectToDevice(address);
    } 
  }

  private async processCommandQueue(addr: string): Promise<void> {
    const state = this.devices.get(addr);
    if (!state || state.commandQueue.length === 0 || state.connectionState !== 'connected' || !state.characteristic) {
      this.log.debug(`[BLE][${addr}] Command queue processing skipped: invalid state or empty queue.`);
      return;
    }
    const command = state.commandQueue.shift();
    if (!command) {
      this.log.debug(`[BLE][${addr}] Command queue processing skipped: no command to process.`);
      return;
    }
    try {
      this.log.debug(`[BLE][${addr}] Writing command to characteristic: ${command.toString('hex')}`);
      await state.characteristic.write(command, false);
      this.log.info(`[BLE][${addr}] Command successfully written.`);
      state.commandQueue = [];
      this.devices.set(addr, state);
    } catch (e) {
      this.log.error(`[BLE][${addr}] Failed to write command:`, e);
      state.commandQueue.unshift(command);
      this.devices.set(addr, state);
    }
  }
}
