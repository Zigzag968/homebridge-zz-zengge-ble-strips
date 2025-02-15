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

const serviceUUID: string = 'ffff';
const writeUUID: string = 'ff01';
const notifyUUID: string = 'ff02';

module.exports = (homebridge: API) => {
  hap = homebridge.hap;
  homebridge.registerPlatform(PLATFORM_NAME, ZenggeLedStripPlatform);
};

class BluetoothCommunicator {
  private readonly log: Logger;
  private readonly config: PlatformConfig;
  private readonly peripherals: Map<string, Peripheral> = new Map();
  private readonly characteristics: Map<string, any> = new Map();

  constructor(log: Logger, config: PlatformConfig) {
    this.log = log;
    this.config = config;
    this.setupNobleObservers();
  }

  startBluetoothScanning() {
    noble.startScanning([], false);
    this.log.info('Started Bluetooth scanning.');
  }

  async connectToDevice(address: string): Promise<void> {
    const peripheral = this.peripherals.get(address.toLowerCase());
    if (!peripheral) {
      this.log.error(`Peripheral with address ${address} not found.`);
      return;
    }

    try {
      await peripheral.connectAsync().then(async () => {
        this.log.info(`Connected to device: ${address}`);
        setTimeout(async () => {
          await this.discoverWriteCharacteristics(peripheral, address);
          await this.enableNotifications(peripheral, address);
          this.log.info('Device setup complete.');
        }, 500);
      });
    } catch (error) {
      this.log.error(`Error connecting to device ${address}:`, error);
    }
  }

  private async discoverWriteCharacteristics(peripheral: Peripheral, address: string) {
    const { characteristics: writeCharacteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [serviceUUID],
      [writeUUID]
    );

    if (writeCharacteristics.length > 0) {
      const characteristic = writeCharacteristics[0];
      this.characteristics.set(address.toLowerCase(), characteristic);
      this.log.info(`Write characteristic (${characteristic.uuid}) discovered for device: ${address}`);
    } else {
      this.log.error(`No write characteristics found for device: ${address}`);
    }
  }

  private async enableNotifications(peripheral: Peripheral, address: string) {
    const { characteristics: notifyCharacteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [serviceUUID],
      [notifyUUID]
    );

    if (notifyCharacteristics.length > 0) {
      const notifyCharacteristic = notifyCharacteristics[0];
      notifyCharacteristic.on('data', (data: any) => {
        this.log.info(`Notification received from ${address}: ${data.toString('hex')}`);
      });

      notifyCharacteristic.subscribe((error: any) => {
        if (error) {
          this.log.error(`Error subscribing to notifications for ${address}:`, error);
        } else {
          this.log.info(`Notifications enabled for ${address}`);
        }
      });
    } else {
      this.log.error(`No notify characteristics found for device: ${address}`);
    }
  }

  setupNobleObservers() {
    noble.on('scanStart', () => console.log("Scanning started"));
    noble.on('scanStop', () => console.log("Scanning stopped"));

    noble.on('stateChange', (state) => {
      if (state === 'poweredOn') {
        this.startBluetoothScanning();
        this.log.info('Started scanning for devices...');
      }
    });

    noble.on('discover', (peripheral: Peripheral) => {
      const address = peripheral.address.toLowerCase();
      if (this.config.devices.some((device: any) => device.address.toLowerCase() === address)) {
        this.deviceDiscovered(peripheral);
      }
    });


  let attemptCount = 0;
  let interval = 5000;

  setInterval(() => {
    const expectedDevices = this.config.devices.map((d: any) => d.address.toLowerCase());
    const missingDevices = expectedDevices.filter((addr: string) => {
    const peripheral = this.peripherals.get(addr);
    return !peripheral || peripheral.state !== 'connected';
    });

    if (missingDevices.length > 0) {
    this.log.warn(`Missing devices: ${missingDevices.join(', ')}`);
    this.startBluetoothScanning();
    attemptCount++;
    if (attemptCount > 5) {
      const intervals = [5000, 1800000, 3600000];
      interval = attemptCount <= 5 ? intervals[0] : attemptCount <= 10 ? intervals[1] : intervals[2];
    }
    } else {
    attemptCount = 0;
    interval = 5000;
    }
  }, interval);
  }

  private deviceDiscovered(peripheral: Peripheral) {
    if (peripheral.state === 'connected') {
      return;
    }
    const address = peripheral.address.toLowerCase();
    this.log.info(`Discovered new device: ${address}`);
    this.peripherals.set(address.toLowerCase(), peripheral);
    this.connectToDevice(address).then(() => {
      this.startBluetoothScanning();
    });
  }

  public async sendCommand(address: string, command: Buffer): Promise<void> {
    this.log.debug('sendCommand', command);

    const characteristic = this.characteristics.get(address.toLowerCase());
    if (!characteristic) {
      this.log.error(`No characteristic available for device: ${address}`);
      return;
    }

    try {
      await characteristic.write(command, true);
      this.log.info(`Command sent to device: ${address}`);
    } catch (error) {
      this.log.error(`Failed to send command to ${address}:`, error);
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
      exec('sudo /usr/local/bin/enable_bluetooth.sh', (error, stdout, stderr) => {
        if (error) {
          this.log.error(`Error enabling Bluetooth: ${error.message}`);
          return;
        }
        this.log.info('Bluetooth enable script executed.');
      });
    } else {
      exec('sudo /usr/local/bin/disable_bluetooth.sh', (error, stdout, stderr) => {
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
      exec('rfkill list bluetooth', (error: any, stdout: any, stderr: any) => {
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
    exec('sudo reboot', (error, stdout, stderr) => {
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
  
  // Gestion des "color stops"
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

    // Caractéristique On
    this.onService
      .getCharacteristic(hap.Characteristic.On)
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
      .setProps({ minValue: 0, maxValue: 360, minStep: 1 });
    this.onService.getCharacteristic(hap.Characteristic.Saturation)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 });
    this.onService.getCharacteristic(hap.Characteristic.Brightness)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 });

    // Enregistrement des callbacks pour la couleur primaire
    this.onService.getCharacteristic(hap.Characteristic.Hue)
      .onSet(this.setPrimaryHue.bind(this));
    this.onService.getCharacteristic(hap.Characteristic.Saturation)
      .onSet(this.setPrimarySaturation.bind(this));
    this.onService.getCharacteristic(hap.Characteristic.Brightness)
      .onSet(this.setPrimaryBrightness.bind(this));

    this.onService.setPrimaryService(true);
    this.onService.updateCharacteristic(hap.Characteristic.On, this.isOn);
    this.log(`Service Power (primary) créé pour ${this.name}`);
  }

  // Callback pour mettre à jour la couleur primaire
  async setPrimaryHue(value: CharacteristicValue): Promise<void> {
    this.primaryHue = value as number;
    this.onService.updateCharacteristic(hap.Characteristic.Hue, this.primaryHue);
    this.log(`Hue principale mise à jour: ${this.primaryHue}`);
    this.updateActiveColorStops();
    await this.updateGradientFromColorStops();
  }

  async setPrimarySaturation(value: CharacteristicValue): Promise<void> {
    this.primarySaturation = value as number;
    this.onService.updateCharacteristic(hap.Characteristic.Saturation, this.primarySaturation);
    this.log(`Saturation principale mise à jour: ${this.primarySaturation}`);
    this.updateActiveColorStops();
    await this.updateGradientFromColorStops();
  }

  async setPrimaryBrightness(value: CharacteristicValue): Promise<void> {
    this.primaryBrightness = value as number;
    this.onService.updateCharacteristic(hap.Characteristic.Brightness, this.primaryBrightness);
    this.log(`Brightness principale mise à jour: ${this.primaryBrightness}`);
    this.updateActiveColorStops();
    await this.updateGradientFromColorStops();
  }

  // Méthode optionnelle pour regrouper la mise à jour primaire
  async setPrimaryColor(): Promise<void> {
    const hue = this.onService.getCharacteristic(hap.Characteristic.Hue).value as number;
    const saturation = this.onService.getCharacteristic(hap.Characteristic.Saturation).value as number;
    const brightness = this.onService.getCharacteristic(hap.Characteristic.Brightness).value as number;

    this.primaryHue = hue;
    this.primarySaturation = saturation;
    this.primaryBrightness = brightness;
    this.log(`Couleur primaire mise à jour: Hue=${hue}, Sat=${saturation}, Bri=${brightness}`);

    this.updateActiveColorStops();
    await this.updateGradientFromColorStops();
  }

  // Met à jour les stops actifs (premier et dernier) avec les valeurs primaires
  private updateActiveColorStops(): void {
    this.sortedColorStops.forEach((stop, index) => {
      if (index === 0 || index === this.sortedColorStops.length - 1) {
        stop.isOn = true;
        stop.hue = this.primaryHue;
        stop.saturation = this.primarySaturation;
        // Utiliser la brightness propre au stop (qui peut être égale à primaryBrightness)
        stop.color = this.hsvToHex(stop.hue, stop.saturation, stop.brightness);
        stop.service.updateCharacteristic(hap.Characteristic.Hue, stop.hue);
        stop.service.updateCharacteristic(hap.Characteristic.Saturation, stop.saturation);
        stop.service.updateCharacteristic(hap.Characteristic.Brightness, this.primaryBrightness);
        stop.service.updateCharacteristic(hap.Characteristic.On, true);
      } else {
        stop.isOn = false;
        stop.service.updateCharacteristic(hap.Characteristic.On, false);
      }
    });
  }

  // Création des services de "color stops"
  private createColorStopServices(accessory: PlatformAccessory) {
    this.log('Creating color stop services...');
    for (let i = 0; i < this.NUM_STOPS; i++) {
      const serviceName = `Color Stop ${i + 1}`;
      const serviceId = `color-stop-${i + 1}`;
      const colorService =
        accessory.getServiceById(hap.Service.Lightbulb, serviceId) ||
        accessory.addService(hap.Service.Lightbulb, serviceName, serviceId);
      colorService.setCharacteristic(hap.Characteristic.Name, serviceName);

      // Configuration des caractéristiques On, Hue, Saturation et Brightness
      colorService.getCharacteristic(hap.Characteristic.On)
        .onSet((value) => this.setColorStopOn(i, value))
        .onGet(() => this.getColorStopOn(i));

      if (!colorService.testCharacteristic(hap.Characteristic.Hue)) {
        colorService.addCharacteristic(hap.Characteristic.Hue);
      }
      colorService.getCharacteristic(hap.Characteristic.Hue)
        .onSet((value) => this.setColorStopHue(i, value))
        .onGet(() => this.getColorStopHue(i))
        .setProps({ minValue: 0, maxValue: 360, minStep: 1 });

      if (!colorService.testCharacteristic(hap.Characteristic.Saturation)) {
        colorService.addCharacteristic(hap.Characteristic.Saturation);
      }
      colorService.getCharacteristic(hap.Characteristic.Saturation)
        .onSet((value) => this.setColorStopSaturation(i, value))
        .onGet(() => this.getColorStopSaturation(i))
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 });

      if (!colorService.testCharacteristic(hap.Characteristic.Brightness)) {
        colorService.addCharacteristic(hap.Characteristic.Brightness);
      }
      colorService.getCharacteristic(hap.Characteristic.Brightness)
        .onSet((value) => this.setColorStopBrightness(i, value))
        .onGet(() => this.getColorStopBrightness(i))
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 });

      // Initialisation par défaut pour chaque stop
      this.colorStops.push({
        index: i,
        service: colorService,
        isOn: false,
        hue: 30,           // Par défaut : teinte "chaude"
        saturation: 100,   // Saturation maximale
        brightness: 100,   // Brightness maximale
        color: 'FFD700',   // Couleur hex par défaut (gold)
      });
    }
  }

  preparePacket(packet: Buffer): Buffer {
    const count = this.getCounter();
    // Affecter les 2 premiers octets avec le compteur
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
    if (value) {
      await this.updateGradientFromColorStops();
    }
  }

  async getOn(): Promise<CharacteristicValue> {
    return this.isOn;
  }

  // Gestion des color stops

  async setColorStopOn(index: number, value: CharacteristicValue): Promise<void> {
    this.log(`setColorStopOn for stop ${index + 1} called with value:`, value);
    this.colorStops[index].isOn = value as boolean;
    this.colorStops[index].service.updateCharacteristic(hap.Characteristic.On, value);
    await this.updateGradientFromColorStops();
  }

  async getColorStopOn(index: number): Promise<CharacteristicValue> {
    return this.colorStops[index].isOn;
  }

  async setColorStopHue(index: number, value: CharacteristicValue): Promise<void> {
    this.log(`setColorStopHue for stop ${index + 1} called with value:`, value);
    this.colorStops[index].hue = value as number;
    // Mettez à jour la couleur en utilisant HSV (brightness fixée ici à 50 par défaut, ou utilisez stop.brightness)
    this.colorStops[index].color = this.hsvToHex(this.colorStops[index].hue, this.colorStops[index].saturation, this.colorStops[index].brightness);
    this.colorStops[index].service.updateCharacteristic(hap.Characteristic.Hue, value);
    await this.updateGradientFromColorStops();
  }

  async getColorStopHue(index: number): Promise<CharacteristicValue> {
    return this.colorStops[index].hue;
  }

  async setColorStopSaturation(index: number, value: CharacteristicValue): Promise<void> {
    this.log(`setColorStopSaturation for stop ${index + 1} called with value:`, value);
    this.colorStops[index].saturation = value as number;
    this.colorStops[index].color = this.hsvToHex(this.colorStops[index].hue, this.colorStops[index].saturation, this.colorStops[index].brightness);
    this.colorStops[index].service.updateCharacteristic(hap.Characteristic.Saturation, value);
    await this.updateGradientFromColorStops();
  }

  async getColorStopSaturation(index: number): Promise<CharacteristicValue> {
    return this.colorStops[index].saturation;
  }

  async setColorStopBrightness(index: number, value: CharacteristicValue): Promise<void> {
    this.log(`setColorStopBrightness for stop ${index + 1} called with value:`, value);
    this.colorStops[index].brightness = value as number;
    this.colorStops[index].color = this.hsvToHex(this.colorStops[index].hue, this.colorStops[index].saturation, this.colorStops[index].brightness);
    this.colorStops[index].service.updateCharacteristic(hap.Characteristic.Brightness, value);
    await this.updateGradientFromColorStops();
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
      // Si un seul stop est actif, le dupliquer
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

      // Utiliser hexToHsv pour obtenir les composantes HSV des stops
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