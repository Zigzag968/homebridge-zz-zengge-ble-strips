import { API } from 'homebridge';
import { PLATFORM_NAME } from './settings';
import { ZenggeLedStripPlatform } from './platform';

/**
 * This method registers the platform with Homebridge
 */
export = (homebridge: API) => {
  homebridge.registerPlatform(PLATFORM_NAME, ZenggeLedStripPlatform);
};