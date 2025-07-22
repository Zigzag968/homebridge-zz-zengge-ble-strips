import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import fs from 'fs';

type PendingRequest = {
  device: string;
  command: string;
};

export class BleBridge {
  private pythonProcess: ChildProcessWithoutNullStreams | null = null;
  private ready: boolean = false;

  private getPythonExecutable(): string {
    // Vérifie si un venv existe
    const venvPython = path.resolve(__dirname, '../ble-venv/bin/python3');
    if (fs.existsSync(venvPython)) {
      console.log('[BLE] Using virtual environment Python');
      return venvPython;
    }
    
    console.log('[BLE] Using system Python');
    return 'python3';
  }

  start(devices: string[]): void {
    if (this.pythonProcess) return; // déjà lancé

    const pyPath = path.resolve(__dirname, './bleDispatcher.py');
    const pythonExec = this.getPythonExecutable();
    console.log(`[BLE] Attempting to start Python script at: ${pyPath}`);
    console.log(`[BLE] Using Python executable: ${pythonExec}`);
    
    const args = [pyPath, ...devices.map(d => d.toUpperCase())];
    console.log(`[BLE] Starting Python process with args: ${args.join(' ')}`);
    this.pythonProcess = spawn(pythonExec, args);

    this.pythonProcess.stdout.on('data', (data) => {
      const out = data.toString().trim();
      if (out) console.log('[BLE PYTHON OUT]', out);
    });

    this.pythonProcess.stderr.on('data', (data) => {
      const err = data.toString().trim();
      if (err) console.error('[BLE PYTHON ERR]', err);
    });

    this.pythonProcess.on('error', (error) => {
      console.error('[BLE] Failed to start Python process:', error.message);
      this.pythonProcess = null;
      this.ready = false;
    });

    this.pythonProcess.on('exit', (code) => {
      console.warn(`[BLE Python exited] code=${code}`);
      this.pythonProcess = null;
      this.ready = false;
    });

    this.ready = true;
  }

  sendCommand(device: string, command: string): void {
    if (!this.pythonProcess || !this.ready) {
      console.error('[BLE] Python process not started.');
      return;
    }

    const payload: PendingRequest = { device, command };
    this.pythonProcess.stdin.write(JSON.stringify(payload) + '\n');
  }

  stop(): void {
    if (this.pythonProcess) {
      this.pythonProcess.kill('SIGTERM');
      this.pythonProcess = null;
      this.ready = false;
    }
  }
}