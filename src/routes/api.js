const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const mimeTypes = require('mime-types');
const multer = require('multer');
const logger = require('../utils/logger');

const router = express.Router();

// Configure multer for file uploads (session migration)
const storage = multer.memoryStorage(); // Store files in memory for processing
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit for credential files
        files: 20 // Allow multiple credential files (Baileys uses multiple auth files)
    },
    fileFilter: (req, file, cb) => {
        // Allow common credential file extensions and JSON files
        const allowedExtensions = ['.json', '.creds', '.keys', '.txt', ''];
        const fileExtension = path.extname(file.originalname).toLowerCase();
        
        if (allowedExtensions.includes(fileExtension) || file.originalname.startsWith('creds.json') || 
            file.originalname.includes('pre-key') || file.originalname.includes('session') ||
            file.originalname.includes('sender-key')) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only credential files are allowed.'), false);
        }
    }
});

// Middleware to validate auth token
const validateAuthToken = (req, res, next) => {
    const { authToken } = req.body;
    if (!authToken) {
        return res.status(400).json({
            success: false,
            message: 'Authentication token is required',
            error: 'authToken is required'
        });
    }
    
    // Check against global AUTH_TOKEN from environment
    if (authToken !== process.env.AUTH_TOKEN) {
        return res.status(401).json({
            success: false,
            message: 'Authentication failed',
            error: 'Invalid authToken'
        });
    }
    
    next();
};

// Middleware to validate senderId format
const validateSenderId = (req, res, next) => {
    const { senderId, sessionId } = req.body || req.params;
    
    // Use alias if main parameter is not provided
    const finalSenderId = senderId || sessionId;
    
    if (!finalSenderId) {
        return res.status(400).json({
            success: false,
            message: 'Sender ID is required',
            error: 'senderId (or sessionId) is required'
        });
    }
    
    // Validate senderId format (should be a phone number)
    const senderIdRegex = /^[1-9]\d{7,14}$/; // 8-15 digits, not starting with 0
    if (!senderIdRegex.test(finalSenderId)) {
        return res.status(400).json({
            success: false,
            message: 'Invalid sender ID format',
            error: 'Invalid senderId/sessionId format. Must be a valid phone number (8-15 digits, no country code +)'
        });
    }
    
    // Store the final senderId in request body for consistency
    req.body.senderId = finalSenderId;
    
    next();
};

// Middleware to check if session exists in database (for operations requiring existing session)
const checkSessionExists = async (req, res, next) => {
    try {
        const { senderId, sessionId } = req.body || req.params;
        
        // Use alias if main parameter is not provided
        const finalSenderId = senderId || sessionId;
        
        const sessionData = await sessionManager.database.getSession(finalSenderId);
        if (!sessionData) {
            return res.status(404).json({
                success: false,
                message: 'Session not found',
                error: `Session not found for senderId: ${finalSenderId}. Please create session first.`,
                data: {
                    senderId: finalSenderId,
                    suggestion: 'Use POST /api/createSession to create a new session'
                }
            });
        }
        
        // Store session data in request for use in route handlers
        req.sessionData = sessionData;
        next();
    } catch (error) {
        logger.error('Error checking session existence', { error: error.message, senderId: req.body?.senderId || req.body?.sessionId || req.params?.senderId });
        res.status(500).json({
            success: false,
            message: 'Database error while checking session',
            error: 'Database error while checking session',
            data: {
                senderId: req.body?.senderId || req.body?.sessionId || req.params?.senderId
            }
        });
    }
};

// Helper function to validate senderId format
const isValidSenderId = (senderId) => {
    if (!senderId || typeof senderId !== 'string') {
        return false;
    }
    
    // Remove any non-digits
    const cleanSenderId = senderId.replace(/\D/g, '');
    
    // Check if it's between 8-15 digits and doesn't start with 0
    const senderIdRegex = /^[1-9]\d{7,14}$/;
    return senderIdRegex.test(cleanSenderId);
};

// Initialize session manager (will be set in server.js)
let sessionManager = null;

const setSessionManager = (manager) => {
    sessionManager = manager;
};

// GET QR Code endpoint
router.post('/getQRCode', validateAuthToken, validateSenderId, async (req, res) => {
    try {
        const { authToken, senderId } = req.body;
        
        // Additional validation - ensure session exists or can be created
        logger.api('/getQRCode', 'QR code requested', { senderId });
        
        // Use the new API-specific method that doesn't trigger auto-recovery
        const qrResponse = await sessionManager.getQRCodeForAPI(senderId);
        
        // Handle different response types from enhanced QR API
        if (typeof qrResponse === 'object' && qrResponse.qrCode) {
            // Enhanced response with state information
            res.json({
                success: true,
                message: qrResponse.message || 'QR code generated successfully',
                data: {
                    qrCode: qrResponse.qrCode,
                    senderId: senderId,
                    state: qrResponse.state,
                    shouldStopPolling: qrResponse.shouldStopPolling || false,
                    expiresIn: qrResponse.expiresIn || null,
                    estimatedWaitTime: qrResponse.estimatedWaitTime || null,
                    generatedAt: qrResponse.generatedAt || Date.now(),
                    message: qrResponse.message,
                    note: qrResponse.state === 'AUTHENTICATION_IN_PROGRESS' 
                        ? 'Authentication in progress. Please wait and avoid scanning new QR codes.'
                        : 'QR code has been displayed in the terminal'
                }
            });
        } else if (typeof qrResponse === 'string') {
            // Legacy response format (just QR code string)
            res.json({
                success: true,
                message: 'QR code generated successfully',
                data: {
                    qrCode: qrResponse,
                    senderId: senderId,
                    state: 'QR_READY',
                    shouldStopPolling: false,
                    expiresIn: 20000,
                    message: 'Scan this QR code with WhatsApp to connect your session',
                    note: 'QR code has been displayed in the terminal'
                }
            });
        } else {
            // No QR code available
            return res.status(404).json({
                success: false,
                message: 'QR code not available',
                error: 'QR code not available. Session might already be connected or still initializing.',
                data: {
                    senderId: senderId,
                    suggestion: 'Try again in a few seconds or check session status'
                }
            });
        }
        
    } catch (error) {
        logger.error('Error in /getQRCode', { error: error.message, senderId: req.body?.senderId });
        
        // Handle specific error cases
        if (error.message.includes('already connected')) {
            return res.status(409).json({
                success: false,
                message: 'Session already connected',
                error: error.message,
                data: {
                    senderId: req.body?.senderId,
                    state: 'ALREADY_CONNECTED',
                    shouldStopPolling: true,
                    suggestion: 'Session is already active. No QR code needed.'
                }
            });
        }
        
        if (error.message.includes('Authentication in progress')) {
            return res.status(202).json({
                success: false,
                message: 'Authentication in progress',
                error: error.message,
                data: {
                    senderId: req.body?.senderId,
                    state: 'AUTHENTICATION_IN_PROGRESS',
                    shouldStopPolling: true,
                    estimatedWaitTime: 30000,
                    suggestion: 'Please wait for authentication to complete.'
                }
            });
        }
        
        res.status(500).json({
            success: false,
            message: 'Failed to generate QR code',
            error: error.message,
            data: {
                senderId: req.body?.senderId,
                state: 'ERROR',
                shouldStopPolling: false,
                suggestion: 'Try again in a few seconds'
            }
        });
    }
});

// Helper function to determine message delivery status
const getMessageDeliveryStatus = (error, validationResult) => {
    if (!error) {
        // Message sent successfully
        if (validationResult && validationResult.isRegistered === false) {
            return "not on WA";
        }
        return "delivered";
    }
    
    // Error occurred - determine the type
    const errorMessage = error.message.toLowerCase();
    
    // Group access forbidden errors (user not in group)
    if (errorMessage.includes('forbidden') || 
        errorMessage.includes('not a participant') ||
        errorMessage.includes('not in group') ||
        errorMessage.includes('group access denied') ||
        error.message === 'forbidden') {
        return "skipped";
    }
    
    // Session-related errors
    if (errorMessage.includes('session not connected') ||
        errorMessage.includes('connection timeout') ||
        errorMessage.includes('session requires fresh qr') ||
        errorMessage.includes('session offline') ||
        errorMessage.includes('qr scan') ||
        errorMessage.includes('auto-reconnect') ||
        errorMessage.includes('requires_qr') ||
        errorMessage.includes('logged_out')) {
        return "session offline";
    }
    
    // WhatsApp registration errors
    if (errorMessage.includes('not registered on whatsapp') ||
        errorMessage.includes('phone number') && errorMessage.includes('not registered') ||
        errorMessage.includes('not on whatsapp')) {
        return "not on WA";
    }
    
    // General failure for any other errors
    return "failed";
};

// Send Text SMS endpoint
router.post('/sendTextSMS', validateAuthToken, validateSenderId, checkSessionExists, async (req, res) => {
    try {
        const { 
            authToken, 
            senderId, sessionId,           // sessionId as alias for senderId
            receiverId, number,            // number as alias for receiverId
            messageText 
        } = req.body;
        
        // Use aliases if main parameters are not provided
        const finalSenderId = senderId || sessionId;
        const finalReceiverId = receiverId || number;
        
        if (!finalReceiverId || !messageText) {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameters',
                error: 'receiverId (or number) and messageText are required',
                status: "failed",
                data: {
                    senderId: finalSenderId,
                    received: {
                        receiverId: !!finalReceiverId,
                        messageText: !!messageText
                    }
                }
            });
        }
        
        // Validate receiverId format
        if (!finalReceiverId.includes('@') && !isValidSenderId(finalReceiverId)) {
            // Check if it might be a group ID (longer than 15 characters with hyphens or long numeric)
            const isGroupId = finalReceiverId.length > 15 && (finalReceiverId.includes('-') || /^\d{18,}$/.test(finalReceiverId));
            
            if (!isGroupId) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid receiver ID format',
                    error: 'Invalid receiverId/number format. Must be a valid phone number, group ID, or WhatsApp JID',
                    status: "failed",
                    data: {
                        senderId: finalSenderId,
                        receiverId: finalReceiverId,
                        expectedFormats: [
                            "Phone number: 919876543210",
                            "Group ID: 120363168346132205",
                            "WhatsApp JID: 919876543210@s.whatsapp.net",
                            "Group JID: 120363168346132205@g.us"
                        ]
                    }
                });
            }
        }
        
        logger.api('/sendTextSMS', 'Text message send requested', { 
            senderId: finalSenderId, 
            receiverId: finalReceiverId, 
            messageLength: messageText.length 
        });
        
        // OPTIMIZED: Fast pre-validation for better performance
        const session = await sessionManager.getSessionBySenderId(finalSenderId);
        if (session && session.isSessionConnected()) {
            // Quick validation check before sending
            const quickValidation = await session.isNumberRegisteredOnWhatsApp(finalReceiverId);
            if (!quickValidation.isRegistered && !quickValidation.validationFailed && !quickValidation.isGroup) {
                // Fast fail for unregistered numbers
                const errorStatus = getMessageDeliveryStatus({ message: `Phone number ${finalReceiverId} is not registered on WhatsApp` });
                return res.status(500).json({
                    success: false,
                    message: 'Failed to send text message',
                    error: `Phone number ${finalReceiverId} is not registered on WhatsApp`,
                    status: errorStatus,
                    senderId: finalSenderId,
                    fastFail: true,
                    responseTime: '<1s'
                });
            }
        }
        
        const result = await sessionManager.sendTextMessage(finalSenderId, finalReceiverId, messageText);
        
        // Determine delivery status
        const deliveryStatus = getMessageDeliveryStatus(null, result.validationResult);
        
        res.json({
            success: true,
            message: 'Text message sent successfully',
            status: deliveryStatus,
            data: {
                messageId: result.key.id,
                senderId: finalSenderId,
                receiverId: finalReceiverId,
                messageLength: messageText.length,
                sessionStatus: req.sessionData.status,
                validation: result.validationResult ? {
                    isRegistered: result.validationResult.isRegistered,
                    isGroup: result.validationResult.isGroup,
                    formattedJID: result.validationResult.jid,
                    validationPassed: result.validationResult.isRegistered || result.validationResult.validationFailed
                } : null
            }
        });
        
    } catch (error) {
        logger.error('Error in /sendTextSMS', { error: error.message, senderId: req.body?.senderId || req.body?.sessionId });
        
        // Determine error status
        const errorStatus = getMessageDeliveryStatus(error);
        
        res.status(500).json({
            success: false,
            message: 'Failed to send text message',
            error: error.message,
            status: errorStatus,
            senderId: req.body?.senderId || req.body?.sessionId
        });
    }
});

// Send Media SMS endpoint
router.post('/sendMediaSMS', validateAuthToken, validateSenderId, checkSessionExists, async (req, res) => {
    try {
        const { 
            authToken, 
            senderId, sessionId,           // sessionId as alias for senderId
            receiverId, number,            // number as alias for receiverId
            mediaurl, media,               // media as alias for mediaurl
            caption, messageText           // messageText as additional parameter alongside caption
        } = req.body;
        
        // Use aliases if main parameters are not provided
        const finalSenderId = senderId || sessionId;
        const finalReceiverId = receiverId || number;
        const finalMediaUrl = mediaurl || media;
        const finalCaption = caption || messageText || '';
        
        if (!finalReceiverId || !finalMediaUrl) {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameters',
                error: 'receiverId (or number) and mediaurl (or media) are required',
                status: "failed",
                data: {
                    senderId: finalSenderId,
                    received: {
                        receiverId: !!finalReceiverId,
                        mediaurl: !!finalMediaUrl
                    }
                }
            });
        }
        
        // Validate receiverId format
        if (!finalReceiverId.includes('@') && !isValidSenderId(finalReceiverId)) {
            // Check if it might be a group ID (longer than 15 characters with hyphens or long numeric)
            const isGroupId = finalReceiverId.length > 15 && (finalReceiverId.includes('-') || /^\d{18,}$/.test(finalReceiverId));
            
            if (!isGroupId) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid receiver ID format',
                    error: 'Invalid receiverId/number format. Must be a valid phone number, group ID, or WhatsApp JID',
                    status: "failed",
                    data: {
                        senderId: finalSenderId,
                        receiverId: finalReceiverId,
                        expectedFormats: [
                            "Phone number: 919876543210",
                            "Group ID: 120363168346132205",
                            "WhatsApp JID: 919876543210@s.whatsapp.net",
                            "Group JID: 120363168346132205@g.us"
                        ]
                    }
                });
            }
        }
        
        // Validate mediaurl format
        const urlRegex = /^https?:\/\/.+/;
        if (!urlRegex.test(finalMediaUrl)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid media URL format',
                error: 'Invalid mediaurl/media format. Must be a valid HTTP/HTTPS URL',
                status: "failed",
                data: {
                    senderId: finalSenderId,
                    mediaurl: finalMediaUrl
                }
            });
        }
        
        // OPTIMIZED: Fast pre-validation before downloading media
        const session = await sessionManager.getSessionBySenderId(finalSenderId);
        if (session && session.isSessionConnected()) {
            // Quick validation check before downloading media
            const quickValidation = await session.isNumberRegisteredOnWhatsApp(finalReceiverId);
            if (!quickValidation.isRegistered && !quickValidation.validationFailed && !quickValidation.isGroup) {
                // Fast fail for unregistered numbers - don't download media
                const errorStatus = getMessageDeliveryStatus({ message: `Phone number ${finalReceiverId} is not registered on WhatsApp` });
                return res.status(500).json({
                    success: false,
                    message: 'Failed to send media message',
                    error: `Phone number ${finalReceiverId} is not registered on WhatsApp`,
                    status: errorStatus,
                    senderId: finalSenderId,
                    fastFail: true,
                    responseTime: '<1s',
                    note: 'Media download skipped - number not registered'
                });
            }
        }

        let mediaBuffer;
        let mediaType;
        let originalFileName;
        
        // Download media from URL
        try {
            logger.api('/sendMediaSMS', 'Media message send requested', { 
                senderId: finalSenderId, 
                receiverId: finalReceiverId, 
                mediaurl: finalMediaUrl 
            });
            
            // Extract filename from URL
            try {
                const url = new URL(finalMediaUrl);
                const pathname = url.pathname;
                // Get the last part of the path (filename)
                originalFileName = pathname.split('/').pop();
                
                // Clean up filename and decode URL encoding
                if (originalFileName) {
                    originalFileName = decodeURIComponent(originalFileName);
                    // Remove query parameters if any
                    originalFileName = originalFileName.split('?')[0];
                    // Ensure filename has an extension
                    if (!originalFileName.includes('.')) {
                        originalFileName = null; // Will use default naming
                    }
                }
            } catch (urlError) {
                logger.warn('Could not extract filename from URL', { mediaurl: finalMediaUrl, error: urlError.message });
                originalFileName = null;
            }
            
            const response = await axios.get(finalMediaUrl, {
                responseType: 'arraybuffer',
                timeout: 15000, // OPTIMIZED: Reduced from 30s to 15s for faster failure detection
                maxContentLength: 50 * 1024 * 1024 // 50MB
            });
            
            mediaBuffer = Buffer.from(response.data);
            mediaType = response.headers['content-type'] || mimeTypes.lookup(finalMediaUrl) || 'application/octet-stream';
            
        } catch (downloadError) {
            logger.error('Error downloading media from URL', { mediaurl: finalMediaUrl, error: downloadError.message });
            return res.status(400).json({
                success: false,
                message: 'Failed to download media',
                error: 'Failed to download media from URL: ' + downloadError.message,
                status: "failed",
                data: {
                    senderId: finalSenderId,
                    mediaurl: finalMediaUrl
                }
            });
        }
        
        const result = await sessionManager.sendMediaMessage(finalSenderId, finalReceiverId, mediaBuffer, mediaType, finalCaption, originalFileName);
        
        // Determine delivery status
        const deliveryStatus = getMessageDeliveryStatus(null, result.validationResult);
        
        res.json({
            success: true,
            message: 'Media message sent successfully',
            status: deliveryStatus,
            data: {
                messageId: result.key.id,
                senderId: finalSenderId,
                receiverId: finalReceiverId,
                mediaurl: finalMediaUrl,
                mediaType: mediaType,
                fileName: originalFileName,
                caption: finalCaption,
                sessionStatus: req.sessionData.status,
                validation: result.validationResult ? {
                    isRegistered: result.validationResult.isRegistered,
                    isGroup: result.validationResult.isGroup,
                    formattedJID: result.validationResult.jid,
                    validationPassed: result.validationResult.isRegistered || result.validationResult.validationFailed
                } : null
            }
        });
        
    } catch (error) {
        logger.error('Error in /sendMediaSMS', { error: error.message, senderId: req.body?.senderId || req.body?.sessionId });
        
        // Determine error status
        const errorStatus = getMessageDeliveryStatus(error);
        
        res.status(500).json({
            success: false,
            message: 'Failed to send media message',
            error: error.message,
            status: errorStatus,
            senderId: req.body?.senderId || req.body?.sessionId
        });
    }
});

// Get Groups endpoint
router.post('/getGroups', validateAuthToken, validateSenderId, checkSessionExists, async (req, res) => {
    try {
        const { senderId } = req.body;
        
        logger.api('/getGroups', 'Groups list requested', { senderId });
        
        const groups = await sessionManager.getGroups(senderId);
        
        res.json({
            success: true,
            message: 'Groups retrieved successfully',
            data: {
                groups: groups,
                count: groups.length,
                senderId: senderId,
                sessionStatus: req.sessionData.status
            }
        });
        
    } catch (error) {
        logger.error('Error in /getGroups', { error: error.message, senderId: req.body?.senderId });
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve groups',
            error: error.message,
            senderId: req.body?.senderId
        });
    }
});

// Get Contacts endpoint
router.post('/getContacts', validateAuthToken, validateSenderId, checkSessionExists, async (req, res) => {
    try {
        const { senderId } = req.body;
        
        logger.api('/getContacts', 'Contacts list requested', { senderId });
        
        const contacts = await sessionManager.getContacts(senderId);
        
        res.json({
            success: true,
            message: 'Contacts retrieved successfully',
            data: {
                contacts: contacts,
                count: contacts.length,
                senderId: senderId,
                sessionStatus: req.sessionData.status
            }
        });
        
    } catch (error) {
        logger.error('Error in /getContacts', { error: error.message, senderId: req.body?.senderId });
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve contacts',
            error: error.message,
            senderId: req.body?.senderId
        });
    }
});

// Session management endpoints

// Create new session
router.post('/createSession', validateAuthToken, validateSenderId, async (req, res) => {
    try {
        const { senderId, name, userId, user_id, adminId, admin_id, webhookUrl } = req.body;
        
        // Use aliases if main parameters are not provided
        const finalUserId = String(userId || user_id || senderId);
        const finalAdminId = adminId || admin_id;
        
        // Check if session already exists
        try {
            const existingSession = await sessionManager.database.getSession(senderId);
            if (existingSession) {
                return res.status(409).json({
                    success: false,
                    message: 'Session already exists',
                    error: `Session already exists for senderId: ${senderId}`,
                    data: {
                        sessionId: senderId,
                        status: existingSession.status,
                        createdAt: existingSession.created_at,
                        userId: existingSession.user_id,
                        adminId: existingSession.admin_id
                    }
                });
            }
        } catch (dbError) {
            logger.error('Error checking existing session', { senderId, error: dbError.message });
        }
        
        // Prepare additional data for session creation
        const additionalData = {
            name: name,
            user_id: finalUserId,
            admin_id: finalAdminId,
            webhook_url: webhookUrl
        };
        
        // Use senderId as the session ID
        const sessionId = await sessionManager.createSession(senderId, true, additionalData);
        
        logger.api('/createSession', 'Session created', { 
            sessionId: senderId, 
            userId: finalUserId, 
            adminId: finalAdminId 
        });
        
        res.json({
            success: true,
            message: 'Session created successfully',
            data: {
                sessionId: senderId,
                senderId: senderId,
                userId: finalUserId,
                adminId: finalAdminId,
                name: name,
                webhookUrl: webhookUrl,
                status: 'created',
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        logger.error('Error in /createSession', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Failed to create session',
            error: error.message
        });
    }
});

// Get session status
router.get('/sessionStatus/:senderId', async (req, res) => {
    try {
        const { senderId } = req.params;
        const { authToken } = req.query;
        
        // Validate authToken from query parameter
        if (!authToken || authToken !== process.env.AUTH_TOKEN) {
            return res.status(401).json({
                success: false,
                message: 'Authentication failed',
                error: 'Invalid or missing authToken',
                data: {
                    senderId: senderId
                }
            });
        }
        
        // Validate senderId format
        if (!isValidSenderId(senderId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid sender ID format',
                error: 'Invalid senderId format. Must be a valid phone number (8-15 digits, no country code +)',
                data: {
                    senderId: senderId
                }
            });
        }
        
        // Check if session exists in database
        const sessionData = await sessionManager.database.getSession(senderId);
        if (!sessionData) {
            return res.status(404).json({
                success: false,
                message: 'Session not found',
                error: `Session not found for senderId: ${senderId}. Please create session first.`,
                data: {
                    senderId: senderId,
                    suggestion: 'Use POST /api/createSession to create a new session'
                }
            });
        }
        
        const session = await sessionManager.getSessionBySenderId(senderId);
        
        // Get detailed connection info if session exists in memory
        let connectionInfo = null;
        if (session && typeof session.getConnectionInfo === 'function') {
            connectionInfo = session.getConnectionInfo();
        }
        
        res.json({
            success: true,
            message: 'Session status retrieved successfully',
            data: {
                senderId: senderId,
                isConnected: session ? session.isSessionConnected() : false,
                hasQRCode: session ? !!session.getQRCode() : false,
                databaseStatus: sessionData.status,
                createdAt: sessionData.created_at,
                updatedAt: sessionData.updated_at,
                userId: sessionData.user_id,
                adminId: sessionData.admin_id,
                webhookUrl: sessionData.webhook_url,
                webhookStatus: sessionData.webhook_status,
                connectionInfo: connectionInfo
            }
        });
        
    } catch (error) {
        logger.error('Error in /sessionStatus', { error: error.message, senderId: req.params?.senderId });
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve session status',
            error: error.message,
            senderId: req.params?.senderId
        });
    }
});

// Update group message webhook setting
router.post('/updateGroupMessageSetting', validateAuthToken, validateSenderId, checkSessionExists, async (req, res) => {
    try {
        const { 
            senderId, sessionId,                    // Session identifier (with alias support)
            sendGroupMessages, send_group_messages, enabled    // Group message setting (with alias support)
        } = req.body;
        
        // Use aliases if main parameter is not provided
        const finalSenderId = senderId || sessionId;
        let finalSendGroupMessages = sendGroupMessages;
        
        // Handle alias parameters
        if (finalSendGroupMessages === undefined) {
            if (send_group_messages !== undefined) {
                finalSendGroupMessages = send_group_messages;
            } else if (enabled !== undefined) {
                finalSendGroupMessages = enabled;
            }
        }
        
        // Validate that the parameter is provided
        if (finalSendGroupMessages === undefined) {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameter',
                error: 'sendGroupMessages (or send_group_messages/enabled) is required',
                data: {
                    senderId: finalSenderId,
                    acceptedParameters: {
                        sendGroupMessages: 'Boolean - enable/disable group message webhooks',
                        send_group_messages: 'Boolean - alias for sendGroupMessages',
                        enabled: 'Boolean - alias for sendGroupMessages'
                    },
                    examples: {
                        enable: '{ "sendGroupMessages": true }',
                        disable: '{ "sendGroupMessages": false }',
                        usingAlias: '{ "send_group_messages": true }'
                    }
                }
            });
        }
        
        // Convert to boolean
        const updateSendGroupMessages = Boolean(finalSendGroupMessages);
        
        logger.api('/updateGroupMessageSetting', 'Group message setting update requested', { 
            senderId: finalSenderId, 
            sendGroupMessages: updateSendGroupMessages
        });
        
        // Update group message setting
        await sessionManager.database.updateGroupMessageSetting(finalSenderId, updateSendGroupMessages);
        
        res.json({
            success: true,
            message: 'Group message setting updated successfully',
            data: {
                senderId: finalSenderId,
                sendGroupMessages: updateSendGroupMessages,
                groupMessagesEnabled: updateSendGroupMessages,
                timestamp: new Date().toISOString(),
                sessionStatus: req.sessionData.status,
                note: updateSendGroupMessages ? 
                    'Group messages will now be sent to webhooks (if webhook is enabled)' :
                    'Group messages will not be sent to webhooks (private messages still sent)'
            }
        });
        
    } catch (error) {
        logger.error('Error in /updateGroupMessageSetting', { error: error.message, senderId: req.body?.senderId || req.body?.sessionId });
        res.status(500).json({
            success: false,
            message: 'Failed to update group message setting',
            error: error.message,
            senderId: req.body?.senderId || req.body?.sessionId
        });
    }
});

// Update webhook configuration
router.post('/updateWebhook', validateAuthToken, validateSenderId, checkSessionExists, async (req, res) => {
    try {
        const { 
            senderId, sessionId,                    // Session identifier (with alias support)
            webhookUrl, url,                       // Webhook URL (with alias support)
            webhookStatus, status, enabled         // Webhook status (with multiple alias support)
        } = req.body;
        
        // Use aliases if main parameters are not provided
        const finalSenderId = senderId || sessionId;
        const finalWebhookUrl = webhookUrl || url;
        let finalWebhookStatus = webhookStatus;
        
        // Handle multiple status parameter formats
        if (finalWebhookStatus === undefined) {
            if (status !== undefined) {
                finalWebhookStatus = status;
            } else if (enabled !== undefined) {
                finalWebhookStatus = enabled;
            }
        }
        
        // Validate that at least one parameter is provided
        if (finalWebhookUrl === undefined && finalWebhookStatus === undefined) {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameters',
                error: 'At least one of webhookUrl or webhookStatus (or their aliases) is required',
                data: {
                    senderId: finalSenderId,
                    acceptedParameters: {
                        webhookUrl: 'String - webhook URL (alias: url)',
                        webhookStatus: 'Boolean - enable/disable webhook (aliases: status, enabled)'
                    },
                    examples: {
                        updateUrlOnly: '{ "webhookUrl": "https://example.com/webhook" }',
                        updateStatusOnly: '{ "webhookStatus": true }',
                        updateBoth: '{ "webhookUrl": "https://example.com/webhook", "webhookStatus": true }'
                    }
                }
            });
        }
        
        // Get current session data to preserve existing values
        const currentSession = await sessionManager.database.getSession(finalSenderId);
        if (!currentSession) {
            return res.status(404).json({
                success: false,
                message: 'Session not found',
                error: `Session not found for senderId: ${finalSenderId}`,
                data: { senderId: finalSenderId }
            });
        }
        
        // Determine final values (use provided values or keep existing ones)
        const updateWebhookUrl = finalWebhookUrl !== undefined ? finalWebhookUrl : currentSession.webhook_url;
        const updateWebhookStatus = finalWebhookStatus !== undefined ? Boolean(finalWebhookStatus) : currentSession.webhook_status;
        
        // Validate webhook URL format if provided
        if (finalWebhookUrl !== undefined && finalWebhookUrl !== null) {
            if (typeof finalWebhookUrl !== 'string' || finalWebhookUrl.trim() === '') {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid webhook URL format',
                    error: 'webhookUrl must be a non-empty string',
                    data: {
                        senderId: finalSenderId,
                        provided: finalWebhookUrl,
                        type: typeof finalWebhookUrl
                    }
                });
            }
            
            try {
                new URL(finalWebhookUrl);
            } catch (urlError) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid webhook URL format',
                    error: 'webhookUrl must be a valid HTTP/HTTPS URL',
                    data: {
                        senderId: finalSenderId,
                        webhookUrl: finalWebhookUrl,
                        expectedFormat: 'https://your-domain.com/webhook'
                    }
                });
            }
        }
        
        logger.api('/updateWebhook', 'Webhook configuration update requested', { 
            senderId: finalSenderId, 
            webhookUrl: updateWebhookUrl,
            webhookStatus: updateWebhookStatus,
            fieldsUpdated: {
                url: finalWebhookUrl !== undefined,
                status: finalWebhookStatus !== undefined
            }
        });
        
        // Update webhook configuration
        await sessionManager.updateWebhookConfig(finalSenderId, updateWebhookUrl, updateWebhookStatus);
        
        res.json({
            success: true,
            message: 'Webhook configuration updated successfully',
            data: {
                senderId: finalSenderId,
                webhookUrl: updateWebhookUrl,
                webhookStatus: updateWebhookStatus,
                webhookEnabled: Boolean(updateWebhookStatus),
                isActive: Boolean(updateWebhookStatus) && !!updateWebhookUrl,
                timestamp: new Date().toISOString(),
                sessionStatus: req.sessionData.status,
                updated: {
                    url: finalWebhookUrl !== undefined,
                    status: finalWebhookStatus !== undefined
                }
            }
        });
        
    } catch (error) {
        logger.error('Error in /updateWebhook', { error: error.message, senderId: req.body?.senderId || req.body?.sessionId });
        res.status(500).json({
            success: false,
            message: 'Failed to update webhook configuration',
            error: error.message,
            senderId: req.body?.senderId || req.body?.sessionId
        });
    }
});

// Test webhook
router.post('/testWebhook', validateAuthToken, async (req, res) => {
    try {
        const { senderId, webhookUrl } = req.body;
        
        if (!senderId || !webhookUrl) {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameters',
                error: 'senderId and webhookUrl are required'
            });
        }
        
        const result = await sessionManager.testWebhook(senderId, webhookUrl);
        
        res.json({
            success: true,
            message: 'Webhook test completed',
            data: {
                senderId: senderId,
                webhookTest: result
            }
        });
        
    } catch (error) {
        logger.error('Error in /testWebhook', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Failed to test webhook',
            error: error.message
        });
    }
});

// Enhanced webhook diagnostics
router.post('/webhookDiagnostics', validateAuthToken, async (req, res) => {
    try {
        const { senderId, webhookUrl } = req.body;
        
        if (!senderId || !webhookUrl) {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameters',
                error: 'senderId and webhookUrl are required',
                required: {
                    senderId: 'string',
                    webhookUrl: 'string (HTTP/HTTPS URL)'
                }
            });
        }

        logger.api('/webhookDiagnostics', 'Webhook diagnostics requested', { senderId, webhookUrl });

        // Step 1: Validate URL format
        const urlValidation = sessionManager.webhookManager.validateWebhookUrl(webhookUrl);
        
        // Step 2: Test basic connectivity
        const connectionTest = await sessionManager.webhookManager.testConnection(webhookUrl);
        
        // Step 3: Full webhook test
        const webhookTest = await sessionManager.testWebhook(senderId, webhookUrl);
        
        // Step 4: Environment and network info
        const environmentInfo = {
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            timeout: sessionManager.webhookManager.timeout,
            retryAttempts: sessionManager.webhookManager.retryAttempts,
            maxRedirects: sessionManager.webhookManager.maxRedirects,
            keepAlive: sessionManager.webhookManager.keepAlive,
            userAgent: 'WhatsApp-API-Baileys/1.0.0',
            tlsRejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== 'false',
            proxy: process.env.HTTP_PROXY || 'none'
        };

        // Step 5: DNS resolution test
        let dnsTest = { success: false, error: 'Not tested' };
        try {
            const dns = require('dns').promises;
            const url = new URL(webhookUrl);
            const addresses = await dns.resolve(url.hostname);
            dnsTest = {
                success: true,
                hostname: url.hostname,
                addresses: addresses,
                resolvedCount: addresses.length
            };
        } catch (dnsError) {
            dnsTest = {
                success: false,
                hostname: new URL(webhookUrl).hostname,
                error: dnsError.message,
                errorType: 'DNS_RESOLUTION_FAILED'
            };
        }

        const diagnostics = {
            summary: {
                urlValid: urlValidation.isValid,
                dnsResolvable: dnsTest.success,
                connectionWorking: connectionTest.connectionWorking,
                webhookWorking: webhookTest.success,
                overallStatus: urlValidation.isValid && dnsTest.success && connectionTest.connectionWorking && webhookTest.success ? 'HEALTHY' : 'ISSUES_DETECTED'
            },
            urlValidation,
            dnsTest,
            connectionTest,
            webhookTest,
            environmentInfo,
            troubleshooting: {
                commonIssues: [
                    'Firewall blocking outbound connections',
                    'Webhook server not accepting requests',
                    'SSL/TLS certificate issues',
                    'Network timeout issues',
                    'Rate limiting on webhook server',
                    'Authentication required but not provided'
                ],
                suggestions: [
                    !urlValidation.isValid && 'Fix webhook URL format',
                    !dnsTest.success && 'Check domain name and DNS configuration',
                    !connectionTest.connectionWorking && 'Verify webhook server is running and accessible',
                    !webhookTest.success && 'Check webhook server logs for request handling issues'
                ].filter(Boolean)
            }
        };

        res.json({
            success: true,
            message: 'Webhook diagnostics completed',
            data: {
                senderId,
                webhookUrl,
                timestamp: new Date().toISOString(),
                diagnostics
            }
        });
        
    } catch (error) {
        logger.error('Error in /webhookDiagnostics', { error: error.message, senderId: req.body?.senderId });
        res.status(500).json({
            success: false,
            message: 'Failed to run webhook diagnostics',
            error: error.message,
            senderId: req.body?.senderId
        });
    }
});

// Quick webhook connectivity test
router.post('/testWebhookConnection', validateAuthToken, async (req, res) => {
    try {
        const { webhookUrl } = req.body;
        
        if (!webhookUrl) {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameter',
                error: 'webhookUrl is required'
            });
        }

        logger.api('/testWebhookConnection', 'Webhook connection test requested', { webhookUrl });

        const connectionTest = await sessionManager.webhookManager.testConnection(webhookUrl);
        
        res.json({
            success: connectionTest.success,
            message: connectionTest.success ? 'Webhook endpoint is reachable' : 'Webhook endpoint is not reachable',
            data: {
                webhookUrl,
                connectionTest,
                recommendation: connectionTest.success ? 
                    'Connection successful. Try full webhook test with /api/testWebhook' :
                    'Connection failed. Check if webhook server is running and accessible'
            }
        });
        
    } catch (error) {
        logger.error('Error in /testWebhookConnection', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Failed to test webhook connection',
            error: error.message
        });
    }
});

// Webhook payload comparison for debugging WhatsApp Business vs Regular WhatsApp
router.post('/compareWebhookPayloads', validateAuthToken, async (req, res) => {
    try {
        const { senderId, webhookUrl, testBoth = true } = req.body;
        
        if (!senderId || !webhookUrl) {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameters',
                error: 'senderId and webhookUrl are required'
            });
        }

        logger.api('/compareWebhookPayloads', 'Webhook payload comparison requested', { senderId, webhookUrl });

        // Create test payloads for both WhatsApp types
        const regularWhatsAppPayload = {
            sessionId: senderId,
            messageId: 'test_regular_' + Date.now(),
            remoteJid: '919876543210@s.whatsapp.net',
            fromMe: false,
            timestamp: Date.now(),
            message: {
                type: 'text',
                content: 'Test message from Regular WhatsApp'
            },
            participant: null,
            pushName: 'Test User Regular',
            appType: 'Regular WhatsApp',
            deviceInfo: {},
            messageMetadata: {
                verifiedBizName: null,
                bizPrivacyStatus: null,
                messageStubType: null,
                messageStubParameters: null,
                quotedMessage: false,
                mentions: []
            },
            testInfo: {
                payloadType: 'Regular WhatsApp Simulation',
                testTimestamp: new Date().toISOString()
            }
        };

        const businessWhatsAppPayload = {
            sessionId: senderId,
            messageId: 'test_business_' + Date.now(),
            remoteJid: '919876543210@s.whatsapp.net',
            fromMe: false,
            timestamp: Date.now(),
            message: {
                type: 'text',
                content: 'Test message from WhatsApp Business'
            },
            participant: null,
            pushName: 'Test Business User',
            appType: 'WhatsApp Business',
            deviceInfo: {
                deviceSentMeta: {
                    platform: 'android',
                    version: '2.23.20.0'
                }
            },
            messageMetadata: {
                verifiedBizName: 'Test Business',
                bizPrivacyStatus: 'verified',
                messageStubType: null,
                messageStubParameters: null,
                quotedMessage: false,
                mentions: []
            },
            testInfo: {
                payloadType: 'WhatsApp Business Simulation',
                testTimestamp: new Date().toISOString()
            }
        };

        const results = [];

        // Test Regular WhatsApp payload
        console.log('\n🔍 TESTING REGULAR WHATSAPP PAYLOAD');
        console.log('═══════════════════════════════════════════');
        console.log(JSON.stringify(regularWhatsAppPayload, null, 2));

        try {
            const regularResult = await sessionManager.webhookManager.sendWebhook(webhookUrl, 'test_user', regularWhatsAppPayload);
            results.push({
                type: 'Regular WhatsApp',
                success: true,
                result: regularResult,
                payload: regularWhatsAppPayload
            });
            console.log('✅ Regular WhatsApp webhook SUCCESS');
        } catch (regularError) {
            results.push({
                type: 'Regular WhatsApp',
                success: false,
                error: regularError,
                payload: regularWhatsAppPayload
            });
            console.log('❌ Regular WhatsApp webhook FAILED:', regularError.message);
        }

        if (testBoth) {
            // Test WhatsApp Business payload
            console.log('\n🏢 TESTING WHATSAPP BUSINESS PAYLOAD');
            console.log('═══════════════════════════════════════════');
            console.log(JSON.stringify(businessWhatsAppPayload, null, 2));

            try {
                const businessResult = await sessionManager.webhookManager.sendWebhook(webhookUrl, 'test_user', businessWhatsAppPayload);
                results.push({
                    type: 'WhatsApp Business',
                    success: true,
                    result: businessResult,
                    payload: businessWhatsAppPayload
                });
                console.log('✅ WhatsApp Business webhook SUCCESS');
            } catch (businessError) {
                results.push({
                    type: 'WhatsApp Business',
                    success: false,
                    error: businessError,
                    payload: businessWhatsAppPayload
                });
                console.log('❌ WhatsApp Business webhook FAILED:', businessError.message);
            }
        }

        // Compare results
        const comparison = {
            regularWhatsApp: results.find(r => r.type === 'Regular WhatsApp'),
            whatsappBusiness: results.find(r => r.type === 'WhatsApp Business'),
            analysis: {
                bothSuccessful: results.every(r => r.success),
                bothFailed: results.every(r => !r.success),
                differentResults: results.length > 1 && results[0].success !== results[1].success,
                payloadDifferences: {
                    appType: 'Different appType field',
                    deviceInfo: 'Business has more device information',
                    verifiedBizName: 'Business has verified business name',
                    bizPrivacyStatus: 'Business has privacy status'
                }
            }
        };

        console.log('\n📊 COMPARISON RESULTS:');
        console.log('═══════════════════════════════════════════');
        console.log('Regular WhatsApp Success:', comparison.regularWhatsApp?.success);
        console.log('WhatsApp Business Success:', comparison.whatsappBusiness?.success);
        console.log('Different Results:', comparison.analysis.differentResults);

        res.json({
            success: true,
            message: 'Webhook payload comparison completed',
            data: {
                senderId,
                webhookUrl,
                timestamp: new Date().toISOString(),
                comparison,
                recommendations: [
                    comparison.analysis.differentResults && 'Check webhook server logs for differences in payload handling',
                    !comparison.analysis.bothSuccessful && 'Check webhook server configuration and error logs',
                    'Compare the payload structures and server response handling',
                    'Verify if webhook server expects specific fields for WhatsApp Business vs Regular WhatsApp'
                ].filter(Boolean)
            }
        });
        
    } catch (error) {
        logger.error('Error in /compareWebhookPayloads', { error: error.message, senderId: req.body?.senderId });
        res.status(500).json({
            success: false,
            message: 'Failed to compare webhook payloads',
            error: error.message,
            senderId: req.body?.senderId
        });
    }
});

// Get system stats
router.get('/stats', (req, res) => {
    try {
        const stats = sessionManager.getSessionStats();
        
        res.json({
            success: true,
            message: 'System stats retrieved successfully',
            data: stats
        });
        
    } catch (error) {
        logger.error('Error in /stats', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve system stats',
            error: error.message
        });
    }
});

// Display QR in terminal only (convenience endpoint)
router.post('/displayQR', validateAuthToken, validateSenderId, async (req, res) => {
    try {
        const { senderId } = req.body;
        
        logger.api('/displayQR', 'Terminal QR display requested', { senderId });
        
        // Use the new API-specific method
        const qrString = await sessionManager.getQRStringForAPI(senderId);
        
        if (!qrString) {
            return res.status(404).json({
                success: false,
                message: 'QR code not available',
                error: 'QR code not available. Session might already be connected or still initializing.',
                data: {
                    senderId: senderId,
                    suggestion: 'Try calling /api/getQRCode first or check session status'
                }
            });
        }

        // QR code is already displayed in terminal by the BaileysSession
        // No need for additional terminal display here
        
        res.json({
            success: true,
            message: 'QR code displayed in terminal successfully',
            data: {
                senderId: senderId,
                expiresIn: '~20 seconds',
                note: 'QR code has been displayed in the terminal above'
            }
        });
        
    } catch (error) {
        logger.error('Error in /displayQR', { error: error.message, senderId: req.body?.senderId });
        res.status(500).json({
            success: false,
            message: 'Failed to display QR code',
            error: error.message,
            senderId: req.body?.senderId
        });
    }
});

// Validate WhatsApp number endpoint
router.post('/validateNumber', validateAuthToken, validateSenderId, checkSessionExists, async (req, res) => {
    try {
        const { 
            senderId, sessionId,           // sessionId as alias for senderId
            phoneNumber, receiverId, number // Multiple parameter aliases for the number to validate
        } = req.body;
        
        // Use aliases if main parameters are not provided
        const finalSenderId = senderId || sessionId;
        const finalPhoneNumber = phoneNumber || receiverId || number;
        
        if (!finalPhoneNumber) {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameters',
                error: 'phoneNumber (or receiverId/number) is required',
                data: {
                    senderId: finalSenderId,
                    received: {
                        phoneNumber: !!finalPhoneNumber
                    }
                }
            });
        }
        
        logger.api('/validateNumber', 'Number validation requested', { 
            senderId: finalSenderId, 
            phoneNumber: finalPhoneNumber 
        });
        
        const session = await sessionManager.getSessionBySenderId(finalSenderId);
        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found or not connected',
                error: 'Session not found or not connected',
                data: {
                    senderId: finalSenderId
                }
            });
        }
        
        const validation = await session.isNumberRegisteredOnWhatsApp(finalPhoneNumber);
        
        res.json({
            success: true,
            message: validation.isRegistered ? 'Number is registered on WhatsApp' : 'Number is not registered on WhatsApp',
            data: {
                senderId: finalSenderId,
                phoneNumber: finalPhoneNumber,
                formattedJID: validation.jid,
                isRegistered: validation.isRegistered,
                isGroup: validation.isGroup,
                validationFailed: validation.validationFailed || false,
                error: validation.error || null,
                sessionStatus: req.sessionData.status
            }
        });
        
    } catch (error) {
        logger.error('Error in /validateNumber', { error: error.message, senderId: req.body?.senderId || req.body?.sessionId });
        res.status(500).json({
            success: false,
            message: 'Failed to validate WhatsApp number',
            error: error.message,
            senderId: req.body?.senderId || req.body?.sessionId
        });
    }
});

// Logout session endpoint
router.post('/logoutSession', validateAuthToken, validateSenderId, checkSessionExists, async (req, res) => {
    try {
        const { senderId, sessionId } = req.body;
        
        // Use alias if main parameter is not provided
        const finalSenderId = senderId || sessionId;
        
        logger.api('/logoutSession', 'Session logout requested', { senderId: finalSenderId });
        
        // Check if session is active in memory
        const activeSession = await sessionManager.getSessionBySenderId(finalSenderId);
        
        if (activeSession) {
            // Session is active in memory, perform proper logout
            await sessionManager.logoutSession(finalSenderId);
        } else {
            // Session exists in database but not in memory, just update status
            await sessionManager.database.updateSessionStatus(finalSenderId, 'logged_out');
            logger.info('Session marked as logged out (was not active)', { sessionId: finalSenderId });
        }

        // ENHANCED: Delete both authentication files AND backup files after successful logout
        try {
            const sessionDir = path.join(process.env.SESSION_STORAGE_PATH || './sessions', finalSenderId);
            const authDir = path.join(sessionDir, 'auth');
            const backupDir = path.join(sessionDir, 'backup');
            
            let deletedAuthFiles = [];
            let deletedBackupFiles = [];
            
            // Delete all authentication files
            if (fs.existsSync(authDir)) {
                // Get list of files before deletion for logging
                deletedAuthFiles = fs.readdirSync(authDir);
                
                // Delete all authentication files
                fs.rmSync(authDir, { recursive: true, force: true });
                
                // Recreate empty auth directory
                fs.mkdirSync(authDir, { recursive: true });
                
                logger.info('Authentication files deleted after logout', { 
                    sessionId: finalSenderId,
                    deletedFiles: deletedAuthFiles,
                    authDir: authDir
                });
            }
            
            // CRITICAL FIX: Delete all backup files to prevent restoration interference
            if (fs.existsSync(backupDir)) {
                // Get list of backup files/directories before deletion for logging
                const backupContents = fs.readdirSync(backupDir);
                deletedBackupFiles = backupContents;
                
                // Delete entire backup directory
                fs.rmSync(backupDir, { recursive: true, force: true });
                
                // Recreate empty backup directory
                fs.mkdirSync(backupDir, { recursive: true });
                
                logger.info('Backup files deleted after logout', { 
                    sessionId: finalSenderId,
                    deletedBackups: deletedBackupFiles,
                    backupDir: backupDir
                });
            }
            
            console.log(`🗑️ LOGOUT: Session cleanup completed for ${finalSenderId}`);
            console.log(`📁 Auth files deleted: ${deletedAuthFiles.length} files (${deletedAuthFiles.join(', ')})`);
            console.log(`💾 Backup files deleted: ${deletedBackupFiles.length} items (${deletedBackupFiles.join(', ')})`);
            console.log(`✅ Fresh QR code generation ready - no interference from old backups`);
            
        } catch (deleteError) {
            // Log the error but don't fail the logout operation
            logger.error('Error deleting authentication/backup files after logout', { 
                sessionId: finalSenderId, 
                error: deleteError.message 
            });
            console.log(`❌ Warning: Could not delete files for session ${finalSenderId}: ${deleteError.message}`);
        }
        
        res.json({
            success: true,
            message: 'Session logged out successfully - all authentication and backup files cleared',
            data: {
                senderId: finalSenderId,
                status: 'logged_out',
                authFilesCleared: true,
                backupFilesCleared: true,
                timestamp: new Date().toISOString(),
                note: 'Fresh QR code scan will be required for next connection - no backup restoration interference'
            }
        });
        
    } catch (error) {
        logger.error('Error in /logoutSession', { error: error.message, senderId: req.body?.senderId || req.body?.sessionId });
        res.status(500).json({
            success: false,
            message: 'Failed to logout session',
            error: error.message,
            senderId: req.body?.senderId || req.body?.sessionId
        });
    }
});

// Delete session endpoint (removes from database and deletes session folder)
router.post('/deleteSession', validateAuthToken, validateSenderId, async (req, res) => {
    try {
        const { senderId, sessionId } = req.body;
        
        // Use alias if main parameter is not provided
        const finalSenderId = senderId || sessionId;
        
        // Check if session exists in database (don't require active session)
        const sessionData = await sessionManager.database.getSession(finalSenderId);
        if (!sessionData) {
            return res.status(404).json({
                success: false,
                message: 'Session not found',
                error: `Session not found for senderId: ${finalSenderId}`,
                data: {
                    senderId: finalSenderId
                }
            });
        }
        
        logger.api('/deleteSession', 'Session deletion requested', { senderId: finalSenderId });
        
        await sessionManager.deleteSession(finalSenderId);
        
        res.json({
            success: true,
            message: 'Session deleted successfully',
            data: {
                senderId: finalSenderId,
                status: 'deleted',
                timestamp: new Date().toISOString(),
                note: 'Session removed from database and session folder deleted'
            }
        });
        
    } catch (error) {
        logger.error('Error in /deleteSession', { error: error.message, senderId: req.body?.senderId || req.body?.sessionId });
        res.status(500).json({
            success: false,
            message: 'Failed to delete session',
            error: error.message,
            senderId: req.body?.senderId || req.body?.sessionId
        });
    }
});

// Manual session refresh endpoint
router.post('/refreshSession', validateAuthToken, validateSenderId, checkSessionExists, async (req, res) => {
    try {
        const { senderId, sessionId } = req.body;
        
        // Use alias if main parameter is not provided
        const finalSenderId = senderId || sessionId;
        
        logger.api('/refreshSession', 'Manual session refresh requested', { senderId: finalSenderId });
        
        // Force session reconnection
        await sessionManager.autoReconnectSession(finalSenderId);
        
        const refreshedSession = await sessionManager.getSessionBySenderId(finalSenderId);
        
        res.json({
            success: true,
            message: 'Session refreshed successfully',
            data: {
                senderId: finalSenderId,
                isConnected: refreshedSession ? refreshedSession.isSessionConnected() : false,
                status: 'refreshed',
                timestamp: new Date().toISOString(),
                sessionStatus: req.sessionData.status
            }
        });
        
    } catch (error) {
        logger.error('Error in /refreshSession', { error: error.message, senderId: req.body?.senderId || req.body?.sessionId });
        res.status(500).json({
            success: false,
            message: 'Failed to refresh session',
            error: error.message,
            senderId: req.body?.senderId || req.body?.sessionId
        });
    }
});

// Session health check endpoint
router.post('/checkSessionHealth', validateAuthToken, validateSenderId, async (req, res) => {
    try {
        const { senderId, sessionId } = req.body;
        
        // Use alias if main parameter is not provided
        const finalSenderId = senderId || sessionId;
        
        logger.api('/checkSessionHealth', 'Session health check requested', { senderId: finalSenderId });
        
        const session = await sessionManager.getSessionBySenderId(finalSenderId);
        const sessionData = await sessionManager.database.getSession(finalSenderId);
        
        if (!sessionData) {
            return res.status(404).json({
                success: false,
                message: 'Session not found',
                error: `Session not found for senderId: ${finalSenderId}`,
                data: { senderId: finalSenderId }
            });
        }
        
        let healthStatus = 'unknown';
        let isConnected = false;
        let isResponsive = false;
        
        if (session) {
            isConnected = session.isSessionConnected();
            isResponsive = await sessionManager.checkSessionResponsiveness(session);
            
            if (isConnected && isResponsive) {
                healthStatus = 'healthy';
            } else if (isConnected && !isResponsive) {
                healthStatus = 'unresponsive';
            } else {
                healthStatus = 'disconnected';
            }
        } else {
            healthStatus = 'not_in_memory';
        }
        
        res.json({
            success: true,
            message: 'Session health check completed',
            data: {
                senderId: finalSenderId,
                healthStatus: healthStatus,
                isConnected: isConnected,
                isResponsive: isResponsive,
                inMemory: !!session,
                databaseStatus: sessionData.status,
                lastUpdated: sessionData.updated_at,
                autoRefreshEnabled: sessionManager.autoRefreshEnabled,
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        logger.error('Error in /checkSessionHealth', { error: error.message, senderId: req.body?.senderId || req.body?.sessionId });
        res.status(500).json({
            success: false,
            message: 'Failed to check session health',
            error: error.message,
            senderId: req.body?.senderId || req.body?.sessionId
        });
    }
});

// Trigger global health check endpoint
router.post('/triggerHealthCheck', validateAuthToken, async (req, res) => {
    try {
        logger.api('/triggerHealthCheck', 'Global health check triggered manually');
        
        // Trigger immediate health check
        await sessionManager.performSessionHealthCheck();
        
        const stats = sessionManager.getSessionStats();
        
        res.json({
            success: true,
            message: 'Global health check completed',
            data: {
                timestamp: new Date().toISOString(),
                sessionStats: stats,
                autoRefreshEnabled: sessionManager.autoRefreshEnabled,
                healthCheckInterval: sessionManager.sessionHealthCheckInterval / 1000 + 's'
            }
        });
        
    } catch (error) {
        logger.error('Error in /triggerHealthCheck', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Failed to trigger health check',
            error: error.message
        });
    }
});

// Get sessions by user ID
router.get('/sessions/user/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { authToken } = req.query;
        
        // Validate authToken from query parameter
        if (!authToken || authToken !== process.env.AUTH_TOKEN) {
            return res.status(401).json({
                success: false,
                message: 'Authentication failed',
                error: 'Invalid or missing authToken',
                data: {
                    userId: userId
                }
            });
        }
        
        // Validate userId format (should be a non-empty string)
        if (!userId || typeof userId !== 'string' || userId.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Invalid user ID format',
                error: 'userId must be a non-empty string',
                data: {
                    userId: userId
                }
            });
        }
        
        logger.api('/sessions/user/:userId', 'Sessions requested for user', { userId });
        
        // Get sessions for the user
        const sessions = await sessionManager.getSessionsByUserId(userId);
        
        // Prepare response data with enhanced information
        const responseData = sessions.map(session => ({
            sessionId: session.session_id,
            senderId: session.session_id,
            name: session.name,
            status: session.status,
            userId: session.user_id,
            adminId: session.admin_id,
            webhookUrl: session.webhook_url,
            webhookStatus: session.webhook_status,
            autoRead: session.auto_read,
            sendGroupMessages: session.send_group_messages,
            createdAt: session.created_at,
            updatedAt: session.updated_at,
            // Runtime status from active sessions
            isConnected: session.isConnected,
            hasQRCode: session.hasQRCode,
            inMemory: session.inMemory
        }));
        
        res.json({
            success: true,
            message: `Sessions retrieved successfully for user_id ${userId}`,
            data: {
                userId: userId,
                sessions: responseData,
                count: responseData.length,
                statistics: {
                    total: responseData.length,
                    connected: responseData.filter(s => s.isConnected).length,
                    disconnected: responseData.filter(s => !s.isConnected).length,
                    withQRCode: responseData.filter(s => s.hasQRCode).length,
                    inMemory: responseData.filter(s => s.inMemory).length
                },
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        logger.error('Error in /sessions/user/:userId', { error: error.message, userId: req.params?.userId });
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve user sessions',
            error: error.message,
            userId: req.params?.userId
        });
    }
});

// New endpoint for detailed connection diagnostics
router.post('/sessionDiagnostics', validateAuthToken, validateSenderId, async (req, res) => {
    try {
        const { senderId } = req.body;
        
        logger.api('/sessionDiagnostics', 'Session diagnostics requested', { senderId });
        
        // Check if session exists in database
        const sessionData = await sessionManager.database.getSession(senderId);
        if (!sessionData) {
            return res.status(404).json({
                success: false,
                message: 'Session not found',
                error: `Session not found for senderId: ${senderId}. Please create session first.`,
                data: {
                    senderId: senderId,
                    suggestion: 'Use POST /api/createSession to create a new session'
                }
            });
        }
        
        const session = await sessionManager.getSessionBySenderId(senderId);
        
        // Collect diagnostic information
        const diagnostics = {
            senderId: senderId,
            sessionInMemory: !!session,
            databaseInfo: {
                exists: !!sessionData,
                status: sessionData?.status,
                userId: sessionData?.user_id,
                adminId: sessionData?.admin_id,
                createdAt: sessionData?.created_at,
                updatedAt: sessionData?.updated_at
            }
        };
        
        if (session) {
            diagnostics.sessionInfo = {
                isConnected: session.isSessionConnected(),
                hasQRCode: !!session.getQRCode(),
                qrString: !!session.getQRString(),
                connectionInfo: session.getConnectionInfo ? session.getConnectionInfo() : null
            };
            
            // Check session directory
            const fs = require('fs');
            const path = require('path');
            const sessionPath = path.join(process.env.SESSION_STORAGE_PATH || './sessions', senderId);
            const authPath = path.join(sessionPath, 'auth');
            
            diagnostics.filesystem = {
                sessionDirExists: fs.existsSync(sessionPath),
                authDirExists: fs.existsSync(authPath),
                authFiles: []
            };
            
            try {
                if (fs.existsSync(authPath)) {
                    diagnostics.filesystem.authFiles = fs.readdirSync(authPath);
                }
            } catch (fsError) {
                diagnostics.filesystem.error = fsError.message;
            }
        }
        
        res.json({
            success: true,
            message: 'Session diagnostics completed',
            data: diagnostics
        });
        
    } catch (error) {
        logger.error('Error in /sessionDiagnostics', { error: error.message, senderId: req.body?.senderId });
        res.status(500).json({
            success: false,
            message: 'Failed to get session diagnostics',
            error: error.message,
            senderId: req.body?.senderId
        });
    }
});

// Debug unknown message types
router.post('/debugUnknownMessages', validateAuthToken, validateSenderId, checkSessionExists, async (req, res) => {
    try {
        const { senderId, enableDetailedLogging = true } = req.body;
        
        logger.api('/debugUnknownMessages', 'Unknown message debugging requested', { senderId, enableDetailedLogging });
        
        const session = await sessionManager.getSessionBySenderId(senderId);
        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found',
                error: 'Session not found or not active',
                senderId
            });
        }

        // Enable detailed logging for unknown messages
        session.debugUnknownMessages = enableDetailedLogging;
        
        console.log(`🔍 UNKNOWN MESSAGE DEBUGGING ${enableDetailedLogging ? 'ENABLED' : 'DISABLED'} for session ${senderId}`);
        console.log('═══════════════════════════════════════════════════════════════════');
        
        if (enableDetailedLogging) {
            console.log('📋 Next unknown messages will show detailed structure');
            console.log('📊 Look for messages like: "🔍 [SessionID] DEBUG - Unknown message type(s): ..."');
            console.log('💡 Send some messages to this WhatsApp number to see what message types are being received');
        }

        res.json({
            success: true,
            message: `Unknown message debugging ${enableDetailedLogging ? 'enabled' : 'disabled'} successfully`,
            data: {
                senderId,
                debugEnabled: enableDetailedLogging,
                timestamp: new Date().toISOString(),
                instructions: [
                    'Send various message types to this WhatsApp number',
                    'Check console logs for "🔍 DEBUG - Unknown message type(s)" messages',
                    'Look for detailed message structure information in the logs',
                    'Common unknown types: stickers, reactions, locations, buttons, lists, protocols'
                ],
                supportedTypes: [
                    'text (conversation, extendedTextMessage)',
                    'image', 'video', 'audio', 'document', 'contact',
                    'location', 'sticker', 'reaction', 'list', 'buttons', 
                    'template', 'protocol', 'ephemeral', 'view_once'
                ]
            }
        });
        
    } catch (error) {
        logger.error('Error in /debugUnknownMessages', { error: error.message, senderId: req.body?.senderId });
        res.status(500).json({
            success: false,
            message: 'Failed to enable unknown message debugging',
            error: error.message,
            senderId: req.body?.senderId
        });
    }
});

// Test app type detection for WhatsApp Business vs Regular WhatsApp
router.post('/testAppTypeDetection', validateAuthToken, async (req, res) => {
    try {
        const { senderId } = req.body;
        
        if (!senderId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameter',
                error: 'senderId is required'
            });
        }

        logger.api('/testAppTypeDetection', 'App type detection test requested', { senderId });

        // Get the session to test message handling
        const session = await sessionManager.getSessionBySenderId(senderId);
        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found',
                error: 'Session not found or not active',
                senderId
            });
        }

        console.log('\n🧪 TESTING APP TYPE DETECTION');
        console.log('════════════════════════════════════════════════════════════════════');

        // Test 1: Regular WhatsApp message simulation
        const regularMessage = {
            key: {
                id: 'test_regular_' + Date.now(),
                remoteJid: '919876543210@s.whatsapp.net',
                fromMe: false
            },
            messageTimestamp: Math.floor(Date.now() / 1000),
            pushName: 'Regular User',
            message: {
                conversation: 'Test message from regular WhatsApp'
            }
            // No verifiedBizName, bizPrivacyStatus, deviceSentMeta fields
        };

        // Test 2: WhatsApp Business message simulation (verified)
        const businessVerifiedMessage = {
            key: {
                id: 'test_business_verified_' + Date.now(),
                remoteJid: '919876543211@s.whatsapp.net',
                fromMe: false
            },
            messageTimestamp: Math.floor(Date.now() / 1000),
            pushName: 'Business User',
            verifiedBizName: 'Test Business',
            message: {
                conversation: 'Test message from verified WhatsApp Business'
            }
        };

        // Test 3: WhatsApp Business message simulation (unverified)
        const businessUnverifiedMessage = {
            key: {
                id: 'test_business_unverified_' + Date.now(),
                remoteJid: '919876543212@s.whatsapp.net',
                fromMe: false
            },
            messageTimestamp: Math.floor(Date.now() / 1000),
            pushName: 'Business User 2',
            bizPrivacyStatus: 'unverified',
            message: {
                conversation: 'Test message from unverified WhatsApp Business'
            }
        };

        const testResults = [];

        // Test Regular WhatsApp detection
        console.log('\n📱 TESTING: Regular WhatsApp Message');
        console.log('Expected: Regular WhatsApp');
        await session.handleIncomingMessage(regularMessage);
        testResults.push({
            type: 'Regular WhatsApp',
            message: regularMessage,
            tested: true
        });

        console.log('\n🏢 TESTING: WhatsApp Business (Verified) Message');
        console.log('Expected: WhatsApp Business (Verified)');
        await session.handleIncomingMessage(businessVerifiedMessage);
        testResults.push({
            type: 'WhatsApp Business (Verified)',
            message: businessVerifiedMessage,
            tested: true
        });

        console.log('\n🏢 TESTING: WhatsApp Business (Unverified) Message');
        console.log('Expected: WhatsApp Business');
        await session.handleIncomingMessage(businessUnverifiedMessage);
        testResults.push({
            type: 'WhatsApp Business (Unverified)',
            message: businessUnverifiedMessage,
            tested: true
        });

        console.log('\n✅ APP TYPE DETECTION TESTS COMPLETED');
        console.log('════════════════════════════════════════════════════════════════════');

        res.json({
            success: true,
            message: 'App type detection tests completed successfully',
            data: {
                senderId,
                timestamp: new Date().toISOString(),
                testsRun: testResults.length,
                testResults,
                instructions: [
                    'Check the console logs above to see the detailed app type detection process',
                    'Each test message should show the correct app type detection',
                    'Regular WhatsApp messages should not have verifiedBizName or bizPrivacyStatus fields',
                    'WhatsApp Business messages should have these business-specific fields'
                ]
            }
        });
        
    } catch (error) {
        logger.error('Error in /testAppTypeDetection', { error: error.message, senderId: req.body?.senderId });
        res.status(500).json({
            success: false,
            message: 'Failed to test app type detection',
            error: error.message,
            senderId: req.body?.senderId
        });
    }
});

// Session migration endpoint - Upload credential files for existing sessions no need to validate auth token
router.post('/migrateSession', upload.array('credFiles'), async (req, res) => {
    try {
        const { senderId, sessionId, restartSession = true, overwriteExisting = false } = req.body;
        const files = req.files;
        
        // Use alias if main parameter is not provided
        const finalSenderId = senderId || sessionId;
        
        if (!finalSenderId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameter',
                error: 'senderId (or sessionId) is required'
            });
        }
        
        if (!files || files.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Missing credential files',
                error: 'At least one credential file is required'
            });
        }
        
        // Validate senderId format
        if (!isValidSenderId(finalSenderId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid sender ID format',
                error: 'Invalid senderId format. Must be a valid phone number (8-15 digits, no country code +)'
            });
        }
        
        logger.api('/migrateSession', 'Session migration requested', { 
            senderId: finalSenderId, 
            fileCount: files.length,
            fileNames: files.map(f => f.originalname)
        });
        
        // Create session directory structure
        const sessionDir = path.join(process.env.SESSION_STORAGE_PATH || './sessions', finalSenderId);
        const authDir = path.join(sessionDir, 'auth');
        
        // Ensure directories exist
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }
        if (!fs.existsSync(authDir)) {
            fs.mkdirSync(authDir, { recursive: true });
        }
        
        // Check if session already exists
        const existingSession = await sessionManager.database.getSession(finalSenderId);
        if (existingSession && !overwriteExisting) {
            // Check if auth files already exist
            const existingFiles = fs.readdirSync(authDir);
            if (existingFiles.length > 0) {
                return res.status(409).json({
                    success: false,
                    message: 'Session already exists with credential files',
                    error: 'Session already has credential files. Use overwriteExisting=true to replace them.',
                    data: {
                        senderId: finalSenderId,
                        existingFiles: existingFiles,
                        sessionStatus: existingSession.status
                    }
                });
            }
        }
        
        // Store uploaded files in auth directory
        const storedFiles = [];
        const errors = [];
        
        for (const file of files) {
            try {
                const fileName = file.originalname;
                const filePath = path.join(authDir, fileName);
                
                // Validate JSON files to ensure they contain valid credential data
                if (fileName.endsWith('.json')) {
                    try {
                        const jsonContent = JSON.parse(file.buffer.toString());
                        
                        // Basic validation for Baileys credential files
                        if (fileName.includes('creds') && !jsonContent.noiseKey) {
                            throw new Error('Invalid credentials file - missing noiseKey');
                        }
                        
                        // Store the validated JSON with proper formatting
                        fs.writeFileSync(filePath, JSON.stringify(jsonContent, null, 2));
                    } catch (jsonError) {
                        errors.push({
                            fileName: fileName,
                            error: `Invalid JSON file: ${jsonError.message}`
                        });
                        continue;
                    }
                } else {
                    // Store binary/text files as-is
                    fs.writeFileSync(filePath, file.buffer);
                }
                
                storedFiles.push({
                    fileName: fileName,
                    size: file.size,
                    path: filePath
                });
                
                logger.info('Credential file stored', { 
                    sessionId: finalSenderId, 
                    fileName: fileName,
                    size: file.size 
                });
                
            } catch (fileError) {
                errors.push({
                    fileName: file.originalname,
                    error: fileError.message
                });
                logger.error('Error storing credential file', { 
                    sessionId: finalSenderId, 
                    fileName: file.originalname,
                    error: fileError.message 
                });
            }
        }
        
        // Create or update session in database if it doesn't exist
        if (!existingSession) {
            try {
                await sessionManager.createSession(finalSenderId, false, {
                    name: `Migrated Session - ${finalSenderId}`,
                    user_id: finalSenderId,
                    admin_id: null,
                    webhook_url: null
                });
                logger.info('Session created for migration', { sessionId: finalSenderId });
            } catch (createError) {
                logger.error('Error creating session for migration', { 
                    sessionId: finalSenderId, 
                    error: createError.message 
                });
            }
        }
        
        // Optionally restart the session to use new credentials
        let sessionRestarted = false;
        if (restartSession && storedFiles.length > 0) {
            try {
                // Check if session is currently active and destroy it
                const activeSession = await sessionManager.getSessionBySenderId(finalSenderId);
                if (activeSession) {
                    await activeSession.destroy();
                    logger.info('Active session destroyed for migration', { sessionId: finalSenderId });
                }
                
                // Initialize new session with migrated credentials
                await sessionManager.autoReconnectSession(finalSenderId);
                sessionRestarted = true;
                logger.info('Session restarted with migrated credentials', { sessionId: finalSenderId });
                
            } catch (restartError) {
                logger.error('Error restarting session after migration', { 
                    sessionId: finalSenderId, 
                    error: restartError.message 
                });
                // Don't fail the entire migration if restart fails
            }
        }
        
        // Prepare response
        const response = {
            success: true,
            message: 'Session migration completed',
            data: {
                sessionId: finalSenderId,
                filesProcessed: files.length,
                filesStored: storedFiles.length,
                filesWithErrors: errors.length,
                storedFiles: storedFiles,
                errors: errors,
                sessionRestarted: sessionRestarted,
                timestamp: new Date().toISOString()
            }
        };
        
        if (errors.length > 0) {
            response.message = 'Session migration completed with some errors';
            response.warning = 'Some files could not be processed. Check the errors array for details.';
        }
        
        res.json(response);
        
    } catch (error) {
        logger.error('Error in /migrateSession', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Failed to migrate session',
            error: error.message
        });
    }
});

// Get session migration status
router.get('/migrationStatus/:senderId', async (req, res) => {
    try {
        const { senderId } = req.params;
        const { authToken } = req.query;
        
        // Validate authToken from query parameter
        if (!authToken || authToken !== process.env.AUTH_TOKEN) {
            return res.status(401).json({
                success: false,
                message: 'Authentication failed',
                error: 'Invalid or missing authToken'
            });
        }
        
        if (!isValidSenderId(senderId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid sender ID format',
                error: 'Invalid senderId format'
            });
        }
        
        logger.api('/migrationStatus', 'Migration status requested', { senderId });
        
        // Check session directory and files
        const sessionDir = path.join(process.env.SESSION_STORAGE_PATH || './sessions', senderId);
        const authDir = path.join(sessionDir, 'auth');
        
        const migrationStatus = {
            sessionId: senderId,
            sessionDirExists: fs.existsSync(sessionDir),
            authDirExists: fs.existsSync(authDir),
            credentialFiles: [],
            sessionInDatabase: false,
            sessionActive: false,
            timestamp: new Date().toISOString()
        };
        
        // Get credential files
        if (migrationStatus.authDirExists) {
            try {
                const files = fs.readdirSync(authDir);
                migrationStatus.credentialFiles = files.map(file => {
                    const filePath = path.join(authDir, file);
                    const stats = fs.statSync(filePath);
                    return {
                        fileName: file,
                        size: stats.size,
                        modified: stats.mtime,
                        isJSON: file.endsWith('.json')
                    };
                });
            } catch (fileError) {
                migrationStatus.credentialFilesError = fileError.message;
            }
        }
        
        // Check database
        try {
            const sessionData = await sessionManager.database.getSession(senderId);
            if (sessionData) {
                migrationStatus.sessionInDatabase = true;
                migrationStatus.sessionData = {
                    status: sessionData.status,
                    createdAt: sessionData.created_at,
                    updatedAt: sessionData.updated_at,
                    userId: sessionData.user_id,
                    adminId: sessionData.admin_id
                };
            }
        } catch (dbError) {
            migrationStatus.databaseError = dbError.message;
        }
        
        // Check if session is currently active
        try {
            const activeSession = await sessionManager.getSessionBySenderId(senderId);
            if (activeSession) {
                migrationStatus.sessionActive = true;
                migrationStatus.activeSessionInfo = {
                    connected: activeSession.isSessionConnected(),
                    hasQRCode: !!activeSession.getQRCode(),
                    hasAuthData: activeSession.hasAuthData()
                };
            }
        } catch (activeError) {
            migrationStatus.activeSessionError = activeError.message;
        }
        
        res.json({
            success: true,
            message: 'Migration status retrieved',
            data: migrationStatus
        });
        
    } catch (error) {
        logger.error('Error in /migrationStatus', { error: error.message, senderId: req.params?.senderId });
        res.status(500).json({
            success: false,
            message: 'Failed to get migration status',
            error: error.message
        });
    }
});

// Get Authentication Status endpoint - helps frontend manage QR polling
router.post('/getAuthStatus', validateAuthToken, validateSenderId, async (req, res) => {
    try {
        const { senderId } = req.body;
        
        logger.api('/getAuthStatus', 'Authentication status requested', { senderId });
        
        // Check if session exists in database
        const sessionData = await sessionManager.database.getSession(senderId);
        if (!sessionData) {
            return res.status(404).json({
                success: false,
                message: 'Session not found',
                error: `Session not found for senderId: ${senderId}. Please create session first.`,
                data: {
                    senderId: senderId,
                    state: 'SESSION_NOT_FOUND',
                    shouldStopPolling: true,
                    suggestion: 'Use POST /api/createSession to create a new session'
                }
            });
        }
        
        // Get session from memory if it exists
        const session = await sessionManager.getSessionBySenderId(senderId);
        
        if (!session) {
            return res.json({
                success: true,
                message: 'Session exists but not in memory',
                data: {
                    senderId: senderId,
                    state: 'SESSION_NOT_IN_MEMORY',
                    isConnected: false,
                    databaseStatus: sessionData.status,
                    shouldStopPolling: false,
                    suggestion: 'Request QR code to start authentication'
                }
            });
        }
        
        // Check if already connected
        if (session.isSessionConnected()) {
            return res.json({
                success: true,
                message: 'Session is connected',
                data: {
                    senderId: senderId,
                    state: 'CONNECTED',
                    isConnected: true,
                    databaseStatus: sessionData.status,
                    shouldStopPolling: true,
                    connectionInfo: session.getConnectionInfo ? session.getConnectionInfo() : null,
                    message: 'WhatsApp session is active and ready'
                }
            });
        }
        
        // Analyze authentication state
        const authState = sessionManager.getAuthenticationState(session);
        
        let shouldStopPolling = false;
        let message = '';
        let suggestion = '';
        
        switch (authState.state) {
            case 'AUTHENTICATION_IN_PROGRESS':
                shouldStopPolling = true;
                message = 'Authentication in progress. Please wait...';
                suggestion = 'Wait for authentication to complete. Do not scan additional QR codes.';
                break;
                
            case 'QR_VALID':
                shouldStopPolling = false;
                message = 'QR code is available and valid';
                suggestion = 'You can continue polling for QR codes or scan the current one';
                break;
                
            case 'QR_EXPIRED':
                shouldStopPolling = false;
                message = 'QR code has expired, new one needed';
                suggestion = 'Request a new QR code';
                break;
                
            case 'NEED_FRESH_START':
                shouldStopPolling = false;
                message = 'Ready for new authentication';
                suggestion = 'Request QR code to start authentication';
                break;
                
            case 'SOCKET_ERROR':
                shouldStopPolling = false;
                message = 'Connection error, recovery needed';
                suggestion = 'Request QR code to restart authentication';
                break;
                
            default:
                shouldStopPolling = false;
                message = 'Unknown authentication state';
                suggestion = 'Request QR code to check status';
        }
        
        res.json({
            success: true,
            message: message,
            data: {
                senderId: senderId,
                state: authState.state,
                isConnected: false,
                databaseStatus: sessionData.status,
                shouldStopPolling: shouldStopPolling,
                socketState: authState.socketState,
                details: authState.details,
                suggestion: suggestion,
                qrInfo: session.qrCodeTimestamp ? {
                    hasQR: !!session.qrCodeData,
                    age: Date.now() - session.qrCodeTimestamp,
                    expired: (Date.now() - session.qrCodeTimestamp) > 20000
                } : null,
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        logger.error('Error in /getAuthStatus', { error: error.message, senderId: req.body?.senderId });
        res.status(500).json({
            success: false,
            message: 'Failed to get authentication status',
            error: error.message,
            data: {
                senderId: req.body?.senderId,
                state: 'ERROR',
                shouldStopPolling: false
            }
        });
    }
});


// NEW: Backup Management Endpoints

// Create manual backup
router.post('/createBackup', validateAuthToken, validateSenderId, checkSessionExists, async (req, res) => {
    try {
        const { senderId } = req.body;
        
        logger.api('/createBackup', 'Manual backup requested', { senderId });
        
        const session = sessionManager.getSession(senderId);
        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found',
                error: 'Session not found in memory',
                data: { senderId }
            });
        }

        const backupCreated = await session.createManualBackup();
        
        if (backupCreated) {
            const backupInfo = session.getBackupInfo();
            res.json({
                success: true,
                message: 'Backup created successfully',
                data: {
                    senderId,
                    backupCreated: true,
                    backupInfo: backupInfo,
                    timestamp: new Date().toISOString()
                }
            });
        } else {
            res.status(400).json({
                success: false,
                message: 'Failed to create backup',
                error: 'Backup creation failed - session may not be ready or files may be missing',
                data: { senderId }
            });
        }
        
    } catch (error) {
        logger.error('Error creating manual backup', { senderId: req.body?.senderId, error: error.message });
        res.status(500).json({
            success: false,
            message: 'Failed to create backup',
            error: error.message,
            data: { senderId: req.body?.senderId }
        });
    }
});

// Restore from backup
router.post('/restoreBackup', validateAuthToken, validateSenderId, checkSessionExists, async (req, res) => {
    try {
        const { senderId } = req.body;
        
        logger.api('/restoreBackup', 'Manual restore requested', { senderId });
        
        const session = sessionManager.getSession(senderId);
        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found',
                error: 'Session not found in memory',
                data: { senderId }
            });
        }

        const restored = await session.restoreFromBackup();
        
        if (restored) {
            const backupInfo = session.getBackupInfo();
            res.json({
                success: true,
                message: 'Session restored from backup successfully',
                data: {
                    senderId,
                    restored: true,
                    backupInfo: backupInfo,
                    timestamp: new Date().toISOString(),
                    note: 'Session will attempt to reconnect automatically'
                }
            });
        } else {
            res.status(400).json({
                success: false,
                message: 'Failed to restore from backup',
                error: 'Restore failed - backup may not exist or be corrupted',
                data: { senderId }
            });
        }
        
    } catch (error) {
        logger.error('Error restoring from backup', { senderId: req.body?.senderId, error: error.message });
        res.status(500).json({
            success: false,
            message: 'Failed to restore from backup',
            error: error.message,
            data: { senderId: req.body?.senderId }
        });
    }
});

// Get backup information
router.post('/getBackupInfo', validateAuthToken, validateSenderId, checkSessionExists, async (req, res) => {
    try {
        const { senderId } = req.body;
        
        logger.api('/getBackupInfo', 'Backup info requested', { senderId });
        
        const session = sessionManager.getSession(senderId);
        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found',
                error: 'Session not found in memory',
                data: { senderId }
            });
        }

        const backupInfo = session.getBackupInfo();
        
        res.json({
            success: true,
            message: 'Backup information retrieved successfully',
            data: {
                senderId,
                backupInfo: backupInfo,
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        logger.error('Error getting backup info', { senderId: req.body?.senderId, error: error.message });
        res.status(500).json({
            success: false,
            message: 'Failed to get backup information',
            error: error.message,
            data: { senderId: req.body?.senderId }
        });
    }
});

// Enable/disable backup system
router.post('/setBackupEnabled', validateAuthToken, validateSenderId, checkSessionExists, async (req, res) => {
    try {
        const { senderId, enabled } = req.body;
        
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({
                success: false,
                message: 'Invalid enabled parameter',
                error: 'enabled parameter must be a boolean (true/false)',
                data: { senderId }
            });
        }
        
        logger.api('/setBackupEnabled', 'Backup system toggle requested', { senderId, enabled });
        
        const session = sessionManager.getSession(senderId);
        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found',
                error: 'Session not found in memory',
                data: { senderId }
            });
        }

        session.setBackupEnabled(enabled);
        const backupInfo = session.getBackupInfo();
        
        res.json({
            success: true,
            message: `Backup system ${enabled ? 'enabled' : 'disabled'} successfully`,
            data: {
                senderId,
                backupEnabled: enabled,
                backupInfo: backupInfo,
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        logger.error('Error setting backup enabled state', { senderId: req.body?.senderId, error: error.message });
        res.status(500).json({
            success: false,
            message: 'Failed to set backup enabled state',
            error: error.message,
            data: { senderId: req.body?.senderId }
        });
    }
});

// NEW: Session Integrity Check Endpoints

// Perform comprehensive session integrity check
router.post('/integrityCheck', validateAuthToken, validateSenderId, checkSessionExists, async (req, res) => {
    try {
        const { senderId } = req.body;
        
        logger.api('/integrityCheck', 'Session integrity check requested', { senderId });
        
        const session = sessionManager.getSession(senderId);
        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found',
                error: 'Session not found in memory',
                data: { senderId }
            });
        }

        // Perform comprehensive integrity check
        const integrityCheck = await session.performPreBackupIntegrityCheck();
        const authValidation = await session.validateAuthFiles();
        const connectionInfo = session.getConnectionInfo();
        const backupInfo = session.getBackupInfo();

        // Calculate overall health score
        let healthScore = 0;
        if (integrityCheck.passed) healthScore += 40;
        if (authValidation.valid) healthScore += 30;
        if (session.isSessionConnected()) healthScore += 20;
        if (backupInfo.hasBackup) healthScore += 10;

        const healthStatus = healthScore >= 80 ? 'excellent' : 
                           healthScore >= 60 ? 'good' : 
                           healthScore >= 40 ? 'warning' : 'critical';

        res.json({
            success: true,
            message: 'Session integrity check completed',
            data: {
                senderId,
                healthScore: healthScore,
                healthStatus: healthStatus,
                integrityCheck: {
                    passed: integrityCheck.passed,
                    reason: integrityCheck.reason,
                    details: integrityCheck.details
                },
                authValidation: {
                    valid: authValidation.valid,
                    reason: authValidation.reason
                },
                connectionInfo: connectionInfo,
                backupInfo: backupInfo,
                recommendations: generateHealthRecommendations(healthScore, integrityCheck, authValidation, backupInfo),
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        logger.error('Error performing integrity check', { senderId: req.body?.senderId, error: error.message });
        res.status(500).json({
            success: false,
            message: 'Failed to perform integrity check',
            error: error.message,
            data: { senderId: req.body?.senderId }
        });
    }
});

// Validate backup integrity
router.post('/validateBackup', validateAuthToken, validateSenderId, checkSessionExists, async (req, res) => {
    try {
        const { senderId } = req.body;
        
        logger.api('/validateBackup', 'Backup validation requested', { senderId });
        
        const session = sessionManager.getSession(senderId);
        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found',
                error: 'Session not found in memory',
                data: { senderId }
            });
        }

        const backupInfo = session.getBackupInfo();
        
        if (!backupInfo.hasBackup) {
            return res.status(404).json({
                success: false,
                message: 'No backup found',
                error: 'No backup exists for this session',
                data: { senderId }
            });
        }

        // Validate backup files
        const fs = require('fs');
        const path = require('path');
        const latestBackupDir = path.join(process.env.SESSION_STORAGE_PATH || './sessions', senderId, 'backup', 'latest');
        
        let validationResults = {};
        let overallValid = true;
        
        if (fs.existsSync(latestBackupDir)) {
            const backupFiles = fs.readdirSync(latestBackupDir).filter(file => 
                file.includes('creds') && file.endsWith('.json')
            );
            
            for (const file of backupFiles) {
                const filePath = path.join(latestBackupDir, file);
                const validation = await session.validateCredentialFileIntegrity(filePath, file);
                validationResults[file] = validation;
                if (!validation.valid) {
                    overallValid = false;
                }
            }
        } else {
            overallValid = false;
            validationResults.error = 'Backup directory not found';
        }

        res.json({
            success: true,
            message: 'Backup validation completed',
            data: {
                senderId,
                backupValid: overallValid,
                backupInfo: backupInfo,
                validationResults: validationResults,
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        logger.error('Error validating backup', { senderId: req.body?.senderId, error: error.message });
        res.status(500).json({
            success: false,
            message: 'Failed to validate backup',
            error: error.message,
            data: { senderId: req.body?.senderId }
        });
    }
});

// Helper function to generate health recommendations
function generateHealthRecommendations(healthScore, integrityCheck, authValidation, backupInfo) {
    const recommendations = [];
    
    if (healthScore < 60) {
        recommendations.push('Session health is below optimal - consider troubleshooting');
    }
    
    if (!integrityCheck.passed) {
        recommendations.push(`Session integrity issue: ${integrityCheck.reason}`);
        if (integrityCheck.details.integrityScore < 70) {
            recommendations.push('Consider restarting the session or restoring from backup');
        }
    }
    
    if (!authValidation.valid) {
        recommendations.push(`Authentication files corrupted: ${authValidation.reason}`);
        recommendations.push('Consider restoring from backup or re-authenticating');
    }
    
    if (!backupInfo.hasBackup) {
        recommendations.push('No backup available - create a backup when session is stable');
    } else if (backupInfo.backupAge && backupInfo.backupAge > 24 * 60 * 60 * 1000) {
        recommendations.push('Backup is older than 24 hours - consider creating a fresh backup');
    }
    
    if (recommendations.length === 0) {
        recommendations.push('Session is healthy - no immediate action required');
    }
    
    return recommendations;
}

// NEW: Session Status and Reset Management

// Get comprehensive session status
router.post('/getSessionStatus', validateAuthToken, validateSenderId, async (req, res) => {
    try {
        const { senderId } = req.body;
        
        logger.api('/getSessionStatus', 'Session status check requested', { senderId });
        
        // Get session from database
        const sessionData = await database.getSession(senderId);
        if (!sessionData) {
            return res.status(404).json({
                success: false,
                message: 'Session not found',
                error: 'Session not found in database',
                data: { senderId }
            });
        }

        // Get session from memory
        const session = sessionManager.getSession(senderId);
        const inMemory = !!session;
        
        let sessionInfo = {
            sessionId: senderId,
            databaseStatus: sessionData.status,
            inMemory: inMemory,
            isConnected: false,
            hasAuthData: false,
            hasSocket: false,
            hasUser: false,
            requiresQR: false,
            consecutiveLogoutAttempts: 0,
            canSendMessages: false,
            lastActivity: null,
            createdAt: sessionData.created_at,
            updatedAt: sessionData.updated_at
        };

        if (session) {
            sessionInfo.isConnected = session.isSessionConnected();
            sessionInfo.hasAuthData = session.hasAuthData();
            sessionInfo.hasSocket = !!session.socket;
            sessionInfo.hasUser = !!(session.socket && session.socket.user);
            sessionInfo.consecutiveLogoutAttempts = session.consecutiveLogoutAttempts || 0;
            sessionInfo.lastActivity = session.lastActivity;
            sessionInfo.retryCount = session.retryCount;
            sessionInfo.maxRetries = session.maxRetries;
        }

        // Determine if session requires QR
        sessionInfo.requiresQR = sessionData.status === 'requires_qr' || 
                                sessionData.status === 'logged_out' ||
                                sessionInfo.consecutiveLogoutAttempts >= 3;

        // Determine if session can send messages
        sessionInfo.canSendMessages = sessionInfo.isConnected && 
                                     !sessionInfo.requiresQR && 
                                     sessionData.status === 'connected';

        // Add recommendation
        let recommendation = '';
        if (sessionInfo.requiresQR) {
            recommendation = 'Generate new QR code and scan with your device';
        } else if (!sessionInfo.isConnected && sessionData.status !== 'requires_qr') {
            recommendation = 'Session is connecting or recovering';
        } else if (sessionInfo.isConnected && sessionInfo.canSendMessages) {
            recommendation = 'Session is ready for messaging';
        } else {
            recommendation = 'Check session configuration';
        }

        sessionInfo.recommendation = recommendation;

        res.json({
            success: true,
            message: 'Session status retrieved successfully',
            data: sessionInfo
        });

    } catch (error) {
        logger.error('Error in /getSessionStatus', { 
            senderId: req.body.senderId, 
            error: error.message 
        });
        res.status(500).json({
            success: false,
            message: 'Failed to get session status',
            error: error.message
        });
    }
});

// Reset session when credentials become invalid
router.post('/resetSession', validateAuthToken, validateSenderId, async (req, res) => {
    try {
        const { senderId, force = false } = req.body;
        
        logger.api('/resetSession', 'Session reset requested', { senderId, force });
        
        const session = sessionManager.getSession(senderId);
        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found',
                error: 'Session not found in memory',
                data: { senderId }
            });
        }

        // Check if reset is needed
        const sessionData = await database.getSession(senderId);
        const needsReset = force || 
                          sessionData?.status === 'requires_qr' || 
                          sessionData?.status === 'logged_out' ||
                          (session.consecutiveLogoutAttempts && session.consecutiveLogoutAttempts >= 2);

        if (!needsReset && !force) {
            return res.json({
                success: false,
                message: 'Session reset not needed',
                data: {
                    senderId,
                    currentStatus: sessionData?.status,
                    consecutiveLogoutAttempts: session.consecutiveLogoutAttempts || 0,
                    suggestion: 'Session appears to be working normally'
                }
            });
        }

        logger.session(senderId, 'Performing manual session reset', {
            force: force,
            currentStatus: sessionData?.status,
            consecutiveLogoutAttempts: session.consecutiveLogoutAttempts || 0
        });

        try {
            // Stop the session
            if (session.heartbeatInterval) {
                clearInterval(session.heartbeatInterval);
                session.heartbeatInterval = null;
            }

            // CRITICAL: Disable backup system to prevent restoration interference
            if (session.setBackupEnabled) {
                session.setBackupEnabled(false);
                logger.session(senderId, 'Backup system disabled for reset');
            }

            // Clear authentication state
            session.clearAuthenticationState();
            session.consecutiveLogoutAttempts = 0;
            session.retryCount = 0;
            session.isInitialized = false;
            session.authState = null;
            session.saveCreds = null;

            // Clear QR data
            session.qrCodeData = null;
            session.qrCodeString = null;
            session.qrCodeTimestamp = null;

            // ENHANCED: Clear both auth files AND backup files to prevent restoration interference
            let deletedAuthFiles = [];
            let deletedBackupFiles = [];
            
            // Clear auth files
            if (fs.existsSync(session.authDir)) {
                const authFiles = fs.readdirSync(session.authDir);
                deletedAuthFiles = authFiles;
                for (const file of authFiles) {
                    try {
                        fs.unlinkSync(path.join(session.authDir, file));
                        logger.session(senderId, `Cleared auth file during reset: ${file}`);
                    } catch (unlinkError) {
                        logger.warn('Error clearing auth file during reset', {
                            sessionId: senderId,
                            file,
                            error: unlinkError.message
                        });
                    }
                }
            }

            // CRITICAL: Clear backup files to prevent restoration interference
            if (fs.existsSync(session.backupDir)) {
                const backupContents = fs.readdirSync(session.backupDir);
                deletedBackupFiles = backupContents;
                
                // Delete entire backup directory
                fs.rmSync(session.backupDir, { recursive: true, force: true });
                
                // Recreate empty backup directory
                fs.mkdirSync(session.backupDir, { recursive: true });
                
                logger.session(senderId, 'Backup files cleared during reset', {
                    deletedBackups: deletedBackupFiles
                });
            }

            // Destroy socket safely
            if (session.socket) {
                try {
                    if (session.socket.ev) {
                        session.socket.ev.removeAllListeners();
                    }
                    
                    const socketReadyState = session.socket.readyState;
                    if (typeof socketReadyState !== 'undefined' && (socketReadyState === 0 || socketReadyState === 1)) {
                        session.socket.close();
                    }
                } catch (socketError) {
                    logger.warn('Error closing socket during reset', {
                        sessionId: senderId,
                        error: socketError.message
                    });
                }
                session.socket = null;
            }

            // Update database status
            await database.updateSessionStatus(senderId, 'requires_qr');

            // Reset connection flags
            session.isConnected = false;
            session.isConnecting = false;
            session.socketCreateLock = false;
            session.connectionPromise = null;

            logger.session(senderId, 'Session reset completed successfully');
            
            console.log(`🔄 RESET: Session cleanup completed for ${senderId}`);
            console.log(`📁 Auth files deleted: ${deletedAuthFiles.length} files (${deletedAuthFiles.join(', ')})`);
            console.log(`💾 Backup files deleted: ${deletedBackupFiles.length} items (${deletedBackupFiles.join(', ')})`);
            console.log(`✅ Fresh QR code generation ready - no backup restoration interference`);

            res.json({
                success: true,
                message: 'Session reset successfully - all authentication and backup files cleared',
                data: {
                    senderId,
                    status: 'requires_qr',
                    authFilesCleared: deletedAuthFiles.length,
                    backupFilesCleared: deletedBackupFiles.length,
                    message: 'Session has been completely reset. Generate a new QR code to reconnect.',
                    nextStep: 'Call /getQRCode to generate a new QR code',
                    note: 'No backup restoration interference - fresh authentication required'
                }
            });

        } catch (resetError) {
            logger.error('Error during session reset', {
                sessionId: senderId,
                error: resetError.message
            });

            res.status(500).json({
                success: false,
                message: 'Session reset failed',
                error: resetError.message,
                data: { senderId }
            });
        }

    } catch (error) {
        logger.error('Error in /resetSession', { 
            senderId: req.body.senderId, 
            error: error.message 
        });
        res.status(500).json({
            success: false,
            message: 'Failed to reset session',
            error: error.message
        });
    }
});

module.exports = { router, setSessionManager }; 