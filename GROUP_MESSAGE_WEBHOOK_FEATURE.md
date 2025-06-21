# Group Message Webhook Control Feature

## 🎯 **Overview**

Added a new database column `send_group_messages` to control whether group messages should be sent to webhooks. This allows users to selectively enable/disable webhook delivery for group messages while keeping private messages enabled.

## 📊 **Database Changes**

### **New Column Added:**
- **Column Name:** `send_group_messages`
- **Type:** `BOOLEAN`
- **Default Value:** `0` (disabled)
- **Purpose:** Controls webhook delivery for group messages

### **Database Schema Update:**
```sql
ALTER TABLE sessions ADD COLUMN send_group_messages BOOLEAN DEFAULT 0;
```

## 🔧 **New Database Methods**

### **updateGroupMessageSetting(sessionId, sendGroupMessages)**
```javascript
// Enable group message webhooks for a session
await database.updateGroupMessageSetting('session123', 1);

// Disable group message webhooks for a session  
await database.updateGroupMessageSetting('session123', 0);
```

### **createSession() - Updated**
Now accepts `send_group_messages` parameter:
```javascript
const sessionData = {
    session_id: 'session123',
    name: 'My Session',
    auth_token: 'token123',
    user_id: 'user456',
    admin_id: 'admin789',
    webhook_url: 'https://example.com/webhook',
    send_group_messages: 1  // NEW: Enable group message webhooks
};

await database.createSession(sessionData);
```

## 📱 **Webhook Behavior**

### **Private Messages:**
- **Always sent to webhook** (if webhook is enabled)
- Behavior unchanged from previous implementation

### **Group Messages:**
- **Only sent if `send_group_messages = 1`**
- If `send_group_messages = 0`, group messages are filtered out
- Includes `isGroup: true` flag in webhook payload

### **Webhook Payload Enhancement:**
```json
{
    "sessionId": "session123",
    "messageId": "msg456",
    "remoteJid": "120363168346132205@g.us",
    "fromMe": false,
    "timestamp": 1672531200,
    "message": {
        "type": "text",
        "content": "Hello group!"
    },
    "participant": "919876543210@s.whatsapp.net",
    "pushName": "John Doe",
    "isGroup": true,  // NEW: Group indicator
    "messageMetadata": {
        // ... existing metadata
    }
}
```

## 🚀 **Usage Examples**

### **Enable Group Messages for Existing Session:**
```javascript
// Via database method
await database.updateGroupMessageSetting('session123', 1);

// Via API endpoint (you'll need to create this)
POST /api/sessions/session123/group-messages
{
    "enabled": true
}
```

### **Create Session with Group Messages Enabled:**
```javascript
const sessionData = {
    session_id: 'session123',
    name: 'Business Support',
    user_id: 'user456',
    webhook_url: 'https://myapi.com/webhook',
    send_group_messages: 1  // Enable group message webhooks
};

await database.createSession(sessionData);
```

### **Check Current Setting:**
```javascript
const session = await database.getSession('session123');
const groupMessagesEnabled = session.send_group_messages;

console.log(`Group messages ${groupMessagesEnabled ? 'enabled' : 'disabled'}`);
```

## 🔍 **Message Filtering Logic**

```javascript
// NEW: Enhanced message processing logic
const isGroup = message.key.remoteJid?.endsWith('@g.us');
const shouldSendGroupMessage = isGroup ? sessionData.send_group_messages : true;
const shouldSendWebhook = !isGroup || shouldSendGroupMessage;

if (shouldSendWebhook) {
    // Send webhook with group indicator
    const messageData = {
        // ... message data
        isGroup: isGroup,
        // ... rest of payload
    };
    
    await webhookManager.sendWebhook(webhookUrl, userId, messageData);
} else {
    // Group message skipped (group messages disabled)
    logger.info('Group message webhook skipped - group messages disabled');
}
```

## 📋 **Console Logging Enhancement**

- **Private Messages:** `✅ Private webhook sent successfully - Status: 200`
- **Group Messages:** `✅ Group webhook sent successfully - Status: 200`
- **Skipped Groups:** `Group message webhook skipped (group messages disabled)`

## 🛠️ **Migration for Existing Sessions**

Existing sessions will have `send_group_messages = 0` by default, meaning:
- **Group message webhooks are DISABLED by default**
- **Private message webhooks continue working normally**
- **Users need to explicitly enable group messages if desired**

## 🎯 **Benefits**

1. **Selective Control:** Choose which message types trigger webhooks
2. **Reduced Noise:** Filter out group messages if only private messages are needed
3. **Backward Compatible:** Existing sessions continue working without changes
4. **Clear Indicators:** Webhook payload includes group/private message flags
5. **Flexible Configuration:** Enable/disable per session as needed

## 🚨 **Important Notes**

1. **Default Behavior:** Group messages are **DISABLED** by default for new sessions
2. **Existing Sessions:** Will have group messages **DISABLED** until explicitly enabled
3. **Private Messages:** Always sent regardless of group message setting
4. **Group Detection:** Based on JID ending with `@g.us`
5. **Auto-Read:** Works independently of webhook settings

---

**This feature provides granular control over webhook delivery while maintaining full backward compatibility with existing implementations.** 