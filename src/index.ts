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

class ZenggeLedStripPlatformAccessory {
  private readonly logger: Logger;
  private readonly name: string;
  private bluetoothCommunicator: BluetoothCommunicator;
  readonly deviceAddress: string;
  private accessory: PlatformAccessory;
  private isOn: boolean = false;
  private onService!: Service;
  private trames: { name: string; trame: string }[] = [];
  private trameStates: { [key: string]: boolean } = {};
  private trameServices: { [key: string]: Service } = {};
  private counter: number = 0;

  constructor(bluetoothCommunicator: BluetoothCommunicator, logger: Logger, config: DeviceConfig, accessory: PlatformAccessory) {
    this.bluetoothCommunicator = bluetoothCommunicator;
    this.logger = logger;
    this.name = config.name || 'Zengge LED Strip';
    this.trames = config.trames || [];
    this.deviceAddress = config.address;
    this.accessory = accessory;
    this.log('Trames:', this.trames);
  }

  log(...messages: any[]) {
    const message = messages.map((msg) => (typeof msg === 'object' ? JSON.stringify(msg) : msg)).join(' ');
    this.logger.info(`[${this.name}] ${message}`);
  }

  error(...messages: any[]) {
    const message = messages.map((msg) => (typeof msg === 'object' ? JSON.stringify(msg) : msg)).join(' ');
    this.logger.error(`[${this.name}] ${message}`);
  }

  configure(accessory: PlatformAccessory) {
    accessory.category = hap.Categories.LIGHTBULB;
    this.createPowerSwitchService(accessory);
    this.createTrameSwitchServices(accessory);

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
    this.onService = accessory.getServiceById(hap.Service.Lightbulb, 'power-service') || accessory.addService(hap.Service.Lightbulb, 'Power', 'power-service');
    this.onService.setCharacteristic(hap.Characteristic.Name, 'Power');
    this.onService.getCharacteristic(hap.Characteristic.On).onSet(this.setOn.bind(this)).onGet(this.getOn.bind(this));
    this.onService.setPrimaryService(true);
    this.onService.updateCharacteristic(hap.Characteristic.On, this.isOn);
    this.log(`Set Power service as primary for accessory: ${this.name}`);
  }

  private createTrameSwitchServices(accessory: PlatformAccessory) {
    this.log('Creating trame switch services...', this.trames.map((trame: any) => trame.name).join(', '));
    this.trames.forEach((trame) => {
      const trameName = trame.name;
      const serviceName = trameName;
      const serviceSubType = `trame-${Buffer.from(trameName).toString('hex')}`;
      const trameService = accessory.getServiceById(hap.Service.Switch, serviceSubType) || accessory.addService(hap.Service.Switch, serviceName, serviceSubType);
      trameService.setCharacteristic(hap.Characteristic.Name, trameName);
      trameService.getCharacteristic(hap.Characteristic.On).onSet(this.setTrame.bind(this, trameName)).onGet(this.getTrame.bind(this, trameName));
      this.trameStates[trameName] = false;
      this.trameServices[trameName] = trameService;
    });
  }

  preparePacket(packet: Buffer): Buffer {
    const count = this.getCounter();
    packet[0] = 0xff00 & count;
    packet[1] = 0x00ff & count;
    return packet;
  }

  getCounter(): number {
    return this.counter++;
  }

  async sendCommand(command: Buffer) {
    return this.bluetoothCommunicator.sendCommand(this.deviceAddress, this.preparePacket(command));
  }

  async setPattern(index: number) {
    let command: Buffer | null = null;
    switch (index) {
      case 1:
        command = Buffer.from('000f80000063640b590063e543ffe049f8db4ff1d656ead15ce3cc63dcc769d6c270cfbd76c8b87dc1b383baae8ab3a990ada497a69f9d9f9aa49895aa918fb18a8bb78486be7d81c4767ccb6f77d16872d8616cde5b68e55463eb4d5df24659f83f54ff39001e0164009d', 'hex');
        break;
      case 2:
        command = Buffer.from('000980000063640b5900630059ff0055ff0052ff004fff004cff0049ff0046ff0043ff0040ff003dff003aff0037ff0034ff0031ff002eff002aff0027ff0024ff0021ff001eff001bff0018ff0015ff0012ff000fff000cff0009ff0006ff0003ff0000ff001e0227000e', 'hex');
        break;
      case 3:
        command = Buffer.from('000680000063640b590063ff0000f60008ed0011e4001adb0023d3002bca0034c1003db80046af004fa700579e00619500698c007283007b7b008372008c69009560009e5700a74f00af4600b83d00c13400ca2b00d32300db1a00e41100ed0800f60000ff001e01640005', 'hex');
        break;
      default:
        this.logger.error('Invalid pattern index:', index);
        return;
    }
    if (!command) {
      this.logger.error('Command not found for pattern index:', index);
      return;
    }
    this.log('Setting pattern:', index); 
    await this.sendCommand(command);
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
  }

  async getOn(): Promise<CharacteristicValue> {
    return this.isOn;
  }

  async setCustomGradient(
    mode: number,
    stops: Array<{ color: string; pos: number }>
  ): Promise<void> {
    // On s'assure que les stops sont triés par position croissante
    stops.sort((a, b) => a.pos - b.pos);
  
    // Choix du header et footer en fonction du mode (les 2 premiers octets et les 6 derniers octets varient)
    let header: string;
    let footer: string;
    switch (mode) {
      case 1: // dégradé entre 2 oranges claires
        header = "002880000063640B590063";
        footer = "001E016400BF";
        break;
      case 2: // dégradé entre 2 bleu
        header = "000880000063640B590063";
        footer = "001E02360043";
        break;
      case 3: // dégradé entre 2 rose
        header = "001C80000063640B590063";
        footer = "001E02640064";
        break;
      default:
        this.logger.error("Invalid mode:", mode);
        return;
    }
    
    // Le gradient table doit comporter 30 "words" (chaque word = 3 octets = 6 hex)
    const numWords = 30;
    let gradientTable = "";
    
    // Pour chaque segment (i de 0 à 29), on calcule t entre 0 et 1
    for (let i = 0; i < numWords; i++) {
      const t = i / (numWords - 1);
      // Trouver les deux stops entre lesquels t se trouve
      let lower = stops[0],
          upper = stops[stops.length - 1];
      for (let j = 0; j < stops.length - 1; j++) {
        if (t >= stops[j].pos && t <= stops[j + 1].pos) {
          lower = stops[j];
          upper = stops[j + 1];
          break;
        }
      }
      // Normaliser t entre lower.pos et upper.pos (attention à la division par zéro)
      const localT =
        lower.pos === upper.pos
          ? 0
          : (t - lower.pos) / (upper.pos - lower.pos);
      
      // On retire le caractère '#' s'il existe et on extrait les composantes RGB
      const formatColor = (col: string) =>
        col.startsWith("#") ? col.slice(1) : col;
      const lc = formatColor(lower.color);
      const uc = formatColor(upper.color);
      const rLower = parseInt(lc.slice(0, 2), 16);
      const gLower = parseInt(lc.slice(2, 4), 16);
      const bLower = parseInt(lc.slice(4, 6), 16);
      const rUpper = parseInt(uc.slice(0, 2), 16);
      const gUpper = parseInt(uc.slice(2, 4), 16);
      const bUpper = parseInt(uc.slice(4, 6), 16);
      
      // Interpolation linéaire sur chaque canal (sur 8 bits)
      const r = Math.round(rLower + (rUpper - rLower) * localT);
      const g = Math.round(gLower + (gUpper - gLower) * localT);
      const b = Math.round(bLower + (bUpper - bLower) * localT);
      
      // Le contrôleur attend l'ordre GRB (chaque composante sur 8 bits)
      const word =
        g.toString(16).toUpperCase().padStart(2, "0") +
        r.toString(16).toUpperCase().padStart(2, "0") +
        b.toString(16).toUpperCase().padStart(2, "0");
      gradientTable += word;
    }
    
    // La trame finale est la concaténation du header, de la table de gradient et du footer.
    // La longueur attendue est de 214 caractères hexadécimaux (11 octets header + 30*3 octets gradient + 6 octets footer = 107 octets)
    const commandHex = header + gradientTable + footer;
    if (commandHex.length !== 214) {
      this.logger.error(
        `La trame générée contient ${commandHex.length} caractères (attendu: 214).`
      );
      return;
    }
    
    const command = Buffer.from(commandHex, "hex");
    this.log("Setting gradient with command:", commandHex, `(${commandHex.length} characters)`);
    await this.sendCommand(command);
  }

  async setTrame(trameName: string, value: CharacteristicValue): Promise<void> {
    const colors = ['FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF'];
    const shuffledColors = colors.sort(() => 0.5 - Math.random());

    const startColor = shuffledColors[0];
    const endColor = shuffledColors[1];

    // this.log(`Entering setTrame with trameName='${trameName}', value=${value}`);
    const stops = [
      { color: startColor, pos: 0 },
      { color: endColor, pos: 1 },
    ];
    return this.setCustomGradient(1, stops);
    // try {
    //   const boolValue = value as boolean;
    //   this.log(`boolValue: ${boolValue}`);
    //   if (boolValue) {
    //     this.trameStates[trameName] = true;
    //     this.log(`Trame '${trameName}' switch turned ON`);
    //     this.log(`trameStates after turning on '${trameName}':`, this.trameStates);
    //     const trame = this.trames.find((t) => t.name === trameName);
    //     if (trame) {
    //       const commandBuffer = Buffer.from(trame.trame, 'hex');
    //       await this.sendCommand(commandBuffer);
    //       this.log(`Sent trame command for '${trameName}'`);
    //     } else {
    //       const errorMsg = `Trame '${trameName}' not found in configuration`;
    //       this.log(errorMsg);
    //       throw new Error(errorMsg);
    //     }
    //     await this.turnOffOtherTrames(trameName);
    //     this.log(`Finished turning off other trames`);
    //     if (!this.isOn) {
    //       this.log('Power is off, turning it on');
    //       await this.setPower(true);
    //     }
    //   } else {
    //     await this.setPower(false);
    //     this.trameStates[trameName] = false;
    //     this.log(`Trame '${trameName}' switch turned OFF`);
    //   }
    // } catch (error) {
    //   this.logger.error('Error in setTrame:', error);
    //   throw error;
    // } finally {
    //   this.log(`Exiting setTrame for trameName='${trameName}'`);
    // }
  }

  private async turnOffOtherTrames(trameName: string) {
    this.log(`Entering turnOffOtherTrames, excluding '${trameName}'`);
    for (const otherTrameName of Object.keys(this.trameStates)) {
      if (otherTrameName !== trameName) {
        if (this.trameStates[otherTrameName]) {
          this.trameStates[otherTrameName] = false;
          const service = this.trameServices[otherTrameName];
          try {
            service.getCharacteristic(hap.Characteristic.On).updateValue(false);
            this.log(`Trame '${otherTrameName}' switch turned OFF`);
          } catch (error) {
            this.error(`Error updating characteristic for trame '${otherTrameName}':`, error);
          }
        }
      }
    }
    this.log(`Exiting turnOffOtherTrames`);
  }

  async getTrame(trameName: string): Promise<CharacteristicValue> {
    return this.trameStates[trameName] || false;
  }
}
