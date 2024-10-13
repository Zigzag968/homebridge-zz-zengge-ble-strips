import { Buffer } from 'buffer';
import noble, { Peripheral } from '@abandonware/noble';
import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, CharacteristicEventTypes, CharacteristicValue, HAP } from 'homebridge';
import { exec } from 'child_process';

const PLATFORM_NAME = "HomebridgeZzZenggeBleStrips";

let hap: HAP;

const serviceUUID: string = 'ffff';
const writeUUID: string = 'ff01';
const notifyUUID: string = 'ff02';

module.exports = (homebridge: API) => {
  hap = homebridge.hap;
  homebridge.registerPlatform(PLATFORM_NAME, ZenggeLedStripPlatform);
};

type AccessoryInfo = {
  uuid: string,
  homebridgeAccessory: PlatformAccessory,
  controller: ZenggeLedStripPlatformAccessory
};

type DeviceConfig = {
  name: string,
  address: string,
  trames: { name: string, trame: string }[]
};

class ZenggeLedStripPlatform implements DynamicPlatformPlugin {
  private readonly log: Logger;
  private readonly config: PlatformConfig;
  private readonly accessories: PlatformAccessory[] = [];
  private readonly homebridge: API;

  private bluetoothSwitchAccessory: PlatformAccessory | null = null;
  private bluetoothEnabled: boolean = true;

  constructor(log: Logger, config: PlatformConfig, homebridge: API) {
    this.log = log;
    this.config = config;
    this.homebridge = homebridge;

    homebridge.on('didFinishLaunching', () => {
      if (!config.devices) {
        log.error('No devices configured');
        return;
      }
      log.info('ZenggeLedStrip platform initializing...');

      config.devices.forEach((deviceConfig: any) => {
        const address = deviceConfig.address;
        const name = deviceConfig.name;

        if (!address) {
          log.error('Missing device address in configuration.');
          return;
        }
        if (!name) {
          log.error('Missing device name in configuration.');
          return;
        }

        const uuid = homebridge.hap.uuid.generate(`${address}`);

        // Create or retrieve the accessory
        let accessory = this.accessories.find(accessory => accessory.UUID === uuid);
        if (!accessory) {
          // Create new accessory
          accessory = new this.homebridge.platformAccessory(name, uuid);
          accessory.context.deviceAddress = address;
          accessory.context.deviceConfig = deviceConfig;

          // Create and assign the controller
          const controller = new ZenggeLedStripPlatformAccessory(this.log, deviceConfig);
          accessory.context.controller = controller;

          // Configure the accessory
          controller.configure(accessory);

          // Register the accessory
          this.homebridge.registerPlatformAccessories('homebridge-zz-zengge-ble-strips', PLATFORM_NAME, [accessory]);

          // Add to accessories list
          this.accessories.push(accessory);
        } else {
          this.log.info(`Accessory ${accessory.displayName} is cached.`);
          const controller = new ZenggeLedStripPlatformAccessory(this.log, deviceConfig);
          accessory.context.controller = controller;
          controller.configure(accessory);
          this.accessories.push(accessory);
        }
      });

      // Initialize the Host Bluetooth switch accessory
      this.initializeBluetoothSwitchAccessory();

      // Set up Noble observers
      this.setupNobleObservers();

      log.info('Initialization complete.');
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info(`Configuring cached accessory: ${accessory.displayName}`);

    if (accessory.context.isHostBluetoothSwitch) {
      // This is the Host Bluetooth switch accessory
      this.bluetoothSwitchAccessory = accessory;
      this.configureBluetoothSwitchAccessory(accessory);
      this.accessories.push(accessory);
      return;
    }

    // Retrieve the device address
    const deviceAddress = accessory.context.deviceAddress;

    if (!deviceAddress) {
      this.log.error('No deviceAddress found in context for accessory:', accessory.displayName);
      return;
    }

    // Find the device configuration from the platform config
    let deviceConfig = this.config.devices.find((device: any) => device.address === deviceAddress);

    // Concatenate trames from platform config and device config
    deviceConfig.trames = [
      ...(this.config.trames || []),
      ...(deviceConfig.trames || [])
    ];

    if (!deviceConfig) {
      this.log.warn(`No device configuration found for deviceAddress ${deviceAddress}.`);
      return;
    }

    // Recreate the controller
    const controller = new ZenggeLedStripPlatformAccessory(this.log, deviceConfig);

    // Assign the controller to the accessory context
    accessory.context.controller = controller;

    // Configure the accessory
    controller.configure(accessory);

    // Add the accessory to your internal list
    this.accessories.push(accessory);
  }

  async setupNobleObservers() {
    noble.on('stateChange', async (state) => {
      this.log.info(`Bluetooth adapter state changed to: ${state}`);
      if (state === 'poweredOn') {
        if (this.bluetoothEnabled) {
          this.log.info('Bluetooth adapter is powered on. Starting scanning...');
          this.startBluetoothScanning();
        } else {
          this.log.info('Bluetooth is disabled in the plugin. Not starting scanning.');
        }
      } else {
        noble.stopScanning();
        this.log.warn(`Bluetooth adapter state is ${state}. Scanning stopped.`);
      }
    });

    noble.on('discover', async (peripheral: Peripheral) => {
      if (!this.bluetoothEnabled) {
        this.log.info('Host Bluetooth is disabled. Ignoring discovered devices.');
        return;
      }

      const accessory = this.accessories.find(accessory => accessory.context.controller && accessory.context.controller.deviceAddress.toLowerCase() === peripheral.address.toLowerCase());
      if (accessory) {
        this.log.info(`Found registered device: ${peripheral.address}`);
        await accessory.context.controller.connectToDevice(peripheral).then(() => {
          this.startBluetoothScanning();
        });
      }
    });

    noble.on('disconnect', () => {
      this.log.warn('Device disconnected');
    });
  }

  startBluetoothScanning() {
    if (!this.bluetoothEnabled) {
      this.log.info('Host Bluetooth is disabled. Not starting scanning.');
      return;
    }
    noble.startScanning([], false);  // Scan all devices
    this.log.info('Started Bluetooth scanning.');
  }

  private initializeBluetoothSwitchAccessory() {
    const uuid = this.homebridge.hap.uuid.generate('HostBluetoothSwitch');
    let accessory = this.accessories.find(accessory => accessory.UUID === uuid);

    if (accessory) {
      this.log.info('Host Bluetooth Switch accessory already exists.');
      this.bluetoothSwitchAccessory = accessory;
      this.configureBluetoothSwitchAccessory(accessory);
    } else {
      accessory = new this.homebridge.platformAccessory('Host Bluetooth', uuid);
      accessory.category = hap.Categories.SWITCH;

      this.configureBluetoothSwitchAccessory(accessory);

      // Register the accessory
      this.homebridge.registerPlatformAccessories('homebridge-zz-zengge-ble-strips', PLATFORM_NAME, [accessory]);

      this.bluetoothSwitchAccessory = accessory;
      this.accessories.push(accessory);
    }
  }

  private configureBluetoothSwitchAccessory(accessory: PlatformAccessory) {
    const switchService = accessory.getService(hap.Service.Switch) ||
      accessory.addService(hap.Service.Switch, 'Host Bluetooth', 'host-bluetooth-switch');

    switchService.getCharacteristic(hap.Characteristic.On)
      .onSet(this.setHostBluetoothEnabled.bind(this))
      .onGet(this.getHostBluetoothEnabled.bind(this));

    // Set accessory information
    accessory.getService(hap.Service.AccessoryInformation)!
      .setCharacteristic(hap.Characteristic.Manufacturer, 'YourCompany')
      .setCharacteristic(hap.Characteristic.Model, 'Host Bluetooth Switch')
      .setCharacteristic(hap.Characteristic.SerialNumber, 'HB-001');

    // Update accessory context
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
        // Wait for 'stateChange' event to start scanning
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
        const isBlocked = stdout.includes('Soft blocked: yes') || stdout.includes('Hard blocked: yes');
        resolve(!isBlocked);
      });
    });
  }
}

class ZenggeLedStripPlatformAccessory {
  private readonly logger: Logger;
  private readonly name: string;
  readonly deviceAddress: string;
  private peripheral: Peripheral | null = null;
  private ledCharacteristic: any;
  private counter: number = 0;

  private isOn: boolean = false;
  private onService!: Service;
  private trames: { name: string; trame: string }[] = [];
  private trameStates: { [key: string]: boolean } = {};
  private trameServices: { [key: string]: Service } = {};

  constructor(logger: Logger, config: DeviceConfig) {
    this.logger = logger;
    this.name = config.name || 'Zengge LED Strip';
    this.trames = config.trames || [];
    this.deviceAddress = config.address;
    this.log('Trames:', this.trames);
  }

  log(...messages: any[]) {
    const message = messages.map(msg => typeof msg === 'object' ? JSON.stringify(msg) : msg).join(' ');
    this.logger.info(`[${this.name}] ${message}`);
  }

  error(...messages: any[]) {
    const message = messages.map(msg => typeof msg === 'object' ? JSON.stringify(msg) : msg).join(' ');
    this.logger.error(`[${this.name}] ${message}`);
  }

  configure(accessory: PlatformAccessory) {
    // Set accessory category
    accessory.category = hap.Categories.LIGHTBULB; // or SWITCH
  
    // Get or create the On Lightbulb service
    this.createPowerSwitchService(accessory);
    
    // Create switches for each trame
    this.createTrameSwitchServices(accessory);

    // Set accessory information
    const accessoryInfoService = accessory.getService(hap.Service.AccessoryInformation);
    if (accessoryInfoService) {
      accessoryInfoService
        .setCharacteristic(hap.Characteristic.Manufacturer, 'Zengge')
        .setCharacteristic(hap.Characteristic.Model, PLATFORM_NAME)
        .setCharacteristic(hap.Characteristic.SerialNumber, this.deviceAddress);
    } else {
      this.logger.error('Accessory Information Service not found');
    }
  }

  private createPowerSwitchService(accessory: PlatformAccessory) {
    this.onService = accessory.getService('Power') ||
      accessory.addService(hap.Service.Lightbulb, 'Power', 'power'); 
    
    // Set up characteristics for On Lightbulb service
    this.onService.setCharacteristic(hap.Characteristic.Name, 'power');
    this.onService.getCharacteristic(hap.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

        // Mark the power switch service as the primary service

      this.onService.setPrimaryService(true);
  }

  private createTrameSwitchServices(accessory: PlatformAccessory) {
    this.log('Creating trame switch services...', this.trames.map((trame: any) => trame.name).join(', '));
    this.trames.forEach(trame => {
      const trameName = trame.name;
      const serviceName = trameName;
      const serviceSubType = `trame-${Buffer.from(trameName).toString('hex')}`;

      // Get or create the trame switch service
      const trameService = accessory.getService(serviceName) ||
        accessory.addService(hap.Service.Switch, serviceName, serviceSubType);

      // Set the Name characteristic
      trameService.setCharacteristic(hap.Characteristic.Name, trameName);

      // Set up characteristics for the trame switch
      trameService.getCharacteristic(hap.Characteristic.On)
        .onSet(this.setTrame.bind(this, trameName))
        .onGet(this.getTrame.bind(this, trameName));

      // Initialize trame state
      this.trameStates[trameName] = false;
      this.trameServices[trameName] = trameService;
    });
  }

  async onConnected() {
    await this.setPower(true);  // Turn on the LEDs
    await this.setPattern(1);  // Change color to red
    // await new Promise(resolve => setTimeout(resolve, 2000));  // Sleep for 2 seconds
    // await this.setPattern(2);  // Change color to another pattern
    // await new Promise(resolve => setTimeout(resolve, 2000));  // Sleep for 2 seconds
    // await this.setPattern(3);  // Change color to another pattern
  }

  async connectToDevice(peripheral: Peripheral) {
    try {
      await this.peripheralConnect(peripheral);
      await this.discoverLedCharacteristic(peripheral);
      await this.enableNotifications(peripheral);
      this.log('Device setup complete.');
      this.log(`Peripheral found: ${peripheral}`);
      this.peripheral = peripheral;
      setTimeout(async () => {
        this.onConnected()
      }, 500);  // 500 ms delay
    } catch (error: any) {
      this.logger.error('Error during device connection:', error);
    }
  }

  async peripheralConnect(peripheral: Peripheral) {
    try {
      if (peripheral && typeof peripheral.connectAsync === 'function') {
        this.log('Connecting to peripheral...');
        await peripheral.connectAsync();
      } else {
        this.logger.error('Peripheral does not support connectAsync:', peripheral);
      }
    } catch (error: any) {
      throw new Error(`Failed to connect to device: ${error.message}`);
    }
  }

  async discoverLedCharacteristic(peripheral: Peripheral) {
    return new Promise<void>((resolve, reject) => {
      this.log('Discovering LED characteristic...');
      peripheral.discoverSomeServicesAndCharacteristics([serviceUUID], [writeUUID], (error, services, characteristics) => {
        if (error) {
          this.logger.error('Error discovering LED characteristic:', error);
          reject(error);
        } else {
          this.ledCharacteristic = characteristics[0];
          this.log(`Discovered LED characteristic with UUID: ${this.ledCharacteristic.uuid}`);
          resolve();
        }
      });
    });
  }

  async enableNotifications(peripheral: Peripheral) {
    return new Promise<void>((resolve, reject) => {
      this.log('Enabling notifications...');
      peripheral.discoverSomeServicesAndCharacteristics([serviceUUID], [notifyUUID], (error, services, characteristics) => {
        if (error) {
          this.logger.error('Error enabling notifications:', error);
          reject(error);
        } else {
          const notifyCharacteristic = characteristics[0];
          notifyCharacteristic.subscribe((error) => {
            if (error) {
              this.logger.error('Error subscribing to notifications:', error);
              reject(error);
            } else {
              notifyCharacteristic.on('data', (data) => {
                this.log(`Notification received: ${data}`);
              });
              this.log(`Notifications enabled for characteristic with UUID: ${notifyCharacteristic.uuid}`);
              resolve();
            }
          });
        }
      });
    });
  }

  async setPattern(index: number) {
    let command: Buffer | null = null;
    switch (index) {
      case 1:
        command = Buffer.from("000f80000063640b590063e543ffe049f8db4ff1d656ead15ce3cc63dcc769d6c270cfbd76c8b87dc1b383baae8ab3a990ada497a69f9d9f9aa49895aa918fb18a8bb78486be7d81c4767ccb6f77d16872d8616cde5b68e55463eb4d5df24659f83f54ff39001e0164009d", "hex");
        break;
      case 2:
        command = Buffer.from("000980000063640b5900630059ff0055ff0052ff004fff004cff0049ff0046ff0043ff0040ff003dff003aff0037ff0034ff0031ff002eff002aff0027ff0024ff0021ff001eff001bff0018ff0015ff0012ff000fff000cff0009ff0006ff0003ff0000ff001e0227000e", "hex");
        break;
      case 3:
        command = Buffer.from("000680000063640b590063ff0000f60008ed0011e4001adb0023d3002bca0034c1003db80046af004fa700579e00619500698c007283007b7b008372008c69009560009e5700a74f00af4600b83d00c13400ca2b00d32300db1a00e41100ed0800f60000ff001e01640005", "hex");
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
    const onBuffer = Buffer.from("00048000000d0e0b3b230000000000000032000090", "hex");
    const offBuffer = Buffer.from("005b8000000d0e0b3b240000000000000032000091", "hex");
    const command = value ? onBuffer : offBuffer;  // Turn on/off command
    await this.sendCommand(command);
    this.onService.updateCharacteristic(hap.Characteristic.On, value);
    this.log('Power state set to:', value);
  }

  preparePacket(packet: Buffer): Buffer {
    const count = this.getCounter();
    packet[0] = 0xFF00 & count;
    packet[1] = 0x00FF & count;
    return packet;
  }

  getCounter(): number {
    return this.counter++;
  }


  async sendCommand(command: Buffer) {
    command = this.preparePacket(command);
    this.logger.debug('sendCommand', command);
    if (!this.peripheral) {
      this.logger.error('Peripheral not found. Cannot send command.');
      return;
    }

    if (!this.ledCharacteristic) {
      this.logger.error('LED characteristic not found, cannot send command.');
      return;
    }

    this.log('Sending command...');

    if (!Buffer.isBuffer(command)) {
      command = Buffer.from(command);  // Convert to Buffer if necessary
    }
    try {
      this.logger.debug(`Writing command: ${command}`);
      await this.ledCharacteristic.write(command, true);
      this.log('Command sent successfully.');
    } catch (error: any) {
      this.logger.error('Error sending command:', error);
    }
  }

  async setOn(value: CharacteristicValue): Promise<void> {
    const boolValue = value as boolean;
    this.isOn = boolValue;
    this.log('Power state set to:', boolValue);
    await this.setPower(boolValue);
}

async getOn(): Promise<CharacteristicValue> {
  return this.isOn;
}
async setTrame(trameName: string, value: CharacteristicValue): Promise<void> {
  this.log(`Setting trame '${trameName}' to:`, value);
  return new Promise(async (resolve, reject) => {
    try {
      const boolValue = value as boolean;

      if (boolValue) {
        // Turn on this trame
        this.trameStates[trameName] = true;
        this.log(`Trame '${trameName}' switch turned ON`);

        // Send the trame command to the LED strip
        const trame = this.trames.find(t => t.name === trameName);
        if (trame) {
          const commandBuffer = Buffer.from(trame.trame, 'hex');
          await this.sendCommand(commandBuffer);
          this.log(`Sent trame command for '${trameName}'`);
        } else {
          this.log(`Trame '${trameName}' not found in configuration`);
          return reject(`Trame '${trameName}' not found in configuration`);
        }

        // Turn off other trame switches
        this.turnOffOtherTrames(trameName);

        // Ensure the power switch is ON
        if (!this.isOn) {
          await this.setPower(true);
        }

      } else {
        // Turning off this trame switch, turn off the LED strip
        await this.setPower(false);
        this.trameStates[trameName] = false;
        this.log(`Trame '${trameName}' switch turned OFF`);

        // Update the power switch state
        if (this.isOn) {
          this.isOn = false;
          this.onService.updateCharacteristic(hap.Characteristic.On, false);
          this.log('Power switch turned OFF');
        }
      }
      resolve();
    } catch (error) {
      this.logger.error('Error in setTrame:', error);
      reject(error);
    }
  });
}

  private turnOffOtherTrames(trameName: string) {
    for (const otherTrameName of Object.keys(this.trameStates)) {
      if (otherTrameName !== trameName) {
        if (this.trameStates[otherTrameName]) {
          this.trameStates[otherTrameName] = false;
          const service = this.trameServices[otherTrameName];

          try {
            service.updateCharacteristic(hap.Characteristic.On, false);
            this.log(`Trame '${otherTrameName}' switch turned OFF`);
          } catch (error) {
            this.error(`Error updating characteristic for trame '${otherTrameName}':`, error);
          }
        }
      }
    }
  }

async getTrame(trameName: string): Promise<CharacteristicValue> {
  return this.trameStates[trameName] || false;
}
}

