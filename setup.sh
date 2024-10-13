#!/bin/bash

# setup.sh

# This script creates the enable_bluetooth.sh and disable_bluetooth.sh scripts required by the plugin.

# Create enable_bluetooth.sh
sudo bash -c 'cat << EOF > /usr/local/bin/enable_bluetooth.sh
#!/bin/bash
rfkill unblock bluetooth
systemctl start bluetooth
EOF'

# Create disable_bluetooth.sh
sudo bash -c 'cat << EOF > /usr/local/bin/disable_bluetooth.sh
#!/bin/bash
systemctl stop bluetooth
rfkill block bluetooth
EOF'

# Make the scripts executable
sudo chmod +x /usr/local/bin/enable_bluetooth.sh
sudo chmod +x /usr/local/bin/disable_bluetooth.sh
sudo chown root:root /usr/local/bin/enable_bluetooth.sh
sudo chown root:root /usr/local/bin/disable_bluetooth.sh
sudo chmod 700 /usr/local/bin/enable_bluetooth.sh
sudo chmod 700 /usr/local/bin/disable_bluetooth.sh

echo "Scripts created at /usr/local/bin/enable_bluetooth.sh and /usr/local/bin/disable_bluetooth.sh"

echo "Please ensure these scripts have the appropriate permissions and ownership."

echo "To allow the plugin to execute these scripts, you may need to update the sudoers file."

echo "Please add the following lines to your sudoers file using 'sudo visudo':"

echo "homebridge ALL=(root) NOPASSWD: /usr/local/bin/enable_bluetooth.sh"
echo "homebridge ALL=(root) NOPASSWD: /usr/local/bin/disable_bluetooth.sh"

echo "Replace 'homebridge' with the username under which Homebridge is running."

echo "For security reasons, ensure that these scripts are only writable by root and are not accessible to unauthorized users."
