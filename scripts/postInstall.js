const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { DIST_DIR, VENV_DIR, PYTHON_BIN } = require('../dist/settings');


console.log('[POSTINSTALL] Setting up Python environment for BLE...');

try {
  if (!fs.existsSync(PYTHON_BIN)) {
    console.log('[BLEAK] Creating virtual environment...');
    execSync(`python3 -m venv ${VENV_DIR}`, { stdio: 'inherit' });
  }

  try {
    execSync(`${PYTHON_BIN} -c "import bleak"`, { stdio: 'ignore' });
    console.log('[BLEAK] bleak already installed in venv.');
  } catch {
    console.log('[BLEAK] Installing bleak in venv...');
    execSync(`${PYTHON_BIN} -m pip install bleak`, { stdio: 'inherit' });
  }

  console.log('[POSTINSTALL] Python environment setup complete.');
} catch (e) {
  console.error('[POSTINSTALL] Failed to set up Python environment:', e.message);
  console.warn('[POSTINSTALL] Please install manually if needed.');
}