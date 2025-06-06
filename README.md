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
Send media files with automatic validation and URL support to individuals or groups.

**Endpoint:** `POST /api/sendMediaSMS`

**Individual Chat:**
```json
{
  "authToken": "your-global-api-auth-token",
  "senderId": "919876543210", 
  "receiverId": "919876543211",
  "mediaurl": "https://example.com/image.jpg",
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
    "mediaurl": "https://example.com/image.jpg",
    "mediaType": "image/jpeg",
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

### 10. Logout Session
Logout from WhatsApp (session can be reconnected later with QR code).

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
  "message": "Session logged out successfully",
  "data": {
    "senderId": "919876543210",
    "status": "logged_out",
    "timestamp": "2024-01-01T00:00:00.000Z"
  }
}
```

---

### 11. Delete Session
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

## 🏗️ Project Structure

```
whatsapp-api-baileys/
├── src/
│   ├── database/
│   │   └── db.js                 # SQLite database operations
│   │   
│   ├── routes/
│   │   └── api.js                # API endpoints
│   │   
│   ├── services/
│   │   ├── baileys-session.js    # WhatsApp session management
│   │   ├── session-manager.js    # Multi-session coordinator
│   │   └── webhook-manager.js    # Webhook handling
│   │   
│   ├── utils/
│   │   └── logger.js             # Winston logger configuration
│   │   
│   └── server.js                 # Express server
├── sessions/                     # Session storage
│   └── {sessionId}/
│       └── auth/                 # Authentication files
├── data/                         # Database files
├── logs/                         # Application logs
├── ecosystem.config.js           # PM2 configuration
├── docker-compose.yml           # Docker composition
├── Dockerfile                   # Docker container
└── package.json                # Dependencies
```

## 🚀 Deployment

### Using PM2 (Recommended)
```bash
# Install PM2 globally
npm install -g pm2

# Start with PM2
npm run pm2:start

# Monitor
npm run pm2:monit

# View logs
npm run pm2:logs

# Stop
npm run pm2:stop
```

### Using Docker
```bash
# Build and run with docker-compose
docker-compose up -d

# Or build manually
docker build -t whatsapp-api .
docker run -p 3000:3000 whatsapp-api
```

## 📊 Session Management

### Session Operations

| Operation | Endpoint | Description | Recoverable |
|-----------|----------|-------------|-------------|
| **Create** | `POST /api/createSession` | Create new WhatsApp session | N/A |
| **Logout** | `POST /api/logoutSession` | Logout from WhatsApp (keeps data) | ✅ Yes - scan QR again |
| **Delete** | `POST /api/deleteSession` | Permanently remove session & folder | ❌ No - data lost forever |

### Session Lifecycle

1. **Create** → Session created in database
2. **QR Scan** → WhatsApp authentication 
3. **Connected** → Ready to send/receive messages
4. **Logout** → Disconnected but can reconnect
5. **Delete** → Permanently removed

### Session Storage Structure
```
./sessions/
├── {senderId}/
│   └── auth/
│       ├── creds.json
│       ├── session-*.json
│       ├── pre-key-*.json
│       └── app-state-sync-*.json
```

### Database Schema
```sql
-- Sessions table
CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT UNIQUE NOT NULL,
    name TEXT,
    auth_token TEXT,
    status TEXT DEFAULT 'disconnected',
    auto_read BOOLEAN DEFAULT 0,
    webhook_status BOOLEAN DEFAULT 0,
    webhook_url TEXT,
    user_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## 🔧 Configuration

### Environment Variables
| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `NODE_ENV` | Environment | `development` |
| `DB_PATH` | Database path | `./data/whatsapp_sessions.db` |
| `SESSION_STORAGE_PATH` | Sessions directory | `./sessions` |
| `MAX_CONCURRENT_SESSIONS` | Max sessions | `100` |
| `AUTH_TOKEN` | Global API auth token | Required |
| `LOG_LEVEL` | Logging level | `info` |
| `WEBHOOK_TIMEOUT` | Webhook timeout (ms) | `5000` |
| `WEBHOOK_RETRY_ATTEMPTS` | Webhook retries | `3` |

## 🛡️ Security Features

- Global authentication token for API access
- WhatsApp number validation to prevent spam
- Session isolation with individual auth folders
- Webhook retry logic with exponential backoff
- Comprehensive error handling and logging
- Process-level error handlers to prevent crashes

## 🚦 Health Check

**Endpoint:** `GET /health`

**Response:**
```json
{
  "status": "OK",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "uptime": "0:05:30",
  "service": "WhatsApp API",
  "version": "1.0.0"
}
```

## 📝 Logging

The application uses Winston for comprehensive logging:

- **Error logs**: `./logs/error.log`
- **Combined logs**: `./logs/combined.log`  
- **Session logs**: `./logs/sessions.log`
- **PM2 logs**: `./logs/pm2-*.log`

## 🐛 Troubleshooting

### Common Issues

1. **QR Code not generating**: Ensure session is created and not already connected
2. **Messages failing**: Check number validation and session connection status
3. **Session disconnections**: Check logs for specific error messages
4. **Database errors**: Ensure proper permissions on `./data/` directory

### Debug Mode
```bash
LOG_LEVEL=debug npm start
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License.

## 🆘 Support

For issues and questions:
- Create an issue on GitHub
- Check the logs for detailed error information
- Ensure all prerequisites are met

---

**Built with ❤️ using [Baileys](https://github.com/WhiskeySockets/Baileys) WhatsApp library**
