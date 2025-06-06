# WhatsApp API Integration using Baileys

A robust Node.js WhatsApp API integration using the Baileys library for managing up to 100 concurrent device sessions. This project provides RESTful APIs for sending messages, handling QR codes, fetching contacts and groups, and managing webhooks for incoming messages.

## Features

- 🚀 **Multi-Session Support**: Manage up to 100 concurrent WhatsApp sessions
- 📱 **QR Code Authentication**: Easy WhatsApp Web authentication via QR codes
- 💬 **Text & Media Messages**: Send text messages and media files (images, videos, documents, audio)
- 👥 **Contacts & Groups**: Fetch WhatsApp contacts and groups
- 🔗 **Webhook Support**: Configurable webhooks for incoming messages with retry logic
- 📊 **Comprehensive Logging**: Detailed logging using Winston
- 🗄️ **SQLite Database**: Persistent session storage
- 🔄 **Auto-Reconnection**: Robust session management with automatic reconnection
- 🐳 **Docker Ready**: Containerized deployment support

## Prerequisites

- Node.js 16.x or higher
- npm or yarn
- SQLite3

## Installation

1. **Clone the repository:**
```bash
git clone <repository-url>
cd whatsapp-api-baileys
```

2. **Install dependencies:**
```bash
npm install
```

3. **Set up environment variables:**
Create a `.env` file in the root directory:
```env
PORT=3000
NODE_ENV=development
DB_PATH=./data/whatsapp_sessions.db
SESSION_STORAGE_PATH=./sessions
MAX_CONCURRENT_SESSIONS=100
LOG_LEVEL=info
WEBHOOK_TIMEOUT=5000
WEBHOOK_RETRY_ATTEMPTS=3
```

4. **Start the server:**
```bash
# Development mode with auto-restart
npm run dev

# Production mode
npm start
```


The server will start on `http://localhost:3000`

## API Documentation

### Base URL
```
http://localhost:3000/api
```

### Authentication
Most endpoints require an `authToken` which is obtained when creating a session.

---

### 1. Create Session
Create a new WhatsApp session.

**Endpoint:** `POST /api/createSession`

**Request Body:**
```json
{
  "name": "My Session",
  "userId": "user123",
  "webhookUrl": "https://your-webhook-url.com/webhook"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "sessionId": "uuid-session-id",
    "authToken": "uuid-auth-token",
    "message": "Session created successfully"
  }
}
```

---

### 2. Get QR Code
Get QR code for WhatsApp authentication.

**Endpoint:** `POST /api/getQRCode`

**Request Body:**
```json
{
  "authToken": "your-auth-token"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "qrCode": "data:image/png;base64,iVBORw0KGgoAAAANSU...",
    "message": "Scan this QR code with WhatsApp to connect your session"
  }
}
```

---

### 3. Send Text Message
Send a text message to a WhatsApp number.

**Endpoint:** `POST /api/sendTextSMS`

**Request Body:**
```json
{
  "authToken": "your-auth-token",
  "receiverId": "1234567890@s.whatsapp.net",
  "messageText": "Hello, this is a test message!"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "messageId": "message-unique-id",
    "message": "Text message sent successfully"
  }
}
```

---

### 4. Send Media Message
Send media files (images, videos, documents, audio).

**Endpoint:** `POST /api/sendMediaSMS`

**Request:** Form-data or JSON

**Option 1: File Upload (Form-data)**
```
authToken: your-auth-token
receiverId: 1234567890@s.whatsapp.net
media: [file upload]
caption: Optional caption for the media
```

**Option 2: Media URL (JSON)**
```json
{
  "authToken": "your-auth-token",
  "receiverId": "1234567890@s.whatsapp.net",
  "mediaurl": "https://example.com/image.jpg",
  "caption": "Optional caption for the media"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "messageId": "message-unique-id",
    "message": "Media message sent successfully"
  }
}
```

---

### 5. Get Groups
Fetch WhatsApp groups for the authenticated session.

**Endpoint:** `POST /api/getGroups`

**Request Body:**
```json
{
  "authToken": "your-auth-token"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "groups": [
      {
        "id": "group-id@g.us",
        "subject": "Group Name",
        "owner": "owner@s.whatsapp.net",
        "desc": "Group description",
        "participants": 5,
        "creation": 1234567890
      }
    ],
    "count": 1,
    "message": "Groups fetched successfully"
  }
}
```

---

### 6. Get Contacts
Fetch WhatsApp contacts for the authenticated session.

**Endpoint:** `POST /api/getContacts`

**Request Body:**
```json
{
  "authToken": "your-auth-token"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "contacts": [
      {
        "id": "contact@s.whatsapp.net",
        "name": "Contact Name",
        "notify": "Display Name",
        "verifiedName": "Verified Name",
        "imgUrl": "profile-pic-url",
        "status": "Hey there! I am using WhatsApp."
      }
    ],
    "count": 1,
    "message": "Contacts fetched successfully"
  }
}
```

---

### 7. Update Webhook Configuration
Configure webhook settings for a session.

**Endpoint:** `POST /api/updateWebhook`

**Request Body:**
```json
{
  "authToken": "your-auth-token",
  "webhookUrl": "https://your-webhook-url.com/webhook",
  "webhookStatus": true
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "message": "Webhook configuration updated successfully"
  }
}
```

---

### 8. Test Webhook
Test webhook endpoint connectivity.

**Endpoint:** `POST /api/testWebhook`

**Request Body:**
```json
{
  "authToken": "your-auth-token",
  "webhookUrl": "https://your-webhook-url.com/webhook"
}
```

---

### 9. Get Session Status
Check the status of a session.

**Endpoint:** `GET /api/sessionStatus/:authToken`

**Response:**
```json
{
  "success": true,
  "data": {
    "isConnected": true,
    "hasQRCode": false,
    "message": "Session status retrieved"
  }
}
```

---

### 10. Get System Statistics
Get system and session statistics.

**Endpoint:** `GET /api/stats`

**Response:**
```json
{
  "success": true,
  "data": {
    "totalSessions": 3,
    "connectedSessions": 2,
    "disconnectedSessions": 1,
    "maxSessions": 100,
    "availableSlots": 97
  }
}
```

## Webhook Format

When a webhook is configured, incoming messages will be sent to your webhook URL in this format:

```json
{
  "sessionId": "session-uuid",
  "messageId": "message-id",
  "remoteJid": "sender@s.whatsapp.net",
  "fromMe": false,
  "timestamp": 1634567890,
  "message": {
    "type": "text",
    "content": "Hello, this is an incoming message"
  },
  "participant": null,
  "pushName": "Sender Name"
}
```

## Phone Number Format

WhatsApp JID (Jabber ID) format:
- **Individual:** `1234567890@s.whatsapp.net`
- **Group:** `groupid@g.us`
- **Broadcast:** `broadcastid@broadcast.whatsapp.net`

## Error Handling

All API responses follow this format:

**Success Response:**
```json
{
  "success": true,
  "data": { ... }
}
```

**Error Response:**
```json
{
  "success": false,
  "error": "Error message description"
}
```

Common HTTP status codes:
- `200` - Success
- `400` - Bad Request (missing parameters, validation errors)
- `404` - Not Found (session not found, endpoint not found)
- `500` - Internal Server Error

## Logging

The application uses Winston for comprehensive logging:

- **Logs Directory:** `./logs/`
- **Log Files:**
  - `combined.log` - All logs
  - `error.log` - Error logs only
  - `sessions.log` - Session-specific logs

Log levels: `error`, `warn`, `info`, `verbose`, `debug`

## Docker Deployment

Build and run with Docker:

```bash
# Build the image
docker build -t whatsapp-api .

# Run the container
docker run -p 3000:3000 -v $(pwd)/data:/app/data -v $(pwd)/sessions:/app/sessions whatsapp-api
```

## Performance Considerations

- **Memory Usage:** Each session consumes approximately 50-100MB of RAM
- **Concurrent Sessions:** Tested up to 100 concurrent sessions
- **Database:** SQLite is suitable for moderate loads; consider PostgreSQL/MySQL for high-scale deployments
- **Session Storage:** Session files are stored locally; use network storage for multi-instance deployments

## Security Best Practices

1. **Environment Variables:** Never commit `.env` files to version control
2. **Auth Tokens:** Treat auth tokens as sensitive credentials
3. **Webhook URLs:** Use HTTPS for webhook endpoints
4. **Rate Limiting:** Implement rate limiting for production deployments
5. **Firewall:** Restrict access to the API endpoints as needed

## Troubleshooting

### Common Issues

1. **QR Code Not Generating:**
   - Check if session is already connected
   - Ensure WhatsApp Web is not open elsewhere
   - Try creating a new session

2. **Messages Not Sending:**
   - Verify session is connected (`/api/sessionStatus`)
   - Check recipient number format
   - Ensure WhatsApp account is not banned

3. **Webhook Not Working:**
   - Test webhook URL accessibility
   - Check webhook configuration
   - Review logs for delivery attempts

4. **High Memory Usage:**
   - Monitor session count
   - Implement session cleanup for inactive sessions
   - Consider session rotation

### Debug Mode

Enable debug logging:
```env
LOG_LEVEL=debug
NODE_ENV=development
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Disclaimer

This project is for educational and development purposes. Make sure to comply with WhatsApp's Terms of Service and local regulations when using this software. The authors are not responsible for any misuse of this software.

## Support

For questions and support:
1. Check the [Issues](https://github.com/your-repo/issues) section
2. Review the logs in `./logs/` directory
3. Enable debug logging for detailed troubleshooting

---

**Built with ❤️ using [Baileys](https://github.com/WhiskeySockets/Baileys)** 