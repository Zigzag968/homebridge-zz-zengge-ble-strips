const Buffer = require('buffer').Buffer;

// module.exports = function (homebridge) {
//     Service = homebridge.hap.Service;
//     Characteristic = homebridge.hap.Characteristic;
//     homebridge.registerAccessory('@lyliya/homebridge-ledstrip-ble', 'LedStrip', LedStrip);
//   };

const noble = require('@abandonware/noble');

const PLATFORM_NAME = "HomebridgeZzZenggeBleStrips";
let Service, Characteristic, CharacteristicEventTypes;

let hap;

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    CharacteristicEventTypes = homebridge.hap.CharacteristicEventTypes;
    hap = homebridge.hap;
    homebridge.registerPlatform(PLATFORM_NAME, ZenggeLedStripPlatform);
};

class ZenggeLedStripPlatform {

    log;
    config;

    constructor(log, config, homebridge) {
        this.log = log;
        this.config = config;
        log.info("ZenggeLedStrip platform initialized!");
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
        this.writeUUID = 'ff01';    // Write characteristic UUID for sending commands to the device
        this.notifyUUID = 'ff02';   // Notify characteristic UUID for receiving updates
        this.isOn = false;
        this.brightness = 100;
        this.peripheral = null;

        // Create Lightbulb services
        this.onService = new hap.Service.Lightbulb(this.name, 'on-switch');
        this.redService = new hap.Service.Lightbulb(this.name, 'red-switch');

        this.onService.getCharacteristic(hap.Characteristic.On)
            .on(CharacteristicEventTypes.SET, this.setOn.bind(this))
            .on(CharacteristicEventTypes.GET, this.getOn.bind(this));

        this.redService.getCharacteristic(hap.Characteristic.On)
            .on(CharacteristicEventTypes.SET, this.setOn.bind(this))
            .on(CharacteristicEventTypes.GET, this.getOn.bind(this));

        this.initialize();
    }

    async onConnected() {
        await this.setPower(true);  // Allumer les LEDs
        await this.setPattern(1);  // Changer la couleur en rouge
        await new Promise(resolve => setTimeout(resolve, 2000));  // Sleep for 2 seconds
        await this.setPattern(2);  // Changer la couleur en rouge 
               await new Promise(resolve => setTimeout(resolve, 2000));  // Sleep for 2 seconds
        await this.setPattern(3);  // Changer la couleur en rouge
    }

    async initialize() {
        try {
            await this.startBluetoothScanning();
        } catch (error) {
            this.log('Error during initialization:', error);
        }
    }

    async startBluetoothScanning() {
        noble.on('stateChange', async (state) => {
            if (state === 'poweredOn') {
                this.log('Starting scan for devices...');
                noble.startScanning([], false);  // Scan all devices
            } else {
                noble.stopScanning();
                this.log('Bluetooth adapter not powered on.');
            }
        });

        noble.on('discover', async (peripheral) => {
            if (peripheral.address === this.deviceAddress.toLowerCase()) {
                this.log(`Found device: ${peripheral.address}`);
                noble.stopScanning();
                await this.connectToDevice(peripheral);
            }
        });

        noble.on('disconnect', () => {
            this.log('Device disconnected, attempting to reconnect...');
            noble.startScanning([], false);  // Restart scanning on disconnect
        });
    }

    async connectToDevice(peripheral) {
        try {
            await this.peripheralConnect(peripheral);
            //await this.listAllServicesAndCharacteristics();
            await this.discoverLedCharacteristic(peripheral);
            await this.enableNotifications(peripheral);
            this.log('Device setup complete.');
            this.log(`Peripheral found: ${peripheral}`);
            this.peripheral = peripheral;
            setTimeout(async () => {
                this.onConnected()
            }, 500);  // Délai de 500 ms
        } catch (error) {
            this.log('Error during device connection:', error);
        }
    }

    async peripheralConnect(peripheral) {
        try {
            if (peripheral && typeof peripheral.connectAsync === 'function') {
                this.log('Connecting to peripheral...');
                await peripheral.connectAsync();

                peripheral.on('disconnect', () => {
                    this.log('Device disconnected');
                });
            } else {
                this.log('Peripheral does not support connectAsync:', peripheral);
            }


        } catch (error) {
            throw new Error(`Failed to connect to device: ${error.message}`);
        }
    }

    async listAllServicesAndCharacteristics() {
        if (!this.peripheral) {
            this.log('No device connected. Cannot list services and characteristics.');
            return;
        }
    
        this.log(`Listing all services and characteristics for device: ${this.deviceAddress}`);
    
        // Découvre tous les services du périphérique
        this.peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics) => {
            if (error) {
                this.log('Error discovering services and characteristics:', error);
                return;
            }
    
            services.forEach((service, serviceIndex) => {
                this.log(`Service ${serviceIndex + 1} UUID: ${service.uuid}`);
    
                // Pour chaque service, lister les caractéristiques
                service.characteristics.forEach((characteristic, charIndex) => {
                    this.log(`  Characteristic ${charIndex + 1} UUID: ${characteristic.uuid}`);
                    this.log(`    Properties: ${characteristic.properties.join(', ')}`);
    
                    // Vous pouvez aussi ajouter d'autres informations spécifiques aux caractéristiques
                });
            });
        });
    }

    async discoverLedCharacteristic(peripheral) {
        return new Promise((resolve, reject) => {
            this.log('Discovering LED characteristic...');
            peripheral.discoverSomeServicesAndCharacteristics([this.serviceUUID], [this.writeUUID], (error, services, characteristics) => {
                if (error) {
                    this.log('Error discovering LED characteristic:', error);
                    reject(error);
                } else {
                    this.ledCharacteristic = characteristics[0];
                    this.log(`Discovered LED characteristic with UUID: ${this.ledCharacteristic.uuid}`);
                    resolve();
                }
            });
        });
    }

    async enableNotifications(peripheral) {
        return new Promise((resolve, reject) => {
            this.log('Enabling notifications...');
            peripheral.discoverSomeServicesAndCharacteristics([this.serviceUUID], [this.notifyUUID], (error, services, characteristics) => {
                if (error) {
                    this.log('Error enabling notifications:', error);
                    reject(error);
                } else {
                    const notifyCharacteristic = characteristics[0];
                    notifyCharacteristic.subscribe((error) => {
                        if (error) {
                            this.log('Error subscribing to notifications:', error);
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

    async setPattern(index) {
        let command = null;
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
                this.log('Invalid pattern index:', index);
                return;
        }
        if (!command) {
            this.log('Command not found for pattern index:', index);
            return;
        }
        this.log('Setting pattern:', index);
        await this.sendCommand(command);
    }

    async setPower(value) {
        const onBuffer = Buffer.from("00048000000d0e0b3b230000000000000032000090", "hex");
        const offBuffer = Buffer.from("005b8000000d0e0b3b240000000000000032000091", "hex");
        //const command = value ? [0x71, 0x23, 0x0F] : [0x71, 0x24, 0x0F];  // Turn on/off command
        const command = value ? onBuffer : offBuffer;  // Turn on/off command
        await this.sendCommand(command);
        this.log('Power state set to:', value);
    }

    preparePacket(packet) {
        const count = this.getCounter();
        packet[0] = 0xFF00 & count;
        packet[1] = 0x00FF & count;
        return packet;
    }

    getCounter() {
        // Implement your counter logic here
        // For example, you can use a simple incrementing counter
        if (!this.counter) {
            this.counter = 0;
        }
        return this.counter++;
    }

    async sendCommand(command) {
        command = this.preparePacket(command);
        this.log('sendCommand', command);
        if (!this.peripheral) {
            this.log('Peripheral not found. Cannot send command.');
            return;
        }
    
        if (!noble._peripherals[this.peripheral.id]) {
            this.log('Peripheral not found in noble. Reconnecting...');
            await this.connectToDevice(this.peripheral);
        }
    
        if (!this.peripheral || this.peripheral.state !== 'connected') {
            this.log('Device not connected, reconnecting...');
            await this.connectToDevice(this.peripheral);
        }
    
        if (!this.ledCharacteristic) {
            this.log('LED characteristic not found, cannot send command.');
            return;
        }
    
            
        this.log('Sending command...');

         // Convertir la commande en Buffer si nécessaire
    if (!Buffer.isBuffer(command)) {
        command = Buffer.from(command);  // Conversion en Buffer
    }
    try {
        this.log(`Writing command: ${command}`);
        await this.ledCharacteristic.write(command, true);
        this.log('Command sent successfully.');
    }
    catch (error) {
        this.log('Error sending command:', error);
    }

    return 
    //décomposer ne sert a rien
        const mtu = 200;  // Utilisez la valeur de MTU par défaut annoncée
        const chunks = [];
    
        for (let i = 0; i < command.length; i += mtu) {
            chunks.push(command.slice(i, i + mtu));
        }
    
        try {
            for (const chunk of chunks) {
                this.log(`Sending chunk: ${chunk}`);
                await this.ledCharacteristic.write(chunk, true);
            }
            this.log('All chunks sent successfully.');
        } catch (error) {
            this.log('Error sending command:', error);
        }
    }

    setOn(value, callback) {
        this.isOn = value;
        this.log('Power state set to:', value);
        this.setPower(value).then(() => callback(null)).catch(callback);
    }

    getOn(callback) {
        callback(null, this.isOn);
    }

    getServices() {
        return [this.onService, this.redService];
    }
}