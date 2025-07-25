#!/usr/bin/env python3
import asyncio
import sys
import json
import signal
import time
from typing import Dict, List, Optional
from bleak import BleakScanner, BleakClient

# Devices to watch, passed as command-line args (uppercase MACs)
wanted_devices: set = set()
# Connected clients: MAC -> {"client": BleakClient, "write_char": UUID}
connected_clients: Dict[str, Dict[str, any]] = {}
# Queued commands: MAC -> list of hex-string commands
pending_commands: Dict[str, List[str]] = {}
# Global shutdown flag
shutdown_requested = False

async def force_disconnect_device(mac: str, client: BleakClient, timeout: float = 3.0):
    """Force la déconnexion d'un périphérique avec timeout"""
    try:
        print(f"Force disconnecting {mac}...", file=sys.stderr, flush=True)
        if client.is_connected:
            # Utiliser asyncio.wait_for pour forcer un timeout
            await asyncio.wait_for(client.disconnect(), timeout=timeout)
            print(f"Successfully disconnected {mac}", file=sys.stderr, flush=True)
        else:
            print(f"Device {mac} was already disconnected", file=sys.stderr, flush=True)
    except asyncio.TimeoutError:
        print(f"Timeout disconnecting {mac}, device may be stuck", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"Error disconnecting {mac}: {type(e).__name__}: {e}", file=sys.stderr, flush=True)

async def cleanup_all_connections():
    """Nettoie toutes les connexions avec timeouts et retry"""
    print("Starting connection cleanup...", file=sys.stderr, flush=True)
    
    if not connected_clients:
        print("No connections to clean up", file=sys.stderr, flush=True)
        return
    
    # Créer une liste des tâches de déconnexion
    disconnect_tasks = []
    for mac, info in connected_clients.items():
        client = info['client']
        if client:
            task = asyncio.create_task(force_disconnect_device(mac, client))
            disconnect_tasks.append(task)
    
    if disconnect_tasks:
        # Attendre toutes les déconnexions avec un timeout global
        try:
            await asyncio.wait_for(
                asyncio.gather(*disconnect_tasks, return_exceptions=True),
                timeout=10.0
            )
        except asyncio.TimeoutError:
            print("Global disconnect timeout reached, some devices may remain connected", file=sys.stderr, flush=True)
    
    # Vider le dictionnaire des clients connectés
    connected_clients.clear()
    print("Connection cleanup completed", file=sys.stderr, flush=True)

async def discover_characteristics(client: BleakClient, address: str) -> (Optional[str], Optional[str]):
    try:
        services = await client.get_services()
    except AttributeError:
        # Fallback for bleak versions without get_services()
        services = client.services
    write_char = None
    notify_char = None
    for service in services:
        for char in service.characteristics:
            props = char.properties
            if not write_char and ("write" in props or "write-without-response" in props):
                write_char = char.uuid
            if not notify_char and "notify" in props:
                notify_char = char.uuid
            if write_char and notify_char:
                break
        if write_char and notify_char:
            break
    return write_char, notify_char

async def validate_connection(mac: str) -> bool:
    """Valide que la connexion BLE est toujours active et fonctionnelle"""
    if mac not in connected_clients:
        return False
    
    client = connected_clients[mac]["client"]
    try:
        # Vérifier l'état de base de la connexion
        if not client.is_connected:
            print(f"Connection validation failed for {mac}: client not connected", file=sys.stderr, flush=True)
            return False
        
        # Test simple : récupérer les services pour vérifier la communication
        try:
            services = await asyncio.wait_for(client.get_services(), timeout=5.0)
            if not services:
                print(f"Connection validation failed for {mac}: no services available", file=sys.stderr, flush=True)
                return False
        except asyncio.TimeoutError:
            print(f"Connection validation failed for {mac}: services timeout", file=sys.stderr, flush=True)
            return False
        except AttributeError:
            # Fallback pour les versions plus anciennes de bleak
            services = client.services
            if not services:
                print(f"Connection validation failed for {mac}: no services available (fallback)", file=sys.stderr, flush=True)
                return False
        
        print(f"Connection validation successful for {mac}", file=sys.stderr, flush=True)
        return True
        
    except Exception as e:
        print(f"Connection validation failed for {mac}: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        return False

async def write_ble_command(mac: str, command: str, send_feedback: bool = True) -> bool:
    """
    Fonction centralisée pour écrire une commande BLE avec gestion d'erreurs complète.
    
    Args:
        mac: Adresse MAC du périphérique
        command: Commande hexadécimale à envoyer
        send_feedback: Si True, envoie des messages JSON de feedback
    
    Returns:
        bool: True si l'écriture a réussi, False sinon
    """
    print(f"DEBUG: write_ble_command called for {mac} with command {command}", file=sys.stderr, flush=True)
    
    if mac not in connected_clients:
        print(f"Device {mac} not in connected_clients", file=sys.stderr, flush=True)
        if send_feedback:
            error_msg = {"device": mac, "status": "error", "command": command, "error": "Device not connected"}
            print(json.dumps(error_msg), flush=True)
        return False
    
    client = connected_clients[mac]["client"]
    write_char = connected_clients[mac]["write_char"]
    
    print(f"DEBUG: Client found for {mac}, is_connected: {client.is_connected if client else 'None'}", file=sys.stderr, flush=True)
    print(f"DEBUG: Write characteristic: {write_char}", file=sys.stderr, flush=True)
    
    if not write_char:
        print(f"No write characteristic for {mac}", file=sys.stderr, flush=True)
        if send_feedback:
            error_msg = {"device": mac, "status": "error", "command": command, "error": "No write characteristic"}
            print(json.dumps(error_msg), flush=True)
        return False
    
    try:
        # Validation complète de la connexion avec timeout
        print(f"DEBUG: Validating connection for {mac}", file=sys.stderr, flush=True)
        if not await validate_connection(mac):
            print(f"Connection validation failed for {mac}", file=sys.stderr, flush=True)
            # Nettoyer la connexion défaillante
            await force_disconnect_device(mac, client)
            connected_clients.pop(mac, None)
            if send_feedback:
                error_msg = {"device": mac, "status": "error", "command": command, "error": "Connection validation failed"}
                print(json.dumps(error_msg), flush=True)
            return False
        
        print(f"DEBUG: About to write to {mac}", file=sys.stderr, flush=True)
        print(f"Sending command to {mac}: {command}", file=sys.stderr, flush=True)
        
        # Écriture avec timeout pour éviter les blocages
        await asyncio.wait_for(
            client.write_gatt_char(write_char, bytes.fromhex(command)),
            timeout=5.0
        )
        
        print(f"DEBUG: Write completed successfully for {mac}", file=sys.stderr, flush=True)
        print(f"Command sent successfully to {mac}", file=sys.stderr, flush=True)
        
        if send_feedback:
            success_msg = {"device": mac, "status": "success", "command": command}
            print(json.dumps(success_msg), flush=True)
        
        return True
        
    except asyncio.TimeoutError:
        print(f"DEBUG: Write timeout for {mac}", file=sys.stderr, flush=True)
        print(f"Write timeout for {mac}, connection may be stale", file=sys.stderr, flush=True)
        # Nettoyer la connexion en timeout
        await force_disconnect_device(mac, client)
        connected_clients.pop(mac, None)
        
        if send_feedback:
            error_msg = {"device": mac, "status": "error", "command": command, "error": "Write timeout"}
            print(json.dumps(error_msg), flush=True)
        
        return False
        
    except Exception as e:
        print(f"DEBUG: Write failed for {mac}: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        print(f"Failed to send command to {mac}: {e}", file=sys.stderr, flush=True)
        # Nettoyer la connexion défaillante
        await force_disconnect_device(mac, client)
        connected_clients.pop(mac, None)
        
        if send_feedback:
            error_msg = {"device": mac, "status": "error", "command": command, "error": str(e)}
            print(json.dumps(error_msg), flush=True)
        
        return False

async def process_command_batch(mac: str, commands: List[str]) -> int:
    """
    Traite un lot de commandes pour un périphérique donné.
    
    Args:
        mac: Adresse MAC du périphérique
        commands: Liste des commandes à envoyer
    
    Returns:
        int: Nombre de commandes envoyées avec succès
    """
    if not commands:
        return 0
    
    print(f"Processing batch of {len(commands)} commands for {mac}", file=sys.stderr, flush=True)
    success_count = 0
    
    for i, command in enumerate(commands):
        if shutdown_requested:
            print(f"Shutdown requested, stopping batch processing for {mac}", file=sys.stderr, flush=True)
            break
            
        success = await write_ble_command(mac, command, send_feedback=True)
        if success:
            success_count += 1
        else:
            print(f"Failed to send command {i+1}/{len(commands)} to {mac}, stopping batch", file=sys.stderr, flush=True)
            # Remettre les commandes restantes en queue
            remaining_commands = commands[i+1:]
            if remaining_commands:
                pending_commands.setdefault(mac, []).extend(remaining_commands)
                print(f"Re-queued {len(remaining_commands)} remaining commands for {mac}", file=sys.stderr, flush=True)
            break
    
    print(f"Batch processing complete for {mac}: {success_count}/{len(commands)} commands sent", file=sys.stderr, flush=True)
    return success_count

async def send_command(mac: str, command: str):
    """
    Interface publique pour envoyer une commande BLE.
    Gère la mise en queue si le périphérique n'est pas connecté.
    """
    print(f"DEBUG: send_command called for {mac} with command {command}", file=sys.stderr, flush=True)
    
    if mac in connected_clients:
        await write_ble_command(mac, command, send_feedback=True)
    else:
        print(f"Device {mac} not connected, queuing command", file=sys.stderr, flush=True)
        pending_commands.setdefault(mac, []).append(command)
        # Envoyer un feedback d'information
        queue_msg = {"device": mac, "status": "queued", "command": command}
        print(json.dumps(queue_msg), flush=True)

async def stdin_listener():
    # Read JSON commands from stdin
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await asyncio.get_event_loop().connect_read_pipe(lambda: protocol, sys.stdin)
    while not shutdown_requested:
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=1.0)
            if not line:
                break
            msg = json.loads(line.decode().strip())
            raw = msg.get("device")
            cmd = msg.get("command")
            if not raw or not cmd:
                continue
            mac = raw.upper()
            await send_command(mac, cmd)
        except asyncio.TimeoutError:
            continue  # Timeout normal pour vérifier shutdown_requested
        except Exception as e:
            print(f"stdin processing: {e}", file=sys.stderr, flush=True)

async def connect_and_manage(address: str):
    mac = address.upper()
    while not shutdown_requested:
        print(f"Attempting to connect to {address.upper()}", file=sys.stderr, flush=True)
        client = None
        try:
            client = BleakClient(mac)
            # Connexion avec timeout
            await asyncio.wait_for(client.connect(), timeout=10.0)
            print(f"Connected to {address.upper()}", file=sys.stderr, flush=True)
            
            write_char, notify_char = await discover_characteristics(client, mac)
            connected_clients[mac] = {"client": client, "write_char": write_char}

            # Subscribe to notifications
            if notify_char:
                def notification_handler(sender, data):
                    out = {"device": mac, "notification": data.hex()}
                    print(json.dumps(out), flush=True)
                await client.start_notify(notify_char, notification_handler)

            # Send any queued commands using the batch processor
            queued_commands = pending_commands.pop(mac, [])
            if queued_commands:
                await process_command_batch(mac, queued_commands)

            # Monitor connection until disconnect with periodic validation
            validation_counter = 0
            while client.is_connected and not shutdown_requested:
                await asyncio.sleep(1)
                validation_counter += 1
                
                # Valider la connexion toutes les 30 secondes
                if validation_counter >= 30:
                    validation_counter = 0
                    if not await validate_connection(mac):
                        print(f"Periodic validation failed for {mac}, forcing disconnect", file=sys.stderr, flush=True)
                        break
            print(f"Disconnected from {mac}", file=sys.stderr, flush=True)
            
        except asyncio.TimeoutError:
            print(f"Connection timeout for {mac}", file=sys.stderr, flush=True)
        except Exception as e:
            print(f"manage {mac}: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        finally:
            if mac in connected_clients:
                if client:
                    await force_disconnect_device(mac, client)
                connected_clients.pop(mac, None)
        
        # Wait before retrying (sauf si shutdown demandé)
        if not shutdown_requested:
            await asyncio.sleep(5)

async def scan_loop():
    while not shutdown_requested:
        print("Scanning for devices...", file=sys.stderr, flush=True)
        try:
            devices = await asyncio.wait_for(BleakScanner.discover(timeout=5.0), timeout=10.0)
            print(f"Found {len(devices)} devices during scan", file=sys.stderr, flush=True)
            for wanted in wanted_devices:
                found = any(d.address.upper() == wanted for d in devices)
                status = "found" if found else "not found"
                print(f"Device {wanted} is {status}", file=sys.stderr, flush=True)
            # Check for wanted devices
            for d in devices:
                mac = d.address.upper()
                if mac in wanted_devices and mac not in connected_clients and not shutdown_requested:
                    asyncio.create_task(connect_and_manage(mac))
        except asyncio.TimeoutError:
            print("Scan timeout, retrying...", file=sys.stderr, flush=True)
        except Exception as e:
            print(f"scan: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        
        # Attendre avant le prochain scan
        for _ in range(10):  # 10 secondes par incréments de 1s
            if shutdown_requested:
                break
            await asyncio.sleep(1)

def signal_handler(signum, frame):
    """Gestionnaire de signaux pour un arrêt propre"""
    global shutdown_requested
    print(f"Received signal {signum}, initiating shutdown...", file=sys.stderr, flush=True)
    shutdown_requested = True

def main():
    global wanted_devices
    wanted_devices = {addr.upper() for addr in sys.argv[1:]}
    print(f"Watching devices: {wanted_devices}", file=sys.stderr, flush=True)
    
    # Configurer les gestionnaires de signaux
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    loop = asyncio.get_event_loop()
    
    async def main_async():
        
        # Démarrer les tâches principales
        tasks = [
            asyncio.create_task(stdin_listener()),
            asyncio.create_task(scan_loop())
        ]
        
        try:
            await asyncio.gather(*tasks)
        except Exception as e:
            print(f"Main loop error: {e}", file=sys.stderr, flush=True)
        finally:
            # Nettoyage final
            await cleanup_all_connections()
    
    try:
        loop.run_until_complete(main_async())
    except KeyboardInterrupt:
        print("Keyboard interrupt received", file=sys.stderr, flush=True)
    finally:
        print("Shutting down bleDispatcher...", file=sys.stderr, flush=True)
        
        # Nettoyage final synchrone si nécessaire
        if connected_clients:
            loop.run_until_complete(cleanup_all_connections())
        
        # Cancel all pending tasks and wait for them to finish
        pending_tasks = [task for task in asyncio.all_tasks(loop) if not task.done()]
        if pending_tasks:
            for task in pending_tasks:
                task.cancel()
            loop.run_until_complete(asyncio.gather(*pending_tasks, return_exceptions=True))
        
        loop.close()
        print("bleDispatcher shutdown complete", file=sys.stderr, flush=True)

if __name__ == "__main__":
    main()