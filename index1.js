import pkg from 'homebridge';
import { Buffer } from 'buffer';
const {
    AccessoryConfig,
    AccessoryPlugin,
    API,
    CharacteristicEventTypes,
    CharacteristicGetCallback,
    CharacteristicSetCallback,
    CharacteristicValue,
    HAP,
    Logging,
    Service,
    StaticPlatformPlugin,
    PlatformConfig
} = pkg;

import noble from '@abandonware/noble';

const PLATFORM_NAME = "HomebridgeZzZenggeBleStrips";

let hap;

export default (api) => {
    hap = api.hap;
    api.registerPlatform(PLATFORM_NAME, ZenggeLedStripPlatform);
};

class ZenggeLedStripPlatform {

    log;
    config;

    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        log.info("Example platform finished initializing!");
    }

    accessories(callback) {
        callback([
            new ZenggeLedStripAccessory(this.log, this.config),
        ]);
    }

}

class ZenggeLedStripAccessory {
    constructor(log, config) {
        this.log = log;
        this.name = config.name || 'Zengge LED Strip';
        this.deviceAddress = config.deviceAddress;
        this.serviceUUID = 'ffff';  // Service UUID for the device
        this.writeUUID = 'ff01';  // Write characteristic UUID for sending commands to the device
        this.notifyUUID = 'ff02';  // Notify characteristic UUID for receiving updates from the device
        this.isOn = false;
        this.brightness = 100;
        this.color = [255, 255, 255];  // Default to white
        this.peripheral = null;

        // Create a Lightbulb service
        this.onService = new hap.Service.Lightbulb(this.name, 'on-switch');
        this.redService = new hap.Service.Lightbulb(this.name, 'red-switch');

        this.onService.getCharacteristic(hap.Characteristic.On)
            .on(CharacteristicEventTypes.SET, this.setOn.bind(this))
            .on(CharacteristicEventTypes.GET, this.getOn.bind(this));

        this.redService.getCharacteristic(hap.Characteristic.On)
            .on(CharacteristicEventTypes.SET, this.setOn.bind(this))
            .on(CharacteristicEventTypes.GET, this.getOn.bind(this));

        this.connectToDevice(this.deviceAddress);
    }

    async connectToDevice(macAddr) {
        return new Promise((resolve, reject) => {
            noble.on('stateChange', async (state) => {
                if (state === 'poweredOn') {
                    this.log('Starting scan...');
                    noble.startScanning([], false);  // Scan all devices
                } else {
                    noble.stopScanning();
                    reject(new Error('Bluetooth adapter not powered on.'));
                }
            });
    
            noble.on('discover', async (peripheral) => {
                // Ensure the peripheral's address matches
                if (peripheral.address === macAddr) {
                    this.log(`Found device: ${peripheral.address}`);
                    noble.stopScanning();
    
                    try {
                        await this.setupDevice(peripheral);
                        this.onConnect(peripheral);
                        resolve(peripheral);
                    } catch (error) {
                        reject(error);
                    }
                }
            });

            noble.on('disconnect', () => {
                this.log('Device disconnected, attempting to reconnect...');
                noble.startScanning([this.serviceUUID], false);  // Relance la recherche du périphérique
            });
        });
    }

    onConnect(peripheral) {
        this.log('Device connected');
        this.startingSequence();
    }

    async setupDevice(peripheral) {
        return new Promise((resolve, reject) => {
            peripheral.connect(async (error) => {
                if (error) {
                    this.log('Failed to connect:', error);
                    reject(error);
                    return;
                }

                peripheral.on('disconnect', () => {
                    this.log('Device disconnected');
                    this.peripheral = null;  // Reset the peripheral reference
                });

                try {
                    await this.discoverLedCharacteristic(peripheral);
                    await this.enableNotifications(peripheral);
                    this.log('Device setup complete.');
                    resolve();
                } catch (error) {
                    this.log('Error setting up device:', error);
                    reject(error);
                }
            });
        });
    }

    startingSequence() {
        const actions = [
            () => this.setPower(true, () => {}),
            () => this.setColor([0, 255, 0], () => {}),
            () => this.setColor([255, 0, 0], () => {}),
            () => this.setColor([0, 0, 255], () => {}),
            () => {
                this.setPower(false, () => {});
                this.log("Disconnecting from the device.");
                if (this.peripheral) this.peripheral.disconnect();
            }
        ];

        const executeActions = async () => {
            for (const action of actions) {
                action();
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        };

        executeActions();
    }
    
    async discoverLedCharacteristic(peripheral) {
        try {
            const { characteristics } = await this.discoverCharacteristics(peripheral, this.serviceUUID, this.writeUUID);
            this.ledCharacteristic = characteristics[0];
            this.log('Discovered LED characteristic.');
        } catch (error) {
            this.log('Error discovering services and characteristics:', error);
        }
    }
    
    async enableNotifications(peripheral) {
        try {
            const { characteristics } = await this.discoverCharacteristics(peripheral, this.serviceUUID, this.notifyUUID);
            const notifyCharacteristic = characteristics[0];

            await this.subscribeToNotifications(notifyCharacteristic);
            this.log('Notifications enabled');
        } catch (error) {
            this.log('Failed to enable notifications:', error);
        }
    }

    discoverCharacteristics(peripheral, serviceUUID, characteristicUUID) {
        this.log(`Discovering Characteristics of: ${peripheral.address}`);
        return new Promise((resolve, reject) => {
            peripheral.discoverSomeServicesAndCharacteristics([serviceUUID], [characteristicUUID], (error, services, characteristics) => {
                if (error) {
                    reject(error);
                } else {
                    resolve({ services, characteristics });
                }
            });
        });
    }

    subscribeToNotifications(characteristic) {
        return new Promise((resolve, reject) => {
            characteristic.subscribe((error) => {
                if (error) {
                    reject(error);
                } else {
                    characteristic.on('data', (data) => {
                        this.log(`Notification received: ${data}`);
                    });
                    resolve();
                }
            });
        });
    }

    setColor(rgb, callback) {
        this.log(`Setting RGB color: ${rgb[0]}, ${rgb[1]}, ${rgb[2]}`);
        const command = [0x56, ...rgb, 0x00, 0xF0, 0xAA];  // Example RGB command
        this.sendCommand(command, callback);
    }

    setPower(value, callback) {
        this.log(`Setting Power ${value ? "on" : "off"}`);
        const command = value ? [0x71, 0x23, 0x0F] : [0x71, 0x24, 0x0F];  // Turn on/off command
        this.sendCommand(command, callback);
    }

    sendCommand(command, callback) {
        if (!this.peripheral || this.peripheral.state !== 'connected') {
            this.log('Device not connected, cannot send command.');
            callback(new Error('Device not connected'));
            return;
        }
    
        if (!this.ledCharacteristic) {
            this.log('LED characteristic not found, cannot send command.');
            callback(new Error('Device not ready'));
            return;
        }
    
        const buffer = Buffer.from(command);
    
        this.ledCharacteristic.write(buffer, false, (error) => {
            if (error) {
                this.log('Error sending command:', error);
                callback(error);
            } else {
                this.log('Command sent successfully');
                callback();
            }
        });
    }

    setOn(value, callback) {
        this.isOn = value;
        this.log('Lumière allumée: ', value);
        callback(null);
    }

    getOn(callback) {
        callback(null, this.isOn);
    }

    getServices() {
        return [this.onService, this.redService];
    }
}
