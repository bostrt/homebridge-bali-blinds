#!/bin/bash
set -e
set -x 

command -v jq >/dev/null 2>&1 || { echo >&2 "I require jq but it's not installed (see: https://stedolan.github.io/jq/).  Aborting."; exit 1; }
command -v curl >/dev/null 2>&1 || { echo >&2 "I require curl but it's not installed (see: https://curl.haxx.se/).  Aborting."; exit 1; }

userId=$1
[ -z "$userId" ] && { echo >&2 "Error: A userId parameter is required"; exit 1; }
read -s -p "Password: " userPassword
[ -z "$userPassword" ] && { echo >&2 "Error: A password parameter is required"; exit 1; }

authUrl="https://swf-us-oem-autha1.mios.com" # Bali motorization specific
passwordSeed=oZ7QE6LcLJp6fiWzdqZc
shaPassword=$(echo -n "${userId}${userPassword}${passwordSeed}" | openssl dgst -sha1 | cut -d ' ' -f 2)

authRequest="${authUrl}/autha/auth/username/${userId}?SHA1Password=${shaPassword}&PK_Oem=73&AppKey=255C5AC6213CEB860AA6EDB23D6F714C5DFC1139"
identityJson=$(curl -s "$authRequest")
echo "curl to autha works"
identityToken=$(echo "$identityJson" | jq -r '.Identity')
echo "identity found"
identitySignature=$(echo "$identityJson" | jq -r '.IdentitySignature')
echo "identity json signature found"
serverAccount=$(echo "$identityJson" | jq -r '.Server_Account')
echo "server account found: $serverAccount"

identityTokenJson=$(echo "$identityToken" | base64 --decode)

# Get Session token
sessionRequest="https://${serverAccount}/info/session/token"
sessionToken=$(curl -s -H "MMSAuth: ${identityToken}" -H "MMSAuthSig: ${identitySignature}" "$sessionRequest")
echo "session token acquired"
echo "Success"
