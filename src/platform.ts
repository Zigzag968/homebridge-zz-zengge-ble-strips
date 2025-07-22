import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  CharacteristicValue,
  HAP,
} from 'homebridge';
import { exec } from 'child_process';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { PACKAGE_NAME, PLATFORM_NAME } from './settings';
import { BleBridge } from './bleBridge';
import { ZenggeLedStripPlatformAccessory, DeviceConfig } from './accessory';

export class ZenggeLedStripPlatform implements DynamicPlatformPlugin {
  private readonly log: Logger;
  private readonly config: PlatformConfig;
  private readonly accessories: PlatformAccessory[] = [];
  public readonly hap: HAP;
  public readonly ble: BleBridge;
  private bluetoothSwitchAccessory: PlatformAccessory | null = null;
  private bluetoothEnabled: boolean = true;

  constructor(log: Logger, config: PlatformConfig, public readonly homebridge: API) {
    this.log = log;
    this.config = config;
    this.hap = homebridge.hap;
    this.ble = new BleBridge();

    homebridge.on('didFinishLaunching', () => {
      this.launchPythonDispatcher();
      this.initializePlatform();
    });
  }

  private launchPythonDispatcher() {
    const pythonPath = path.resolve(__dirname, '..', 'ble-venv', 'bin', 'python3');
    const scriptPath = path.resolve(__dirname, '..', 'scripts', 'bleDispatcher.py');
    if (!fs.existsSync(pythonPath)) {
      this.log.error(`[BLEAK] Python virtual environment not found at ${pythonPath}. Please reinstall the plugin.`);
      return;
    }
    const child = spawn(pythonPath, [scriptPath], {
      stdio: 'inherit',
      detached: true
    });
    child.unref();
  }

  private initializePlatform() {
    if (!this.config.devices) {
      this.log.error('No devices configured');
      return;
    }
    this.log.info('ZenggeLedStrip platform initializing...');

    this.ble.start(this.config.devices.map((device: any) => device.address.toUpperCase()));

    // Register each device in the BLE daemon by sending a dummy command
    this.config.devices.forEach((deviceConfig: any) => {
      const address = deviceConfig.address?.toUpperCase();
      if (address) {
        this.ble.sendCommand(address, '00'); // Inform daemon to track this device
      }
    });

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

        const controller = new ZenggeLedStripPlatformAccessory(this, this.log, deviceConfig, accessory);
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
        const controller = new ZenggeLedStripPlatformAccessory(this, this.log, deviceConfig, accessory);
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

    const controller = new ZenggeLedStripPlatformAccessory(this, this.log, deviceConfig, accessory);
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
      accessory.category = this.hap.Categories.SWITCH;

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
      accessory.getService(this.hap.Service.Switch) ||
      accessory.addService(this.hap.Service.Switch, 'Host Bluetooth', 'host-bluetooth-switch');

    switchService
      .getCharacteristic(this.hap.Characteristic.On)
      .onSet(this.setHostBluetoothEnabled.bind(this))
      .onGet(this.getHostBluetoothEnabled.bind(this));

    accessory
      .getService(this.hap.Service.AccessoryInformation)!
      .setCharacteristic(this.hap.Characteristic.Manufacturer, 'YourCompany')
      .setCharacteristic(this.hap.Characteristic.Model, 'Host Bluetooth Switch')
      .setCharacteristic(this.hap.Characteristic.SerialNumber, 'HB-001');

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
        // Consider stopping noble scanning here if needed
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
      accessory.category = this.hap.Categories.SWITCH;

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
      accessory.getService(this.hap.Service.Switch) ||
      accessory.addService(this.hap.Service.Switch, 'Host Reboot', 'host-reboot-switch');

    switchService
      .getCharacteristic(this.hap.Characteristic.On)
      .onSet(this.setHostReboot.bind(this))
      .onGet(this.getHostReboot.bind(this));

    accessory
      .getService(this.hap.Service.AccessoryInformation)!
      .setCharacteristic(this.hap.Characteristic.Manufacturer, 'YourCompany')
      .setCharacteristic(this.hap.Characteristic.Model, 'Host Reboot Switch')
      .setCharacteristic(this.hap.Characteristic.SerialNumber, 'HB-002');

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