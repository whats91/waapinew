#!/bin/bash

# Session Migration API Examples using curl
# =========================================
# 
# This script demonstrates how to use the session migration endpoints
# using curl commands. Modify the variables below to match your setup.

# Configuration
API_BASE_URL="http://localhost:3000"
AUTH_TOKEN="your-auth-token-here"
SENDER_ID="1234567890"
OLD_SESSION_PATH="./old-sessions/1234567890/auth"

echo "🚀 WhatsApp API Session Migration Examples"
echo "=========================================="
echo

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_step() {
    echo -e "${BLUE}📋 $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️ $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

# Check if required variables are set
if [ "$AUTH_TOKEN" = "your-auth-token-here" ]; then
    print_error "Please set your AUTH_TOKEN in this script before running!"
    exit 1
fi

# Example 1: Check Migration Status
print_step "Example 1: Check Migration Status for $SENDER_ID"
echo "curl -X GET \"$API_BASE_URL/api/migrationStatus/$SENDER_ID?authToken=$AUTH_TOKEN\""
echo

curl -X GET "$API_BASE_URL/api/migrationStatus/$SENDER_ID?authToken=$AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  | jq '.' 2>/dev/null || echo "Response received (install jq for pretty printing)"

echo
echo "----------------------------------------"
echo

# Example 2: Migrate Session with Multiple Files
print_step "Example 2: Migrate Session with Multiple Credential Files"

# Check if old session directory exists
if [ ! -d "$OLD_SESSION_PATH" ]; then
    print_warning "Old session path not found: $OLD_SESSION_PATH"
    print_warning "Creating example with placeholder files..."
    
    echo "curl -X POST \"$API_BASE_URL/api/migrateSession\" \\"
    echo "  -F \"authToken=$AUTH_TOKEN\" \\"
    echo "  -F \"senderId=$SENDER_ID\" \\"
    echo "  -F \"credFiles=@./path/to/creds.json\" \\"
    echo "  -F \"credFiles=@./path/to/pre-key-1.json\" \\"
    echo "  -F \"credFiles=@./path/to/sender-key-123.json\" \\"
    echo "  -F \"restartSession=true\" \\"
    echo "  -F \"overwriteExisting=false\""
    echo
    print_warning "Update the file paths above to point to your actual credential files."
else
    print_success "Found old session directory: $OLD_SESSION_PATH"
    
    # Build curl command with actual files
    CURL_CMD="curl -X POST \"$API_BASE_URL/api/migrateSession\" -F \"authToken=$AUTH_TOKEN\" -F \"senderId=$SENDER_ID\" -F \"restartSession=true\" -F \"overwriteExisting=true\""
    
    # Add each credential file
    for file in "$OLD_SESSION_PATH"/*; do
        if [ -f "$file" ]; then
            filename=$(basename "$file")
            CURL_CMD="$CURL_CMD -F \"credFiles=@$file\""
            echo "📎 Found credential file: $filename"
        fi
    done
    
    echo
    echo "Generated curl command:"
    echo "$CURL_CMD"
    echo
    
    print_warning "Uncomment the line below to execute the migration:"
    echo "# $CURL_CMD | jq '.'"
fi

echo
echo "----------------------------------------"
echo

# Example 3: Migrate with Specific Options
print_step "Example 3: Migrate with Custom Options (Overwrite Existing)"

echo "curl -X POST \"$API_BASE_URL/api/migrateSession\" \\"
echo "  -F \"authToken=$AUTH_TOKEN\" \\"
echo "  -F \"senderId=$SENDER_ID\" \\"
echo "  -F \"credFiles=@./creds.json\" \\"
echo "  -F \"restartSession=true\" \\"
echo "  -F \"overwriteExisting=true\""

echo
echo "----------------------------------------"
echo

# Example 4: Migrate without restarting session
print_step "Example 4: Migrate Files Only (Don't Restart Session)"

echo "curl -X POST \"$API_BASE_URL/api/migrateSession\" \\"
echo "  -F \"authToken=$AUTH_TOKEN\" \\"
echo "  -F \"senderId=$SENDER_ID\" \\"
echo "  -F \"credFiles=@./creds.json\" \\"
echo "  -F \"restartSession=false\" \\"
echo "  -F \"overwriteExisting=false\""

echo
echo "----------------------------------------"
echo

# Example 5: Check status after migration
print_step "Example 5: Check Status After Migration"

echo "# Wait a moment for session to initialize, then check status:"
echo "sleep 5"
echo "curl -X GET \"$API_BASE_URL/api/migrationStatus/$SENDER_ID?authToken=$AUTH_TOKEN\" | jq '.'"

echo
echo "=========================================="
print_success "Session Migration Examples Complete!"
echo
echo "📝 Notes:"
echo "  - Replace credential file paths with actual paths to your files"
echo "  - Ensure your API server is running on $API_BASE_URL"
echo "  - Update AUTH_TOKEN with your actual authentication token"
echo "  - The senderId should be the phone number without country code (+)"
echo
echo "🔧 File Types Supported:"
echo "  - creds.json (main credentials file)"
echo "  - pre-key-*.json (pre-key files)"
echo "  - session-*.json (session files)"
echo "  - sender-key-*.json (sender key files)"
echo "  - Any other .json, .creds, .keys files"
echo
echo "📚 For programmatic usage, see: examples/session-migration-example.js" 