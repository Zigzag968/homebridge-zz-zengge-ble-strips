import asyncio
import sys
import json
from bleak import BleakScanner, BleakClient

wanted_devices = set()
connected_clients = {}
pending_commands = {}

# UUIDs temporaires - seront découverts dynamiquement
WRITE_CHAR_UUID = None
NOTIFY_CHAR_UUID = None

MAX_CONNECT_RETRIES = 5
CONNECT_BACKOFF = 5  # seconds

async def discover_characteristics(client, address):
    """Découvre et affiche tous les services et caractéristiques"""
    try:
        print(f"=== DISCOVERING SERVICES FOR {address} ===", file=sys.stderr)
        services = await client.get_services()
        
        write_char = None
        notify_char = None
        
        for service in services:
            print(f"Service: {service.uuid} ({service.description})", file=sys.stderr)
            
            for char in service.characteristics:
                props = ", ".join(char.properties)
                print(f"  Characteristic: {char.uuid} - Properties: [{props}]", file=sys.stderr)
                
                # Chercher une caractéristique avec propriété WRITE
                if "write" in char.properties or "write-without-response" in char.properties:
                    if not write_char:  # Prendre la première trouvée
                        write_char = char.uuid
                        print(f"    -> SELECTED as WRITE characteristic", file=sys.stderr)
                
                # Chercher une caractéristique avec propriété NOTIFY
                if "notify" in char.properties:
                    if not notify_char:  # Prendre la première trouvée
                        notify_char = char.uuid
                        print(f"    -> SELECTED as NOTIFY characteristic", file=sys.stderr)
        
        print(f"=== DISCOVERY COMPLETE FOR {address} ===", file=sys.stderr)
        print(f"Selected WRITE: {write_char}", file=sys.stderr)
        print(f"Selected NOTIFY: {notify_char}", file=sys.stderr)
        
        return write_char, notify_char
    except Exception as e:
        print(f"Error discovering characteristics for {address}: {e}", file=sys.stderr)
        return None, None

async def stdin_listener():
    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)
    while True:
        line = await reader.readline()
        if not line:
            break
        try:
            message = json.loads(line.decode().strip())
            device_id = message.get("device")
            command = message.get("command")
            if device_id in connected_clients:
                client_info = connected_clients[device_id]
                client = client_info["client"]
                write_char = client_info["write_char"]
                
                if write_char:
                    command_bytes = bytes.fromhex(command)
                    print(f"Writing to {write_char}: {command}", file=sys.stderr)
                    await client.write_gatt_char(write_char, command_bytes)
                    print(f"Sent command to {device_id}: {command}", file=sys.stderr)
                else:
                    print(f"No write characteristic available for {device_id}", file=sys.stderr)
            else:
                # Queue the command for later sending
                pending_commands[device_id] = command
                print(f"Queued command for {device_id}: {command}", file=sys.stderr)
        except Exception as e:
            print(f"Error processing input line: {e}", file=sys.stderr)

def notification_handler(sender, data):
    # This function will be called when a notification is received
    print(f"Notification from {sender}: {data.hex()}", file=sys.stderr)

async def connect_and_manage(address):
    retries = 0
    while True:
        try:
            client = BleakClient(address)
            await client.connect()
            print(f"Connected to {address}", file=sys.stderr)

            # Découvrir les caractéristiques disponibles
            write_char, notify_char = await discover_characteristics(client, address)
            
            connected_clients[address] = {
                "client": client,
                "write_char": write_char,
                "notify_char": notify_char
            }

            # Subscribe to notifications si disponible
            if notify_char:
                try:
                    await client.start_notify(notify_char, notification_handler)
                    print(f"Subscribed to notifications on {address} ({notify_char})", file=sys.stderr)
                except Exception as e:
                    print(f"Failed to subscribe to notifications on {address}: {e}", file=sys.stderr)

            # Send any pending command
            if address in pending_commands and write_char:
                command = pending_commands.pop(address)
                command_bytes = bytes.fromhex(command)
                print(f"Sending pending command to {write_char}: {command}", file=sys.stderr)
                await client.write_gatt_char(write_char, command_bytes)
                print(f"Sent pending command to {address}: {command}", file=sys.stderr)

            # Monitor connection
            while client.is_connected:
                await asyncio.sleep(1)

            print(f"Disconnected from {address}", file=sys.stderr)

        except Exception as e:
            print(f"Failed to connect or manage device {address}: {e}", file=sys.stderr)

        # Cleanup
        if address in connected_clients:
            try:
                client_info = connected_clients[address]
                client = client_info["client"]
                if client.is_connected:
                    await client.disconnect()
            except Exception:
                pass
            del connected_clients[address]

        retries += 1
        if retries > MAX_CONNECT_RETRIES:
            print(f"Max retries reached for {address}, giving up.", file=sys.stderr)
            break

        backoff_time = CONNECT_BACKOFF * retries
        print(f"Retrying connection to {address} in {backoff_time} seconds...", file=sys.stderr)
        await asyncio.sleep(backoff_time)

async def scan_loop():
    while True:
        print("Scanning for devices...", file=sys.stderr)
        try:
            devices = await BleakScanner.discover(timeout=5.0)
        except Exception as e:
            print(f"Scan failed: {e}", file=sys.stderr)
            await asyncio.sleep(5)
            continue

        for d in devices:
            if d.address in wanted_devices and d.address not in connected_clients:
                print(f"Found wanted device: {d.address} - {d.name}", file=sys.stderr)
                asyncio.create_task(connect_and_manage(d.address))

        await asyncio.sleep(10)

def main():
    global wanted_devices
    if len(sys.argv) > 1:
        wanted_devices = set(sys.argv[1:])
    else:
        print("No devices specified to watch.", file=sys.stderr)
    loop = asyncio.get_event_loop()
    loop.create_task(stdin_listener())
    loop.create_task(scan_loop())
    loop.run_forever()

if __name__ == "__main__":
    main()
