const axios = require('axios');
const logger = require('../utils/logger');

class WebhookManager {
    constructor() {
        this.timeout = parseInt(process.env.WEBHOOK_TIMEOUT) || 5000;
        this.retryAttempts = parseInt(process.env.WEBHOOK_RETRY_ATTEMPTS) || 3;
        
        // Enhanced configuration for cloud deployments
        this.maxRedirects = parseInt(process.env.WEBHOOK_MAX_REDIRECTS) || 5;
        this.keepAlive = process.env.WEBHOOK_KEEP_ALIVE !== 'false'; // Default true
        this.followRedirect = process.env.WEBHOOK_FOLLOW_REDIRECT !== 'false'; // Default true
    }

    async sendWebhook(webhookUrl, data, attempt = 1) {
        try {
            logger.webhook(data.sessionId, `Sending webhook (attempt ${attempt}/${this.retryAttempts})`, { 
                webhookUrl, 
                messageId: data.messageId,
                attempt,
                timeout: this.timeout
            });

            // Enhanced axios configuration for cloud compatibility
            const axiosConfig = {
                timeout: this.timeout,
                maxRedirects: this.maxRedirects,
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'WhatsApp-API-Baileys/1.0.0',
                    'Accept': 'application/json',
                    'Accept-Encoding': 'gzip, deflate',
                    'Connection': this.keepAlive ? 'keep-alive' : 'close',
                    'Cache-Control': 'no-cache'
                },
                validateStatus: (status) => status >= 200 && status < 300,
                // Add support for HTTPS with self-signed certificates if needed
                httpsAgent: process.env.NODE_TLS_REJECT_UNAUTHORIZED === 'false' ? 
                    new (require('https').Agent)({ rejectUnauthorized: false }) : undefined,
                // Add proxy support if configured
                proxy: process.env.HTTP_PROXY ? {
                    protocol: process.env.HTTP_PROXY.startsWith('https') ? 'https' : 'http',
                    host: new URL(process.env.HTTP_PROXY).hostname,
                    port: new URL(process.env.HTTP_PROXY).port
                } : false
            };

            // Log detailed request info for debugging
            logger.webhook(data.sessionId, 'Webhook request details', {
                webhookUrl,
                timeout: this.timeout,
                maxRedirects: this.maxRedirects,
                headers: axiosConfig.headers,
                dataSize: JSON.stringify(data).length,
                userAgent: axiosConfig.headers['User-Agent']
            });

            const startTime = Date.now();
            const response = await axios.post(webhookUrl, data, axiosConfig);
            const duration = Date.now() - startTime;

            logger.webhook(data.sessionId, 'Webhook sent successfully', { 
                webhookUrl, 
                messageId: data.messageId,
                status: response.status,
                statusText: response.statusText,
                duration: `${duration}ms`,
                responseHeaders: response.headers,
                responseSize: response.data ? JSON.stringify(response.data).length : 0
            });

            return {
                success: true,
                status: response.status,
                statusText: response.statusText,
                response: response.data,
                duration: duration,
                headers: response.headers
            };

        } catch (error) {
            const duration = Date.now() - (error.config?.metadata?.startTime || Date.now());
            
            // Enhanced error logging with more details
            const errorDetails = {
                webhookUrl, 
                messageId: data.messageId,
                error: error.message,
                code: error.code,
                status: error.response?.status,
                statusText: error.response?.statusText,
                responseHeaders: error.response?.headers,
                responseData: error.response?.data,
                duration: `${duration}ms`,
                attempt: attempt,
                maxAttempts: this.retryAttempts
            };

            // Add network-specific error details
            if (error.code === 'ETIMEDOUT') {
                errorDetails.errorType = 'TIMEOUT';
                errorDetails.suggestion = 'Consider increasing WEBHOOK_TIMEOUT environment variable';
            } else if (error.code === 'ECONNREFUSED') {
                errorDetails.errorType = 'CONNECTION_REFUSED';
                errorDetails.suggestion = 'Check if the webhook endpoint is accessible and running';
            } else if (error.code === 'ENOTFOUND') {
                errorDetails.errorType = 'DNS_RESOLUTION_FAILED';
                errorDetails.suggestion = 'Check if the webhook domain exists and is reachable';
            } else if (error.code === 'ECONNRESET') {
                errorDetails.errorType = 'CONNECTION_RESET';
                errorDetails.suggestion = 'Server closed connection unexpectedly, may retry automatically';
            } else if (error.response?.status >= 400 && error.response?.status < 500) {
                errorDetails.errorType = 'CLIENT_ERROR';
                errorDetails.suggestion = 'Check webhook endpoint authentication and request format';
            } else if (error.response?.status >= 500) {
                errorDetails.errorType = 'SERVER_ERROR';
                errorDetails.suggestion = 'Webhook server is experiencing issues, will retry';
            }

            logger.webhook(data.sessionId, `Webhook failed (attempt ${attempt}/${this.retryAttempts})`, errorDetails);

            // Retry logic with improved backoff
            if (attempt < this.retryAttempts) {
                // Don't retry on client errors (4xx) unless it's a specific retryable error
                const shouldRetry = !error.response || 
                                   error.response.status >= 500 || 
                                   error.response.status === 429 || // Rate limited
                                   error.response.status === 408 || // Request timeout
                                   ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'].includes(error.code);
                
                if (shouldRetry) {
                    const retryDelay = Math.min(Math.pow(2, attempt) * 1000, 30000); // Cap at 30 seconds
                    logger.webhook(data.sessionId, `Retrying webhook in ${retryDelay}ms`, { 
                        webhookUrl, 
                        messageId: data.messageId,
                        retryReason: errorDetails.errorType || 'UNKNOWN_ERROR',
                        nextAttempt: attempt + 1
                    });

                    await this.delay(retryDelay);
                    return this.sendWebhook(webhookUrl, data, attempt + 1);
                } else {
                    logger.webhook(data.sessionId, 'Webhook not retryable due to client error', { 
                        webhookUrl, 
                        messageId: data.messageId,
                        status: error.response?.status,
                        reason: 'Client error (4xx) - not retrying'
                    });
                }
            }

            // Final failure after all retries
            logger.webhook(data.sessionId, 'Webhook failed permanently after all retry attempts', { 
                webhookUrl, 
                messageId: data.messageId,
                error: error.message,
                finalStatus: error.response?.status || 0,
                totalAttempts: attempt,
                errorType: errorDetails.errorType,
                suggestion: errorDetails.suggestion
            });

            return {
                success: false,
                error: error.message,
                errorType: errorDetails.errorType,
                code: error.code,
                status: error.response?.status || 0,
                statusText: error.response?.statusText,
                attempts: attempt,
                duration: duration,
                suggestion: errorDetails.suggestion,
                responseData: error.response?.data
            };
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
                content: 'This is a test webhook message from WhatsApp API'
            },
            participant: null,
            pushName: 'Test User',
            isTest: true,
            testInfo: {
                userAgent: 'WhatsApp-API-Baileys/1.0.0',
                serverTime: new Date().toISOString(),
                apiVersion: '1.0.0'
            }
        };

        logger.webhook(sessionId, 'Starting webhook test', {
            webhookUrl,
            testDataSize: JSON.stringify(testData).length
        });

        const result = await this.sendWebhook(webhookUrl, testData);
        
        // Add additional test information
        result.testMetadata = {
            webhookUrl,
            testStartTime: new Date().toISOString(),
            payloadSize: JSON.stringify(testData).length,
            timeout: this.timeout,
            retryAttempts: this.retryAttempts
        };

        return result;
    }

    // Enhanced connection testing
    async testConnection(webhookUrl) {
        try {
            logger.info('Testing basic connectivity to webhook URL', { webhookUrl });
            
            const startTime = Date.now();
            const response = await axios.head(webhookUrl, {
                timeout: this.timeout,
                validateStatus: () => true, // Accept any status for connection test
                headers: {
                    'User-Agent': 'WhatsApp-API-Baileys/1.0.0'
                }
            });
            const duration = Date.now() - startTime;

            const connectionTest = {
                success: true,
                status: response.status,
                statusText: response.statusText,
                duration: duration,
                headers: response.headers,
                connectionWorking: response.status < 500
            };

            logger.info('Connection test completed', { 
                webhookUrl, 
                ...connectionTest 
            });

            return connectionTest;
        } catch (error) {
            const connectionTest = {
                success: false,
                error: error.message,
                code: error.code,
                duration: Date.now() - Date.now(), // Will be minimal since it failed
                connectionWorking: false
            };

            logger.error('Connection test failed', { 
                webhookUrl, 
                ...connectionTest 
            });

            return connectionTest;
        }
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    validateWebhookUrl(url) {
        try {
            const urlObject = new URL(url);
            const isValidProtocol = urlObject.protocol === 'http:' || urlObject.protocol === 'https:';
            const isValidHost = urlObject.hostname && urlObject.hostname.length > 0;
            
            return {
                isValid: isValidProtocol && isValidHost,
                protocol: urlObject.protocol,
                hostname: urlObject.hostname,
                port: urlObject.port,
                pathname: urlObject.pathname,
                issues: [
                    !isValidProtocol && 'Invalid protocol (must be http or https)',
                    !isValidHost && 'Invalid hostname'
                ].filter(Boolean)
            };
        } catch (error) {
            return {
                isValid: false,
                error: error.message,
                issues: ['Invalid URL format']
            };
        }
    }
}

module.exports = WebhookManager; 