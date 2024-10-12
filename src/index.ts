import {
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
} from "homebridge";

const PLATFORM_NAME = "HomebridgeZzZenggeBleStrips";

let hap: HAP;

export default (api: API) => {
    hap = api.hap;
    api.registerPlatform(PLATFORM_NAME, ZenggeLedStripPlatform);

};



class ZenggeLedStripPlatform implements StaticPlatformPlugin {

  private readonly log: Logging;

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.log = log;

    // probably parse config or something here

    log.info("Example platform finished initializing!");
  }

  /*
   * This method is called to retrieve all accessories exposed by the platform.
   * The Platform can delay the response my invoking the callback at a later time,
   * it will delay the bridge startup though, so keep it to a minimum.
   * The set of exposed accessories CANNOT change over the lifetime of the plugin!
   */
  accessories(callback: (foundAccessories: AccessoryPlugin[]) => void): void {
    callback([
      new ZenggeLedStripAccessory(this.log, "Zengge BLE LED Strip", hap),
    ]);
  }

}

class ZenggeLedStripAccessory implements AccessoryPlugin {
    private readonly log: Logging;
    private readonly name: string;
    private isOn: boolean;
    private isRed: boolean;
    private readonly lightService: Service;

    constructor(log: Logging, name: string, api: API) {
        this.log = log;
        this.name = name;

        this.isOn = false;
        this.isRed = false;

        // Créer le service principal de la lumière
        this.lightService = new hap.Service.Lightbulb(this.name);

//         this.lightService.getCharacteristic(hap.Characteristic.On)
//         .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
//           log.info("Current state of the switch was returned: " + (this.isOn? "ON": "OFF"));
//           callback(undefined, this.isOn);
//         })
//         .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
//           this.isOn = value as boolean;
//           log.info("Switch state was set to: " + (this.isOn? "ON": "OFF"));
//           callback();
//         });
        

//         // Caractéristique personnalisée pour gérer l'état "Rouge" (utilisation de "Hue" pour changer la couleur)
// /
          }

    // Renvoie tous les services de l'accessoire
    getServices(): Service[] {
        return [this.lightService];
    }
  }