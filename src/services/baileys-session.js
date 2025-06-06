const { 
    default: makeWASocket, 
    DisconnectReason, 
    useMultiFileAuthState,
    isJidBroadcast,
    isJidStatusBroadcast,
    isJidNewsletter,
    proto
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const axios = require('axios');

class BaileysSession {
    constructor(sessionId, database, webhookManager) {
        this.sessionId = sessionId;
        this.database = database;
        this.webhookManager = webhookManager;
        this.socket = null;
        this.qrCodeData = null;
        this.qrCodeString = null;
        this.isConnected = false;
        this.retryCount = 0;
        this.maxRetries = 3;
        this.sessionDir = path.join(process.env.SESSION_STORAGE_PATH || './sessions', sessionId);
        this.authDir = path.join(this.sessionDir, 'auth'); // All auth files will be stored in auth subfolder
        this.authState = null;
        this.saveCreds = null;
        
        this.ensureSessionDirectory();
    }

    ensureSessionDirectory() {
        // Create session directory
        if (!fs.existsSync(this.sessionDir)) {
            fs.mkdirSync(this.sessionDir, { recursive: true });
        }
        // Create auth subdirectory for all authentication files
        if (!fs.existsSync(this.authDir)) {
            fs.mkdirSync(this.authDir, { recursive: true });
        }
    }

    async initialize() {
        try {
            logger.session(this.sessionId, 'Initializing Baileys session');
            
            // Load authentication state from auth subdirectory
            const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
            this.authState = state;
            this.saveCreds = saveCreds;

            // Create WhatsApp socket
            this.socket = makeWASocket({
                auth: this.authState,
                logger: {
                    level: 'silent',
                    trace: () => {},
                    debug: () => {},
                    info: () => {},
                    warn: () => {},
                    error: () => {},
                    fatal: () => {},
                    child: () => ({
                        level: 'silent',
                        trace: () => {},
                        debug: () => {},
                        info: () => {},
                        warn: () => {},
                        error: () => {},
                        fatal: () => {}
                    })
                },
                browser: ['WhatsApp API', 'Chrome', '1.0.0'],
                generateHighQualityLinkPreview: true,
                markOnlineOnConnect: false,
                // Add connection options for better stability
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 60000,
                keepAliveIntervalMs: 10000,
                // Reduce memory usage
                shouldSyncHistoryMessage: () => false,
                shouldIgnoreJid: jid => isJidBroadcast(jid) || isJidStatusBroadcast(jid) || isJidNewsletter(jid)
            });

            this.setupEventHandlers();
            
            logger.session(this.sessionId, 'Baileys session initialized successfully');
            return true;
        } catch (error) {
            logger.error('Failed to initialize Baileys session', { sessionId: this.sessionId, error: error.message, stack: error.stack });
            throw error;
        }
    }

    setupEventHandlers() {
        // Add error handler for the socket
        this.socket.ev.on('connection.update', async (update) => {
            try {
                const { connection, lastDisconnect, qr } = update;
                
                if (qr) {
                    try {
                        this.qrCodeString = qr; // Store original QR string for terminal display
                        this.qrCodeData = await QRCode.toDataURL(qr);
                        logger.session(this.sessionId, 'QR code generated');
                        
                        // Enhanced QR code display in terminal with LARGE size
                        console.log('\n' + '='.repeat(80));
                        console.log('📱 WHATSAPP QR CODE - SCAN WITH YOUR PHONE');
                        console.log(`🔗 Session ID: ${this.sessionId.substring(0, 8)}...`);
                        console.log('='.repeat(80));
                        
                        // Display large QR code in terminal
                        QRCode.toString(qr, { 
                            type: 'terminal',
                            width: 60,           // Make it wider
                            margin: 2,           // Add margin
                            small: false         // Use full block characters for better visibility
                        }, (err, qrTerminal) => {
                            if (!err && qrTerminal) {
                                console.log(qrTerminal);
                            } else if (err) {
                                logger.error('Error generating terminal QR', { sessionId: this.sessionId, error: err.message });
                            }
                        });
                        
                        console.log('📋 QR Code is displayed above this message');
                        console.log('⏱️  QR Code expires in ~20 seconds');
                        console.log('🔄 A new QR will generate automatically if needed');
                        console.log('='.repeat(80) + '\n');
                        
                    } catch (error) {
                        logger.error('Failed to generate QR code', { sessionId: this.sessionId, error: error.message });
                    }
                }

                if (connection === 'close') {
                    const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    
                    logger.session(this.sessionId, 'Connection closed', { 
                        reason: statusCode,
                        shouldReconnect,
                        error: lastDisconnect?.error?.message
                    });

                    this.isConnected = false;
                    await this.updateSessionStatus('disconnected').catch(err => {
                        logger.error('Error updating session status to disconnected', { sessionId: this.sessionId, error: err.message });
                    });

                    // Handle different disconnect reasons
                    if (statusCode === DisconnectReason.loggedOut) {
                        logger.session(this.sessionId, 'Session logged out, will not reconnect');
                        await this.updateSessionStatus('logged_out').catch(() => {});
                    } else if (shouldReconnect && this.retryCount < this.maxRetries) {
                        this.retryCount++;
                        logger.session(this.sessionId, `Attempting reconnection (${this.retryCount}/${this.maxRetries})`);
                        setTimeout(() => {
                            this.initialize().catch(error => {
                                logger.error('Reconnection failed', { sessionId: this.sessionId, error: error.message });
                            });
                        }, 5000);
                    } else if (this.retryCount >= this.maxRetries) {
                        logger.session(this.sessionId, 'Max retry attempts reached, stopping reconnection');
                        await this.updateSessionStatus('failed').catch(() => {});
                    }
                } else if (connection === 'open') {
                    this.isConnected = true;
                    this.retryCount = 0;
                    this.qrCodeData = null;
                    this.qrCodeString = null; // Clear QR string when connected
                    
                    console.log('\n' + '🎉'.repeat(20));
                    console.log('✅ WHATSAPP SESSION CONNECTED SUCCESSFULLY!');
                    console.log(`📱 Session ID: ${this.sessionId.substring(0, 8)}...`);
                    console.log('🚀 Ready to send and receive messages');
                    console.log('🎉'.repeat(20) + '\n');
                    
                    logger.session(this.sessionId, 'Session connected successfully');
                    await this.updateSessionStatus('connected').catch(err => {
                        logger.error('Error updating session status to connected', { sessionId: this.sessionId, error: err.message });
                    });
                } else if (connection === 'connecting') {
                    console.log(`\n🔄 Connecting to WhatsApp... (Session: ${this.sessionId.substring(0, 8)}...)\n`);
                    logger.session(this.sessionId, 'Connecting to WhatsApp...');
                    await this.updateSessionStatus('connecting').catch(err => {
                        logger.error('Error updating session status to connecting', { sessionId: this.sessionId, error: err.message });
                    });
                }
            } catch (error) {
                logger.error('Error in connection.update handler', { sessionId: this.sessionId, error: error.message, stack: error.stack });
            }
        });

        // Credentials update with error handling
        this.socket.ev.on('creds.update', async () => {
            try {
                if (this.saveCreds) {
                    await this.saveCreds();
                }
            } catch (error) {
                logger.error('Error saving credentials', { sessionId: this.sessionId, error: error.message });
            }
        });

        // Message handling
        this.socket.ev.on('messages.upsert', async (messageInfo) => {
            try {
                const { messages, type } = messageInfo;
                
                if (type === 'notify' && Array.isArray(messages)) {
                    for (const message of messages) {
                        try {
                            if (message && message.key && !message.key.fromMe && 
                                !isJidBroadcast(message.key.remoteJid) && 
                                !isJidStatusBroadcast(message.key.remoteJid) && 
                                !isJidNewsletter(message.key.remoteJid)) {
                                
                                await this.handleIncomingMessage(message);
                            }
                        } catch (messageError) {
                            logger.error('Error handling individual message', { 
                                sessionId: this.sessionId, 
                                messageId: message?.key?.id,
                                error: messageError.message 
                            });
                        }
                    }
                }
            } catch (error) {
                logger.error('Error handling incoming message batch', { sessionId: this.sessionId, error: error.message });
            }
        });

        // Group updates
        this.socket.ev.on('groups.update', (updates) => {
            try {
                if (Array.isArray(updates)) {
                    logger.session(this.sessionId, 'Groups updated', { count: updates.length });
                }
            } catch (error) {
                logger.error('Error handling groups update', { sessionId: this.sessionId, error: error.message });
            }
        });

        // Contacts update
        this.socket.ev.on('contacts.update', (updates) => {
            try {
                if (Array.isArray(updates)) {
                    logger.session(this.sessionId, 'Contacts updated', { count: updates.length });
                }
            } catch (error) {
                logger.error('Error handling contacts update', { sessionId: this.sessionId, error: error.message });
            }
        });

        // Add generic error handlers for the socket
        this.socket.ev.on('connection.error', (error) => {
            logger.error('Socket connection error', { sessionId: this.sessionId, error: error?.message || 'Unknown error' });
        });

        // Handle any other unhandled socket events
        this.socket.ev.on('error', (error) => {
            logger.error('Socket error', { sessionId: this.sessionId, error: error?.message || 'Unknown error' });
        });

        // Handle process errors to prevent crashes
        process.on('unhandledRejection', (reason, promise) => {
            logger.error('Unhandled Rejection', { 
                sessionId: this.sessionId,
                reason: reason?.message || reason,
                promise: promise?.toString() || 'Unknown promise'
            });
        });

        process.on('uncaughtException', (error) => {
            logger.error('Uncaught Exception', { 
                sessionId: this.sessionId,
                error: error?.message || 'Unknown error',
                stack: error?.stack
            });
        });
    }

    async handleIncomingMessage(message) {
        try {
            if (!message || !message.key) {
                logger.warn('Invalid message received', { sessionId: this.sessionId });
                return;
            }

            const sessionData = await this.database.getSession(this.sessionId);
            
            if (sessionData && sessionData.webhook_status && sessionData.webhook_url) {
                const messageData = {
                    sessionId: this.sessionId,
                    messageId: message.key.id,
                    remoteJid: message.key.remoteJid,
                    fromMe: message.key.fromMe,
                    timestamp: message.messageTimestamp,
                    message: this.extractMessageContent(message),
                    participant: message.key.participant || null,
                    pushName: message.pushName || null
                };

                try {
                    await this.webhookManager.sendWebhook(sessionData.webhook_url, messageData);
                } catch (webhookError) {
                    logger.error('Error sending webhook for message', { 
                        sessionId: this.sessionId, 
                        messageId: message.key.id,
                        error: webhookError.message 
                    });
                }
            }

            // Auto-read functionality
            if (sessionData && sessionData.auto_read) {
                try {
                    await this.markMessageAsRead(message.key);
                } catch (readError) {
                    logger.error('Error marking message as read', { 
                        sessionId: this.sessionId, 
                        messageId: message.key.id,
                        error: readError.message 
                    });
                }
            }
        } catch (error) {
            logger.error('Error processing incoming message', { 
                sessionId: this.sessionId, 
                messageId: message?.key?.id,
                error: error.message 
            });
        }
    }

    extractMessageContent(message) {
        const messageContent = message.message;
        
        if (messageContent?.conversation) {
            return { type: 'text', content: messageContent.conversation };
        } else if (messageContent?.extendedTextMessage) {
            return { type: 'text', content: messageContent.extendedTextMessage.text };
        } else if (messageContent?.imageMessage) {
            return { type: 'image', caption: messageContent.imageMessage.caption };
        } else if (messageContent?.videoMessage) {
            return { type: 'video', caption: messageContent.videoMessage.caption };
        } else if (messageContent?.audioMessage) {
            return { type: 'audio' };
        } else if (messageContent?.documentMessage) {
            return { type: 'document', fileName: messageContent.documentMessage.fileName };
        } else if (messageContent?.contactMessage) {
            return { type: 'contact', displayName: messageContent.contactMessage.displayName };
        }
        
        return { type: 'unknown', raw: messageContent };
    }

    // Utility function to format phone number as WhatsApp JID
    formatAsWhatsAppJID(phoneNumber) {
        // Remove any non-digit characters
        const cleanNumber = phoneNumber.replace(/[^\d]/g, '');
        
        // If it already ends with @s.whatsapp.net or @g.us, return as is
        if (phoneNumber.includes('@')) {
            return phoneNumber;
        }
        
        // For individual chats, add @s.whatsapp.net
        // For group chats, they typically end with @g.us, but we'll handle that separately
        return `${cleanNumber}@s.whatsapp.net`;
    }

    // Check if a phone number is registered on WhatsApp
    async isNumberRegisteredOnWhatsApp(phoneNumber) {
        if (!this.isConnected) {
            throw new Error('Session not connected');
        }

        try {
            // Format the phone number as WhatsApp JID
            const formattedJID = this.formatAsWhatsAppJID(phoneNumber);
            
            // Skip validation for group chats
            if (formattedJID.includes('@g.us')) {
                return {
                    isRegistered: true,
                    jid: formattedJID,
                    isGroup: true
                };
            }

            // Use onWhatsApp method to check if number is registered
            const [result] = await this.socket.onWhatsApp(formattedJID);
            
            if (result && result.exists) {
                logger.session(this.sessionId, 'Number validation: registered', { phoneNumber: formattedJID });
                return {
                    isRegistered: true,
                    jid: result.jid || formattedJID,
                    isGroup: false
                };
            } else {
                logger.session(this.sessionId, 'Number validation: not registered', { phoneNumber: formattedJID });
                return {
                    isRegistered: false,
                    jid: formattedJID,
                    isGroup: false
                };
            }
        } catch (error) {
            logger.error('Error validating WhatsApp number', { 
                sessionId: this.sessionId, 
                phoneNumber, 
                error: error.message 
            });
            
            // If validation fails, assume number is valid to avoid blocking legitimate sends
            // This could happen due to network issues or rate limiting
            return {
                isRegistered: true,
                jid: this.formatAsWhatsAppJID(phoneNumber),
                isGroup: false,
                validationFailed: true,
                error: error.message
            };
        }
    }

    async sendTextMessage(receiverId, messageText) {
        if (!this.isConnected) {
            throw new Error('Session not connected');
        }

        try {
            // Validate if the number is registered on WhatsApp
            const validation = await this.isNumberRegisteredOnWhatsApp(receiverId);
            
            if (!validation.isRegistered && !validation.validationFailed) {
                throw new Error(`Phone number ${receiverId} is not registered on WhatsApp`);
            }

            // Use the validated JID for sending
            const result = await this.socket.sendMessage(validation.jid, { text: messageText });
            
            logger.session(this.sessionId, 'Text message sent', { 
                receiverId: validation.jid,
                isGroup: validation.isGroup,
                validationPassed: validation.isRegistered
            });
            
            return {
                ...result,
                validationResult: validation
            };
        } catch (error) {
            logger.error('Failed to send text message', { sessionId: this.sessionId, receiverId, error: error.message });
            throw error;
        }
    }

    async sendMediaMessage(receiverId, mediaBuffer, mediaType, caption = '') {
        if (!this.isConnected) {
            throw new Error('Session not connected');
        }

        try {
            // Validate if the number is registered on WhatsApp
            const validation = await this.isNumberRegisteredOnWhatsApp(receiverId);
            
            if (!validation.isRegistered && !validation.validationFailed) {
                throw new Error(`Phone number ${receiverId} is not registered on WhatsApp`);
            }

            const messageOptions = { caption };
            
            if (mediaType.startsWith('image/')) {
                messageOptions.image = mediaBuffer;
            } else if (mediaType.startsWith('video/')) {
                messageOptions.video = mediaBuffer;
            } else if (mediaType.startsWith('audio/')) {
                messageOptions.audio = mediaBuffer;
                messageOptions.mimetype = mediaType;
            } else {
                messageOptions.document = mediaBuffer;
                messageOptions.mimetype = mediaType;
                messageOptions.fileName = `document.${mediaType.split('/')[1]}`;
            }

            // Use the validated JID for sending
            const result = await this.socket.sendMessage(validation.jid, messageOptions);
            
            logger.session(this.sessionId, 'Media message sent', { 
                receiverId: validation.jid, 
                mediaType,
                isGroup: validation.isGroup,
                validationPassed: validation.isRegistered
            });
            
            return {
                ...result,
                validationResult: validation
            };
        } catch (error) {
            logger.error('Failed to send media message', { sessionId: this.sessionId, receiverId, error: error.message });
            throw error;
        }
    }

    async markMessageAsRead(messageKey) {
        try {
            await this.socket.readMessages([messageKey]);
            logger.session(this.sessionId, 'Message marked as read', { messageId: messageKey.id });
        } catch (error) {
            logger.error('Failed to mark message as read', { sessionId: this.sessionId, error: error.message });
        }
    }

    async getGroups() {
        if (!this.isConnected) {
            throw new Error('Session not connected');
        }

        try {
            const groups = await this.socket.groupFetchAllParticipating();
            const groupList = Object.values(groups).map(group => ({
                id: group.id,
                subject: group.subject,
                owner: group.owner,
                desc: group.desc,
                participants: group.participants.length,
                creation: group.creation,
                subjectOwner: group.subjectOwner,
                subjectTime: group.subjectTime
            }));

            logger.session(this.sessionId, 'Groups fetched', { count: groupList.length });
            return groupList;
        } catch (error) {
            logger.error('Failed to fetch groups', { sessionId: this.sessionId, error: error.message });
            throw error;
        }
    }

    async getContacts() {
        if (!this.isConnected) {
            throw new Error('Session not connected');
        }

        try {
            const contacts = this.socket.store?.contacts || {};
            const contactList = Object.values(contacts).map(contact => ({
                id: contact.id,
                name: contact.name,
                notify: contact.notify,
                verifiedName: contact.verifiedName,
                imgUrl: contact.imgUrl,
                status: contact.status
            }));

            logger.session(this.sessionId, 'Contacts fetched', { count: contactList.length });
            return contactList;
        } catch (error) {
            logger.error('Failed to fetch contacts', { sessionId: this.sessionId, error: error.message });
            throw error;
        }
    }

    async updateSessionStatus(status) {
        try {
            await this.database.updateSessionStatus(this.sessionId, status);
        } catch (error) {
            logger.error('Failed to update session status', { sessionId: this.sessionId, status, error: error.message });
        }
    }

    getQRCode() {
        return this.qrCodeData;
    }

    getQRString() {
        return this.qrCodeString;
    }

    isSessionConnected() {
        return this.isConnected;
    }

    async destroy() {
        try {
            if (this.socket) {
                this.socket.end();
            }
            this.isConnected = false;
            await this.updateSessionStatus('disconnected');
            logger.session(this.sessionId, 'Session destroyed');
        } catch (error) {
            logger.error('Error destroying session', { sessionId: this.sessionId, error: error.message });
        }
    }
}

module.exports = BaileysSession; 