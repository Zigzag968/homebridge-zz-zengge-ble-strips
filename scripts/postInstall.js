const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('[POSTINSTALL] Setting up Python environment for BLE...');

function ensureBleakInVenv() {
  const venvPath = path.join(__dirname, '..', 'ble-venv');
  const pythonBin = path.join(venvPath, 'bin', 'python3');
  const pipBin = path.join(venvPath, 'bin', 'pip3');

  try {
    // Vérifie si bleak est disponible globalement d'abord
    try {
      execSync('python3 -c "import bleak"', { stdio: 'ignore' });
      console.log('[BLEAK] bleak already available globally.');
      return 'python3';
    } catch {
      console.log('[BLEAK] bleak not found globally, creating virtual environment...');
    }

    // Crée le venv s'il n'existe pas
    if (!fs.existsSync(pythonBin)) {
      console.log('[BLEAK] Creating virtual environment...');
      execSync(`python3 -m venv ${venvPath}`, { stdio: 'inherit' });
    }

    // Vérifie si bleak est déjà installé dans le venv
    try {
      execSync(`${pythonBin} -c "import bleak"`, { stdio: 'ignore' });
      console.log('[BLEAK] bleak already installed in venv.');
    } catch {
      console.log('[BLEAK] Installing bleak in venv...');
      execSync(`${pipBin} install bleak`, { stdio: 'inherit' });
    }

    return pythonBin;
  } catch (e) {
    console.error('[BLEAK] Failed to setup Python environment:', e.message);
    console.warn('[BLEAK] Manual installation required:');
    console.warn('  python3 -m venv ble-venv');
    console.warn('  ble-venv/bin/pip install bleak');
    return null;
  }
}

const pythonPath = ensureBleakInVenv();
if (pythonPath) {
  console.log(`[POSTINSTALL] Python environment ready: ${pythonPath}`);
} else {
  console.warn('[POSTINSTALL] Python setup incomplete - manual intervention required.');
}
