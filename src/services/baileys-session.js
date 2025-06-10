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
        this.qrCodeTimestamp = null; // Track when QR was generated for expiry
        this.isConnected = false;
        this.retryCount = 0;
        this.maxRetries = parseInt(process.env.SESSION_MAX_RETRIES) || 5; // Use configurable max retries
        this.sessionDir = path.join(process.env.SESSION_STORAGE_PATH || './sessions', sessionId);
        this.authDir = path.join(this.sessionDir, 'auth'); // All auth files will be stored in auth subfolder
        this.authState = null;
        this.saveCreds = null;
        this.lastActivity = Date.now(); // Track last activity for health monitoring
        this.displayQRInTerminal = false; // Default to false - no QR display unless requested
        this.isAPIRequest = false; // Flag to identify if this is an API-requested QR
        this.autoConnect = false; // Flag to control automatic connection - default false
        this.isInitialized = false; // Track if session has been initialized
        
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

    // Method to set QR display preferences
    setQRDisplayMode(displayInTerminal = true, isAPIRequest = false) {
        this.displayQRInTerminal = displayInTerminal;
        this.isAPIRequest = isAPIRequest;
    }

    // Method to enable/disable automatic connection
    setAutoConnect(autoConnect = true) {
        this.autoConnect = autoConnect;
    }

    // Initialize session without connecting (lazy initialization)
    async initializeWithoutConnection() {
        try {
            logger.session(this.sessionId, 'Initializing Baileys session (lazy mode)');
            
            // Load authentication state from auth subdirectory
            const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
            this.authState = state;
            this.saveCreds = saveCreds;
            this.isInitialized = true;

            logger.session(this.sessionId, 'Baileys session initialized successfully (lazy mode)');
            return true;
        } catch (error) {
            logger.error('Failed to initialize Baileys session (lazy mode)', { sessionId: this.sessionId, error: error.message });
            throw error;
        }
    }

    // Connect to WhatsApp (creates socket and starts connection)
    async connect() {
        try {
            if (!this.isInitialized) {
                await this.initializeWithoutConnection();
            }

            if (this.socket) {
                logger.session(this.sessionId, 'Socket already exists, destroying before reconnect');
                try {
                    this.socket.end();
                } catch (e) {
                    // Ignore errors when ending existing socket
                }
                this.socket = null;
            }

            logger.session(this.sessionId, 'Creating WhatsApp socket and connecting');
            
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
            
            logger.session(this.sessionId, 'WhatsApp socket created and connection started');
            return true;
        } catch (error) {
            logger.error('Failed to connect Baileys session', { sessionId: this.sessionId, error: error.message });
            throw error;
        }
    }

    async initialize() {
        // Check if we should auto-connect or just do lazy initialization
        if (this.autoConnect) {
            return await this.connect();
        } else {
            return await this.initializeWithoutConnection();
        }
    }

    setupEventHandlers() {
        // Add error handler for the socket
        this.socket.ev.on('connection.update', async (update) => {
            try {
                const { connection, lastDisconnect, qr } = update;
                
                // Log socket state changes for debugging
                if (this.socket && this.socket.readyState !== undefined) {
                    const stateNames = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
                    const stateName = stateNames[this.socket.readyState] || 'UNKNOWN';
                    logger.session(this.sessionId, `Socket readyState: ${this.socket.readyState} (${stateName})`, {
                        connection,
                        hasQR: !!qr
                    });
                }
                
                if (qr) {
                    try {
                        this.qrCodeString = qr; // Store original QR string for terminal display
                        this.qrCodeData = await QRCode.toDataURL(qr);
                        this.qrCodeTimestamp = Date.now(); // Track when QR was generated for expiry
                        logger.session(this.sessionId, 'QR code generated', {
                            socketState: this.socket?.readyState,
                            displayMode: this.displayQRInTerminal,
                            isAPIRequest: this.isAPIRequest
                        });
                        
                        // Only display QR in terminal if explicitly requested
                        if (this.displayQRInTerminal) {
                            // Enhanced QR code display in terminal with LARGE size
                            const displayTitle = this.isAPIRequest ? 
                                '🌐 API QR CODE REQUEST - SCAN WITH YOUR PHONE' : 
                                '📱 WHATSAPP QR CODE - SCAN WITH YOUR PHONE';
                            
                            console.log('\n' + '='.repeat(80));
                            console.log(displayTitle);
                            console.log(`🔗 Session ID: ${this.sessionId.substring(0, 8)}...`);
                            console.log(`🔌 Socket State: ${this.socket?.readyState} (${['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][this.socket?.readyState] || 'UNKNOWN'})`);
                            if (this.isAPIRequest) {
                                console.log(`📡 API Requested: ${new Date().toLocaleTimeString()}`);
                            }
                            console.log('⚠️  DO NOT SCAN MULTIPLE TIMES - Wait for connection!');
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
                            console.log('🚨 SCAN ONLY ONCE - Multiple scans will fail!');
                            if (!this.isAPIRequest) {
                                console.log('🔄 A new QR will generate automatically if needed');
                            }
                            console.log('='.repeat(80) + '\n');
                        } else {
                            logger.session(this.sessionId, 'QR code generated (terminal display disabled)');
                        }
                        
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
                        error: lastDisconnect?.error?.message,
                        socketState: this.socket?.readyState
                    });

                    this.isConnected = false;
                    await this.updateSessionStatus('disconnected').catch(err => {
                        logger.error('Error updating session status to disconnected', { sessionId: this.sessionId, error: err.message });
                    });

                    // Enhanced disconnect handling with better reconnection logic
                    if (statusCode === DisconnectReason.loggedOut) {
                        logger.session(this.sessionId, 'Session logged out, will not reconnect');
                        await this.updateSessionStatus('logged_out').catch(() => {});
                    } else if (statusCode === DisconnectReason.restartRequired) {
                        logger.session(this.sessionId, 'WhatsApp restart required, attempting reconnection');
                        this.retryCount = 0; // Reset retry count for restart scenarios
                        setTimeout(() => {
                            this.initialize().catch(error => {
                                logger.error('Restart reconnection failed', { sessionId: this.sessionId, error: error.message });
                            });
                        }, 2000);
                    } else if (statusCode === DisconnectReason.connectionClosed || 
                              statusCode === DisconnectReason.connectionLost ||
                              statusCode === DisconnectReason.timedOut) {
                        // Common network issues - retry immediately with exponential backoff
                        if (this.retryCount < this.maxRetries) {
                            this.retryCount++;
                            const backoffTime = Math.min(1000 * Math.pow(2, this.retryCount - 1), 30000); // Max 30 seconds
                            logger.session(this.sessionId, `Network disconnection, retrying in ${backoffTime}ms (${this.retryCount}/${this.maxRetries})`);
                            
                            setTimeout(() => {
                                this.initialize().catch(error => {
                                    logger.error('Network reconnection failed', { sessionId: this.sessionId, error: error.message });
                                });
                            }, backoffTime);
                        } else {
                            logger.session(this.sessionId, 'Max network retry attempts reached');
                            await this.updateSessionStatus('failed').catch(() => {});
                        }
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
                    this.qrCodeTimestamp = null; // Clear QR timestamp when connected
                    
                    console.log('\n' + '🎉'.repeat(20));
                    console.log('✅ WHATSAPP SESSION CONNECTED SUCCESSFULLY!');
                    console.log(`📱 Session ID: ${this.sessionId.substring(0, 8)}...`);
                    console.log('🚀 Ready to send and receive messages');
                    console.log('🔄 Auto-refresh monitoring active');
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

        // Enhanced error handling for socket events
        this.socket.ev.on('messaging.update', (update) => {
            try {
                // Handle message updates if needed
                logger.session(this.sessionId, 'Message update received', { update: update.length || 'unknown' });
            } catch (error) {
                logger.error('Error in messaging.update handler', { sessionId: this.sessionId, error: error.message });
            }
        });

        // Add socket error handler
        this.socket.ev.on('socket.error', (error) => {
            logger.error('Socket error occurred', { sessionId: this.sessionId, error: error.message });
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
                
                console.log('\n🔍 RAW MESSAGE UPSERT EVENT RECEIVED');
                console.log('════════════════════════════════════════════════════════════════════');
                console.log('Session ID:', this.sessionId);
                console.log('📊 SESSION STATUS CHECK:');
                console.log('  Socket exists:', !!this.socket);
                console.log('  Socket user exists:', !!this.socket?.user);
                console.log('  Socket readyState:', this.socket?.readyState);
                console.log('  isConnected flag:', this.isConnected);
                console.log('  Session connected:', this.isSessionConnected());
                console.log('  Auth state exists:', !!this.authState);
                console.log('  Has credentials:', !!(this.authState?.creds));
                
                // Check what type of WhatsApp this is
                if (this.socket?.user) {
                    console.log('👤 CONNECTED USER INFO:');
                    console.log('  User ID:', this.socket.user.id);
                    console.log('  User Name:', this.socket.user.name);
                    console.log('  Is Business:', this.socket.user.businessProfile ? 'YES' : 'NO');
                    if (this.socket.user.businessProfile) {
                        console.log('  Business Name:', this.socket.user.businessProfile.businessName);
                        console.log('  Business Category:', this.socket.user.businessProfile.category);
                    }
                }
                
                console.log('Message Info Type:', type);
                console.log('Messages Array Length:', Array.isArray(messages) ? messages.length : 'Not an array');
                console.log('Timestamp:', new Date().toISOString());
                
                if (type === 'notify' && Array.isArray(messages)) {
                    console.log(`📬 Processing ${messages.length} message(s) of type: ${type}`);
                    
                    for (let i = 0; i < messages.length; i++) {
                        const message = messages[i];
                        console.log(`\n───── MESSAGE ${i + 1}/${messages.length} ─────`);
                        
                        try {
                            // Detailed logging BEFORE filtering
                            console.log('📋 MESSAGE STRUCTURE ANALYSIS:');
                            console.log('  Has message object:', !!message);
                            console.log('  Has message.key:', !!message?.key);
                            console.log('  Message keys:', message ? Object.keys(message) : 'null');
                            
                            if (message?.key) {
                                console.log('🔑 MESSAGE KEY ANALYSIS:');
                                console.log('  Key object:', JSON.stringify(message.key, null, 2));
                                console.log('  From Me:', message.key.fromMe);
                                console.log('  Remote JID:', message.key.remoteJid);
                                console.log('  Message ID:', message.key.id);
                                console.log('  Participant:', message.key.participant);
                                
                                // Test each filtering condition individually
                                console.log('🚦 FILTERING CONDITIONS ANALYSIS:');
                                const hasMessage = !!message;
                                const hasKey = !!message.key;
                                const notFromMe = !message.key.fromMe;
                                const notBroadcast = !isJidBroadcast(message.key.remoteJid);
                                const notStatusBroadcast = !isJidStatusBroadcast(message.key.remoteJid);
                                const notNewsletter = !isJidNewsletter(message.key.remoteJid);
                                
                                console.log('  ✓ Has message:', hasMessage);
                                console.log('  ✓ Has key:', hasKey);
                                console.log('  ✓ Not from me:', notFromMe);
                                console.log('  ✓ Not broadcast (isJidBroadcast):', notBroadcast);
                                console.log('  ✓ Not status broadcast (isJidStatusBroadcast):', notStatusBroadcast);
                                console.log('  ✓ Not newsletter (isJidNewsletter):', notNewsletter);
                                
                                const shouldProcess = hasMessage && hasKey && notBroadcast && notStatusBroadcast && notNewsletter;
                                console.log('  🎯 SHOULD PROCESS MESSAGE:', shouldProcess);
                                
                                if (!shouldProcess) {
                                    console.log('  ❌ MESSAGE FILTERED OUT - REASON:');
                                    if (!hasMessage) console.log('    - Missing message object');
                                    if (!hasKey) console.log('    - Missing message key');
                                    if (!notBroadcast) console.log('    - Message is a broadcast (isJidBroadcast returned true)');
                                    if (!notStatusBroadcast) console.log('    - Message is a status broadcast (isJidStatusBroadcast returned true)');
                                    if (!notNewsletter) console.log('    - Message is a newsletter (isJidNewsletter returned true)');
                                    
                                    // Additional debugging for JID functions
                                    console.log('  🔍 JID FUNCTION DEBUGGING:');
                                    console.log('    - Remote JID:', message.key.remoteJid);
                                    console.log('    - isJidBroadcast result:', isJidBroadcast(message.key.remoteJid));
                                    console.log('    - isJidStatusBroadcast result:', isJidStatusBroadcast(message.key.remoteJid));
                                    console.log('    - isJidNewsletter result:', isJidNewsletter(message.key.remoteJid));
                                    
                                    // Check JID patterns
                                    const jid = message.key.remoteJid;
                                    console.log('    - JID ends with @s.whatsapp.net:', jid?.endsWith('@s.whatsapp.net'));
                                    console.log('    - JID ends with @g.us:', jid?.endsWith('@g.us'));
                                    console.log('    - JID ends with @broadcast:', jid?.endsWith('@broadcast'));
                                    console.log('    - JID contains "status":', jid?.includes('status'));
                                    console.log('    - JID contains "newsletter":', jid?.includes('newsletter'));
                                }
                            } else {
                                console.log('  ❌ No message key found');
                            }
                            
                            // TEMPORARILY MODIFIED FILTERING - ALLOW ALL MESSAGES FOR DEBUGGING
                            // Original condition was: if (message && message.key && !message.key.fromMe && !isJidBroadcast(message.key.remoteJid) && !isJidStatusBroadcast(message.key.remoteJid) && !isJidNewsletter(message.key.remoteJid))
                            
                            // NEW TEMPORARY CONDITION - PROCESS ALL MESSAGES TO DEBUG REGULAR VS BUSINESS WHATSAPP
                            if (message && message.key && 
                                !isJidBroadcast(message.key.remoteJid) && 
                                !isJidStatusBroadcast(message.key.remoteJid) && 
                                !isJidNewsletter(message.key.remoteJid)) {
                                
                                console.log('  🎉 MESSAGE PASSED MODIFIED FILTERS - PROCESSING...');
                                console.log('  🔍 DEBUG INFO:');
                                console.log('    - fromMe:', message.key.fromMe);
                                console.log('    - Direction:', message.key.fromMe ? 'OUTGOING' : 'INCOMING');
                                console.log('    - Will Process:', true);
                                
                                await this.handleIncomingMessage(message);
                            } else {
                                console.log('  🚫 MESSAGE REJECTED BY FILTERS');
                            }
                        } catch (messageError) {
                            console.log('  ❌ ERROR PROCESSING INDIVIDUAL MESSAGE:');
                            console.log('    Error:', messageError.message);
                            console.log('    Message ID:', message?.key?.id);
                            console.log('    Stack:', messageError.stack);
                            
                            logger.error('Error handling individual message', { 
                                sessionId: this.sessionId, 
                                messageId: message?.key?.id,
                                error: messageError.message 
                            });
                        }
                        
                        console.log(`───── END MESSAGE ${i + 1} ─────`);
                    }
                } else {
                    console.log('📭 Message event ignored:');
                    console.log('  Type is not "notify":', type !== 'notify');
                    console.log('  Messages is not array:', !Array.isArray(messages));
                    if (type !== 'notify') {
                        console.log('  Message type received:', type);
                    }
                    if (!Array.isArray(messages)) {
                        console.log('  Messages object type:', typeof messages);
                        console.log('  Messages content:', messages);
                    }
                }
                
                console.log('════════════════════════════════════════════════════════════════════');
                console.log('✅ MESSAGE UPSERT EVENT PROCESSING COMPLETED\n');
                
            } catch (error) {
                console.log('\n❌ ERROR IN MESSAGE UPSERT EVENT HANDLER:');
                console.log('Session ID:', this.sessionId);
                console.log('Error:', error.message);
                console.log('Stack:', error.stack);
                console.log('════════════════════════════════════════════════════════════════════\n');
                
                logger.error('Error handling incoming message batch', { sessionId: this.sessionId, error: error.message });
            }
        });

        // Add additional event listeners to debug regular WhatsApp connection issues
        console.log('\n🔧 SETTING UP EVENT LISTENERS FOR SESSION:', this.sessionId);
        
        // Monitor all socket events for debugging
        const originalOn = this.socket.ev.on.bind(this.socket.ev);
        this.socket.ev.on = (event, handler) => {
            if (event === 'messages.upsert') {
                console.log(`📡 Event listener registered for '${event}' on session:`, this.sessionId);
            }
            return originalOn(event, handler);
        };
        
        // Add a heartbeat to check if the session is still alive
        const heartbeatInterval = setInterval(() => {
            console.log(`💓 Session Heartbeat [${this.sessionId}]:`, {
                connected: this.isConnected,
                socketExists: !!this.socket,
                socketReadyState: this.socket?.readyState,
                hasUser: !!this.socket?.user,
                timestamp: new Date().toISOString()
            });
        }, 30000); // Every 30 seconds
        
        // Clean up heartbeat when socket is destroyed
        const originalDestroy = this.destroy.bind(this);
        this.destroy = async () => {
            console.log(`🧹 Cleaning up heartbeat for session: ${this.sessionId}`);
            clearInterval(heartbeatInterval);
            return await originalDestroy();
        };

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

        // Handle process errors to prevent crashes - but only set once per process
        if (!global.processListenersSet) {
            process.on('unhandledRejection', (reason, promise) => {
                logger.error('Unhandled Rejection', { 
                    reason: reason?.message || reason, 
                    stack: reason?.stack,
                    name: reason?.name,
                    code: reason?.code,
                    promise: promise?.toString() || 'Unknown promise'
                });
            });

            process.on('uncaughtException', (error) => {
                logger.error('Uncaught Exception', { 
                    error: error?.message || 'Unknown error',
                    stack: error?.stack,
                    name: error?.name,
                    code: error?.code
                });
            });

            // Add warning handler
            process.on('warning', (warning) => {
                logger.warn('Process Warning', {
                    name: warning.name,
                    message: warning.message,
                    stack: warning.stack
                });
            });

            // Mark that process listeners are set
            global.processListenersSet = true;
        }
    }

    async handleIncomingMessage(message) {
        try {
            // Enhanced logging for debugging WhatsApp Business vs regular WhatsApp differences
            console.log('\n═══════════════════════════════════════════════════════════════');
            console.log('🔔 MESSAGE RECEIVED FOR PROCESSING');
            console.log('═══════════════════════════════════════════════════════════════');
            console.log('Session ID:', this.sessionId);
            console.log('Timestamp:', new Date().toISOString());
            
            // CRITICAL: Check message direction first
            const isIncoming = !message.key.fromMe;
            const isOutgoing = message.key.fromMe;
            
            console.log('📍 MESSAGE DIRECTION:');
            console.log('  Is Incoming (fromMe: false):', isIncoming);
            console.log('  Is Outgoing (fromMe: true):', isOutgoing);
            console.log('  🎯 WEBHOOK ELIGIBLE:', isIncoming ? 'YES' : 'NO (outgoing messages do not trigger webhooks)');
            
            if (!message || !message.key) {
                console.log('❌ INVALID MESSAGE: Missing message or key');
                console.log('Raw message:', JSON.stringify(message, null, 2));
                logger.warn('Invalid message received', { sessionId: this.sessionId });
                return;
            }

            // Log complete message structure for debugging
            console.log('📱 MESSAGE KEY DETAILS:');
            console.log('  Message ID:', message.key.id);
            console.log('  Remote JID:', message.key.remoteJid);
            console.log('  From Me:', message.key.fromMe);
            console.log('  Participant:', message.key.participant);
            
            console.log('📝 MESSAGE METADATA:');
            console.log('  Push Name:', message.pushName);
            console.log('  Message Timestamp:', message.messageTimestamp);
            console.log('  Message Stub Type:', message.messageStubType);
            console.log('  Message Stub Parameters:', message.messageStubParameters);
            
            // Detect app type from message structure
            let appType = 'unknown';
            let appVersion = 'unknown';
            let deviceInfo = {};
            
            // Enhanced app type detection with detailed logging
            console.log('🔍 APP TYPE DETECTION ANALYSIS:');
            console.log('  Has verifiedBizName:', !!message.verifiedBizName, message.verifiedBizName || 'null');
            console.log('  Has bizPrivacyStatus:', !!message.bizPrivacyStatus, message.bizPrivacyStatus || 'null');
            console.log('  Has deviceSentMeta:', !!message.deviceSentMeta);
            console.log('  Has deviceInfo:', !!message.deviceInfo);
            console.log('  Remote JID:', message.key.remoteJid);
            console.log('  Message keys:', Object.keys(message));
            
            if (message.verifiedBizName) {
                appType = 'WhatsApp Business (Verified)';
                console.log('  ✅ Detected: WhatsApp Business (Verified) - Has verifiedBizName');
            } else if (message.bizPrivacyStatus) {
                appType = 'WhatsApp Business';
                console.log('  ✅ Detected: WhatsApp Business - Has bizPrivacyStatus');
            } else if (message.deviceSentMeta || message.deviceInfo) {
                // Check if there's business-specific metadata
                appType = 'WhatsApp Business';
                console.log('  ✅ Detected: WhatsApp Business - Has device metadata');
            } else {
                // Default to Regular WhatsApp if no business indicators are present
                // Both regular and business WhatsApp use @s.whatsapp.net for individual chats
                // The presence of business-specific fields determines the app type, not the JID domain
                appType = 'Regular WhatsApp';
                console.log('  ✅ Detected: Regular WhatsApp - No business indicators found');
            }
            
            // Extract device and app information if available
            if (message.deviceSentMeta) {
                deviceInfo.deviceSentMeta = message.deviceSentMeta;
            }
            if (message.userReceipt) {
                deviceInfo.userReceipt = message.userReceipt;
            }
            
            console.log('🏢 APP TYPE DETECTION:');
            console.log('  Detected App Type:', appType);
            console.log('  Verified Business Name:', message.verifiedBizName || 'Not available');
            console.log('  Business Privacy Status:', message.bizPrivacyStatus || 'Not available');
            console.log('  Device Info:', JSON.stringify(deviceInfo, null, 4));

            // Extract and log message content
            const extractedContent = this.extractMessageContent(message);
            console.log('💬 MESSAGE CONTENT:');
            console.log('  Content Type:', extractedContent.type);
            console.log('  Content:', JSON.stringify(extractedContent, null, 4));
            
            // Log raw message structure (truncated for readability)
            console.log('🔍 RAW MESSAGE STRUCTURE (first level keys):');
            console.log('  Available keys:', Object.keys(message));
            if (message.message) {
                console.log('  Message object keys:', Object.keys(message.message));
            }

            const sessionData = await this.database.getSession(this.sessionId);
            
            console.log('⚙️ SESSION CONFIGURATION:');
            console.log('  Webhook Status:', sessionData?.webhook_status);
            console.log('  Webhook URL:', sessionData?.webhook_url);
            console.log('  Auto Read:', sessionData?.auto_read);
            console.log('  User ID:', sessionData?.user_id);
            console.log('  Admin ID:', sessionData?.admin_id);
            
            // ⚠️ CRITICAL: Only process webhooks for INCOMING messages
            if (isIncoming && sessionData && sessionData.webhook_status && sessionData.webhook_url) {
                const messageData = {
                    sessionId: this.sessionId,
                    messageId: message.key.id,
                    remoteJid: message.key.remoteJid,
                    fromMe: message.key.fromMe,
                    timestamp: message.messageTimestamp,
                    message: extractedContent,
                    participant: message.key.participant || null,
                    pushName: message.pushName || null,
                    // Add app type detection to webhook payload
                    appType: appType,
                    deviceInfo: deviceInfo,
                    // Add additional metadata for debugging
                    messageMetadata: {
                        verifiedBizName: message.verifiedBizName,
                        bizPrivacyStatus: message.bizPrivacyStatus,
                        messageStubType: message.messageStubType,
                        messageStubParameters: message.messageStubParameters,
                        quotedMessage: message.message?.extendedTextMessage?.contextInfo?.quotedMessage ? true : false,
                        mentions: message.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
                    }
                };

                console.log('📤 WEBHOOK PAYLOAD (INCOMING MESSAGE):');
                console.log(JSON.stringify(messageData, null, 2));
                console.log('🌐 Sending webhook to:', sessionData.webhook_url);

                try {
                    const webhookResult = await this.webhookManager.sendWebhook(sessionData.webhook_url, messageData);
                    console.log('✅ WEBHOOK SUCCESS:');
                    console.log('  Status:', webhookResult.status);
                    console.log('  Duration:', webhookResult.duration);
                    console.log('  Response:', JSON.stringify(webhookResult.response, null, 2));
                } catch (webhookError) {
                    console.log('❌ WEBHOOK FAILED:');
                    console.log('  Error:', webhookError.message);
                    console.log('  Error Type:', webhookError.errorType || 'Unknown');
                    console.log('  Status Code:', webhookError.status);
                    console.log('  Response Data:', JSON.stringify(webhookError.responseData, null, 2));
                    
                    logger.error('Error sending webhook for message', { 
                        sessionId: this.sessionId, 
                        messageId: message.key.id,
                        error: webhookError.message,
                        appType: appType
                    });
                }
            } else if (isOutgoing) {
                console.log('⚠️ WEBHOOK SKIPPED:');
                console.log('  Reason: OUTGOING MESSAGE (fromMe: true)');
                console.log('  Note: Webhooks only trigger for incoming messages');
                console.log('  App Type Detected:', appType);
            } else {
                console.log('⚠️ WEBHOOK SKIPPED:');
                if (!sessionData) {
                    console.log('  Reason: Session data not found');
                } else if (!sessionData.webhook_status) {
                    console.log('  Reason: Webhook not enabled');
                } else if (!sessionData.webhook_url) {
                    console.log('  Reason: No webhook URL configured');
                }
                console.log('  App Type Detected:', appType);
            }

            // Auto-read functionality (only for incoming messages)
            if (isIncoming && sessionData && sessionData.auto_read) {
                try {
                    await this.markMessageAsRead(message.key);
                    console.log('📖 Message marked as read');
                } catch (readError) {
                    console.log('❌ Failed to mark message as read:', readError.message);
                    logger.error('Error marking message as read', { 
                        sessionId: this.sessionId, 
                        messageId: message.key.id,
                        error: readError.message,
                        appType: appType
                    });
                }
            }
            
            console.log('═══════════════════════════════════════════════════════════════');
            console.log('✅ Message processing completed');
            console.log('🎯 Summary: Direction =', isIncoming ? 'INCOMING' : 'OUTGOING', '| App Type =', appType, '| Webhook Sent =', isIncoming && sessionData?.webhook_status && sessionData?.webhook_url ? 'YES' : 'NO');
            console.log('═══════════════════════════════════════════════════════════════\n');
            
        } catch (error) {
            console.log('\n❌ ERROR PROCESSING MESSAGE:');
            console.log('  Session ID:', this.sessionId);
            console.log('  Message ID:', message?.key?.id);
            console.log('  Error:', error.message);
            console.log('  Stack:', error.stack);
            console.log('═══════════════════════════════════════════════════════════════\n');
            
            logger.error('Error processing message', { 
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

    // Utility function to format phone number or group ID as WhatsApp JID
    formatAsWhatsAppJID(receiverId) {
        // If already formatted with proper WhatsApp domain, return as is
        if (receiverId.endsWith('@g.us') || receiverId.endsWith('@s.whatsapp.net')) {
            return receiverId;
        }
        
        // If it contains @ but not the proper WhatsApp domains, extract the ID part
        if (receiverId.includes('@')) {
            receiverId = receiverId.split('@')[0];
        }
        
        // Determine if it's a group ID or individual phone number
        let formattedJID;
        
        // Group IDs are typically longer than 15 characters and contain hyphens or are numeric with specific patterns
        // Examples: "120363168346132205", "1234567890-1234567890", etc.
        if (receiverId.length > 15 && (receiverId.includes('-') || /^\d{18,}$/.test(receiverId))) {
            // This appears to be a group ID
            formattedJID = receiverId + '@g.us';
        } else if (/^\d{8,15}$/.test(receiverId)) {
            // This appears to be an individual phone number (8-15 digits)
            formattedJID = receiverId + '@s.whatsapp.net';
        } else {
            // For any other format, try to clean and determine
            const cleanId = receiverId.replace(/[^\d\-]/g, ''); // Keep digits and hyphens
            
            if (cleanId.length > 15 && cleanId.includes('-')) {
                // Likely a group ID with hyphens
                formattedJID = cleanId + '@g.us';
            } else if (cleanId.length >= 8) {
                // Likely a phone number
                const cleanNumber = cleanId.replace(/[^\d]/g, ''); // Remove all non-digits for phone numbers
                formattedJID = cleanNumber + '@s.whatsapp.net';
            } else {
                // Default to individual chat if uncertain
                formattedJID = receiverId + '@s.whatsapp.net';
            }
        }
        
        return formattedJID;
    }

    // Check if a phone number is registered on WhatsApp
    async isNumberRegisteredOnWhatsApp(receiverId) {
        if (!this.isConnected) {
            throw new Error('Session not connected');
        }

        try {
            // Format the receiverId as a proper WhatsApp JID
            const formattedJID = this.formatAsWhatsAppJID(receiverId);
            
            // Skip validation for group chats - groups are always "valid" if they exist
            if (formattedJID.includes('@g.us')) {
                logger.session(this.sessionId, 'Group chat detected, skipping validation', { groupId: formattedJID });
                return {
                    isRegistered: true,
                    jid: formattedJID,
                    isGroup: true,
                    validationSkipped: true
                };
            }

            // Use onWhatsApp method to check if individual number is registered
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
                receiverId, 
                error: error.message 
            });
            
            // If validation fails, assume number is valid to avoid blocking legitimate sends
            // This could happen due to network issues or rate limiting
            const formattedJID = this.formatAsWhatsAppJID(receiverId);
            return {
                isRegistered: true,
                jid: formattedJID,
                isGroup: formattedJID.includes('@g.us'),
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
        return this.isConnected && this.socket && !!this.socket.user;
    }

    // Method to check if session has authentication data
    hasAuthData() {
        return this.authState && this.authState.creds && this.authState.creds.noiseKey;
    }

    // Method to get session connection info
    getConnectionInfo() {
        return {
            isConnected: this.isConnected,
            hasAuthData: this.hasAuthData(),
            hasSocket: !!this.socket,
            hasUser: !!(this.socket && this.socket.user),
            retryCount: this.retryCount,
            maxRetries: this.maxRetries,
            sessionId: this.sessionId
        };
    }

    async logout() {
        try {
            if (this.socket && this.isConnected) {
                // Send logout signal to WhatsApp
                await this.socket.logout();
                logger.session(this.sessionId, 'Session logout signal sent');
            }
            this.isConnected = false;
            await this.updateSessionStatus('logged_out');
            logger.session(this.sessionId, 'Session logged out successfully');
        } catch (error) {
            logger.error('Error during logout', { sessionId: this.sessionId, error: error.message });
            throw error;
        }
    }

    async destroy() {
        try {
            if (this.socket) {
                try {
                    // Check socket state before attempting to close
                    if (this.socket.readyState !== undefined) {
                        // WebSocket readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
                        if (this.socket.readyState === 0 || this.socket.readyState === 1) {
                            this.socket.end();
                        } else {
                            logger.session(this.sessionId, 'Socket already closed or closing, skipping end() call');
                        }
                    } else {
                        // Fallback for other socket types or if readyState is not available
                        this.socket.end();
                    }
                } catch (socketError) {
                    // Log the error but don't throw it - destruction should continue
                    logger.warn('Error ending socket during destroy', { 
                        sessionId: this.sessionId, 
                        error: socketError.message,
                        socketState: this.socket.readyState 
                    });
                }
                
                // Clear the socket reference
                this.socket = null;
            }
            
            this.isConnected = false;
            await this.updateSessionStatus('disconnected');
            logger.session(this.sessionId, 'Session destroyed');
        } catch (error) {
            logger.error('Error destroying session', { sessionId: this.sessionId, error: error.message });
            // Don't throw the error - destruction should be resilient
        }
    }
}

module.exports = BaileysSession; 