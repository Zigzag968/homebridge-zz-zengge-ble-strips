import { Buffer } from 'buffer';
import noble, { Peripheral } from '@abandonware/noble';
import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, CharacteristicEventTypes, CharacteristicValue, HAP } from 'homebridge';

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
  homebridgeAccessory: () => PlatformAccessory,
  controller: ZenggeLedStripPlatformAccessory
};

type DeviceConfig = {
  name: string,
  address: string
};

class ZenggeLedStripPlatform implements DynamicPlatformPlugin {
  private readonly log: Logger;
  private readonly config: PlatformConfig;
  private readonly accessories: PlatformAccessory[] = [];
  private readonly homebridge: API;

  constructor(log: Logger, config: PlatformConfig, homebridge: API) {
    this.log = log;
    this.config = config;
    this.homebridge = homebridge;

    homebridge.on('didFinishLaunching', () => {
      if (!config.devices) {
        log.error("No devices configured");
        return;
      }
      log.info("ZenggeLedStrip platform initializing...");

      const accessories = config.devices.map((deviceConfig: any) => {
        const address = deviceConfig.address;
        const name = deviceConfig.name;
        if (!address) {
          log.error('Missing device address in configuration.');
          return null;
        }
        if (!name) {
          log.error('Missing device name in configuration.');
          return null;
        }

        const uuid = homebridge.hap.uuid.generate(address);

        const controller = new ZenggeLedStripPlatformAccessory(this.log, deviceConfig);

        const homebridgeAccessory = () => {
          const cachedAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
          if (cachedAccessory) {
            cachedAccessory.context.controller = controller;
            return cachedAccessory;
          }

          const accessory = new homebridge.platformAccessory(name, uuid);
          accessory.context.controller = controller;
          accessory.context.deviceAddress = address;
          homebridge.registerPlatformAccessories("homebridge-zz-zengge-ble-strips", PLATFORM_NAME, [accessory]);

          return accessory;
        };

        return {
          uuid: uuid,
          homebridgeAccessory: homebridgeAccessory,
          controller: controller,
        };
      }).filter((accessory: AccessoryInfo | null): accessory is AccessoryInfo => accessory !== null) as AccessoryInfo[];

      log.info('Initialization complete.');
      log.info('Registering accessories:', accessories.map(accessory => accessory.homebridgeAccessory().displayName).join(', '));
      accessories.forEach(accessory => {
        accessory.controller.launchWithAccessory(accessory.homebridgeAccessory());
      });
      this.initialize().catch(error => {
        log.error('Error during initialization:', error);
      });
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.accessories.push(accessory);
    const deviceConfig = accessory.context.deviceConfig;
    if (deviceConfig) {
      accessory.context.controller = new ZenggeLedStripPlatformAccessory(this.log, deviceConfig);
    }
  }

  async initialize() {
    noble.on('stateChange', async (state) => {
      if (state === 'poweredOn') {
        this.log.info('Starting scan for devices...');
        this.startBluetoothScanning();
      } else {
        noble.stopScanning();
        this.log.warn('Bluetooth adapter not powered on.');
      }
    });

    noble.on('discover', async (peripheral: Peripheral) => {
      const accessory = this.accessories.find(accessory => accessory.context.controller.deviceAddress.toLowerCase() === peripheral.address.toLowerCase());
      if (accessory) {
        this.log.info(`Found registered device: ${peripheral.address}`);
        await accessory.context.controller.connectToDevice(peripheral).then(() => {
          this.startBluetoothScanning();
        })
        // noble.stopScanning(); // Uncomment if you want to stop scanning after finding the device
      }
    });

    noble.on('disconnect', () => {
      this.log.warn('Device disconnected');
    });
  }

  startBluetoothScanning() {
    noble.startScanning([], false);  // Scan all devices
  }
}

class ZenggeLedStripPlatformAccessory {
  private readonly logger: Logger;
  private readonly name: string;
  readonly deviceAddress: string;
  private isOn: boolean = false;
  private peripheral: Peripheral | null = null;
  private ledCharacteristic: any;
  private counter: number = 0;
  private onService!: Service;
  private redService!: Service;

  constructor(logger: Logger, config: any) {
    this.logger = logger;
    this.name = config.name || 'Zengge LED Strip';
    this.deviceAddress = config.address;
  }

  log(...messages: any[]) {
    const message = messages.map(msg => typeof msg === 'object' ? JSON.stringify(msg) : msg).join(' ');
    this.logger.info(`[${this.name}] ${message}`);
  }

  launchWithAccessory(accessory: PlatformAccessory) {
    // this.onService = new hap.Service.Lightbulb(this.name, 'on switch');
    this.redService = new hap.Service.Lightbulb(this.name, 'red switch');

     // get the LightBulb service if it exists
     let service = accessory.getService('on switch');
     //this.redService = accessory.getService(Service.Lightbulb, 'red switch');

     // otherwise create a new LightBulb service
     if (!service) {
      service = accessory.addService(hap.Service.Lightbulb, 'on switch', 'On');
     }

     service.getCharacteristic(hap.Characteristic.On)
    .onSet(this.setOn.bind(this))
    .onGet(this.getOn.bind(this));

this.redService.getCharacteristic(hap.Characteristic.On)
    .onSet(this.setOn.bind(this))
    .onGet(this.getOn.bind(this));

    accessory.getService(hap.Service.AccessoryInformation)!
      .setCharacteristic(hap.Characteristic.Manufacturer, 'Zengge')
      .setCharacteristic(hap.Characteristic.Model, PLATFORM_NAME)
      .setCharacteristic(hap.Characteristic.SerialNumber, this.deviceAddress);


      // this.peripheral.on('disconnect', () => {
      //   this.log('Device disconnected');
      //   this.peripheral = null;
      //   this.connectToDevice(this.peripheral);
      // });
  }

  async onConnected() {
    await this.setPower(true);  // Turn on the LEDs
    await this.setPattern(1);  // Change color to red
    await new Promise(resolve => setTimeout(resolve, 2000));  // Sleep for 2 seconds
    await this.setPattern(2);  // Change color to another pattern
    await new Promise(resolve => setTimeout(resolve, 2000));  // Sleep for 2 seconds
    await this.setPattern(3);  // Change color to another pattern
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
}
