# Homebridge ZZ Zengge BLE Strips

Homebridge ZZ Zengge BLE Strips is a Homebridge platform plugin designed to control Zengge BLE LED strips using HomeKit. The plugin supports gradient effects and state persistence so that your lighting scenes are restored when you power on the LED strip.

## Features

- **HomeKit Integration:** Control your LED strips via the Home app and Siri.
- **Gradient Effects:** The plugin computes smooth gradients based on customizable color stops.
- **Five Sub-Bulb Gradient System:** The gradient effect is implemented using five virtual sub-bulbs. Each sub-bulb represents a portion of the LED strip, allowing for a gradual color transition.
- **State Persistence:** When the LED strip is turned off, the current gradient is saved and automatically restored on power-on.
- **Seamless Mode Switching:** Switch effortlessly between solid colors and gradient effects without losing your custom settings.
- **Robust Bluetooth Communication:** Uses BLE to manage connections, auto-reconnects on communication failures, and continuously monitors the adapter state.

## How It Works

### Gradient System with Five Sub-Bulbs

The gradient functionality in the plugin is based on the concept of five optional virtual sub-bulbs. Just assign color to some or all of them, and the plugin will compute the gradient.

### Mode Switching

The plugin supports switching between:
- **Solid Color Mode:** A uniform color is applied across the entire LED strip.
- **Gradient Mode:** A computed gradient (based on the five sub-bulb system) is applied.

### Bluetooth Communication

- **BLE Connection:** Uses [@abandonware/noble](https://github.com/abandonware/noble) for BLE operations.
- **Auto-Reconnection:** The plugin continuously monitors the connection state and automatically reconnects if needed.
- **State Monitoring:** It listens to BLE events to ensure robust communication even during intermittent issues.

## Installation

1. **Install Homebridge:** Follow the [Homebridge installation guide](https://homebridge.io/).
2. **Install the Plugin:**  
   ```bash
   npm install -g homebridge-zz-zengge-ble-strips
   ```
3. **Configure Homebridge:** Add the following configuration to your config.json file:
    ```json
    {
    "platforms": [
        {
        "platform": "HomebridgeZzZenggeBleStrips",
        "name": "LED Strips",
        "devices": [
            {
            "name": "Living Room LED Strip",
            "address": "XX:XX:XX:XX:XX:XX"
            }
        ]
        }
    ]
    }
    ```

## Usage

- **Power On/Off:**  
  Use HomeKit or Siri commands to toggle the LED strip’s power. When you turn the strip on, the plugin restores the last configured gradient instead of defaulting to white.

- **Set Gradient:**  
  Configure your gradient colors in the Home app. The plugin uses five virtual sub-lightbulbs to render the gradient across the entire strip. Each sub-lightbulb represents a segment of the gradient, and the intermediate colors are automatically computed based on the provided color stops.

- **Restoring State:**  
  When the LED strip is turned on via HomeKit (or via Siri), the plugin restores the previously set gradient. This ensures that your favorite lighting scene is preserved between power cycles.

## Troubleshooting

- **Connectivity Issues:**  
  If you experience connectivity issues, ensure that your BLE adapter is properly powered and that the device is within range.

- **Gradient Restoration Problems:**  
  If the gradient does not restore as expected, verify that the previous state is being correctly saved and that your Homebridge configuration is up-to-date.

- **General Issues:**  
  Check the Homebridge logs for any error messages related to the plugin. Make sure that your device is not reporting an unauthorized state and that the BLE services are being discovered correctly.

## Contributing

Contributions, issues, and feature requests are welcome. Please see the [issues page](https://github.com/Zigzag968/homebridge-zz-zengge-ble-strips/issues) for more information on how to contribute to this project.

## License

This project is licensed under the [MIT License](LICENSE).