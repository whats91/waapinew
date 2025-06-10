const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const mimeTypes = require('mime-types');
const logger = require('../utils/logger');

const router = express.Router();

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
        const qrCodeData = await sessionManager.getQRCodeForAPI(senderId);
        
        if (!qrCodeData) {
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

        // QR code is already displayed in terminal by the BaileysSession
        // No need for additional terminal display here
        
        res.json({
            success: true,
            message: 'QR code generated successfully',
            data: {
                qrCode: qrCodeData,
                senderId: senderId,
                message: 'Scan this QR code with WhatsApp to connect your session',
                expiresIn: '~20 seconds',
                note: 'QR code has been displayed in the terminal'
            }
        });
        
    } catch (error) {
        logger.error('Error in /getQRCode', { error: error.message, senderId: req.body?.senderId });
        res.status(500).json({
            success: false,
            message: 'Failed to generate QR code',
            error: error.message,
            senderId: req.body?.senderId
        });
    }
});

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
        
        const result = await sessionManager.sendTextMessage(finalSenderId, finalReceiverId, messageText);
        
        res.json({
            success: true,
            message: 'Text message sent successfully',
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
        res.status(500).json({
            success: false,
            message: 'Failed to send text message',
            error: error.message,
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
                data: {
                    senderId: finalSenderId,
                    mediaurl: finalMediaUrl
                }
            });
        }
        
        let mediaBuffer;
        let mediaType;
        
        // Download media from URL
        try {
            logger.api('/sendMediaSMS', 'Media message send requested', { 
                senderId: finalSenderId, 
                receiverId: finalReceiverId, 
                mediaurl: finalMediaUrl 
            });
            
            const response = await axios.get(finalMediaUrl, {
                responseType: 'arraybuffer',
                timeout: 30000,
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
                data: {
                    senderId: finalSenderId,
                    mediaurl: finalMediaUrl
                }
            });
        }
        
        const result = await sessionManager.sendMediaMessage(finalSenderId, finalReceiverId, mediaBuffer, mediaType, finalCaption);
        
        res.json({
            success: true,
            message: 'Media message sent successfully',
            data: {
                messageId: result.key.id,
                senderId: finalSenderId,
                receiverId: finalReceiverId,
                mediaurl: finalMediaUrl,
                mediaType: mediaType,
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
        res.status(500).json({
            success: false,
            message: 'Failed to send media message',
            error: error.message,
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
        const finalUserId = userId || user_id;
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
            const regularResult = await sessionManager.webhookManager.sendWebhook(webhookUrl, regularWhatsAppPayload);
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
                const businessResult = await sessionManager.webhookManager.sendWebhook(webhookUrl, businessWhatsAppPayload);
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
        
        res.json({
            success: true,
            message: 'Session logged out successfully',
            data: {
                senderId: finalSenderId,
                status: 'logged_out',
                timestamp: new Date().toISOString()
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
            createdAt: session.created_at,
            updatedAt: session.updated_at,
            // Runtime status from active sessions
            isConnected: session.isConnected,
            hasQRCode: session.hasQRCode,
            inMemory: session.inMemory
        }));
        
        res.json({
            success: true,
            message: `Sessions retrieved successfully for user ${userId}`,
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

module.exports = { router, setSessionManager }; 