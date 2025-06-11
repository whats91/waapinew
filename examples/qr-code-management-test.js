/**
 * Enhanced QR Code Management Test Script
 * 
 * This script demonstrates the correct way to handle QR code polling
 * to prevent authentication interference and provide smooth user experience.
 * 
 * Usage: node examples/qr-code-management-test.js
 */

const axios = require('axios');

class QRCodeManager {
    constructor(apiUrl, authToken, senderId) {
        this.apiUrl = apiUrl;
        this.authToken = authToken;
        this.senderId = senderId;
        this.pollingInterval = null;
        this.shouldPoll = true;
        this.currentQRCode = null;
        this.authStatusInterval = null;
    }

    // Main entry point
    async start() {
        console.log('🚀 Starting Enhanced QR Code Management Test');
        console.log('═══════════════════════════════════════════════════');
        console.log(`📱 Sender ID: ${this.senderId}`);
        console.log(`🔗 API URL: ${this.apiUrl}`);
        console.log('');

        try {
            // First, create session if it doesn't exist
            await this.createSessionIfNeeded();
            
            // Start the authentication flow
            await this.startAuthenticationFlow();
            
        } catch (error) {
            console.error('❌ Error starting QR management:', error.message);
        }
    }

    // Create session if it doesn't exist
    async createSessionIfNeeded() {
        try {
            const response = await axios.get(
                `${this.apiUrl}/sessionStatus/${this.senderId}?authToken=${this.authToken}`
            );
            console.log('✅ Session already exists');
        } catch (error) {
            if (error.response?.status === 404) {
                console.log('📝 Creating new session...');
                await axios.post(`${this.apiUrl}/createSession`, {
                    authToken: this.authToken,
                    senderId: this.senderId,
                    name: `Test Session - ${this.senderId}`
                });
                console.log('✅ Session created successfully');
            } else {
                throw error;
            }
        }
    }

    // Start the authentication flow
    async startAuthenticationFlow() {
        console.log('🔍 Checking initial authentication status...');
        
        const authStatus = await this.checkAuthenticationStatus();
        
        if (authStatus.data.state === 'CONNECTED') {
            console.log('✅ Session is already connected!');
            return;
        }
        
        console.log(`📊 Initial state: ${authStatus.data.state}`);
        
        if (authStatus.data.shouldStopPolling) {
            console.log('⏸️ Starting with authentication status monitoring...');
            this.startAuthStatusMonitoring();
        } else {
            console.log('▶️ Starting QR code polling...');
            this.startQRPolling();
        }
    }

    // Enhanced QR code polling with state awareness
    async startQRPolling() {
        if (!this.shouldPoll) {
            console.log('🚫 Polling stopped - shouldPoll is false');
            return;
        }

        console.log('🔄 Starting QR code polling...');
        
        // Initial QR fetch
        await this.fetchQRCode();
        
        // Set up polling interval
        this.pollingInterval = setInterval(async () => {
            if (this.shouldPoll) {
                await this.fetchQRCode();
            } else {
                this.stopQRPolling();
            }
        }, 15000); // Poll every 15 seconds
    }

    // Fetch QR code with enhanced state handling
    async fetchQRCode() {
        try {
            console.log('\n🔍 Requesting QR code...');
            
            const response = await axios.post(`${this.apiUrl}/getQRCode`, {
                authToken: this.authToken,
                senderId: this.senderId
            });

            if (response.data.success) {
                const data = response.data.data;
                console.log(`📱 QR Code received - State: ${data.state}`);
                console.log(`⏰ Expires in: ${data.expiresIn || 'unknown'}ms`);
                console.log(`📝 Message: ${data.message}`);
                
                // Store current QR code
                this.currentQRCode = data.qrCode;
                
                // Check if we should stop polling
                if (data.shouldStopPolling) {
                    console.log('🛑 STOPPING QR POLLING - Reason:', data.state);
                    this.stopQRPolling();
                    
                    if (data.state === 'AUTHENTICATION_IN_PROGRESS') {
                        console.log('🔄 QR Code scanned! Starting authentication monitoring...');
                        this.startAuthStatusMonitoring();
                    }
                } else {
                    console.log('▶️ Continuing QR polling...');
                }
                
            } else {
                console.log('❌ QR request failed:', response.data.message);
            }

        } catch (error) {
            console.log('❌ QR fetch error:', error.response?.status, error.response?.data?.message);
            
            // Handle specific error cases
            if (error.response?.status === 409) {
                console.log('✅ Session already connected!');
                this.stopQRPolling();
                this.onAuthenticationSuccess();
            } else if (error.response?.status === 202) {
                console.log('🔄 Authentication in progress, starting monitoring...');
                this.stopQRPolling();
                this.startAuthStatusMonitoring();
            }
        }
    }

    // Stop QR code polling
    stopQRPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
            console.log('⏹️ QR polling stopped');
        }
        this.shouldPoll = false;
    }

    // Start authentication status monitoring
    startAuthStatusMonitoring() {
        console.log('👁️ Starting authentication status monitoring...');
        
        // Check immediately
        this.checkAuthenticationStatus(true);
        
        // Set up monitoring interval
        this.authStatusInterval = setInterval(async () => {
            await this.checkAuthenticationStatus(true);
        }, 5000); // Check every 5 seconds
    }

    // Check authentication status
    async checkAuthenticationStatus(isMonitoring = false) {
        try {
            const response = await axios.post(`${this.apiUrl}/getAuthStatus`, {
                authToken: this.authToken,
                senderId: this.senderId
            });

            if (response.data.success) {
                const data = response.data.data;
                
                if (isMonitoring) {
                    console.log(`\n🔍 Auth Status: ${data.state}`);
                    console.log(`📊 Details: ${data.details}`);
                    console.log(`💡 Suggestion: ${data.suggestion}`);
                }

                switch (data.state) {
                    case 'CONNECTED':
                        console.log('🎉 SUCCESS! WhatsApp session connected!');
                        this.stopAuthStatusMonitoring();
                        this.onAuthenticationSuccess();
                        break;

                    case 'AUTHENTICATION_IN_PROGRESS':
                        if (isMonitoring) {
                            console.log('⏳ Authentication still in progress...');
                        }
                        break;

                    case 'QR_EXPIRED':
                    case 'NEED_FRESH_START':
                        console.log('🔄 Need new QR code, restarting polling...');
                        this.stopAuthStatusMonitoring();
                        this.shouldPoll = true;
                        this.startQRPolling();
                        break;

                    case 'SOCKET_ERROR':
                        console.log('⚠️ Socket error detected, restarting...');
                        this.stopAuthStatusMonitoring();
                        setTimeout(() => {
                            this.shouldPoll = true;
                            this.startQRPolling();
                        }, 3000);
                        break;

                    default:
                        if (isMonitoring) {
                            console.log(`❓ Unknown state: ${data.state}`);
                        }
                }

                return response.data;
            }

        } catch (error) {
            console.log('❌ Auth status error:', error.response?.data?.message || error.message);
            
            if (isMonitoring) {
                console.log('🔄 Will retry in 5 seconds...');
            }
        }
    }

    // Stop authentication status monitoring
    stopAuthStatusMonitoring() {
        if (this.authStatusInterval) {
            clearInterval(this.authStatusInterval);
            this.authStatusInterval = null;
            console.log('⏹️ Auth status monitoring stopped');
        }
    }

    // Handle successful authentication
    onAuthenticationSuccess() {
        console.log('\n🎊 AUTHENTICATION SUCCESSFUL!');
        console.log('═══════════════════════════════════════════════════');
        console.log('✅ WhatsApp session is now connected and ready');
        console.log('📱 You can now send messages');
        console.log('🔗 Session will auto-reconnect if disconnected');
        console.log('');
        
        // Cleanup
        this.cleanup();
        
        // Optionally test sending a message
        this.testSendMessage();
    }

    // Test sending a message
    async testSendMessage() {
        try {
            console.log('📨 Testing message sending...');
            
            const response = await axios.post(`${this.apiUrl}/sendTextSMS`, {
                authToken: this.authToken,
                senderId: this.senderId,
                receiverId: this.senderId, // Send to self for testing
                messageText: '🎉 QR Code authentication test successful! Session is working perfectly.'
            });

            if (response.data.success) {
                console.log('✅ Test message sent successfully!');
                console.log(`📩 Message ID: ${response.data.data.messageId}`);
            }

        } catch (error) {
            console.log('❌ Test message failed:', error.response?.data?.message || error.message);
        }
    }

    // Cleanup intervals
    cleanup() {
        this.stopQRPolling();
        this.stopAuthStatusMonitoring();
    }

    // Graceful shutdown
    shutdown() {
        console.log('\n🛑 Shutting down QR Code Manager...');
        this.cleanup();
        process.exit(0);
    }
}

// Main execution
async function main() {
    // Configuration
    const config = {
        apiUrl: process.env.API_URL || 'http://localhost:3000/api',
        authToken: process.env.AUTH_TOKEN || 'your-auth-token-here',
        senderId: process.env.SENDER_ID || '1234567890'
    };

    // Validate configuration
    if (config.authToken === 'your-auth-token-here') {
        console.error('❌ Please set AUTH_TOKEN environment variable');
        process.exit(1);
    }

    if (config.senderId === '1234567890') {
        console.error('❌ Please set SENDER_ID environment variable');
        process.exit(1);
    }

    // Create and start QR manager
    const qrManager = new QRCodeManager(config.apiUrl, config.authToken, config.senderId);

    // Handle graceful shutdown
    process.on('SIGINT', () => qrManager.shutdown());
    process.on('SIGTERM', () => qrManager.shutdown());

    console.log('🔧 Configuration:');
    console.log(`   API URL: ${config.apiUrl}`);
    console.log(`   Sender ID: ${config.senderId}`);
    console.log('');

    // Start the process
    await qrManager.start();
}

// Run the script
if (require.main === module) {
    main().catch(error => {
        console.error('💥 Fatal error:', error.message);
        process.exit(1);
    });
}

module.exports = QRCodeManager; 