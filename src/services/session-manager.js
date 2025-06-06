const BaileysSession = require('./baileys-session');
const WebhookManager = require('./webhook-manager');
const Database = require('../database/db');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

class SessionManager {
    constructor() {
        this.sessions = new Map();
        this.database = new Database(process.env.DB_PATH);
        this.webhookManager = new WebhookManager();
        this.maxSessions = parseInt(process.env.MAX_CONCURRENT_SESSIONS) || 100;
        this.isInitialized = false;
        
        // Initialize existing sessions asynchronously but safely
        this.initializeExistingSessions().catch(error => {
            logger.error('Failed to initialize existing sessions during startup', { error: error.message });
        });
    }

    async initializeExistingSessions() {
        try {
            logger.info('Initializing existing sessions from database');
            const existingSessions = await this.database.getAllSessions();
            
            for (const sessionData of existingSessions) {
                if (sessionData.status === 'connected' || sessionData.status === 'connecting') {
                    try {
                        logger.info(`Restoring session: ${sessionData.session_id}`);
                        await this.createSession(sessionData.session_id, false); // Don't create new DB entry
                    } catch (sessionError) {
                        logger.error(`Failed to restore session: ${sessionData.session_id}`, { error: sessionError.message });
                        // Update session status to disconnected if restoration fails
                        await this.database.updateSessionStatus(sessionData.session_id, 'disconnected').catch(() => {});
                    }
                }
            }
            
            logger.info(`Initialized ${this.sessions.size} existing sessions`);
            this.isInitialized = true;
        } catch (error) {
            logger.error('Failed to initialize existing sessions', { error: error.message });
            this.isInitialized = true; // Set to true even on error to prevent blocking
        }
    }

    async waitForInitialization(timeout = 30000) {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            
            const checkInitialization = () => {
                if (this.isInitialized) {
                    resolve(true);
                } else if (Date.now() - startTime > timeout) {
                    reject(new Error('Session manager initialization timeout'));
                } else {
                    setTimeout(checkInitialization, 100);
                }
            };
            
            checkInitialization();
        });
    }

    async createSession(sessionId = null, createDbEntry = true) {
        if (this.sessions.size >= this.maxSessions) {
            throw new Error(`Maximum session limit reached (${this.maxSessions})`);
        }

        if (!sessionId) {
            throw new Error('senderId is required for session creation');
        }

        if (this.sessions.has(sessionId)) {
            throw new Error(`Session with senderId ${sessionId} already exists`);
        }

        try {
            // Create database entry if needed
            if (createDbEntry) {
                const sessionData = {
                    session_id: sessionId, // Use senderId as session_id
                    name: `Session-${sessionId}`,
                    auth_token: null, // No longer using per-session auth tokens
                    user_id: sessionId, // Store senderId as user_id
                    webhook_url: null
                };
                
                await this.database.createSession(sessionData);
                logger.info('Session database entry created', { sessionId });
            }

            // Create Baileys session
            const baileysSession = new BaileysSession(sessionId, this.database, this.webhookManager);
            this.sessions.set(sessionId, baileysSession);
            
            // Initialize the session with proper error handling
            try {
                await baileysSession.initialize();
                logger.info('Session created and initialized', { sessionId });
            } catch (initError) {
                // If initialization fails, remove the session from memory but keep DB entry
                this.sessions.delete(sessionId);
                logger.error('Session initialization failed', { sessionId, error: initError.message });
                
                // Update database status to failed
                if (!createDbEntry) {
                    await this.database.updateSessionStatus(sessionId, 'failed').catch(() => {});
                }
                
                throw initError;
            }
            
            return sessionId;
        } catch (error) {
            // Cleanup on failure
            this.sessions.delete(sessionId);
            logger.error('Failed to create session', { sessionId, error: error.message });
            throw error;
        }
    }

    async getSession(sessionId) {
        return this.sessions.get(sessionId);
    }

    async getSessionBySenderId(senderId) {
        return this.sessions.get(senderId);
    }

    async getSessionByAuthToken(authToken) {
        try {
            const sessionData = await this.database.getSessionByAuthToken(authToken);
            if (!sessionData) {
                return null;
            }
            
            return this.sessions.get(sessionData.session_id);
        } catch (error) {
            logger.error('Failed to get session by auth token', { authToken, error: error.message });
            return null;
        }
    }

    async destroySession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Session ${sessionId} not found`);
        }

        try {
            await session.destroy();
            this.sessions.delete(sessionId);
            
            // Update database status
            await this.database.updateSessionStatus(sessionId, 'disconnected');
            
            logger.info('Session destroyed', { sessionId });
            return true;
        } catch (error) {
            logger.error('Failed to destroy session', { sessionId, error: error.message });
            throw error;
        }
    }

    async deleteSession(sessionId) {
        // First destroy the active session
        if (this.sessions.has(sessionId)) {
            await this.destroySession(sessionId);
        }

        try {
            // Delete from database
            await this.database.deleteSession(sessionId);
            logger.info('Session deleted permanently', { sessionId });
            return true;
        } catch (error) {
            logger.error('Failed to delete session', { sessionId, error: error.message });
            throw error;
        }
    }

    async sendTextMessage(senderId, receiverId, messageText) {
        let session = this.sessions.get(senderId);
        
        if (!session) {
            // Auto-initialize session if it doesn't exist
            try {
                await this.createSession(senderId, false);
                session = this.sessions.get(senderId);
                
                // Wait for connection (with timeout)
                await this.waitForConnection(session, 30000);
            } catch (error) {
                throw new Error(`Failed to initialize session for senderId ${senderId}: ${error.message}`);
            }
        }

        if (!session.isSessionConnected()) {
            throw new Error('Session not connected');
        }

        return await session.sendTextMessage(receiverId, messageText);
    }

    async sendMediaMessage(senderId, receiverId, mediaBuffer, mediaType, caption = '') {
        let session = this.sessions.get(senderId);
        
        if (!session) {
            // Auto-initialize session if it doesn't exist
            try {
                await this.createSession(senderId, false);
                session = this.sessions.get(senderId);
                
                // Wait for connection (with timeout)
                await this.waitForConnection(session, 30000);
            } catch (error) {
                throw new Error(`Failed to initialize session for senderId ${senderId}: ${error.message}`);
            }
        }

        if (!session.isSessionConnected()) {
            throw new Error('Session not connected');
        }

        return await session.sendMediaMessage(receiverId, mediaBuffer, mediaType, caption);
    }

    async getQRCode(senderId) {
        let session = this.sessions.get(senderId);
        
        if (!session) {
            // Auto-initialize session if it doesn't exist
            try {
                await this.createSession(senderId, false);
                session = this.sessions.get(senderId);
                
                // Wait for QR code generation (with timeout)
                await this.waitForQRCode(session, 15000);
            } catch (error) {
                throw new Error(`Failed to initialize session for senderId ${senderId}: ${error.message}`);
            }
        }

        return session.getQRCode();
    }

    async getQRString(senderId) {
        let session = this.sessions.get(senderId);
        
        if (!session) {
            // Auto-initialize session if it doesn't exist
            try {
                await this.createSession(senderId, false);
                session = this.sessions.get(senderId);
                
                // Wait for QR code generation (with timeout)
                await this.waitForQRCode(session, 15000);
            } catch (error) {
                throw new Error(`Failed to initialize session for senderId ${senderId}: ${error.message}`);
            }
        }

        return session.getQRString();
    }

    async getGroups(senderId) {
        const session = this.sessions.get(senderId);
        
        if (!session) {
            throw new Error(`Session not found for senderId ${senderId}`);
        }

        if (!session.isSessionConnected()) {
            throw new Error('Session not connected');
        }

        return await session.getGroups();
    }

    async getContacts(senderId) {
        const session = this.sessions.get(senderId);
        
        if (!session) {
            throw new Error(`Session not found for senderId ${senderId}`);
        }

        if (!session.isSessionConnected()) {
            throw new Error('Session not connected');
        }

        return await session.getContacts();
    }

    async waitForConnection(session, timeout = 30000) {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            
            const checkConnection = () => {
                if (session.isSessionConnected()) {
                    resolve(true);
                } else if (Date.now() - startTime > timeout) {
                    reject(new Error('Connection timeout'));
                } else {
                    setTimeout(checkConnection, 1000);
                }
            };
            
            checkConnection();
        });
    }

    async waitForQRCode(session, timeout = 15000) {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            
            const checkQRCode = () => {
                if (session.getQRCode()) {
                    resolve(true);
                } else if (session.isSessionConnected()) {
                    resolve(true); // Already connected, no QR needed
                } else if (Date.now() - startTime > timeout) {
                    reject(new Error('QR code generation timeout'));
                } else {
                    setTimeout(checkQRCode, 1000);
                }
            };
            
            checkQRCode();
        });
    }

    getAllSessions() {
        const sessionList = [];
        
        for (const [sessionId, session] of this.sessions) {
            sessionList.push({
                sessionId,
                isConnected: session.isSessionConnected(),
                hasQRCode: !!session.getQRCode()
            });
        }
        
        return sessionList;
    }

    getSessionStats() {
        const connectedSessions = Array.from(this.sessions.values())
            .filter(session => session.isSessionConnected()).length;
        
        return {
            totalSessions: this.sessions.size,
            connectedSessions,
            disconnectedSessions: this.sessions.size - connectedSessions,
            maxSessions: this.maxSessions,
            availableSlots: this.maxSessions - this.sessions.size
        };
    }

    async updateWebhookConfig(sessionId, webhookUrl, webhookStatus) {
        try {
            await this.database.updateWebhookConfig(sessionId, webhookUrl, webhookStatus);
            logger.info('Webhook configuration updated', { sessionId, webhookUrl, webhookStatus });
            return true;
        } catch (error) {
            logger.error('Failed to update webhook configuration', { sessionId, error: error.message });
            throw error;
        }
    }

    async testWebhook(sessionId, webhookUrl) {
        try {
            const result = await this.webhookManager.testWebhook(webhookUrl, sessionId);
            logger.info('Webhook test completed', { sessionId, webhookUrl, success: result.success });
            return result;
        } catch (error) {
            logger.error('Webhook test failed', { sessionId, webhookUrl, error: error.message });
            throw error;
        }
    }

    async cleanup() {
        logger.info('Cleaning up session manager');
        
        for (const [sessionId, session] of this.sessions) {
            try {
                await session.destroy();
            } catch (error) {
                logger.error('Error destroying session during cleanup', { sessionId, error: error.message });
            }
        }
        
        this.sessions.clear();
        this.database.close();
        logger.info('Session manager cleanup completed');
    }
}

module.exports = SessionManager; 