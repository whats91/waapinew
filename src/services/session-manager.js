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
        
        // Auto-refresh configuration from environment variables
        this.sessionHealthCheckInterval = parseInt(process.env.SESSION_HEALTH_CHECK_INTERVAL) || 5 * 60 * 1000; // Default 5 minutes
        this.maxSessionIdleTime = parseInt(process.env.MAX_SESSION_IDLE_TIME) || 30 * 60 * 1000; // Default 30 minutes
        this.autoRefreshEnabled = process.env.AUTO_REFRESH_ENABLED !== 'false'; // Default true
        this.sessionMaxRetries = parseInt(process.env.SESSION_MAX_RETRIES) || 5; // Default 5 retries
        this.healthCheckTimer = null;
        
        // Initialize existing sessions asynchronously but safely
        this.initializeExistingSessions().catch(error => {
            logger.error('Failed to initialize existing sessions during startup', { error: error.message });
        });
        
        // Start session health monitoring if enabled
        if (this.autoRefreshEnabled) {
            this.startSessionHealthMonitoring();
        } else {
            logger.info('Auto-refresh disabled via configuration');
        }
    }

    startSessionHealthMonitoring() {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
        }
        
        this.healthCheckTimer = setInterval(async () => {
            try {
                await this.performSessionHealthCheck();
            } catch (error) {
                logger.error('Error during session health check', { error: error.message });
            }
        }, this.sessionHealthCheckInterval);
        
        logger.info('Session health monitoring started', { 
            interval: this.sessionHealthCheckInterval / 1000 + 's',
            maxIdleTime: this.maxSessionIdleTime / 1000 + 's'
        });
    }

    async performSessionHealthCheck() {
        logger.info('Starting session health check', { totalSessions: this.sessions.size });
        
        for (const [sessionId, session] of this.sessions) {
            try {
                // Check if session is connected
                if (!session.isSessionConnected()) {
                    logger.warn('Session disconnected, attempting auto-reconnect', { sessionId });
                    await this.autoReconnectSession(sessionId);
                    continue;
                }
                
                // Check session responsiveness
                const isResponsive = await this.checkSessionResponsiveness(session);
                if (!isResponsive) {
                    logger.warn('Session unresponsive, attempting recovery', { sessionId });
                    await this.recoverUnresponsiveSession(sessionId);
                }
                
            } catch (error) {
                logger.error('Error checking session health', { sessionId, error: error.message });
            }
        }
        
        logger.info('Session health check completed');
    }

    async checkSessionResponsiveness(session) {
        try {
            // Simple ping test - check if we can access socket state
            if (!session.socket || !session.socket.user) {
                return false;
            }
            
            // Check if socket is in a healthy state
            if (session.socket.readyState !== undefined && session.socket.readyState !== 1) {
                return false;
            }
            
            return true;
        } catch (error) {
            logger.error('Session responsiveness check failed', { 
                sessionId: session.sessionId, 
                error: error.message 
            });
            return false;
        }
    }

    async autoReconnectSession(sessionId) {
        try {
            logger.info('Auto-reconnecting session', { sessionId });
            
            // Get session from memory
            const session = this.sessions.get(sessionId);
            if (!session) {
                logger.warn('Session not found in memory for auto-reconnect', { sessionId });
                return;
            }
            
            // Destroy the old session
            await session.destroy().catch(() => {}); // Ignore errors
            
            // Remove from memory
            this.sessions.delete(sessionId);
            
            // Create new session
            const newSession = new BaileysSession(sessionId, this.database, this.webhookManager);
            this.sessions.set(sessionId, newSession);
            
            // Initialize with timeout
            const initPromise = newSession.initialize();
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Initialization timeout')), 30000)
            );
            
            await Promise.race([initPromise, timeoutPromise]);
            
            logger.info('Session auto-reconnected successfully', { sessionId });
            
        } catch (error) {
            logger.error('Auto-reconnection failed', { sessionId, error: error.message });
            
            // Update database status
            await this.database.updateSessionStatus(sessionId, 'failed').catch(() => {});
            
            // Remove from memory if initialization failed
            this.sessions.delete(sessionId);
        }
    }

    async recoverUnresponsiveSession(sessionId) {
        try {
            logger.info('Recovering unresponsive session', { sessionId });
            await this.autoReconnectSession(sessionId);
        } catch (error) {
            logger.error('Session recovery failed', { sessionId, error: error.message });
        }
    }

    async createOrRecoverSession(sessionId) {
        // Enhanced session creation with automatic recovery
        let session = this.sessions.get(sessionId);
        
        if (session) {
            // Session exists, check if it's healthy
            if (session.isSessionConnected()) {
                return session;
            } else {
                // Session exists but disconnected, recover it
                logger.info('Found disconnected session, attempting recovery', { sessionId });
                await this.autoReconnectSession(sessionId);
                return this.sessions.get(sessionId);
            }
        }
        
        // Session doesn't exist, create new one
        await this.createSession(sessionId, false);
        return this.sessions.get(sessionId);
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

    async logoutSession(sessionId) {
        const session = this.sessions.get(sessionId);
        
        if (!session) {
            // Session not in memory, check if it exists in database
            const sessionData = await this.database.getSession(sessionId);
            if (!sessionData) {
                throw new Error(`Session ${sessionId} not found in database`);
            }
            
            // Session exists in database but not in memory, just update status
            await this.database.updateSessionStatus(sessionId, 'logged_out');
            logger.info('Session marked as logged out (was not active)', { sessionId });
            return true;
        }

        try {
            // Session is active in memory, perform proper logout
            await session.logout();
            this.sessions.delete(sessionId);
            
            // Update database status
            await this.database.updateSessionStatus(sessionId, 'logged_out');
            
            logger.info('Session logged out', { sessionId });
            return true;
        } catch (error) {
            logger.error('Failed to logout session', { sessionId, error: error.message });
            throw error;
        }
    }

    async deleteSession(sessionId) {
        // First destroy the active session
        if (this.sessions.has(sessionId)) {
            await this.destroySession(sessionId);
        }

        try {
            // Delete session folder from filesystem
            const fs = require('fs');
            const path = require('path');
            const sessionPath = path.join(process.env.SESSION_STORAGE_PATH || './sessions', sessionId);
            
            if (fs.existsSync(sessionPath)) {
                // Remove entire session directory
                fs.rmSync(sessionPath, { recursive: true, force: true });
                logger.info('Session folder deleted', { sessionId, path: sessionPath });
            }

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
        try {
            // Use enhanced session creation with auto-recovery
            const session = await this.createOrRecoverSession(senderId);
            
            if (!session) {
                throw new Error(`Failed to create or recover session for senderId ${senderId}`);
            }

            // Wait for connection with timeout
            if (!session.isSessionConnected()) {
                logger.info('Session not connected, waiting for connection', { senderId });
                await this.waitForConnection(session, 30000);
            }

            return await session.sendTextMessage(receiverId, messageText);
        } catch (error) {
            logger.error('Error in sendTextMessage with auto-recovery', { 
                senderId, 
                receiverId, 
                error: error.message 
            });
            
            // If session fails, try one more time with fresh session
            try {
                logger.info('Retrying with fresh session', { senderId });
                await this.autoReconnectSession(senderId);
                const freshSession = this.sessions.get(senderId);
                
                if (freshSession && freshSession.isSessionConnected()) {
                    return await freshSession.sendTextMessage(receiverId, messageText);
                }
            } catch (retryError) {
                logger.error('Retry with fresh session also failed', { 
                    senderId, 
                    error: retryError.message 
                });
            }
            
            throw error;
        }
    }

    async sendMediaMessage(senderId, receiverId, mediaBuffer, mediaType, caption = '') {
        try {
            // Use enhanced session creation with auto-recovery
            const session = await this.createOrRecoverSession(senderId);
            
            if (!session) {
                throw new Error(`Failed to create or recover session for senderId ${senderId}`);
            }

            // Wait for connection with timeout
            if (!session.isSessionConnected()) {
                logger.info('Session not connected, waiting for connection', { senderId });
                await this.waitForConnection(session, 30000);
            }

            return await session.sendMediaMessage(receiverId, mediaBuffer, mediaType, caption);
        } catch (error) {
            logger.error('Error in sendMediaMessage with auto-recovery', { 
                senderId, 
                receiverId, 
                error: error.message 
            });
            
            // If session fails, try one more time with fresh session
            try {
                logger.info('Retrying with fresh session', { senderId });
                await this.autoReconnectSession(senderId);
                const freshSession = this.sessions.get(senderId);
                
                if (freshSession && freshSession.isSessionConnected()) {
                    return await freshSession.sendMediaMessage(receiverId, mediaBuffer, mediaType, caption);
                }
            } catch (retryError) {
                logger.error('Retry with fresh session also failed', { 
                    senderId, 
                    error: retryError.message 
                });
            }
            
            throw error;
        }
    }

    async getQRCode(senderId) {
        try {
            // Use enhanced session creation
            const session = await this.createOrRecoverSession(senderId);
            
            if (!session) {
                throw new Error(`Failed to create or recover session for senderId ${senderId}`);
            }
            
            // Wait for QR code generation with timeout
            await this.waitForQRCode(session, 15000);
            return session.getQRCode();
        } catch (error) {
            logger.error('Error in getQRCode with auto-recovery', { senderId, error: error.message });
            throw error;
        }
    }

    async getQRString(senderId) {
        try {
            // Use enhanced session creation
            const session = await this.createOrRecoverSession(senderId);
            
            if (!session) {
                throw new Error(`Failed to create or recover session for senderId ${senderId}`);
            }
            
            // Wait for QR code generation with timeout
            await this.waitForQRCode(session, 15000);
            return session.getQRString();
        } catch (error) {
            logger.error('Error in getQRString with auto-recovery', { senderId, error: error.message });
            throw error;
        }
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