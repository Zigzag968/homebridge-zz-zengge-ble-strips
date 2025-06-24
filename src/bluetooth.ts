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
 
 export interface DeviceState {
   peripheral?: Peripheral;
   attempts: number;
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
         connectionState: 'disconnected',
         commandQueue: [],
       });
     }
     this.setupNoble();
   }
 
   startBluetoothScanning() {
     if (this.bleState === 'poweredOn' && !this.isScanning) {
       this.log.debug('Starting Bluetooth scan...');
       noble.startScanning([], true); // Allow duplicates for continuous discovery
     }
   }
 
   async connectToDevice(address: string): Promise<void> {
     const addr = address.toLowerCase();
 
     if (this.connecting.has(addr)) {
       this.log.debug(`Connection already in progress for ${address}, skipping.`);
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
         this.log.error(`Logic error: connectToDevice called for unconfigured device ${addr}`);
         return;
       }
 
       if (!state.peripheral) {
         this.log.warn(`[BLE][${addr}] Cannot connect: peripheral not discovered yet. Waiting for discovery.`);
         this.startBluetoothScanning();
         return;
       }
 
       state.connectionState = 'connecting';
       this.log.info(`[BLE][${addr}] Connecting...`);
 
       if (state.peripheral.state === 'connected') {
         this.log.debug(`Device ${address} already connected.`);
         state.connectionState = 'connected';
         return;
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
         return;
       }
       
       await new Promise(r => setTimeout(r, 200));
       await this.enableNotification(state.peripheral!, addr);
 
       state.attempts = 0;
       state.connectionState = 'connected';
       state.peripheral?.removeAllListeners('disconnect');
       state.peripheral?.once('disconnect', (error?: Error) => {
         if (error) {
           this.log.warn(`Device ${addr} disconnected unexpectedly: ${error.message}`);
         }
         this.handleDisconnect(addr);
       });
 
       this.devices.set(addr, state);
       this.processCommandQueue(addr);
 
     } catch (e) {
       this.log.error(`Error connecting to ${address}:`, e);
       const state = this.devices.get(addr);
       if (state) {
         state.attempts++;
         this.devices.set(addr, state);
         if (state.peripheral && (state.peripheral.state === 'connected' || state.peripheral.state === 'connecting')) {
           await state.peripheral.disconnectAsync().catch((err: Error) => this.log.error(`Error during disconnect after failure: ${err}`));
         }
       }
     } finally {
       this.connecting.delete(addr);
       this.connectionLock = false;
     }
   }
 
   private async retryWithBackoff(fn: () => Promise<void>, retries: number, addr: string): Promise<void> {
     let lastErr;
     for (let i = 0; i < retries; i++) {
       try {
         await fn();
         return;
       } catch (e) {
         lastErr = e;
         this.log.warn(`[BLE][${addr}] Connection attempt ${i + 1}/${retries} failed. Retrying...`);
         await new Promise(r => setTimeout(r, BLE_BACKOFF_BASE * (i + 1)));
       }
     }
     throw lastErr;
   }
 
   private handleDisconnect(addr: string) {
     const state = this.devices.get(addr);
     if (state) {
       this.logDevice(addr, 'Disconnected. Monitor will attempt to reconnect.');
       state.characteristic = undefined;
       state.connectionState = 'disconnected';
       state.attempts = 0;
       this.devices.set(addr, state);
     }
   }
 
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
 
   private logDevice(addr: string, msg: string) {
     this.log.info(`[BLE][${addr}] ${msg}`);
   }
 
   private deviceDiscovered(peripheral: Peripheral) {
     const addr = peripheral.address.toLowerCase();
     if (!this.configuredAddresses.includes(addr)) {
       return;
     }
     const state = this.devices.get(addr)!;
     const now = Date.now();
     if (now - state.lastDiscovery < BLE_DISCOVERY_DEBOUNCE) {
       return;
     }
     this.log.info(`[BLE][${addr}] Discovered. Peripheral is now available for connection attempts.`);
     state.peripheral = peripheral;
     state.lastDiscovery = now;
     this.devices.set(addr, state);
   }
 
   private setupNoble() {
     noble.on('scanStart', () => {
       this.isScanning = true;
       this.log.debug('Bluetooth scanning started.');
     });
     noble.on('scanStop', () => {
       this.isScanning = false;
       this.log.debug('Bluetooth scanning stopped.');
     });
     noble.on('stateChange', (state: string) => {
       this.bleState = state;
       this.log.info(`Bluetooth adapter state: ${state}`);
       if (state === 'poweredOn') {
         this.startBluetoothScanning();
       } else {
         noble.stopScanning();
       }
     });
     noble.on('discover', (peripheral: Peripheral) => this.deviceDiscovered(peripheral));
     setInterval(() => this.monitorConnections(), BLE_MONITOR_INTERVAL);
   }
 
   private async monitorConnections() {
     if (this.monitorInProgress) {
       return;
     }
     this.monitorInProgress = true;
     this.log.debug('Running proactive connection monitor...');
 
     for (const addr of this.configuredAddresses) {
       const state = this.devices.get(addr);
       if (state && state.connectionState === 'disconnected' && !this.connecting.has(addr)) {
         this.log.info(`[BLE][${addr}] Monitor found device disconnected. Attempting to connect.`);
         this.connectToDevice(addr);
       }
     }
     this.monitorInProgress = false;
   }
 
   public async sendCommand(address: string, command: Buffer): Promise<void> {
     const addr = address.toLowerCase();
     const state = this.devices.get(addr);
 
     if (!state) {
       this.log.error(`Device ${address} not configured.`);
       return;
     }
 
     state.commandQueue = [command];
     this.devices.set(addr, state);
 
     if (state.connectionState === 'connected' && state.characteristic) {
       await this.processCommandQueue(addr);
     } else if (state.connectionState === 'disconnected' && !this.connecting.has(addr)) {
       this.log.warn(`[BLE][${addr}] Device is disconnected. Queuing command and attempting to connect.`);
       await this.connectToDevice(address);
     } else {
       this.log.debug(`[BLE][${addr}] Device is busy (${state.connectionState}). Command queued.`);
     }
   }
 
   private async processCommandQueue(addr: string): Promise<void> {
     const state = this.devices.get(addr);
     if (!state || state.commandQueue.length === 0 || state.connectionState !== 'connected' || !state.characteristic) {
       return;
     }
     const command = state.commandQueue.shift();
     if (!command) {
       return;
     }
     try {
       this.log.debug(`Sending command to ${addr}: ${command.toString('hex')}`);
       await state.characteristic.write(command, true);
       this.log.debug(`Command sent to ${addr}`);
       state.commandQueue = [];
       this.devices.set(addr, state);
     } catch (e) {
       this.log.error(`Failed to write command to ${addr}:`, e);
       state.commandQueue.unshift(command);
       this.devices.set(addr, state);
     }
   }
 }