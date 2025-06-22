import { Buffer } from 'buffer';
import noble, { Peripheral } from '@abandonware/noble';
import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  CharacteristicValue,
  HAP,
} from 'homebridge';
import { exec } from 'child_process';

const PLATFORM_NAME = 'HomebridgeZzZenggeBleStrips';
const PACKAGE_NAME = 'homebridge-zz-zengge-ble-strips';

let hap: HAP;

export = (homebridge: API) => {
  hap = homebridge.hap;
  homebridge.registerPlatform(PLATFORM_NAME, ZenggeLedStripPlatform);
};

const BLE_SERVICE_UUID = 'ffff';
const BLE_WRITE_UUID = 'ff01';
const BLE_NOTIFY_UUID = 'ff02';
const BLE_CONNECT_RETRIES = 3;
const BLE_BACKOFF_BASE = 500;
const BLE_MONITOR_INTERVAL = 5000;
const BLE_DISCOVERY_DEBOUNCE = 10000;
const BLE_MONITOR_MAX_RETRIES = 3;

interface DeviceState {
  peripheral?: Peripheral;
  attempts: number;
  monitorAttempts: number;
  lastDiscovery: number;
  characteristic?: any;
  connectionState: 'disconnected' | 'connecting' | 'connected' | 'disconnecting';
  commandQueue: Buffer[];
}

class BluetoothCommunicator {
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

type DeviceConfig = {
  name: string;
  address: string;
  trames: { name: string; trame: string }[];
};

class ZenggeLedStripPlatform implements DynamicPlatformPlugin {
  private readonly log: Logger;
  private readonly config: PlatformConfig;
  private readonly accessories: PlatformAccessory[] = [];
  private readonly homebridge: API;
  private readonly bluetoothCommunicator: BluetoothCommunicator;
  private bluetoothSwitchAccessory: PlatformAccessory | null = null;
  private bluetoothEnabled: boolean = true;

  constructor(log: Logger, config: PlatformConfig, homebridge: API) {
    this.log = log;
    this.config = config;
    this.homebridge = homebridge;
    this.bluetoothCommunicator = new BluetoothCommunicator(log, config);

    homebridge.on('didFinishLaunching', () => {
      this.initializePlatform();
    });
  }

  private initializePlatform() {
    if (!this.config.devices) {
      this.log.error('No devices configured');
      return;
    }
    this.log.info('ZenggeLedStrip platform initializing...');

    this.config.devices.forEach((deviceConfig: any) => {
      const address = deviceConfig.address;
      const name = deviceConfig.name;

      if (!address) {
        this.log.error('Missing device address in configuration.');
        return;
      }
      if (!name) {
        this.log.error('Missing device name in configuration.');
        return;
      }

      const uuid = this.homebridge.hap.uuid.generate(`${address}`);

      let accessory = this.accessories.find((accessory) => accessory.UUID === uuid);
      if (!accessory) {
        accessory = new this.homebridge.platformAccessory(name, uuid);
        accessory.context.deviceAddress = address;
        accessory.context.deviceConfig = deviceConfig;
        deviceConfig.trames = (this.config.trames || []).concat(deviceConfig.trames || []);

        const controller = new ZenggeLedStripPlatformAccessory(this.bluetoothCommunicator, this.log, deviceConfig, accessory);
        accessory.context.controller = controller;
        controller.configure(accessory);

        this.homebridge.registerPlatformAccessories(
          PACKAGE_NAME,
          PLATFORM_NAME,
          [accessory],
        );

        this.accessories.push(accessory);
      } else {
        this.log.info(`Accessory ${accessory.displayName} is cached.`);
        const controller = new ZenggeLedStripPlatformAccessory(this.bluetoothCommunicator, this.log, deviceConfig, accessory);
        accessory.context.controller = controller;
        controller.configure(accessory);
        this.accessories.push(accessory);
      }
    });

    this.initializeBluetoothSwitchAccessory();
    this.initializeRebootSwitchAccessory();
    this.log.info('Initialization complete.');
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info(`Configuring cached accessory: ${accessory.displayName}`);

    if (accessory.context.isHostBluetoothSwitch) {
      this.bluetoothSwitchAccessory = accessory;
      this.configureBluetoothSwitchAccessory(accessory);
      this.accessories.push(accessory);
      return;
    }

    const deviceAddress = accessory.context.deviceAddress;

    if (!deviceAddress) {
      this.log.error('No deviceAddress found in context for accessory:', accessory.displayName);
      return;
    }

    const deviceConfig = this.config.devices.find(
      (device: any) => device.address === deviceAddress,
    );

    if (!deviceConfig) {
      this.log.warn(`No device configuration found for deviceAddress ${deviceAddress}.`);
      return;
    }

    deviceConfig.trames = (this.config.trames || []).concat(deviceConfig.trames || []);

    const controller = new ZenggeLedStripPlatformAccessory(this.bluetoothCommunicator, this.log, deviceConfig, accessory);
    accessory.context.controller = controller;
    controller.configure(accessory);
    this.accessories.push(accessory);
  }

  private initializeBluetoothSwitchAccessory() {
    const uuid = this.homebridge.hap.uuid.generate('HostBluetoothSwitch');
    let accessory = this.accessories.find((accessory) => accessory.UUID === uuid);

    if (accessory) {
      this.log.info('Host Bluetooth Switch accessory already exists.');
      this.bluetoothSwitchAccessory = accessory;
      this.configureBluetoothSwitchAccessory(accessory);
    } else {
      accessory = new this.homebridge.platformAccessory('Host Bluetooth', uuid);
      accessory.category = hap.Categories.SWITCH;

      this.configureBluetoothSwitchAccessory(accessory);

      this.homebridge.registerPlatformAccessories(
        PACKAGE_NAME,
        PLATFORM_NAME,
        [accessory],
      );

      this.bluetoothSwitchAccessory = accessory;
      this.accessories.push(accessory);
    }
  }

  private configureBluetoothSwitchAccessory(accessory: PlatformAccessory) {
    const switchService =
      accessory.getService(hap.Service.Switch) ||
      accessory.addService(hap.Service.Switch, 'Host Bluetooth', 'host-bluetooth-switch');

    switchService
      .getCharacteristic(hap.Characteristic.On)
      .onSet(this.setHostBluetoothEnabled.bind(this))
      .onGet(this.getHostBluetoothEnabled.bind(this));

    accessory
      .getService(hap.Service.AccessoryInformation)!
      .setCharacteristic(hap.Characteristic.Manufacturer, 'YourCompany')
      .setCharacteristic(hap.Characteristic.Model, 'Host Bluetooth Switch')
      .setCharacteristic(hap.Characteristic.SerialNumber, 'HB-001');

    accessory.context.isHostBluetoothSwitch = true;
  }

  private async setHostBluetoothEnabled(value: CharacteristicValue) {
    this.bluetoothEnabled = value as boolean;
    this.log.info(`Host Bluetooth enabled set to: ${this.bluetoothEnabled}`);

    if (this.bluetoothEnabled) {
      exec('sudo /usr/local/bin/enable_bluetooth.sh', (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          this.log.error(`Error enabling Bluetooth: ${error.message}`);
          return;
        }
        this.log.info('Bluetooth enable script executed.');
      });
    } else {
      exec('sudo /usr/local/bin/disable_bluetooth.sh', (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          this.log.error(`Error disabling Bluetooth: ${error.message}`);
          return;
        }
        this.log.info('Bluetooth disable script executed.');
        noble.stopScanning();
      });
    }
  }

  private async getHostBluetoothEnabled(): Promise<CharacteristicValue> {
    return new Promise((resolve, reject) => {
      exec('rfkill list bluetooth', (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          this.log.error(`Error checking Bluetooth status: ${error.message}`);
          return reject(error);
        }
        const isBlocked =
          stdout.includes('Soft blocked: yes') || stdout.includes('Hard blocked: yes');
        resolve(!isBlocked);
      });
    });
  }
private initializeRebootSwitchAccessory() {
  const uuid = this.homebridge.hap.uuid.generate('HostRebootSwitch');
  let accessory = this.accessories.find((accessory) => accessory.UUID === uuid);

  if (accessory) {
    this.log.info('Host Reboot Switch accessory already exists.');
    this.configureRebootSwitchAccessory(accessory);
  } else {
    accessory = new this.homebridge.platformAccessory('Host Reboot', uuid);
    accessory.category = hap.Categories.SWITCH;

    this.configureRebootSwitchAccessory(accessory);

    this.homebridge.registerPlatformAccessories(
      PACKAGE_NAME,
      PLATFORM_NAME,
      [accessory],
    );

    this.accessories.push(accessory);
  }
}

private configureRebootSwitchAccessory(accessory: PlatformAccessory) {
  const switchService =
    accessory.getService(hap.Service.Switch) ||
    accessory.addService(hap.Service.Switch, 'Host Reboot', 'host-reboot-switch');

  switchService
    .getCharacteristic(hap.Characteristic.On)
    .onSet(this.setHostReboot.bind(this))
    .onGet(this.getHostReboot.bind(this));

  accessory
    .getService(hap.Service.AccessoryInformation)!
    .setCharacteristic(hap.Characteristic.Manufacturer, 'YourCompany')
    .setCharacteristic(hap.Characteristic.Model, 'Host Reboot Switch')
    .setCharacteristic(hap.Characteristic.SerialNumber, 'HB-002');

  accessory.context.isHostRebootSwitch = true;
}

private async setHostReboot(value: CharacteristicValue) {
  if (value as boolean) {
    this.log.info('Rebooting host...');
    exec('sudo reboot', (error: Error | null, stdout: string, stderr: string) => {
      if (error) {
        this.log.error(`Error rebooting host: ${error.message}`);
        return;
      }
      this.log.info('Host reboot command executed.');
    });
  }
}

private async getHostReboot(): Promise<CharacteristicValue> {
  return false; // Always return false as the switch should be momentary
}
}

interface ColorStop {
  index: number;
  service: Service;
  isOn: boolean;
  hue: number;
  saturation: number;
  brightness: number;
  color: string;
}

class ZenggeLedStripPlatformAccessory {
  private readonly logger: Logger;
  private readonly name: string;
  private bluetoothCommunicator: BluetoothCommunicator;
  readonly deviceAddress: string;
  private accessory: PlatformAccessory;
  private isOn: boolean = false;
  private onService!: Service;
  private gradientUpdateTimeout: ReturnType<typeof setTimeout> | null = null;

  // Gestion des color stops
  private colorStops: ColorStop[] = [];
  private NUM_STOPS: number = 5;
  get sortedColorStops(): ColorStop[] {
    return this.colorStops.sort((a, b) => a.index - b.index);
  }

  private counter: number = 0;

  // Valeurs primaires issues du service principal (HSV)
  private primaryHue: number = 0;
  private primarySaturation: number = 100;
  private primaryBrightness: number = 100;

  constructor(
    bluetoothCommunicator: BluetoothCommunicator,
    logger: Logger,
    config: DeviceConfig,
    accessory: PlatformAccessory
  ) {
    this.bluetoothCommunicator = bluetoothCommunicator;
    this.logger = logger;
    this.name = config.name || 'Zengge LED Strip';
    this.deviceAddress = config.address;
    this.accessory = accessory;
    this.log('Accessory initialized:', this.name);
  }

  log(...messages: any[]) {
    const message = messages
      .map((msg) => (typeof msg === 'object' ? JSON.stringify(msg) : msg))
      .join(' ');
    this.logger.info(`[${this.name}] ${message}`);
  }

  error(...messages: any[]) {
    const message = messages
      .map((msg) => (typeof msg === 'object' ? JSON.stringify(msg) : msg))
      .join(' ');
    this.logger.error(`[${this.name}] ${message}`);
  }

  configure(accessory: PlatformAccessory) {
    accessory.category = hap.Categories.LIGHTBULB;
    this.createPowerSwitchService(accessory);
    this.createColorStopServices(accessory);

    const accessoryInfoService = accessory.getService(hap.Service.AccessoryInformation);
    if (accessoryInfoService) {
      accessoryInfoService
        .setCharacteristic(hap.Characteristic.Manufacturer, 'Zengge')
        .setCharacteristic(hap.Characteristic.Model, PLATFORM_NAME)
        .setCharacteristic(hap.Characteristic.SerialNumber, this.deviceAddress)
        .setCharacteristic(hap.Characteristic.Name, this.name);
    } else {
      this.logger.error('Accessory Information Service not found');
    }
  }

  private createPowerSwitchService(accessory: PlatformAccessory) {
    this.isOn = accessory.context.isOn || false;
    this.onService =
      accessory.getServiceById(hap.Service.Lightbulb, 'power-service') ||
      accessory.addService(hap.Service.Lightbulb, 'Power', 'power-service');
    this.onService.setCharacteristic(hap.Characteristic.Name, 'Power');

    // On
    this.onService.getCharacteristic(hap.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    // Ajout et configuration des caractéristiques Hue, Saturation et Brightness
    if (!this.onService.testCharacteristic(hap.Characteristic.Hue)) {
      this.onService.addCharacteristic(hap.Characteristic.Hue);
    }
    if (!this.onService.testCharacteristic(hap.Characteristic.Saturation)) {
      this.onService.addCharacteristic(hap.Characteristic.Saturation);
    }
    if (!this.onService.testCharacteristic(hap.Characteristic.Brightness)) {
      this.onService.addCharacteristic(hap.Characteristic.Brightness);
    }

    this.onService.getCharacteristic(hap.Characteristic.Hue)
      .setProps({ minValue: 0, maxValue: 360, minStep: 1 })
      .onSet(this.setPrimaryHue.bind(this));
    this.onService.getCharacteristic(hap.Characteristic.Saturation)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onSet(this.setPrimarySaturation.bind(this));
    this.onService.getCharacteristic(hap.Characteristic.Brightness)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onSet(this.setPrimaryBrightness.bind(this));

    this.onService.setPrimaryService(true);
    this.onService.updateCharacteristic(hap.Characteristic.On, this.isOn);
    this.log(`Service Power (primary) created for ${this.name}`);
  }

  // Callbacks pour mettre à jour les valeurs primaires (HSV)
  async setPrimaryHue(value: CharacteristicValue): Promise<void> {
    this.primaryHue = value as number;
    this.onService.updateCharacteristic(hap.Characteristic.Hue, this.primaryHue);
    this.log(`Primary Hue updated: ${this.primaryHue}`);
    this.updateActiveColorStops();
    await this.scheduleGradientUpdate();
  }

  async setPrimarySaturation(value: CharacteristicValue): Promise<void> {
    this.primarySaturation = value as number;
    this.onService.updateCharacteristic(hap.Characteristic.Saturation, this.primarySaturation);
    this.log(`Primary Saturation updated: ${this.primarySaturation}`);
    this.updateActiveColorStops();
    await this.scheduleGradientUpdate();
  }

  async setPrimaryBrightness(value: CharacteristicValue): Promise<void> {
    this.primaryBrightness = value as number;
    this.onService.updateCharacteristic(hap.Characteristic.Brightness, this.primaryBrightness);
    this.log(`Primary Brightness updated: ${this.primaryBrightness}`);
    this.updateActiveColorStops();
    await this.scheduleGradientUpdate();
  }

  // Optionnelle : mise à jour groupée de la couleur primaire
  async setPrimaryColor(): Promise<void> {
    const hue = this.onService.getCharacteristic(hap.Characteristic.Hue).value as number;
    const saturation = this.onService.getCharacteristic(hap.Characteristic.Saturation).value as number;
    const brightness = this.onService.getCharacteristic(hap.Characteristic.Brightness).value as number;
    this.primaryHue = hue;
    this.primarySaturation = saturation;
    this.primaryBrightness = brightness;
    this.log(`Primary color updated: Hue=${hue}, Sat=${saturation}, Bri=${brightness}`);
    this.updateActiveColorStops();
    await this.scheduleGradientUpdate();
  }

  // Propager les valeurs primaires aux stops actifs (premier et dernier)
  private updateActiveColorStops(): void {
    this.sortedColorStops.forEach((stop, index) => {
      if (index === 0 || index === this.sortedColorStops.length - 1) {
        stop.isOn = true;
        stop.hue = this.primaryHue;
        stop.saturation = this.primarySaturation;
        stop.brightness = this.primaryBrightness;
        stop.color = this.hsvToHex(stop.hue, stop.saturation, stop.brightness);
        stop.service.updateCharacteristic(hap.Characteristic.Hue, stop.hue);
        stop.service.updateCharacteristic(hap.Characteristic.Saturation, stop.saturation);
        stop.service.updateCharacteristic(hap.Characteristic.Brightness, stop.brightness);
        stop.service.updateCharacteristic(hap.Characteristic.On, true);
      } else {
        stop.isOn = false;
        stop.service.updateCharacteristic(hap.Characteristic.On, false);
      }
    });
  }

  // Création des services pour chaque "color stop"
  private createColorStopServices(accessory: PlatformAccessory): void {
    this.log('Creating color stop services...');
    for (let i = 0; i < this.NUM_STOPS; i++) {
      const serviceName = `Color Stop ${i + 1}`;
      const serviceId = `color-stop-${i + 1}`;
      const colorService =
        accessory.getServiceById(hap.Service.Lightbulb, serviceId) ||
        accessory.addService(hap.Service.Lightbulb, serviceName, serviceId);
      colorService.setCharacteristic(hap.Characteristic.Name, serviceName);

      colorService.getCharacteristic(hap.Characteristic.On)
        .onSet((value: CharacteristicValue) => this.setColorStopOn(i, value))
        .onGet(() => this.getColorStopOn(i));

      if (!colorService.testCharacteristic(hap.Characteristic.Hue)) {
        colorService.addCharacteristic(hap.Characteristic.Hue);
      }
      colorService.getCharacteristic(hap.Characteristic.Hue)
        .setProps({ minValue: 0, maxValue: 360, minStep: 1 })
        .onSet((value: CharacteristicValue) => this.setColorStopHue(i, value))
        .onGet(() => this.getColorStopHue(i));

      if (!colorService.testCharacteristic(hap.Characteristic.Saturation)) {
        colorService.addCharacteristic(hap.Characteristic.Saturation);
      }
      colorService.getCharacteristic(hap.Characteristic.Saturation)
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
        .onSet((value: CharacteristicValue) => this.setColorStopSaturation(i, value))
        .onGet(() => this.getColorStopSaturation(i));

      if (!colorService.testCharacteristic(hap.Characteristic.Brightness)) {
        colorService.addCharacteristic(hap.Characteristic.Brightness);
      }
      colorService.getCharacteristic(hap.Characteristic.Brightness)
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
        .onSet((value: CharacteristicValue) => this.setColorStopBrightness(i, value))
        .onGet(() => this.getColorStopBrightness(i));

      // Initialisation par défaut pour ce stop
      this.colorStops.push({
        index: i,
        service: colorService,
        isOn: false,
        hue: 30,
        saturation: 100,
        brightness: 100,
        color: 'FFD700',
      });
    }
  }

  preparePacket(packet: Buffer): Buffer {
    const count = this.getCounter();
    packet[0] = (0xff00 & count) >> 8;
    packet[1] = 0x00ff & count;
    return packet;
  }

  getCounter(): number {
    return this.counter++;
  }

  async sendCommand(command: Buffer) {
    return this.bluetoothCommunicator.sendCommand(this.deviceAddress, this.preparePacket(command));
  }

  async setPower(value: boolean) {
    const onBuffer = Buffer.from('00048000000d0e0b3b230000000000000032000090', 'hex');
    const offBuffer = Buffer.from('005b8000000d0e0b3b240000000000000032000091', 'hex');
    const command = value ? onBuffer : offBuffer;
    await this.sendCommand(command);
    this.isOn = value;
    this.accessory.context.isOn = value;
    this.onService.updateCharacteristic(hap.Characteristic.On, value);
    this.log('Power state set to:', value);
  }

  async setOn(value: CharacteristicValue): Promise<void> {
    this.log('setOn called with value:', value);
    await this.setPower(value as boolean);
    if (value === true) {
      // Augmentez le délai pour vous assurer que le ruban a bien alimenté
      await new Promise(resolve => setTimeout(resolve, 500)); // Passez de 500ms à 1000ms
      await this.scheduleGradientUpdate();
    }
  }

  async getOn(): Promise<CharacteristicValue> {
    return this.isOn;
  }

  async scheduleGradientUpdate(): Promise<void> {
    if (this.gradientUpdateTimeout) {
      clearTimeout(this.gradientUpdateTimeout);
    }
    // Wait 500ms (adjust as needed) before updating the gradient.
    this.gradientUpdateTimeout = setTimeout(async () => {
      await this.updateGradientFromColorStops();
    }, 500);
  }

  // Gestion des color stops

  async setColorStopOn(index: number, value: CharacteristicValue): Promise<void> {
    this.log(`setColorStopOn for stop ${index + 1} called with value:`, value);
    this.colorStops[index].isOn = value as boolean;
    this.colorStops[index].service.updateCharacteristic(hap.Characteristic.On, value);
    await this.scheduleGradientUpdate();
  }

  async getColorStopOn(index: number): Promise<CharacteristicValue> {
    return this.colorStops[index].isOn;
  }

  async setColorStopHue(index: number, value: CharacteristicValue): Promise<void> {
    this.log(`setColorStopHue for stop ${index + 1} called with value:`, value);
    this.colorStops[index].hue = value as number;
    this.colorStops[index].color = this.hsvToHex(
      this.colorStops[index].hue,
      this.colorStops[index].saturation,
      this.colorStops[index].brightness
    );
    this.colorStops[index].service.updateCharacteristic(hap.Characteristic.Hue, value);
    await this.scheduleGradientUpdate();
  }

  async getColorStopHue(index: number): Promise<CharacteristicValue> {
    return this.colorStops[index].hue;
  }

  async setColorStopSaturation(index: number, value: CharacteristicValue): Promise<void> {
    this.log(`setColorStopSaturation for stop ${index + 1} called with value:`, value);
    this.colorStops[index].saturation = value as number;
    this.colorStops[index].color = this.hsvToHex(
      this.colorStops[index].hue,
      this.colorStops[index].saturation,
      this.colorStops[index].brightness
    );
    this.colorStops[index].service.updateCharacteristic(hap.Characteristic.Saturation, value);
    await this.scheduleGradientUpdate();
  }

  async getColorStopSaturation(index: number): Promise<CharacteristicValue> {
    return this.colorStops[index].saturation;
  }

  async setColorStopBrightness(index: number, value: CharacteristicValue): Promise<void> {
    this.log(`setColorStopBrightness for stop ${index + 1} called with value:`, value);
    this.colorStops[index].brightness = value as number;
    this.colorStops[index].color = this.hsvToHex(
      this.colorStops[index].hue,
      this.colorStops[index].saturation,
      this.colorStops[index].brightness
    );
    this.colorStops[index].service.updateCharacteristic(hap.Characteristic.Brightness, value);
    await this.scheduleGradientUpdate();
  }

  async getColorStopBrightness(index: number): Promise<CharacteristicValue> {
    return this.colorStops[index].brightness;
  }

  // Conversion HSV -> Hexadécimal
  hsvToHex(h: number, s: number, v: number): string {
    s /= 100;
    v /= 100;
    const c = v * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) {
      r = c; g = x;
    } else if (h < 120) {
      r = x; g = c;
    } else if (h < 180) {
      g = c; b = x;
    } else if (h < 240) {
      g = x; b = c;
    } else if (h < 300) {
      r = x; b = c;
    } else {
      r = c; b = x;
    }
    const R = Math.round((r + m) * 255);
    const G = Math.round((g + m) * 255);
    const B = Math.round((b + m) * 255);
    return (
      R.toString(16).toUpperCase().padStart(2, "0") +
      G.toString(16).toUpperCase().padStart(2, "0") +
      B.toString(16).toUpperCase().padStart(2, "0")
    );
  }

  /**
   * Met à jour le gradient en se basant sur les stops activés.
   */
  async updateGradientFromColorStops(): Promise<void> {
    const activeStops = this.sortedColorStops.filter((stop) => stop.isOn);
    if (activeStops.length === 0) {
      this.log('Aucun color stop activé, pas de mise à jour du dégradé.');
      return;
    }

    let stopsToUse: Array<{ color: string; pos: number }> = [];
    if (activeStops.length > 1) {
      const count = activeStops.length;
      activeStops.forEach((stop, index) => {
        const pos = index / (count - 1);
        stopsToUse.push({ color: stop.color, pos });
      });
    } else {
      stopsToUse.push({ color: activeStops[0].color, pos: 0 });
      stopsToUse.push({ color: activeStops[0].color, pos: 1 });
    }

    await this.setCustomGradient(1, stopsToUse);
  }

  /**
   * Génère la trame de gradient en interpolant en espace HSV et envoie la commande.
   */
  async setCustomGradient(
    mode: number,
    stops: Array<{ color: string; pos: number }>
  ): Promise<void> {
    stops.sort((a, b) => a.pos - b.pos);

    let header: string;
    let footer: string;
    switch (mode) {
      case 1:
        header = "002880000063640B590063";
        footer = "001E016400BF";
        break;
      case 2:
        header = "000880000063640B590063";
        footer = "001E02360043";
        break;
      case 3:
        header = "001C80000063640B590063";
        footer = "001E02640064";
        break;
      default:
        this.logger.error("Mode invalide:", mode);
        return;
    }

    const numWords = 30;
    let gradientTable = "";

    for (let i = 0; i < numWords; i++) {
      const t = i / (numWords - 1);
      let lowerStop = stops[0], upperStop = stops[stops.length - 1];
      for (let j = 0; j < stops.length - 1; j++) {
        if (t >= stops[j].pos && t <= stops[j + 1].pos) {
          lowerStop = stops[j];
          upperStop = stops[j + 1];
          break;
        }
      }
      const localT = lowerStop.pos === upperStop.pos ? 0 : (t - lowerStop.pos) / (upperStop.pos - lowerStop.pos);

      // Obtenir les composantes HSV des stops à partir du code hex
      const lowerHSV = this.hexToHsv(lowerStop.color);
      const upperHSV = this.hexToHsv(upperStop.color);

      const interpolatedHue = this.interpolateHue(lowerHSV.h, upperHSV.h, localT);
      const interpolatedSaturation = lowerHSV.s + (upperHSV.s - lowerHSV.s) * localT;
      const interpolatedValue = lowerHSV.v + (upperHSV.v - lowerHSV.v) * localT;

      const interpolatedHex = this.hsvToHex(interpolatedHue, interpolatedSaturation, interpolatedValue);
      gradientTable += interpolatedHex;
    }

    const commandHex = header + gradientTable + footer;
    if (commandHex.length !== 214) {
      this.logger.error(`La trame générée contient ${commandHex.length} caractères (attendu: 214).`);
      return;
    }

    const command = Buffer.from(commandHex, "hex");
    this.log("Setting gradient with command:", commandHex, `(${commandHex.length} caractères)`);
    await this.sendCommand(command);
  }

  /**
   * Convertit une couleur hexadécimale (RRGGBB) en HSV.
   * Retourne un objet avec h (0-360), s et v (0-100).
   */
  private hexToHsv(hex: string): { h: number; s: number; v: number } {
    hex = hex.replace(/^#/, "");
    if (hex.length === 3) {
      hex = hex.split("").map(c => c + c).join("");
    }
    const r = parseInt(hex.substring(0, 2), 16) / 255;
    const g = parseInt(hex.substring(2, 4), 16) / 255;
    const b = parseInt(hex.substring(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let h = 0;
    if (delta !== 0) {
      if (max === r) {
        h = 60 * (((g - b) / delta) % 6);
      } else if (max === g) {
        h = 60 * (((b - r) / delta) + 2);
      } else {
        h = 60 * (((r - g) / delta) + 4);
      }
    }
    if (h < 0) h += 360;
    const s = max === 0 ? 0 : (delta / max) * 100;
    const v = max * 100;
    return { h, s, v };
  }

  /**
   * Interpole linéairement la teinte en tenant compte de la circularité (0° = 360°).
   */
  private interpolateHue(h1: number, h2: number, t: number): number {
    let delta = h2 - h1;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    return (h1 + t * delta + 360) % 360;
  }
}