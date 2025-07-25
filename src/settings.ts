import path from 'path';

export const PLATFORM_NAME = 'HomebridgeZzZenggeBleStrips';
export const PACKAGE_NAME = 'homebridge-zz-zengge-ble-strips';
export const DIST_DIR = path.join(__dirname);
export const VENV_DIR = path.join(DIST_DIR, 'ble-venv');
export const PYTHON_BIN = path.join(VENV_DIR, 'bin', 'python3');
