const axios = require('axios');
const logger = require('../utils/logger');

class WebhookManager {
    constructor() {
        this.timeout = parseInt(process.env.WEBHOOK_TIMEOUT) || 5000;
        this.retryAttempts = parseInt(process.env.WEBHOOK_RETRY_ATTEMPTS) || 3;
    }

    async sendWebhook(webhookUrl, data, attempt = 1) {
        try {
            logger.webhook(data.sessionId, `Sending webhook (attempt ${attempt}/${this.retryAttempts})`, { 
                webhookUrl, 
                messageId: data.messageId 
            });

            const response = await axios.post(webhookUrl, data, {
                timeout: this.timeout,
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'WhatsApp-API-Baileys/1.0.0'
                },
                validateStatus: (status) => status >= 200 && status < 300
            });

            logger.webhook(data.sessionId, 'Webhook sent successfully', { 
                webhookUrl, 
                messageId: data.messageId,
                status: response.status 
            });

            return {
                success: true,
                status: response.status,
                response: response.data
            };

        } catch (error) {
            logger.webhook(data.sessionId, `Webhook failed (attempt ${attempt}/${this.retryAttempts})`, { 
                webhookUrl, 
                messageId: data.messageId,
                error: error.message,
                status: error.response?.status
            });

            // Retry logic
            if (attempt < this.retryAttempts) {
                const retryDelay = Math.pow(2, attempt) * 1000; // Exponential backoff
                logger.webhook(data.sessionId, `Retrying webhook in ${retryDelay}ms`, { 
                    webhookUrl, 
                    messageId: data.messageId 
                });

                await this.delay(retryDelay);
                return this.sendWebhook(webhookUrl, data, attempt + 1);
            } else {
                logger.webhook(data.sessionId, 'Webhook failed permanently after all retry attempts', { 
                    webhookUrl, 
                    messageId: data.messageId,
                    error: error.message 
                });

                return {
                    success: false,
                    error: error.message,
                    status: error.response?.status || 0,
                    attempts: attempt
                };
            }
        }
    }

    async testWebhook(webhookUrl, sessionId) {
        const testData = {
            sessionId: sessionId,
            messageId: 'test_message_id',
            remoteJid: 'test@test.com',
            fromMe: false,
            timestamp: Date.now(),
            message: {
                type: 'text',
                content: 'This is a test webhook message'
            },
            participant: null,
            pushName: 'Test User',
            isTest: true
        };

        return this.sendWebhook(webhookUrl, testData);
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    validateWebhookUrl(url) {
        try {
            const urlObject = new URL(url);
            return urlObject.protocol === 'http:' || urlObject.protocol === 'https:';
        } catch (error) {
            return false;
        }
    }
}

module.exports = WebhookManager; 