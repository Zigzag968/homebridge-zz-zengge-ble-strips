import {
  Logger,
  PlatformAccessory,
  Service,
  CharacteristicValue,
} from 'homebridge';
import { ZenggeLedStripPlatform } from './platform';
import { PLATFORM_NAME } from './settings';
import { hsvToHex, hexToHsv, interpolateHue } from './utils';

export interface DeviceConfig {
  name: string;
  address: string;
  trames: { name: string; trame: string }[];
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

export class ZenggeLedStripPlatformAccessory {
  private readonly logger: Logger;
  private readonly name: string;
  readonly deviceAddress: string;
  private accessory: PlatformAccessory;
  private platform: ZenggeLedStripPlatform;
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
    platform: ZenggeLedStripPlatform,
    logger: Logger,
    config: DeviceConfig,
    accessory: PlatformAccessory
  ) {
    this.platform = platform;
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
    accessory.category = this.platform.hap.Categories.LIGHTBULB;
    this.createPowerSwitchService(accessory);
    this.createColorStopServices(accessory);

    const accessoryInfoService = accessory.getService(this.platform.hap.Service.AccessoryInformation);
    if (accessoryInfoService) {
      accessoryInfoService
        .setCharacteristic(this.platform.hap.Characteristic.Manufacturer, 'Zengge')
        .setCharacteristic(this.platform.hap.Characteristic.Model, PLATFORM_NAME)
        .setCharacteristic(this.platform.hap.Characteristic.SerialNumber, this.deviceAddress)
        .setCharacteristic(this.platform.hap.Characteristic.Name, this.name);
    } else {
      this.logger.error('Accessory Information Service not found');
    }
  }

  private createPowerSwitchService(accessory: PlatformAccessory) {
    this.isOn = accessory.context.isOn || false;
    this.onService =
      accessory.getServiceById(this.platform.hap.Service.Lightbulb, 'power-service') ||
      accessory.addService(this.platform.hap.Service.Lightbulb, 'Power', 'power-service');
    this.onService.setCharacteristic(this.platform.hap.Characteristic.Name, 'Power');

    // On
    this.onService.getCharacteristic(this.platform.hap.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    // Ajout et configuration des caractéristiques Hue, Saturation et Brightness
    if (!this.onService.testCharacteristic(this.platform.hap.Characteristic.Hue)) {
      this.onService.addCharacteristic(this.platform.hap.Characteristic.Hue);
    }
    if (!this.onService.testCharacteristic(this.platform.hap.Characteristic.Saturation)) {
      this.onService.addCharacteristic(this.platform.hap.Characteristic.Saturation);
    }
    if (!this.onService.testCharacteristic(this.platform.hap.Characteristic.Brightness)) {
      this.onService.addCharacteristic(this.platform.hap.Characteristic.Brightness);
    }

    this.onService.getCharacteristic(this.platform.hap.Characteristic.Hue)
      .setProps({ minValue: 0, maxValue: 360, minStep: 1 })
      .onSet(this.setPrimaryHue.bind(this));
    this.onService.getCharacteristic(this.platform.hap.Characteristic.Saturation)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onSet(this.setPrimarySaturation.bind(this));
    this.onService.getCharacteristic(this.platform.hap.Characteristic.Brightness)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onSet(this.setPrimaryBrightness.bind(this));

    this.onService.setPrimaryService(true);
    this.onService.updateCharacteristic(this.platform.hap.Characteristic.On, this.isOn);
    this.log(`Service Power (primary) created for ${this.name}`);
  }

  // Callbacks pour mettre à jour les valeurs primaires (HSV)
  async setPrimaryHue(value: CharacteristicValue): Promise<void> {
    this.primaryHue = value as number;
    this.onService.updateCharacteristic(this.platform.hap.Characteristic.Hue, this.primaryHue);
    this.log(`Primary Hue updated: ${this.primaryHue}`);
    this.updateActiveColorStops();
    await this.scheduleGradientUpdate();
  }

  async setPrimarySaturation(value: CharacteristicValue): Promise<void> {
    this.primarySaturation = value as number;
    this.onService.updateCharacteristic(this.platform.hap.Characteristic.Saturation, this.primarySaturation);
    this.log(`Primary Saturation updated: ${this.primarySaturation}`);
    this.updateActiveColorStops();
    await this.scheduleGradientUpdate();
  }

  async setPrimaryBrightness(value: CharacteristicValue): Promise<void> {
    this.primaryBrightness = value as number;
    this.onService.updateCharacteristic(this.platform.hap.Characteristic.Brightness, this.primaryBrightness);
    this.log(`Primary Brightness updated: ${this.primaryBrightness}`);
    this.updateActiveColorStops();
    await this.scheduleGradientUpdate();
  }

  // Optionnelle : mise à jour groupée de la couleur primaire
  async setPrimaryColor(): Promise<void> {
    const hue = this.onService.getCharacteristic(this.platform.hap.Characteristic.Hue).value as number;
    const saturation = this.onService.getCharacteristic(this.platform.hap.Characteristic.Saturation).value as number;
    const brightness = this.onService.getCharacteristic(this.platform.hap.Characteristic.Brightness).value as number;
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
        stop.color = hsvToHex(stop.hue, stop.saturation, stop.brightness);
        stop.service.updateCharacteristic(this.platform.hap.Characteristic.Hue, stop.hue);
        stop.service.updateCharacteristic(this.platform.hap.Characteristic.Saturation, stop.saturation);
        stop.service.updateCharacteristic(this.platform.hap.Characteristic.Brightness, stop.brightness);
        stop.service.updateCharacteristic(this.platform.hap.Characteristic.On, true);
      } else {
        stop.isOn = false;
        stop.service.updateCharacteristic(this.platform.hap.Characteristic.On, false);
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
        accessory.getServiceById(this.platform.hap.Service.Lightbulb, serviceId) ||
        accessory.addService(this.platform.hap.Service.Lightbulb, serviceName, serviceId);
      colorService.setCharacteristic(this.platform.hap.Characteristic.Name, serviceName);

      colorService.getCharacteristic(this.platform.hap.Characteristic.On)
        .onSet((value: CharacteristicValue) => this.setColorStopOn(i, value))
        .onGet(() => this.getColorStopOn(i));

      if (!colorService.testCharacteristic(this.platform.hap.Characteristic.Hue)) {
        colorService.addCharacteristic(this.platform.hap.Characteristic.Hue);
      }
      colorService.getCharacteristic(this.platform.hap.Characteristic.Hue)
        .setProps({ minValue: 0, maxValue: 360, minStep: 1 })
        .onSet((value: CharacteristicValue) => this.setColorStopHue(i, value))
        .onGet(() => this.getColorStopHue(i));

      if (!colorService.testCharacteristic(this.platform.hap.Characteristic.Saturation)) {
        colorService.addCharacteristic(this.platform.hap.Characteristic.Saturation);
      }
      colorService.getCharacteristic(this.platform.hap.Characteristic.Saturation)
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
        .onSet((value: CharacteristicValue) => this.setColorStopSaturation(i, value))
        .onGet(() => this.getColorStopSaturation(i));

      if (!colorService.testCharacteristic(this.platform.hap.Characteristic.Brightness)) {
        colorService.addCharacteristic(this.platform.hap.Characteristic.Brightness);
      }
      colorService.getCharacteristic(this.platform.hap.Characteristic.Brightness)
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
    // Use platform.ble.sendCommandBuffer with Buffer support
    const prepared = this.preparePacket(command);
    await this.platform.ble.sendCommandBuffer(this.deviceAddress, prepared);
  }

  async setPower(value: boolean) {
    const onBuffer = Buffer.from('00048000000d0e0b3b230000000000000032000090', 'hex');
    const offBuffer = Buffer.from('005b8000000d0e0b3b240000000000000032000091', 'hex');
    const command = value ? onBuffer : offBuffer;
    await this.sendCommand(command);
    this.isOn = value;
    this.accessory.context.isOn = value;
    this.onService.updateCharacteristic(this.platform.hap.Characteristic.On, value);
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
    this.colorStops[index].service.updateCharacteristic(this.platform.hap.Characteristic.On, value);
    await this.scheduleGradientUpdate();
  }

  async getColorStopOn(index: number): Promise<CharacteristicValue> {
    return this.colorStops[index].isOn;
  }

  async setColorStopHue(index: number, value: CharacteristicValue): Promise<void> {
    this.log(`setColorStopHue for stop ${index + 1} called with value:`, value);
    this.colorStops[index].hue = value as number;
    this.colorStops[index].color = hsvToHex(
      this.colorStops[index].hue,
      this.colorStops[index].saturation,
      this.colorStops[index].brightness
    );
    this.colorStops[index].service.updateCharacteristic(this.platform.hap.Characteristic.Hue, value);
    await this.scheduleGradientUpdate();
  }

  async getColorStopHue(index: number): Promise<CharacteristicValue> {
    return this.colorStops[index].hue;
  }

  async setColorStopSaturation(index: number, value: CharacteristicValue): Promise<void> {
    this.log(`setColorStopSaturation for stop ${index + 1} called with value:`, value);
    this.colorStops[index].saturation = value as number;
    this.colorStops[index].color = hsvToHex(
      this.colorStops[index].hue,
      this.colorStops[index].saturation,
      this.colorStops[index].brightness
    );
    this.colorStops[index].service.updateCharacteristic(this.platform.hap.Characteristic.Saturation, value);
    await this.scheduleGradientUpdate();
  }

  async getColorStopSaturation(index: number): Promise<CharacteristicValue> {
    return this.colorStops[index].saturation;
  }

  async setColorStopBrightness(index: number, value: CharacteristicValue): Promise<void> {
    this.log(`setColorStopBrightness for stop ${index + 1} called with value:`, value);
    this.colorStops[index].brightness = value as number;
    this.colorStops[index].color = hsvToHex(
      this.colorStops[index].hue,
      this.colorStops[index].saturation,
      this.colorStops[index].brightness
    );
    this.colorStops[index].service.updateCharacteristic(this.platform.hap.Characteristic.Brightness, value);
    await this.scheduleGradientUpdate();
  }

  async getColorStopBrightness(index: number): Promise<CharacteristicValue> {
    return this.colorStops[index].brightness;
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
      const lowerHSV = hexToHsv(lowerStop.color);
      const upperHSV = hexToHsv(upperStop.color);

      const interpolatedHue = interpolateHue(lowerHSV.h, upperHSV.h, localT);
      const interpolatedSaturation = lowerHSV.s + (upperHSV.s - lowerHSV.s) * localT;
      const interpolatedValue = lowerHSV.v + (upperHSV.v - lowerHSV.v) * localT;

      const interpolatedHex = hsvToHex(interpolatedHue, interpolatedSaturation, interpolatedValue);
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

}