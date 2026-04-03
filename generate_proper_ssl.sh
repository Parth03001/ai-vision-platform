#!/bin/bash

# Safe SSL Generation Script
# Generates Nginx-compatible SSL files ensuring proper formatting (newlines).

# Directories
SOURCE_DIR="/home/maiuser/certificate/ssl"
DEST_DIR="/home/maiuser/nashik-chatbot-pq/ssl"
BACKUP_DIR="/home/maiuser/nashik-chatbot-pq/ssl_backup_$(date +%Y%m%d_%H%M%S)"

# Files
SERVER_CERT="$SOURCE_DIR/m-devsecopswildcard.cer"
INTERMEDIATE_CERT="$SOURCE_DIR/intermediate.cer"
ROOT_CERT="$SOURCE_DIR/root.cer"
PFX_FILE="$SOURCE_DIR/m-devsecopswildcard.pfx"

# Output Files
FULLCHAIN="$DEST_DIR/fullchain.pem"
CA_CHAIN="$DEST_DIR/ca-chain.crt"
KEY_FILE="$DEST_DIR/key.pem"

echo "=== Starting Safe SSL Generation ==="
echo "Source: $SOURCE_DIR"
echo "Destination: $DEST_DIR"

# 1. Create Destination and Backup
echo "Creating backup of existing SSL folder..."
if [ -d "$DEST_DIR" ]; then
    cp -r "$DEST_DIR" "$BACKUP_DIR"
    echo "Backup created at $BACKUP_DIR"
else
    mkdir -p "$DEST_DIR"
fi

# 2. Function to convert to PEM if needed and print with guaranteed newline
process_cert() {
    local file=$1
    local name=$2
    
    if [ ! -f "$file" ]; then
        echo "❌ Error: $name file not found at $file"
        return 1
    fi

    echo "Processing $name..." >&2

    # Check if DER format (binary), convert if so. Otherwise cat.
    if openssl x509 -in "$file" -text -noout >/dev/null 2>&1; then
        # It's already PEM
        cat "$file"
    else
        # Try converting DER to PEM
        echo "  (Converting DER to PEM)" >&2
        openssl x509 -inform DER -in "$file" -outform PEM
    fi
    
    # Always append a newline to be safe
    echo ""
}

# 3. Generate fullchain.pem (Server + Intermediate)
echo "------------------------------------------------"
echo "Generating fullchain.pem (Server + Intermediate)..."
{
    process_cert "$SERVER_CERT" "Server Certificate"
    process_cert "$INTERMEDIATE_CERT" "Intermediate Certificate"
} > "$FULLCHAIN"

if [ -s "$FULLCHAIN" ]; then
    echo "✅ fullchain.pem created."
else
    echo "❌ Failed to create fullchain.pem"
    exit 1
fi

# 4. Generate ca-chain.crt (Intermediate + Root)
echo "------------------------------------------------"
echo "Generating ca-chain.crt (Intermediate + Root)..."
{
    process_cert "$INTERMEDIATE_CERT" "Intermediate Certificate"
    process_cert "$ROOT_CERT" "Root Certificate"
} > "$CA_CHAIN"

if [ -s "$CA_CHAIN" ]; then
    echo "✅ ca-chain.crt created."
else
    echo "❌ Failed to create ca-chain.crt"
    exit 1
fi

# 5. Handle Private Key
echo "------------------------------------------------"
echo "Handling Private Key..."

# Strategy A: Copy existing working key if available
if [ -f "$DEST_DIR/key.pem" ] && [ -s "$DEST_DIR/key.pem" ]; then
    echo "Existing key.pem found in destination. Keeping it."
# We verify it matches later
# Strategy B: Extract from PFX if PFX exists
elif [ -f "$PFX_FILE" ]; then
    echo "Extracting private key from PFX..."
    # Try with empty password first
    openssl pkcs12 -in "$PFX_FILE" -nocerts -nodes -out "$KEY_FILE" -passin pass: 2>/dev/null || \
    openssl pkcs12 -in "$PFX_FILE" -nocerts -nodes -out "$KEY_FILE"
    
    if [ -s "$KEY_FILE" ]; then
        echo "✅ Key extracted from PFX."
    else
        echo "❌ Failed to extract key from PFX (password might be required)."
    fi
else
    echo "⚠️ No private key found (checked existing key.pem and source PFX)."
fi

# 6. Set Permissions
chmod 644 "$FULLCHAIN" "$CA_CHAIN"
[ -f "$KEY_FILE" ] && chmod 600 "$KEY_FILE"

# 7. Verification
echo "------------------------------------------------"
echo "Verifying Certificates..."

# Check fullchain
if openssl x509 -in "$FULLCHAIN" -noout; then
    echo "✅ fullchain.pem format is VALID."
else
    echo "❌ fullchain.pem format is INVALID (check logs)."
fi

# Check ca-chain
if openssl x509 -in "$CA_CHAIN" -noout; then
    echo "✅ ca-chain.crt format is VALID."
else
    echo "❌ ca-chain.crt format is INVALID (check logs)."
fi

# Check Match
if [ -f "$KEY_FILE" ]; then
    CERT_MOD=$(openssl x509 -in "$FULLCHAIN" -noout -modulus | openssl md5)
    KEY_MOD=$(openssl rsa -in "$KEY_FILE" -noout -modulus | openssl md5)
    
    if [ "$CERT_MOD" == "$KEY_MOD" ]; then
        echo "✅ Certificate and Key MATCH."
    else
        echo "❌ Certificate and Key DO NOT MATCH!"
        echo "Cert MD5: $CERT_MOD"
        echo "Key MD5:  $KEY_MOD"
    fi
fi

echo "=== Done ==="
