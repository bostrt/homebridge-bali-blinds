#!/bin/bash
set -e

command -v jq >/dev/null 2>&1 || { echo >&2 "I require jq but it's not installed (see: https://stedolan.github.io/jq/).  Aborting."; exit 1; }
command -v curl >/dev/null 2>&1 || { echo >&2 "I require curl but it's not installed (see: https://curl.haxx.se/).  Aborting."; exit 1; }
command -v websocat >/dev/null 2>&1 || { echo >&2 "I require websocat but it's not installed (see: https://github.com/vi/websocat/releases).  Aborting."; exit 1; }


# Adapted from:
# https://gist.github.com/cgmartin/466bd2d3724de6c04743d61cf0de2066

# Usage:
#  ./bali-motorization-routine.sh {userId} {routine}
userId=$1
read -s -p "Password: " userPassword
routine=$2
[ -z "$userId" ] && { echo >&2 "Error: A userId parameter is required"; exit 1; }
[ -z "$userPassword" ] && { echo >&2 "Error: A password parameter is required"; exit 1; }
[ -z "$routine" ] && { echo >&2 "Error: A routine name is required"; exit 1; }

authUrl="https://swf-us-oem-autha1.mios.com" # Bali motorization specific
passwordSeed=oZ7QE6LcLJp6fiWzdqZc
shaPassword=$(echo -n "${userId}${userPassword}${passwordSeed}" | openssl dgst -sha1 | cut -d ' ' -f 2)

# Get Identity tokens
authRequest="${authUrl}/autha/auth/username/${userId}?SHA1Password=${shaPassword}&PK_Oem=73&AppKey=255C5AC6213CEB860AA6EDB23D6F714C5DFC1139"
identityJson=$(curl -s "$authRequest")
identityToken=$(echo "$identityJson" | jq -r '.Identity')
identitySignature=$(echo "$identityJson" | jq -r '.IdentitySignature')
serverAccount=$(echo "$identityJson" | jq -r '.Server_Account')


echo
echo "1. Authenticate"
echo "   $authRequest"
echo "--------------------------------------------------------------------------------------"
echo "$identityJson" | jq

identityTokenJson=$(echo "$identityToken" | base64 --decode)
accountId=$(echo "$identityTokenJson" | jq -r '.PK_Account')

echo
echo "1a. Identity"
echo "------------"
echo "$identityTokenJson" | jq

# Get Session token
sessionRequest="https://${serverAccount}/info/session/token"
sessionToken=$(curl -s -H "MMSAuth: ${identityToken}" -H "MMSAuthSig: ${identitySignature}" "$sessionRequest")

echo
echo "2. Session"
echo "   $sessionRequest"
echo "--------------------------------------------------------------------------------------"
echo "Token: ${sessionToken}"

# Get Account devices (hubs)
devicesRequest="https://${serverAccount}/account/account/account/${accountId}/devices"
devicesJson=$(curl -s -H "MMSSession: ${sessionToken}" "$devicesRequest")
deviceId=$(echo "$devicesJson" | jq -r '.Devices[0].PK_Device')
deviceRelay=$(echo "$devicesJson" | jq -r '.Devices[0].Server_Device')

echo
echo "3. Account Devices"
echo "   $devicesRequest"
echo "--------------------------------------------------------------------------------------"
echo "$devicesJson" | jq

# Get info for a device hub
deviceInfoRequest="https://${deviceRelay}/device/device/device/${deviceId}"
hubJson=$(curl -s -H "MMSSession: ${sessionToken}" "$deviceInfoRequest")
hubInternalIp=$(echo "$hubJson" | jq -r '.InternalIP')
hubExternalIp=$(echo "$hubJson" | jq -r '.ExternalIP')
serverRelay=$(echo "$hubJson" | jq -r '.Server_Relay')

[[ ! "$serverRelay" =~ ^wss://* ]] && { echo >&2 "Error: expected websocket serverRelay but got: $serverRelay"; exit 1; }

set -x
UUID=$(uuidgen)

export routine
export deviceId
export identitySignature
export identityToken
export UUID

wssLogin() {
  # Login
  echo "{\"method\":\"loginUserMios\",\"params\":{\"PK_Device\":\"$deviceId\",\"MMSAuthSig\":\"$identitySignature\",\"MMSAuth\":\"$identityToken\"},\"id\":\"$UUID\"}"
  read -r line
  echo $line >&2

  # Register
  echo "{\"id\":\"$UUID\",\"method\":\"register\",\"params\":{\"serial\":\"$deviceId\"}}"
  read -r line
  echo $line >&2

  # List scenes/routines
  echo "{\"id\":\"$UUID\",\"method\":\"hub.scenes.list\",\"params\":{}}"
  read -r line

  # Validate scene
  foundScene=$(echo $line | jq --arg routine "$routine" '.result.scenes[] | select(.name == $routine)')
  if [ -z "$foundScene" ]; then
    echo "Error: routine $routine does not exist." >&2
    exit 1
  fi

  sceneId=$(echo $foundScene | jq -r '._id')
  # Run the scene
  echo "{\"params\":{\"sceneId\":\"$sceneId\"},\"method\":\"hub.scenes.run\",\"id\":\"$UUID\"}"
  read -r line
  echo $line >&2
}

export -f wssLogin
websocat -v $serverRelay sh-c:"exec bash -c wssLogin"
