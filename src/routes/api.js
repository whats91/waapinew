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
        
        const qrCodeData = await sessionManager.getQRCode(senderId);
        
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

        // Display QR code in terminal for easy scanning
        try {
            const QRCode = require('qrcode');
            
            // Get the original QR string for terminal display
            const qrString = await sessionManager.getQRString(senderId);
            
            console.log('\n' + '='.repeat(80));
            console.log('🌐 API QR CODE REQUEST - SCAN WITH YOUR PHONE');
            console.log(`🔗 Sender ID: ${senderId}`);
            console.log(`📡 API Endpoint: POST /api/getQRCode`);
            console.log(`🕐 Requested at: ${new Date().toLocaleTimeString()}`);
            console.log('='.repeat(80));
            
            // Display the actual QR code in terminal if we have the string
            if (qrString) {
                QRCode.toString(qrString, { 
                    type: 'terminal',
                    width: 60,           // Make it wider
                    margin: 2,           // Add margin  
                    small: false         // Use full block characters for better visibility
                }, (err, qrTerminal) => {
                    if (!err) {
                        console.log(qrTerminal);
                    }
                });
                
                console.log('📱 QR Code displayed above - scan with WhatsApp!');
            } else {
                console.log('📱 QR Code is ready for scanning!');
                console.log('💡 Check the automatic terminal display or use the base64 data');
            }
            
            console.log('⏱️  QR Code expires in ~20 seconds');
            console.log('🔄 Call this endpoint again if QR expires');
            console.log('='.repeat(80) + '\n');
            
        } catch (terminalError) {
            logger.warn('Could not display QR in terminal', { error: terminalError.message });
        }
        
        res.json({
            success: true,
            message: 'QR code generated successfully',
            data: {
                qrCode: qrCodeData,
                senderId: senderId,
                message: 'Scan this QR code with WhatsApp to connect your session',
                expiresIn: '~20 seconds'
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
            return res.status(400).json({
                success: false,
                message: 'Invalid receiver ID format',
                error: 'Invalid receiverId/number format. Must be a valid phone number or WhatsApp JID',
                data: {
                    senderId: finalSenderId,
                    receiverId: finalReceiverId
                }
            });
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
            return res.status(400).json({
                success: false,
                message: 'Invalid receiver ID format',
                error: 'Invalid receiverId/number format. Must be a valid phone number or WhatsApp JID',
                data: {
                    senderId: finalSenderId,
                    receiverId: finalReceiverId
                }
            });
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
        const { senderId, name, userId, webhookUrl } = req.body;
        
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
                        createdAt: existingSession.created_at
                    }
                });
            }
        } catch (dbError) {
            logger.error('Error checking existing session', { senderId, error: dbError.message });
        }
        
        // Use senderId as the session ID
        const sessionId = await sessionManager.createSession(senderId);
        
        // Update session with provided data if needed
        if (name || userId || webhookUrl) {
            // Note: You might want to add update methods to handle this
        }
        
        logger.api('/createSession', 'Session created', { sessionId: senderId });
        
        res.json({
            success: true,
            message: 'Session created successfully',
            data: {
                sessionId: senderId,
                senderId: senderId,
                status: 'created'
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
        
        res.json({
            success: true,
            message: 'Session status retrieved successfully',
            data: {
                senderId: senderId,
                isConnected: session ? session.isSessionConnected() : false,
                hasQRCode: session ? !!session.getQRCode() : false,
                databaseStatus: sessionData.status,
                createdAt: sessionData.created_at,
                updatedAt: sessionData.updated_at
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
router.post('/updateWebhook', validateAuthToken, async (req, res) => {
    try {
        const { senderId, webhookUrl, webhookStatus } = req.body;
        
        if (!senderId) {
            return res.status(400).json({
                success: false,
                message: 'Sender ID is required',
                error: 'senderId is required'
            });
        }
        
        await sessionManager.updateWebhookConfig(senderId, webhookUrl, webhookStatus);
        
        logger.api('/updateWebhook', 'Webhook configuration updated', { 
            senderId, 
            webhookUrl, 
            webhookStatus 
        });
        
        res.json({
            success: true,
            message: 'Webhook configuration updated successfully',
            data: {
                senderId: senderId
            }
        });
        
    } catch (error) {
        logger.error('Error in /updateWebhook', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Failed to update webhook configuration',
            error: error.message
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
        
        const qrString = await sessionManager.getQRString(senderId);
        
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

        // Display QR code in terminal
        const QRCode = require('qrcode');
        
        console.log('\n' + '⚡'.repeat(80));
        console.log('📱 TERMINAL QR DISPLAY - SCAN WITH YOUR PHONE');
        console.log(`🔗 Sender ID: ${senderId}`);
        console.log(`📡 API Endpoint: POST /api/displayQR`);
        console.log(`🕐 Displayed at: ${new Date().toLocaleTimeString()}`);
        console.log('⚡'.repeat(80));
        
        QRCode.toString(qrString, { 
            type: 'terminal',
            width: 60,           // Make it wider
            margin: 2,           // Add margin  
            small: false         // Use full block characters for better visibility
        }, (err, qrTerminal) => {
            if (!err) {
                console.log(qrTerminal);
            }
        });
        
        console.log('📱 Scan the QR code above with WhatsApp!');
        console.log('⏱️  QR Code expires in ~20 seconds');
        console.log('⚡'.repeat(80) + '\n');
        
        res.json({
            success: true,
            message: 'QR code displayed in terminal successfully',
            data: {
                senderId: senderId,
                expiresIn: '~20 seconds'
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

module.exports = { router, setSessionManager }; 