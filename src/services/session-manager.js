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
        
        // Create a copy of the sessions to iterate over, in case the Map changes during iteration
        const sessionEntries = Array.from(this.sessions.entries());
        
        for (const [sessionId, session] of sessionEntries) {
            try {
                // Skip if session is null or undefined
                if (!session) {
                    logger.warn('Found null session during health check, removing', { sessionId });
                    this.sessions.delete(sessionId);
                    continue;
                }
                
                // Check if session is connected
                let isConnected = false;
                try {
                    isConnected = session.isSessionConnected();
                } catch (connCheckError) {
                    logger.warn('Error checking session connection status', { 
                        sessionId, 
                        error: connCheckError.message 
                    });
                    // Assume disconnected if we can't check
                    isConnected = false;
                }
                
                if (!isConnected) {
                    logger.warn('Session disconnected, attempting auto-reconnect', { sessionId });
                    try {
                        await this.autoReconnectSession(sessionId);
                    } catch (reconnectError) {
                        logger.error('Auto-reconnection failed during health check', { 
                            sessionId, 
                            error: reconnectError.message 
                        });
                        // Continue to next session instead of stopping entire health check
                    }
                    continue;
                }
                
                // Check session responsiveness only if connected
                try {
                    const isResponsive = await this.checkSessionResponsiveness(session);
                    if (!isResponsive) {
                        logger.warn('Session unresponsive, attempting recovery', { sessionId });
                        await this.recoverUnresponsiveSession(sessionId);
                    }
                } catch (responsiveError) {
                    logger.error('Error checking session responsiveness', { 
                        sessionId, 
                        error: responsiveError.message 
                    });
                    // Continue to next session
                }
                
            } catch (error) {
                logger.error('Error during individual session health check', { 
                    sessionId, 
                    error: error.message,
                    stack: error.stack 
                });
                // Don't let one session's error stop the entire health check
                continue;
            }
        }
        
        logger.info('Session health check completed', { 
            totalSessions: this.sessions.size,
            timestamp: new Date().toISOString()
        });
    }

    async checkSessionResponsiveness(session) {
        try {
            // Check if session object exists and has required methods
            if (!session || typeof session.isSessionConnected !== 'function') {
                logger.warn('Invalid session object during responsiveness check');
                return false;
            }
            
            // Simple ping test - check if we can access socket state
            if (!session.socket) {
                logger.warn('Session socket is null during responsiveness check');
                return false;
            }
            
            if (!session.socket.user) {
                logger.warn('Session socket user is null during responsiveness check');
                return false;
            }
            
            // Check if socket is in a healthy state
            if (session.socket.readyState !== undefined) {
                // WebSocket readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
                if (session.socket.readyState === 2 || session.socket.readyState === 3) {
                    logger.warn('Session socket is closing or closed', { 
                        sessionId: session.sessionId,
                        readyState: session.socket.readyState
                    });
                    return false;
                }
            }
            
            return true;
        } catch (error) {
            logger.error('Session responsiveness check failed', { 
                sessionId: session?.sessionId || 'unknown', 
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
            
            // Skip auto-reconnection if session is generating QR for API
            if (session.isGeneratingQR) {
                logger.info('Skipping auto-reconnect during QR generation', { sessionId });
                return;
            }
            
            // Check if this session should be auto-reconnected based on its authentication data
            const hasExistingAuth = await this.checkForExistingAuth(sessionId);
            
            // Only auto-reconnect if this session has authentication data (was previously connected)
            if (!hasExistingAuth) {
                logger.info('Session not eligible for auto-reconnect (no authentication data)', { sessionId });
                // Update database status to reflect disconnected state
                await this.database.updateSessionStatus(sessionId, 'disconnected').catch(() => {});
                return;
            }
            
            logger.info('Session eligible for auto-reconnect (has authentication data)', { sessionId });
            
            // Destroy the old session with additional safety
            try {
                await session.destroy();
            } catch (destroyError) {
                logger.warn('Error destroying session during auto-reconnect, continuing anyway', { 
                    sessionId, 
                    error: destroyError.message 
                });
                // Continue with reconnection even if destroy fails
            }
            
            // Remove from memory
            this.sessions.delete(sessionId);
            
            // Add a small delay to ensure cleanup is complete
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Create new session with auto-connect enabled (since this has auth data)
            const newSession = new BaileysSession(sessionId, this.database, this.webhookManager);
            newSession.setAutoConnect(true); // Enable auto-connect for reconnection
            newSession.setQRDisplayMode(false, false); // Disable QR display for auto-reconnect
            
            this.sessions.set(sessionId, newSession);
            
            // Initialize with timeout (will auto-connect since we enabled it)
            const initPromise = newSession.initialize();
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Initialization timeout')), 30000)
            );
            
            await Promise.race([initPromise, timeoutPromise]);
            
            logger.info('Session auto-reconnected successfully', { sessionId });
            
        } catch (error) {
            logger.error('Auto-reconnection failed', { sessionId, error: error.message });
            
            // Update database status
            try {
                await this.database.updateSessionStatus(sessionId, 'failed');
            } catch (dbError) {
                logger.error('Failed to update session status after reconnection failure', { 
                    sessionId, 
                    error: dbError.message 
                });
            }
            
            // Remove from memory if initialization failed
            this.sessions.delete(sessionId);
            
            // Don't throw the error to prevent health check from crashing
            // The caller should handle this gracefully
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
            let restoredCount = 0;
            
            for (const sessionData of existingSessions) {
                try {
                    // Check if session has authentication data (indicates it was previously connected)
                    const hasAuthData = await this.checkForExistingAuth(sessionData.session_id);
                    
                    if (hasAuthData) {
                        // Session has auth data, should be restored regardless of database status
                        logger.info(`Restoring session with auth data: ${sessionData.session_id} (DB status: ${sessionData.status})`);
                        
                        // Create session with auto-connect enabled since it has auth data
                        const baileysSession = new BaileysSession(sessionData.session_id, this.database, this.webhookManager);
                        baileysSession.setAutoConnect(true); // Enable auto-connect for sessions with auth
                        baileysSession.setQRDisplayMode(false, false); // Disable QR display for restoration
                        
                        this.sessions.set(sessionData.session_id, baileysSession);
                        
                        // Initialize with connection (since auto-connect is enabled)
                        await baileysSession.initialize();
                        
                        restoredCount++;
                        logger.info(`Session restored successfully: ${sessionData.session_id}`);
                        
                        // Update database status to connecting since we're attempting to restore
                        await this.database.updateSessionStatus(sessionData.session_id, 'connecting').catch(() => {});
                        
                    } else if (sessionData.status === 'connected' || sessionData.status === 'connecting') {
                        // Session doesn't have auth data but database says it's connected (shouldn't happen, but handle it)
                        logger.warn(`Session marked as ${sessionData.status} but no auth data found: ${sessionData.session_id}`);
                        
                        // Create session with auto-connect enabled
                        const baileysSession = new BaileysSession(sessionData.session_id, this.database, this.webhookManager);
                        baileysSession.setAutoConnect(true);
                        baileysSession.setQRDisplayMode(false, false);
                        
                        this.sessions.set(sessionData.session_id, baileysSession);
                        
                        try {
                            await baileysSession.initialize();
                            restoredCount++;
                            logger.info(`Session restored successfully: ${sessionData.session_id}`);
                        } catch (restoreError) {
                            logger.error(`Failed to restore session without auth: ${sessionData.session_id}`, { error: restoreError.message });
                            this.sessions.delete(sessionData.session_id);
                            await this.database.updateSessionStatus(sessionData.session_id, 'disconnected').catch(() => {});
                        }
                    } else {
                        // Session has no auth data and is disconnected - this is normal for new/unused sessions
                        logger.info(`Skipping session without auth data: ${sessionData.session_id} (status: ${sessionData.status})`);
                    }
                    
                } catch (sessionError) {
                    logger.error(`Failed to process session: ${sessionData.session_id}`, { error: sessionError.message });
                    // Update session status to disconnected if processing fails
                    await this.database.updateSessionStatus(sessionData.session_id, 'disconnected').catch(() => {});
                }
            }
            
            logger.info(`Session restoration completed: ${restoredCount} sessions restored out of ${existingSessions.length} total sessions`);
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

    async createSession(sessionId = null, createDbEntry = true, additionalData = {}) {
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
                    name: additionalData.name || `Session-${sessionId}`,
                    auth_token: null, // No longer using per-session auth tokens
                    user_id: additionalData.user_id || sessionId, // Use provided user_id or default to senderId
                    admin_id: additionalData.admin_id || null, // Use provided admin_id
                    webhook_url: additionalData.webhook_url || null
                };
                
                await this.database.createSession(sessionData);
                logger.info('Session database entry created', { sessionId, userId: sessionData.user_id, adminId: sessionData.admin_id });
            }

            // Create Baileys session with lazy initialization (no auto-connect)
            const baileysSession = new BaileysSession(sessionId, this.database, this.webhookManager);
            
            // Check if this session has existing auth data to determine if it should auto-connect
            const sessionData = await this.database.getSession(sessionId);
            const hasExistingAuth = await this.checkForExistingAuth(sessionId);
            
            if (hasExistingAuth && sessionData && sessionData.status === 'connected') {
                // This is an existing session that was connected, enable auto-connect
                baileysSession.setAutoConnect(true);
                logger.info('Existing connected session found, enabling auto-connect', { sessionId });
            } else {
                // New session or disconnected session, use lazy initialization
                baileysSession.setAutoConnect(false);
                logger.info('New session created with lazy initialization', { sessionId });
            }
            
            this.sessions.set(sessionId, baileysSession);
            
            // Initialize the session (will use lazy mode unless auto-connect is enabled)
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

    // Helper method to check if session has existing authentication data
    async checkForExistingAuth(sessionId) {
        try {
            const fs = require('fs');
            const path = require('path');
            const authDir = path.join(process.env.SESSION_STORAGE_PATH || './sessions', sessionId, 'auth');
            const credsPath = path.join(authDir, 'creds.json');
            
            if (!fs.existsSync(credsPath)) {
                return false;
            }
            
            // Check if the creds file has actual authentication data
            try {
                const credsData = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                // Check if it has the essential WhatsApp authentication fields
                const hasValidAuth = !!(credsData.noiseKey && (credsData.pairingEphemeralKeyPair || credsData.signedIdentityKey));
                
                if (hasValidAuth) {
                    logger.info(`Valid authentication data found for session ${sessionId}`);
                } else {
                    logger.warn(`Invalid or incomplete authentication data for session ${sessionId}`);
                }
                
                return hasValidAuth;
            } catch (parseError) {
                logger.warn('Invalid creds.json file found', { sessionId, error: parseError.message });
                return false;
            }
        } catch (error) {
            logger.warn('Error checking for existing auth data', { sessionId, error: error.message });
            return false;
        }
    }

    // Method to check if a session is restorable (has auth data)
    async isSessionRestorable(sessionId) {
        const hasAuth = await this.checkForExistingAuth(sessionId);
        if (hasAuth) {
            logger.info(`Session ${sessionId} is restorable (has authentication data)`);
        } else {
            logger.info(`Session ${sessionId} is not restorable (no authentication data)`);
        }
        return hasAuth;
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

    async sendMediaMessage(senderId, receiverId, mediaBuffer, mediaType, caption = '', fileName = null) {
        const session = await this.getSessionBySenderId(senderId);
        
        if (!session) {
            throw new Error(`Session not found for senderId: ${senderId}`);
        }

        try {
            return await session.sendMediaMessage(receiverId, mediaBuffer, mediaType, caption, fileName);
        } catch (error) {
            logger.error('Error in sendMediaMessage with auto-recovery', {
                senderId,
                receiverId, 
                error: error.message,
                fileName: fileName
            });

            // Auto-recovery: try to reconnect and send again
            const freshSession = await this.autoReconnectSession(senderId);
            if (!freshSession) {
                throw new Error(`Unable to recover session for senderId: ${senderId}`);
            }

            return await freshSession.sendMediaMessage(receiverId, mediaBuffer, mediaType, caption, fileName);
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

    // Enhanced QR code API with proper caching and authentication state management
    async getQRCodeForAPI(senderId) {
        try {
            logger.info('API QR code requested', { senderId });
            
            // Get existing session or create a minimal one
            let session = this.sessions.get(senderId);
            
            if (!session) {
                // Create session without auto-recovery
                const sessionData = await this.database.getSession(senderId);
                if (!sessionData) {
                    throw new Error(`Session not found. Please create session first.`);
                }
                
                // Create new session instance with lazy initialization
                session = new BaileysSession(senderId, this.database, this.webhookManager);
                session.setAutoConnect(false); // Don't auto-connect
                
                this.sessions.set(senderId, session);
                
                // Initialize without connecting
                await session.initializeWithoutConnection();
            }
            
            const now = Date.now();
            
            // CRITICAL: Check if user is already connected - if so, no QR needed
            if (session.isSessionConnected()) {
                logger.info('Session already connected, no QR needed', { senderId });
                throw new Error('Session already connected. No QR code needed.');
            }
            
            // Enhanced authentication state detection
            const authenticationState = this.getAuthenticationState(session);
            logger.info('Authentication state analysis', { 
                senderId, 
                state: authenticationState.state,
                socketState: authenticationState.socketState,
                details: authenticationState.details
            });
            
            // State-based QR code management
            switch (authenticationState.state) {
                case 'AUTHENTICATION_TIMEOUT':
                    // Authentication has timed out - clear state and generate fresh QR
                    logger.info('Authentication timed out - clearing state for fresh start', { senderId });
                    await this.clearAuthenticationData(session, senderId);
                    // Don't return here, let it fall through to generate fresh QR
                    break;
                    
                case 'AUTHENTICATION_IN_PROGRESS':
                    // User has scanned QR, authentication is happening - NEVER generate new QR
                    logger.info('Authentication in progress - preserving state', { senderId });
                    if (session.qrCodeData) {
                        return {
                            qrCode: session.qrCodeData,
                            state: 'AUTHENTICATION_IN_PROGRESS',
                            message: 'QR code scanned. Authentication in progress. Please wait...',
                            shouldStopPolling: true, // Tell frontend to stop requesting QR codes
                            estimatedWaitTime: 30000, // 30 seconds
                            authDuration: authenticationState.authDuration || 0,
                            autoDetected: authenticationState.autoDetected || false
                        };
                    } else {
                        throw new Error('Authentication in progress. Please wait for completion.');
                    }
                    
                case 'QR_VALID':
                    // QR code is still valid and fresh - return cached version
                    logger.info('Returning cached valid QR code', { 
                        senderId, 
                        age: `${now - session.qrCodeTimestamp}ms`
                    });
                    return {
                        qrCode: session.qrCodeData,
                        state: 'QR_READY',
                        message: 'QR code ready for scanning',
                        shouldStopPolling: false,
                        expiresIn: Math.max(0, 20000 - (now - session.qrCodeTimestamp)) // Show remaining time
                    };
                    
                case 'QR_EXPIRED':
                    // QR code has expired but socket is still good - generate new QR without clearing auth
                    logger.info('QR expired, generating fresh QR without clearing auth', { senderId });
                    break;
                    
                case 'NEED_FRESH_START':
                    // Need to start completely fresh
                    logger.info('Starting fresh authentication process', { senderId });
                    await this.clearAuthenticationData(session, senderId);
                    break;
                    
                case 'SOCKET_ERROR':
                    // Socket is in error state - restart
                    logger.info('Socket error detected, restarting', { senderId });
                    await this.restartSessionSocket(session, senderId);
                    break;
                    
                default:
                    logger.info('Unknown authentication state, proceeding with caution', { senderId });
            }
            
            // Generate new QR code
            session.isGeneratingQR = true;
            session.setQRDisplayMode(true, true);
            
            // Only create new socket if none exists or it's closed
            if (!session.socket || session.socket.readyState === 3) {
                logger.info('Creating new socket for QR generation', { senderId });
                await session.connect();
            } else {
                logger.info('Using existing socket for QR generation', { 
                    senderId,
                    socketState: session.socket.readyState
                });
            }
            
            // Wait for QR code generation with enhanced timeout
            let attempts = 0;
            const maxAttempts = 50; // 5 seconds (50 * 100ms)
            
            while (attempts < maxAttempts && !session.qrCodeData) {
                await new Promise(resolve => setTimeout(resolve, 100));
                attempts++;
                
                // Check if session got connected while waiting (QR was scanned very quickly)
                if (session.isSessionConnected()) {
                    session.isGeneratingQR = false;
                    logger.info('Session connected while generating QR', { senderId });
                    throw new Error('Session connected successfully. No QR code needed.');
                }
            }
            
            session.isGeneratingQR = false;
            
            if (session.qrCodeData) {
                // Store timestamp for expiry tracking
                session.qrCodeTimestamp = Date.now();
                logger.info('Fresh QR code generated successfully', { senderId });
                
                return {
                    qrCode: session.qrCodeData,
                    state: 'QR_READY',
                    message: 'Fresh QR code generated. Please scan with WhatsApp.',
                    shouldStopPolling: false,
                    expiresIn: 20000, // 20 seconds
                    generatedAt: session.qrCodeTimestamp
                };
            } else {
                throw new Error('QR code generation failed. Please try again.');
            }
            
        } catch (error) {
            logger.error('Error in getQRCodeForAPI', { senderId, error: error.message });
            throw error;
        }
    }
    
    // Helper method to analyze authentication state
    getAuthenticationState(session) {
        const now = Date.now();
        const socketState = session.socket?.readyState;
        
        // Check if session is already connected
        if (session.isSessionConnected()) {
            return {
                state: 'CONNECTED',
                socketState: socketState,
                details: 'Session is already connected'
            };
        }
        
        // NEW: Check if authentication is actively in progress using new flags
        if (session.isAuthenticating || session.qrCodeScanned || session.preventQRRegeneration) {
            const authDuration = session.authenticationStartTime ? now - session.authenticationStartTime : 0;
            
            // Check for authentication timeout (more than 60 seconds)
            if (authDuration > 60000) {
                logger.warn('Authentication timeout detected - may need manual intervention', { 
                    senderId: session.sessionId,
                    authDuration: authDuration,
                    socketExists: !!session.socket,
                    socketState: session.socket?.readyState
                });
                
                return {
                    state: 'AUTHENTICATION_TIMEOUT',
                    socketState: socketState,
                    details: `Authentication timeout after ${Math.round(authDuration / 1000)}s - may need fresh QR`,
                    authDuration: authDuration,
                    autoDetected: false,
                    timeout: true
                };
            }
            
            // Allow up to 60 seconds for authentication to complete (reduced from 120s)
            if (authDuration < 60000) {
                return {
                    state: 'AUTHENTICATION_IN_PROGRESS',
                    socketState: socketState,
                    details: `Authentication in progress for ${Math.round(authDuration / 1000)}s - QR scanned or linking active`,
                    authDuration: authDuration,
                    autoDetected: false // Default, will be overridden if needed
                };
            } else {
                // Authentication has been going on too long, reset
                logger.info('Authentication timeout - resetting state', { 
                    senderId: session.sessionId,
                    authDuration: authDuration
                });
                session.clearAuthenticationState();
            }
        }
        
        // NEW: Check for timing-based auto-detection
        if (session.qrCodeTimestamp) {
            const qrAge = now - session.qrCodeTimestamp;
            
            // If QR was generated recently and we had a stream error, it's likely authentication
            if (qrAge < 30000 && session.qrCodeData && !session.isConnected) {
                // Check if this might be authentication based on timing patterns
                const couldBeAuthentication = qrAge > 5000 && qrAge < 30000; // Between 5-30 seconds
                
                if (couldBeAuthentication) {
                    return {
                        state: 'AUTHENTICATION_IN_PROGRESS',
                        socketState: socketState,
                        details: `Potential authentication detected - QR is ${Math.round(qrAge / 1000)}s old`,
                        authDuration: qrAge,
                        autoDetected: true
                    };
                }
            }
        }
        
        // Check if authentication is actively in progress via socket state
        if (session.socket && socketState === 0) { // CONNECTING state
            return {
                state: 'AUTHENTICATION_IN_PROGRESS',
                socketState: socketState,
                details: 'WhatsApp authentication/linking in progress via socket state'
            };
        }
        
        // Check if we have a valid recent QR code
        if (session.qrCodeData && session.qrCodeTimestamp) {
            const qrAge = now - session.qrCodeTimestamp;
            
            if (qrAge < 20000) { // QR valid for 20 seconds
                return {
                    state: 'QR_VALID',
                    socketState: socketState,
                    details: `QR code is ${qrAge}ms old, still valid`
                };
            } else if (qrAge < 120000) { // Less than 2 minutes old
                return {
                    state: 'QR_EXPIRED',
                    socketState: socketState,
                    details: `QR code expired (${qrAge}ms old), but socket may be reusable`
                };
            }
        }
        
        // Check socket state
        if (session.socket) {
            if (socketState === 3) { // CLOSED
                return {
                    state: 'SOCKET_ERROR',
                    socketState: socketState,
                    details: 'Socket is closed, needs restart'
                };
            } else if (socketState === 2) { // CLOSING
                return {
                    state: 'SOCKET_ERROR',
                    socketState: socketState,
                    details: 'Socket is closing, needs restart'
                };
            }
        }
        
        // Default to fresh start
        return {
            state: 'NEED_FRESH_START',
            socketState: socketState,
            details: 'No valid QR or socket state, starting fresh'
        };
    }
    
    // Helper method to clear authentication data
    async clearAuthenticationData(session, senderId) {
        try {
            logger.info('Clearing authentication data for fresh start', { senderId });
            const fs = require('fs');
            const path = require('path');
            const authPath = path.join(process.env.SESSION_STORAGE_PATH || './sessions', senderId, 'auth');
            
            if (fs.existsSync(authPath)) {
                fs.rmSync(authPath, { recursive: true, force: true });
                logger.info('Authentication data cleared', { senderId });
            }
            
            // Re-initialize session
            await session.initializeWithoutConnection();
            
            // Clear socket and QR data
            if (session.socket) {
                try {
                    session.socket.end();
                } catch (e) {
                    // Ignore errors
                }
                session.socket = null;
            }
            
            session.qrCodeData = null;
            session.qrCodeString = null;
            session.qrCodeTimestamp = null;
            
            // NEW: Clear authentication state flags
            session.clearAuthenticationState();
            
        } catch (error) {
            logger.warn('Error clearing authentication data', { senderId, error: error.message });
        }
    }
    
    // Helper method to restart session socket
    async restartSessionSocket(session, senderId) {
        try {
            logger.info('Restarting session socket', { senderId });
            
            if (session.socket) {
                try {
                    session.socket.end();
                } catch (e) {
                    // Ignore errors
                }
                session.socket = null;
            }
            
            // Clear QR data to force regeneration
            session.qrCodeData = null;
            session.qrCodeString = null;
            session.qrCodeTimestamp = null;
            
        } catch (error) {
            logger.warn('Error restarting socket', { senderId, error: error.message });
        }
    }

    async getQRStringForAPI(senderId) {
        try {
            logger.info('API QR string requested', { senderId });
            
            // Get existing session or create a minimal one
            let session = this.sessions.get(senderId);
            
            if (!session) {
                // Create session without auto-recovery
                const sessionData = await this.database.getSession(senderId);
                if (!sessionData) {
                    throw new Error(`Session not found. Please create session first.`);
                }
                
                // Create new session instance with lazy initialization
                session = new BaileysSession(senderId, this.database, this.webhookManager);
                session.setAutoConnect(false); // Don't auto-connect
                
                this.sessions.set(senderId, session);
                
                // Initialize without connecting
                await session.initializeWithoutConnection();
            }
            
            // Check if we have a valid QR string in memory
            const now = Date.now();
            
            // If socket is actively connecting (linking in progress), extend QR validity and don't interrupt
            if (session.socket && session.socket.readyState === 0) { // CONNECTING state - WhatsApp is linking
                logger.info('Socket is in CONNECTING state - device linking in progress', { senderId });
                
                // Extend QR cache time to 60 seconds during linking process
                if (session.qrCodeString && session.qrCodeTimestamp && (now - session.qrCodeTimestamp < 60000)) {
                    logger.info('Returning existing QR string - linking in progress', { 
                        senderId, 
                        age: `${now - session.qrCodeTimestamp}ms`,
                        socketState: 'CONNECTING'
                    });
                    return session.qrCodeString;
                }
            }
            
            // Check for recent QR string (less than 15 seconds old) for normal cases
            if (session.qrCodeString && session.qrCodeTimestamp && (now - session.qrCodeTimestamp < 15000)) {
                logger.info('Returning cached QR string', { 
                    senderId, 
                    age: `${now - session.qrCodeTimestamp}ms`,
                    reason: 'Recent QR still valid'
                });
                return session.qrCodeString;
            }
            
            // Only generate new QR if truly necessary (same logic as QR code)
            const shouldGenerateNewQR = !session.qrCodeString || 
                                       !session.qrCodeTimestamp ||
                                       (session.socket && session.socket.readyState === 3) || // CLOSED
                                       (!session.socket && (now - session.qrCodeTimestamp > 15000));
            
            if (!shouldGenerateNewQR) {
                logger.info('Preserving existing QR string and socket state', { 
                    senderId,
                    socketState: session.socket?.readyState,
                    qrAge: session.qrCodeTimestamp ? `${now - session.qrCodeTimestamp}ms` : 'none'
                });
                return session.qrCodeString;
            }
            
            logger.info('Generating fresh QR string', { 
                senderId,
                reason: !session.qrCodeString ? 'No QR exists' : 
                       !session.socket ? 'No socket' :
                       session.socket.readyState === 3 ? 'Socket closed' : 'QR expired',
                socketState: session.socket?.readyState
            });
            
            // Set flag to prevent auto-reconnection during QR generation
            session.isGeneratingQR = true;
            
            // Only clear auth data if socket is truly failed or closed
            // Never clear during CONNECTING state (readyState === 0)
            const shouldClearAuth = !session.socket || 
                                   session.socket.readyState === 3 || // CLOSED only
                                   (session.qrCodeTimestamp && (now - session.qrCodeTimestamp > 120000)); // QR older than 2 minutes
            
            if (shouldClearAuth) {
                logger.info('Clearing old authentication data for fresh start', { senderId });
                const fs = require('fs');
                const path = require('path');
                const authPath = path.join(process.env.SESSION_STORAGE_PATH || './sessions', senderId, 'auth');
                
                if (fs.existsSync(authPath)) {
                    try {
                        fs.rmSync(authPath, { recursive: true, force: true });
                        logger.info('Cleared old authentication data', { senderId });
                    } catch (clearError) {
                        logger.warn('Error clearing auth data', { senderId, error: clearError.message });
                    }
                }
                
                // Re-initialize session without authentication data
                await session.initializeWithoutConnection();
                
                // Destroy existing socket only if it's not connecting
                if (session.socket && session.socket.readyState !== 0) {
                    try {
                        session.socket.end();
                    } catch (e) {
                        // Ignore errors when ending socket
                    }
                    session.socket = null;
                    session.qrCodeData = null;
                    session.qrCodeString = null;
                    session.qrCodeTimestamp = null;
                }
            } else {
                logger.info('Preserving auth data and socket state', { 
                    senderId,
                    socketState: session.socket?.readyState,
                    reason: 'Socket connecting or recent activity'
                });
            }
            
            // Set QR display mode for API request
            session.setQRDisplayMode(true, true);
            
            // Connect to generate fresh QR code only if no socket or socket is closed
            if (!session.socket || session.socket.readyState === 3) {
                logger.info('Creating new connection for QR generation', { senderId });
                session.connect().catch(error => {
                    logger.error('Error in background connection for QR', { senderId, error: error.message });
                });
            } else {
                logger.info('Using existing socket for QR generation', { 
                    senderId,
                    socketState: session.socket.readyState
                });
            }
            
            // Wait briefly for QR string generation
            let attempts = 0;
            while (attempts < 30 && !session.qrCodeString) { // Max 3 seconds (30 * 100ms)
                await new Promise(resolve => setTimeout(resolve, 100));
                attempts++;
            }
            
            if (session.qrCodeString) {
                // Store timestamp for expiry tracking
                session.qrCodeTimestamp = Date.now();
                session.isGeneratingQR = false; // Clear flag
                logger.info('QR string generated successfully', { senderId });
                return session.qrCodeString;
            } else {
                session.isGeneratingQR = false; // Clear flag even on failure
                // Return a placeholder or error
                throw new Error('QR code not ready. Please wait a moment and try again.');
            }
            
        } catch (error) {
            logger.error('Error in getQRStringForAPI', { senderId, error: error.message });
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
            let checkCount = 0;
            
            const checkQRCode = () => {
                checkCount++;
                const elapsed = Date.now() - startTime;
                
                // Log every 2 seconds to debug what's happening
                if (checkCount % 4 === 0) {
                    logger.info(`QR check #${checkCount}`, {
                        sessionId: session.sessionId,
                        elapsed: `${elapsed}ms`,
                        hasQR: !!session.getQRCode(),
                        hasQRString: !!session.getQRString(),
                        hasSocket: !!session.socket,
                        isConnected: session.isSessionConnected()
                    });
                }
                
                if (session.getQRCode()) {
                    logger.info('QR code found!', { sessionId: session.sessionId, elapsed: `${elapsed}ms` });
                    resolve(true);
                } else if (elapsed > timeout) {
                    logger.error('QR code timeout details', {
                        sessionId: session.sessionId,
                        elapsed: `${elapsed}ms`,
                        timeout: `${timeout}ms`,
                        checkCount: checkCount,
                        hasSocket: !!session.socket,
                        isConnected: session.isSessionConnected(),
                        hasQRData: !!session.qrCodeData,
                        hasQRString: !!session.qrCodeString
                    });
                    reject(new Error('QR code generation timeout'));
                } else {
                    setTimeout(checkQRCode, 500); // Check every 500ms for faster response
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

    async getSessionsByUserId(userId) {
        try {
            const sessions = await this.database.getSessionsByUserId(userId);
            
            // Enhance with runtime status from active sessions
            const enhancedSessions = sessions.map(sessionData => {
                const activeSession = this.sessions.get(sessionData.session_id);
                
                // Get the actual connection status more reliably
                let isConnected = false;
                let hasQRCode = false;
                let connectionInfo = null;
                
                if (activeSession) {
                    try {
                        isConnected = activeSession.isSessionConnected();
                        hasQRCode = !!activeSession.getQRCode();
                        
                        // Get detailed connection info if available
                        if (typeof activeSession.getConnectionInfo === 'function') {
                            connectionInfo = activeSession.getConnectionInfo();
                        }
                    } catch (sessionError) {
                        logger.warn('Error getting session status in getSessionsByUserId', { 
                            sessionId: sessionData.session_id, 
                            error: sessionError.message 
                        });
                    }
                }
                
                return {
                    ...sessionData,
                    isConnected: isConnected,
                    hasQRCode: hasQRCode,
                    inMemory: !!activeSession,
                    connectionInfo: connectionInfo
                };
            });
            
            return enhancedSessions;
        } catch (error) {
            logger.error('Failed to get sessions by user ID', { userId, error: error.message });
            throw error;
        }
    }
}

module.exports = SessionManager; 