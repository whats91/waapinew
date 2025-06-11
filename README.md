# WhatsApp API Integration using Baileys

A robust Node.js WhatsApp API integration using the Baileys library for managing up to 100 concurrent device sessions. This project provides RESTful APIs for sending messages, handling QR codes, fetching contacts and groups, and managing webhooks for incoming messages.

## 🚀 Features

- 🚀 **Multi-Session Support**: Manage up to 100 concurrent WhatsApp sessions
- 📱 **QR Code Authentication**: Easy WhatsApp Web authentication via QR codes with terminal display
- ✅ **WhatsApp Number Validation**: Automatic validation of phone numbers before sending messages
- 💬 **Text & Media Messages**: Send text messages and media files (images, videos, documents, audio)
- 👥 **Contacts & Groups**: Fetch WhatsApp contacts and groups
- 🔗 **Webhook Support**: Configurable webhooks for incoming messages with retry logic
- 📊 **Comprehensive Logging**: Detailed logging using Winston
- 🗄️ **SQLite Database**: Persistent session storage with organized auth folder structure
- 🔄 **Auto-Reconnection**: Robust session management with automatic reconnection
- 🐳 **Docker Ready**: Containerized deployment support
- ⚡ **PM2 Support**: Production-ready process management
- 📁 **Organized Storage**: Session files stored in `./sessions/sessionId/auth/` structure

## 📋 Prerequisites

- Node.js 16.x or higher
- npm or yarn
- SQLite3

## 🛠️ Installation

1. **Clone the repository:**
```bash
git clone https://github.com/whats91/waapinew.git
cd waapinew
```

2. **Install dependencies:**
```bash
npm install
```

3. **Set up environment variables:**
Copy and configure the environment file:
```bash
cp config.env .env
```

Edit `.env` file with your settings:
```env
PORT=3000
NODE_ENV=development
DB_PATH=./data/whatsapp_sessions.db
SESSION_STORAGE_PATH=./sessions
MAX_CONCURRENT_SESSIONS=100
LOG_LEVEL=info
WEBHOOK_TIMEOUT=5000
WEBHOOK_RETRY_ATTEMPTS=3
AUTH_TOKEN=your-global-api-auth-token-here
```

4. **Start the server:**
```bash
# Test setup
npm run test-setup

# Development mode with auto-restart
npm run dev

# Production mode
npm start

# PM2 production deployment
npm run pm2:start
```

The server will start on `http://localhost:3000`

## 📚 API Documentation

### Base URL
```
http://localhost:3000/api
```

### Authentication
All endpoints require a global `authToken` parameter in the request body.

---

### 1. Create Session
Create a new WhatsApp session.

**Endpoint:** `POST /api/createSession`

**Request Body:**
```json
{
  "authToken": "your-global-api-auth-token",
  "senderId": "919876543210",
  "name": "My Session",
  "userId": "user123",
  "webhookUrl": "https://your-webhook-url.com/webhook"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Session created successfully",
  "data": {
    "sessionId": "919876543210",
    "senderId": "919876543210", 
    "status": "created"
  }
}
```

---

### 2. Get QR Code
Get QR code for WhatsApp authentication with large terminal display.

**Endpoint:** `POST /api/getQRCode`

**Request Body:**
```json
{
  "authToken": "your-global-api-auth-token",
  "senderId": "919876543210"
}
```

**Response:**
```json
{
  "success": true,
  "message": "QR code generated successfully",
  "data": {
    "qrCode": "data:image/png;base64,iVBORw0KGgoAAAANSU...",
    "senderId": "919876543210",
    "message": "Scan this QR code with WhatsApp to connect your session",
    "expiresIn": "~20 seconds"
  }
}
```

---

### 2a. Enhanced QR Code Management System

The API now includes an intelligent QR code caching system that prevents authentication interference and provides better user experience.

#### Enhanced QR Code Response

The `/api/getQRCode` endpoint now returns enhanced responses with state information:

**Enhanced Response Format:**
```json
{
  "success": true,
  "message": "QR code ready for scanning",
  "data": {
    "qrCode": "data:image/png;base64,iVBORw0KGgoAAAANSU...",
    "senderId": "919876543210",
    "state": "QR_READY",
    "shouldStopPolling": false,
    "expiresIn": 18500,
    "generatedAt": 1640995200000,
    "message": "Fresh QR code generated. Please scan with WhatsApp.",
    "note": "QR code has been displayed in the terminal"
  }
}
```

#### Authentication States

| State | Description | Frontend Action |
|-------|-------------|-----------------|
| `QR_READY` | QR code is available for scanning | Continue normal polling |
| `AUTHENTICATION_IN_PROGRESS` | User scanned QR, auth happening | **STOP polling immediately** |
| `ALREADY_CONNECTED` | Session is already active | **STOP polling permanently** |
| `QR_EXPIRED` | QR code expired, new one generated | Continue polling |
| `ERROR` | Error occurred | Retry after delay |

#### Frontend Implementation Guidelines

**❌ Wrong Way (Current Problem):**
```javascript
// This causes authentication failures!
setInterval(() => {
    fetchQRCode(); // Keeps requesting every 15 seconds regardless of state
}, 15000);
```

**✅ Correct Way (Recommended):**
```javascript
let pollingInterval;
let shouldPoll = true;

async function fetchQRCode() {
    try {
        const response = await fetch('/api/getQRCode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                authToken: 'your-token',
                senderId: '919876543210'
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            // Display QR code to user
            displayQRCode(data.data.qrCode);
            
            // Check if we should stop polling
            if (data.data.shouldStopPolling) {
                console.log('Stopping QR polling:', data.data.state);
                clearInterval(pollingInterval);
                shouldPoll = false;
                
                // Show appropriate message to user
                if (data.data.state === 'AUTHENTICATION_IN_PROGRESS') {
                    showMessage('QR Code scanned! Please wait for authentication...');
                    // Wait for connection confirmation
                    checkAuthenticationStatus();
                }
            }
        } else if (response.status === 409) {
            // Session already connected
            showMessage('Session already connected!');
            clearInterval(pollingInterval);
            shouldPoll = false;
        } else if (response.status === 202) {
            // Authentication in progress
            showMessage('Authentication in progress. Please wait...');
            clearInterval(pollingInterval);
            shouldPoll = false;
            checkAuthenticationStatus();
        }
    } catch (error) {
        console.error('QR fetch error:', error);
    }
}

// Enhanced polling with state awareness
function startQRPolling() {
    if (!shouldPoll) return;
    
    fetchQRCode();
    pollingInterval = setInterval(() => {
        if (shouldPoll) {
            fetchQRCode();
        } else {
            clearInterval(pollingInterval);
        }
    }, 15000);
}
```

---

### 2b. Get Authentication Status
Check authentication status to help frontend manage QR polling intelligently.

**Endpoint:** `POST /api/getAuthStatus`

**Request Body:**
```json
{
  "authToken": "your-global-api-auth-token",
  "senderId": "919876543210"  
}
```

**Response:**
```json
{
  "success": true,
  "message": "Authentication in progress. Please wait...",
  "data": {
    "senderId": "919876543210",
    "state": "AUTHENTICATION_IN_PROGRESS",
    "isConnected": false,
    "databaseStatus": "connecting",
    "shouldStopPolling": true,
    "socketState": 0,
    "details": "WhatsApp authentication/linking in progress",
    "suggestion": "Wait for authentication to complete. Do not scan additional QR codes.",
    "qrInfo": {
      "hasQR": true,
      "age": 8500,
      "expired": false
    },
    "timestamp": "2024-01-01T10:30:00.000Z"
  }
}
```

#### Usage for Smart Polling

```javascript
async function checkAuthenticationStatus() {
    try {
        const response = await fetch('/api/getAuthStatus', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                authToken: 'your-token',
                senderId: '919876543210'
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            switch (data.data.state) {
                case 'CONNECTED':
                    showMessage('✅ WhatsApp Connected Successfully!');
                    onAuthenticationSuccess();
                    break;
                    
                case 'AUTHENTICATION_IN_PROGRESS':
                    showMessage('🔄 Authentication in progress...');
                    // Check again in 5 seconds
                    setTimeout(checkAuthenticationStatus, 5000);
                    break;
                    
                case 'QR_EXPIRED':
                case 'NEED_FRESH_START':
                    showMessage('QR code expired. Generating new one...');
                    shouldPoll = true;
                    startQRPolling();
                    break;
                    
                default:
                    console.log('Auth state:', data.data.state);
                    setTimeout(checkAuthenticationStatus, 3000);
            }
        }
    } catch (error) {
        console.error('Auth status error:', error);
        setTimeout(checkAuthenticationStatus, 5000);
    }
}
```

#### Best Practices for Frontend

1. **Use `shouldStopPolling` flag** - Always respect this flag to prevent authentication interference
2. **Check authentication status** - Use `/api/getAuthStatus` to monitor progress
3. **Handle all states** - Implement proper UI feedback for each authentication state  
4. **Avoid rapid polling** - Don't request QR codes more than once every 10-15 seconds
5. **Show clear messages** - Inform users about authentication progress

**Complete Frontend Flow:**
```
1. Start QR polling
2. User sees QR code
3. User scans QR code
4. API returns shouldStopPolling: true
5. Stop QR polling immediately  
6. Start checking authentication status
7. Show "Authentication in progress" message
8. Wait for CONNECTED state
9. Redirect to main interface
```

---

### 3. Validate WhatsApp Number
Check if a phone number is registered on WhatsApp before sending messages.

**Endpoint:** `POST /api/validateNumber`

**Request Body:**
```json
{
  "authToken": "your-global-api-auth-token",
  "senderId": "919876543210",
  "phoneNumber": "919876543211"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Number is registered on WhatsApp",
  "data": {
    "senderId": "919876543210",
    "phoneNumber": "919876543211",
    "formattedJID": "919876543211@s.whatsapp.net",
    "isRegistered": true,
    "isGroup": false,
    "validationFailed": false
  }
}
```

---

### 4. Send Text Message
Send a text message to a WhatsApp number or group with automatic validation.

**Endpoint:** `POST /api/sendTextSMS`

**Individual Chat:**
```json
{
  "authToken": "your-global-api-auth-token",
  "senderId": "919876543210",
  "receiverId": "919876543211",
  "messageText": "Hello, this is a test message!"
}
```

**Group Chat:**
```json
{
  "authToken": "your-global-api-auth-token",
  "senderId": "919876543210",
  "receiverId": "120363168346132205",
  "messageText": "Hello everyone in the group!"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Text message sent successfully",
  "data": {
    "messageId": "message-unique-id",
    "senderId": "919876543210",
    "receiverId": "919876543211",
    "messageLength": 33,
    "validation": {
      "isRegistered": true,
      "isGroup": false,
      "formattedJID": "919876543211@s.whatsapp.net",
      "validationPassed": true
    }
  }
}
```

---

### 5. Send Media Message
Send media files with automatic validation and URL support to individuals or groups. **The original filename from the URL is automatically preserved for documents.**

**Endpoint:** `POST /api/sendMediaSMS`

**Individual Chat:**
```json
{
  "authToken": "your-global-api-auth-token",
  "senderId": "919876543210", 
  "receiverId": "919876543211",
  "mediaurl": "https://example.com/santosh-Sale-4-2025-26-182117_1749559882.pdf",
  "caption": "Optional caption for the media"
}
```

**Group Chat:**
```json
{
  "authToken": "your-global-api-auth-token",
  "senderId": "919876543210",
  "receiverId": "120363168346132205",
  "mediaurl": "https://example.com/image.jpg",
  "caption": "Sharing this image with the group!"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Media message sent successfully",
  "data": {
    "messageId": "message-unique-id",
    "senderId": "919876543210",
    "receiverId": "919876543211",
    "mediaurl": "https://example.com/santosh-Sale-4-2025-26-182117_1749559882.pdf",
    "mediaType": "application/pdf",
    "fileName": "santosh-Sale-4-2025-26-182117_1749559882.pdf",
    "caption": "Optional caption",
    "validation": {
      "isRegistered": true,
      "isGroup": false,
      "formattedJID": "919876543211@s.whatsapp.net",
      "validationPassed": true
    }
  }
}
```

**🎯 Filename Preservation:**
- ✅ **PDF files**: `document.pdf` → `santosh-Sale-4-2025-26-182117_1749559882.pdf` 
- ✅ **Excel files**: `document.xlsx` → `financial-report-2024.xlsx`
- ✅ **Word docs**: `document.docx` → `meeting-notes-jan-2024.docx`
- ✅ **Images/Videos**: Original filename preserved for all media types
- ✅ **Automatic fallback**: If filename cannot be extracted, uses generic naming

#### Supported Receiver ID Formats

The API automatically detects and formats receiver IDs for both individual chats and groups:

| Format Type | Example | Description |
|-------------|---------|-------------|
| **Phone Number** | `919876543210` | Individual WhatsApp number |
| **Phone JID** | `919876543210@s.whatsapp.net` | Formatted individual chat |
| **Group ID** | `120363168346132205` | WhatsApp group identifier |
| **Group JID** | `120363168346132205@g.us` | Formatted group chat |
| **Group with Hyphens** | `1234567890-1234567890` | Alternative group ID format |

**Auto-Detection Rules:**
- Numbers 8-15 digits → Individual chat (`@s.whatsapp.net`)
- IDs >15 characters with hyphens or >18 digits → Group chat (`@g.us`)
- Already formatted JIDs → Used as-is

---

### 6. Get Groups
Fetch WhatsApp groups for the authenticated session.

**Endpoint:** `POST /api/getGroups`

**Request Body:**
```json
{
  "authToken": "your-global-api-auth-token",
  "senderId": "919876543210"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Groups retrieved successfully",
  "data": {
    "groups": [
      {
        "id": "120363168346132205@g.us",
        "subject": "My WhatsApp Group",
        "owner": "919876543210@s.whatsapp.net",
        "participants": 15,
        "creation": 1634567890,
        "desc": "Group description"
      }
    ],
    "count": 1
  }
}
```

---

### 7. Get Contacts
Fetch WhatsApp contacts for the authenticated session.

**Endpoint:** `POST /api/getContacts`

**Request Body:**
```json
{
  "authToken": "your-global-api-auth-token",
  "senderId": "919876543210"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Contacts retrieved successfully", 
  "data": {
    "contacts": [
      {
        "id": "919876543211@s.whatsapp.net",
        "name": "John Doe",
        "notify": "John",
        "verifiedName": "John Doe"
      }
    ],
    "count": 1
  }
}
```

---

### 8. Session Status
Get the current status of a session.

**Endpoint:** `GET /api/sessionStatus/:senderId?authToken=your-token`

**Response:**
```json
{
  "success": true,
  "message": "Session status retrieved successfully",
  "data": {
    "senderId": "919876543210",
    "isConnected": true,
    "hasQRCode": false,
    "databaseStatus": "connected"
  }
}
```

---

### 9. Display QR in Terminal
Display QR code in server terminal for easy scanning.

**Endpoint:** `POST /api/displayQR`

**Request Body:**
```json
{
  "authToken": "your-global-api-auth-token",
  "senderId": "919876543210"
}
```

---

### 10. Delete Session
Permanently delete session from database and remove session folder.

**Endpoint:** `POST /api/deleteSession`

**Request Body:**
```json
{
  "authToken": "your-global-api-auth-token",
  "senderId": "919876543210"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Session deleted successfully",
  "data": {
    "senderId": "919876543210",
    "status": "deleted",
    "timestamp": "2024-01-01T00:00:00.000Z",
    "note": "Session removed from database and session folder deleted"
  }
}
```

---

### 11. Logout Session
Logout from WhatsApp and clear all authentication files (requires QR code scan for reconnection).

**Endpoint:** `POST /api/logoutSession`

**Request Body:**
```json
{
  "authToken": "your-global-api-auth-token",
  "senderId": "919876543210"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Session logged out successfully and authentication files cleared",
  "data": {
    "senderId": "919876543210",
    "status": "logged_out",
    "authFilesCleared": true,
    "timestamp": "2024-01-01T00:00:00.000Z",
    "note": "QR code scan will be required for next connection"
  }
}
```

**Important Notes:**
- ⚠️ **Authentication files are permanently deleted** during logout
- 🔄 **QR code scan required** for future connections
- 📁 **All credential files cleared** from the auth directory
- ✅ **Session can be restored** by scanning a new QR code

---

## 🔗 Webhook Management API

### 12. Update Webhook Configuration (Unified API)
Update webhook URL and/or enable/disable webhook status in a single comprehensive API call.

**Endpoint:** `POST /api/updateWebhook`

#### Update Webhook URL Only
```json
{
  "authToken": "your-global-api-auth-token",
  "senderId": "919876543210",
  "webhookUrl": "https://your-domain.com/webhook"
}
```

#### Enable/Disable Webhook Only
```json
{
  "authToken": "your-global-api-auth-token",
  "senderId": "919876543210",
  "webhookStatus": true
}
```

#### Update Both URL and Status
```
```

## 🔧 **QR Code Authentication Issues & Solutions**

### **Common Problem: QR Code Interference During Authentication**

**Issue:** Users scan QR code but device shows timeout/connection failure due to:
- Frontend continuously requesting new QR codes every 15 seconds
- Stream errors during authentication causing QR regeneration
- Multiple QR codes interfering with WhatsApp linking process

**Root Cause:** After user scans QR code, WhatsApp starts authentication but:
1. Stream errors cause socket reconnection
2. Reconnection clears authentication state
3. Frontend continues requesting QR codes
4. New QR codes interrupt authentication process

### **✅ Solution: Authentication State Preservation**

The API now includes **robust authentication state preservation** that:

#### **🔐 Authentication State Detection**
- **`AUTHENTICATION_IN_PROGRESS`** - User has scanned QR, linking in progress
- **`QR_VALID`** - QR code is fresh and ready for scanning
- **`QR_EXPIRED`** - QR expired but socket reusable
- **`CONNECTED`** - Session successfully connected

#### **🛡️ Stream Error Resilience**
- Preserves authentication state during `restartRequired` errors
- Prevents QR regeneration during authentication process
- Maintains state across socket reconnections
- 2-minute timeout for authentication completion

#### **📱 Frontend Integration**
```javascript
// Enhanced response format tells frontend when to stop polling
{
  "qrCode": "data:image/png;base64,iVBORw0KGgoAAAANSU...",
  "state": "AUTHENTICATION_IN_PROGRESS",
  "shouldStopPolling": true,  // ← Frontend should stop requesting QR codes
  "message": "QR code scanned. Authentication in progress. Please wait...",
  "estimatedWaitTime": 30000
}
```

#### **🔄 Best Practices for Frontend**
```javascript
async function handleQRPolling() {
  const response = await fetch('/api/getQRCode', {
    method: 'POST',
    body: JSON.stringify({ authToken, senderId })
  });
  
  const data = await response.json();
  
  // Stop polling when authentication is in progress
  if (data.shouldStopPolling) {
    console.log('Authentication in progress - stopping QR requests');
    clearInterval(pollingInterval);
    
    // Start monitoring authentication status instead
    startAuthStatusMonitoring();
    return;
  }
  
  // Display QR code normally
  displayQRCode(data.qrCode);
}
```

### **🐛 Debugging Authentication Issues**

#### **Log Analysis:**
Look for these patterns in logs:
```bash
# Good - Authentication preserved during stream error
"PRESERVING authentication state during restart"
"Authentication in progress for 15s - QR scanned or linking active"

# Bad - Authentication state lost
"Starting fresh authentication process"
"QR code expired, generating fresh QR without clearing auth"
```

#### **Session Monitoring:**
```bash
# Check session status
curl -X POST http://localhost:3000/api/getAuthStatus \
  -H "Content-Type: application/json" \
  -d '{"authToken":"your-token","senderId":"919876543210"}'
```

---