require('dotenv').config({ path: './config.env' });
const express = require('express');
const cors = require('cors');
const path = require('path');
const SessionManager = require('./services/session-manager');
const { router: apiRouter, setSessionManager } = require('./routes/api');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize session manager
const sessionManager = new SessionManager();
setSessionManager(sessionManager);

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logging middleware
app.use((req, res, next) => {
    logger.info(`${req.method} ${req.path}`, {
        ip: req.ip,
        userAgent: req.get('user-agent'),
        body: req.method === 'POST' ? (req.body.authToken ? { ...req.body, authToken: '[HIDDEN]' } : req.body) : undefined
    });
    next();
});

// API routes
app.use('/api', apiRouter);

// Health check endpoint
app.get('/health', (req, res) => {
    try {
        const stats = sessionManager.getSessionStats();
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            sessionStats: stats,
            initialized: sessionManager.isInitialized
        });
    } catch (error) {
        logger.error('Health check error', { error: error.message });
        res.status(500).json({
            status: 'unhealthy',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Root endpoint with API documentation
app.get('/', (req, res) => {
    try {
        const stats = sessionManager.getSessionStats();
        
        res.json({
            message: 'WhatsApp API using Baileys',
            version: '1.0.0',
            status: 'running',
            initialized: sessionManager.isInitialized,
            sessionStats: stats,
            endpoints: {
                'POST /api/createSession': 'Create a new WhatsApp session with senderId, user_id, and admin_id',
                'POST /api/getQRCode': 'Get QR code for session authentication (also displays in terminal)',
                'POST /api/displayQR': 'Display QR code in terminal only (convenience endpoint)',
                'POST /api/sendTextSMS': 'Send text message with auto-recovery',
                'POST /api/sendMediaSMS': 'Send media message with auto-recovery',
                'POST /api/getGroups': 'Get WhatsApp groups',
                'POST /api/getContacts': 'Get WhatsApp contacts',
                'POST /api/validateNumber': 'Validate if number is registered on WhatsApp',
                'POST /api/updateWebhook': 'Update webhook URL and/or status (unified API)',
                'POST /api/testWebhook': 'Test webhook endpoint',
                'POST /api/webhookDiagnostics': 'Comprehensive webhook diagnostics and troubleshooting',
                'POST /api/testWebhookConnection': 'Quick webhook connectivity test',
                'POST /api/compareWebhookPayloads': 'Compare webhook payloads between WhatsApp Business and Regular WhatsApp',
                'POST /api/testAppTypeDetection': 'Test app type detection for Regular WhatsApp vs WhatsApp Business messages',
                'POST /api/logoutSession': 'Logout from WhatsApp session',
                'POST /api/deleteSession': 'Permanently delete session and data',
                'POST /api/refreshSession': 'Manually refresh/reconnect session',
                'POST /api/checkSessionHealth': 'Check individual session health',
                'POST /api/triggerHealthCheck': 'Trigger global health check for all sessions',
                'POST /api/sessionDiagnostics': 'Get detailed session diagnostics for troubleshooting',
                'GET /api/sessionStatus/:senderId': 'Get session status by senderId',
                'GET /api/sessions/user/:userId': 'Get all sessions for a specific user with status',
                'GET /api/stats': 'Get system statistics',
                'GET /health': 'Health check endpoint'
            },
            documentation: {
                'API Parameters': {
                    'authToken': 'Global API authentication token (set in config.env)',
                    'senderId': 'Sender device phone number (used as session identifier)',
                    'userId': 'User ID to associate with the session (optional, defaults to senderId)',
                    'adminId': 'Admin ID who manages the session (optional)',
                    'receiverId': 'WhatsApp number with country code (e.g., 1234567890@s.whatsapp.net)',
                    'messageText': 'Text message content',
                    'mediaurl': 'URL of media file to send (alternative to file upload)',
                    'caption': 'Optional caption for media messages'
                },
                'Authentication': {
                    'Global Token': 'All API endpoints require the global authToken from config.env',
                    'Session Management': 'Sessions are identified by senderId (phone number)',
                    'No Per-Session Tokens': 'No individual session tokens - use global authToken for all requests'
                },
                'QR Code Features': {
                    'Automatic Display': 'QR codes automatically appear in terminal when sessions start',
                    'API Display': 'Call /api/getQRCode to get base64 data AND display in terminal',
                    'Terminal Only': 'Call /api/displayQR to show QR in terminal without returning data',
                    'Expiry': 'QR codes expire in ~20 seconds, new ones generate automatically'
                },
                'Example Usage': {
                    'Create Session': 'POST /api/createSession with { "authToken": "global-token", "senderId": "919876543210", "userId": "user123", "adminId": "admin456" }',
                    'Get QR Code': 'POST /api/getQRCode with { "authToken": "global-token", "senderId": "919876543210" }',
                    'Display QR': 'POST /api/displayQR with { "authToken": "global-token", "senderId": "919876543210" }',
                    'Send Text': 'POST /api/sendTextSMS with { "authToken": "global-token", "senderId": "919876543210", "receiverId": "number@s.whatsapp.net", "messageText": "Hello" }',
                    'Send Media': 'POST /api/sendMediaSMS with form-data: authToken, senderId, receiverId, and either file upload or mediaurl',
                    'Session Status': 'GET /api/sessionStatus/919876543210?authToken=global-token',
                    'User Sessions': 'GET /api/sessions/user/user123?authToken=global-token'
                }
            }
        });
    } catch (error) {
        logger.error('Root endpoint error', { error: error.message });
        res.status(500).json({
            error: 'Server error',
            message: error.message
        });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    logger.error('Unhandled error', {
        error: err.message,
        stack: err.stack,
        url: req.url,
        method: req.method
    });
    
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        message: `${req.method} ${req.path} is not a valid endpoint`
    });
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
    logger.info(`Received ${signal}. Starting graceful shutdown...`);
    
    // Stop accepting new connections
    server.close(async () => {
        logger.info('HTTP server closed');
        
        try {
            // Cleanup session manager
            await sessionManager.cleanup();
            logger.info('Session manager cleaned up successfully');
            
            // Exit process
            process.exit(0);
        } catch (error) {
            logger.error('Error during cleanup', { error: error.message });
            process.exit(1);
        }
    });
    
    // Force exit after timeout
    setTimeout(() => {
        logger.error('Forced shutdown due to timeout');
        process.exit(1);
    }, 30000);
};

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', { 
        error: error.message, 
        stack: error.stack,
        name: error.name,
        code: error.code
    });
    console.error('Uncaught Exception:', error);
    process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection', { 
        reason: reason?.message || reason, 
        stack: reason?.stack,
        name: reason?.name,
        code: reason?.code,
        promise: promise.toString()
    });
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    
    // Check if it's a WebSocket related error that we can ignore
    const isWebSocketError = reason?.message?.includes('WebSocket was closed') || 
                            reason?.message?.includes('socket hang up') ||
                            reason?.message?.includes('ECONNRESET');
    
    if (isWebSocketError) {
        logger.warn('WebSocket related error caught, continuing operation', { 
            error: reason?.message 
        });
        return; // Don't exit for WebSocket errors
    }
    
    // For debugging, let's not exit immediately but log the error
    if (process.env.NODE_ENV === 'production') {
        logger.error('Exiting due to unhandled rejection in production');
        process.exit(1);
    } else {
        logger.warn('Unhandled rejection in development mode, continuing...');
    }
});

// Add warning handler
process.on('warning', (warning) => {
    logger.warn('Process Warning', {
        name: warning.name,
        message: warning.message,
        stack: warning.stack
    });
});

// Start server
const server = app.listen(PORT, () => {
    logger.info(`WhatsApp API Server running on port ${PORT}`, {
        environment: process.env.NODE_ENV,
        maxSessions: sessionManager.maxSessions,
        nodeVersion: process.version,
        platform: process.platform
    });
    
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                    WhatsApp API Server                       ║
║                     using Baileys                            ║
╠══════════════════════════════════════════════════════════════╣
║  Server running on: http://localhost:${PORT}                    ║
║  Environment: ${process.env.NODE_ENV || 'development'}                               ║
║  Max Sessions: ${sessionManager.maxSessions}                                      ║
║                                                              ║
║  API Documentation: http://localhost:${PORT}/                   ║
║  Health Check: http://localhost:${PORT}/health                  ║
║  System Stats: http://localhost:${PORT}/api/stats               ║
╚══════════════════════════════════════════════════════════════╝
    `);

    // Optional: Wait for session manager initialization and log status
    setTimeout(() => {
        sessionManager.waitForInitialization(10000)
            .then(() => {
                logger.info('Session Manager fully initialized');
            })
            .catch((error) => {
                logger.warn('Session Manager initialization timeout, but server is running', { error: error.message });
            });
    }, 1000);
});

module.exports = app; 