const { 
    default: makeWASocket, 
    DisconnectReason, 
    useMultiFileAuthState,
    isJidBroadcast,
    isJidStatusBroadcast,
    isJidNewsletter,
    proto
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const axios = require('axios');

class BaileysSession {
    constructor(sessionId, database, webhookManager) {
        this.sessionId = sessionId;
        this.database = database;
        this.webhookManager = webhookManager;
        this.socket = null;
        this.qrCodeData = null;
        this.qrCodeString = null;
        this.qrCodeTimestamp = null; // Track when QR was generated for expiry
        this.isConnected = false;
        this.retryCount = 0;
        this.maxRetries = parseInt(process.env.SESSION_MAX_RETRIES) || 5; // Use configurable max retries
        this.sessionDir = path.join(process.env.SESSION_STORAGE_PATH || './sessions', sessionId);
        this.authDir = path.join(this.sessionDir, 'auth'); // All auth files will be stored in auth subfolder
        this.authState = null;
        this.saveCreds = null;
        this.lastActivity = Date.now(); // Track last activity for health monitoring
        this.displayQRInTerminal = false; // Default to false - no QR display unless requested
        this.isAPIRequest = false; // Flag to identify if this is an API-requested QR
        this.autoConnect = false; // Flag to control automatic connection - default false
        this.isInitialized = false; // Track if session has been initialized
        
        // NEW: Authentication state preservation during stream errors
        this.isAuthenticating = false; // Track if user is in authentication process
        this.qrCodeScanned = false; // Track if QR code has been scanned
        this.authenticationStartTime = null; // Track when authentication started
        this.lastQRCodeGenerated = null; // Track last QR code to avoid regeneration during auth
        this.preventQRRegeneration = false; // Flag to prevent QR regeneration during auth
        
        // CRITICAL: Session state management for preventing conflicts
        this.isConnecting = false; // Track if currently connecting to prevent multiple connections
        this.isDestroying = false; // Track if session is being destroyed
        this.connectionPromise = null; // Store active connection promise to prevent multiple connections
        this.heartbeatInterval = null; // Store heartbeat interval reference
        this.socketCreateLock = false; // Prevent multiple socket creation
        this.streamConflictCount = 0; // Track stream conflicts for escalation
        this.lastStreamConflictTime = null; // Track last conflict time
        this.maxStreamConflicts = 3; // Max conflicts before forced reset
        this.streamConflictCooldown = 30000; // 30 seconds cooldown between conflicts
        
        // NEW: Backup and restore system
        this.backupDir = path.join(this.sessionDir, 'backup'); // Backup directory
        this.lastBackupTime = null; // Track last backup time
        this.backupInterval = 5 * 60 * 1000; // Backup every 5 minutes when connected
        this.isRestoring = false; // Flag to prevent recursive restore attempts
        this.backupEnabled = true; // Flag to enable/disable backup system
        this.maxBackupAge = 24 * 60 * 60 * 1000; // Maximum backup age (24 hours)
        this.backupRetryCount = 0; // Track backup retry attempts
        this.maxBackupRetries = 3; // Maximum backup retry attempts
        
        // NEW: Track consecutive logout attempts to detect invalid credentials
        this.consecutiveLogoutAttempts = 0; // Track logout attempts for credential validation
        
        this.ensureSessionDirectory();
    }

    ensureSessionDirectory() {
        // Create session directory
        if (!fs.existsSync(this.sessionDir)) {
            fs.mkdirSync(this.sessionDir, { recursive: true });
        }
        // Create auth subdirectory for all authentication files
        if (!fs.existsSync(this.authDir)) {
            fs.mkdirSync(this.authDir, { recursive: true });
        }
        // Create backup subdirectory for backup files
        if (!fs.existsSync(this.backupDir)) {
            fs.mkdirSync(this.backupDir, { recursive: true });
        }
    }

    // NEW: Comprehensive backup system for session authentication files with integrity verification
    async createSessionBackup() {
        if (!this.backupEnabled || this.isRestoring) {
            return false;
        }

        try {
            logger.session(this.sessionId, 'Creating session backup with integrity verification (creds file only)');

            // CRITICAL: Pre-backup integrity and stability checks
            const integrityCheck = await this.performPreBackupIntegrityCheck();
            if (!integrityCheck.passed) {
                logger.warn('Pre-backup integrity check failed, skipping backup', { 
                    sessionId: this.sessionId,
                    reason: integrityCheck.reason,
                    details: integrityCheck.details
                });
                return false;
            }

            logger.session(this.sessionId, 'Pre-backup integrity check passed', {
                sessionStable: integrityCheck.details.sessionStable,
                authValid: integrityCheck.details.authValid,
                credentialsVerified: integrityCheck.details.credentialsVerified
            });

            // Check if auth directory exists and has files
            if (!fs.existsSync(this.authDir)) {
                logger.warn('Auth directory does not exist, skipping backup', { sessionId: this.sessionId });
                return false;
            }

            const authFiles = fs.readdirSync(this.authDir);
            
            // OPTIMIZED: Only backup credential files (creds.json), ignore pre-key and sender-key files
            const credentialFiles = authFiles.filter(file => 
                file.includes('creds') && file.endsWith('.json')
            );
            
            if (credentialFiles.length === 0) {
                logger.warn('No credential files found, skipping backup', { 
                    sessionId: this.sessionId,
                    availableFiles: authFiles,
                    note: 'Only creds.json files are backed up'
                });
                return false;
            }

            // Create timestamped backup directory
            const backupTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const timestampedBackupDir = path.join(this.backupDir, `backup_${backupTimestamp}`);
            
            if (!fs.existsSync(timestampedBackupDir)) {
                fs.mkdirSync(timestampedBackupDir, { recursive: true });
            }

            // Copy only credential files to backup directory with enhanced validation
            let copiedFiles = 0;
            let validatedFiles = 0;
            for (const file of credentialFiles) {
                const sourcePath = path.join(this.authDir, file);
                const backupPath = path.join(timestampedBackupDir, file);
                
                try {
                    // ENHANCED: Comprehensive file integrity validation
                    const fileValidation = await this.validateCredentialFileIntegrity(sourcePath, file);
                    if (!fileValidation.valid) {
                        logger.warn('Skipping invalid credential file during backup', { 
                            sessionId: this.sessionId, 
                            file,
                            reason: fileValidation.reason,
                            details: fileValidation.details
                        });
                        continue;
                    }

                    validatedFiles++;
                    logger.session(this.sessionId, `Credential file integrity validated: ${file}`, {
                        hasNoiseKey: fileValidation.details.hasNoiseKey,
                        hasPairingKey: fileValidation.details.hasPairingKey,
                        hasSignedIdentityKey: fileValidation.details.hasSignedIdentityKey,
                        hasRegistrationId: fileValidation.details.hasRegistrationId,
                        fileSize: fileValidation.details.fileSize,
                        integrityScore: fileValidation.details.integrityScore
                    });

                    // Copy credential file to backup
                    fs.copyFileSync(sourcePath, backupPath);
                    copiedFiles++;
                    logger.session(this.sessionId, `Backed up validated credential file: ${file}`);
                } catch (fileError) {
                    logger.error('Error backing up credential file', { 
                        sessionId: this.sessionId, 
                        file, 
                        error: fileError.message 
                    });
                }
            }

            if (copiedFiles > 0 && validatedFiles > 0) {
                // Create a latest backup symlink/copy for easy access
                const latestBackupDir = path.join(this.backupDir, 'latest');
                if (fs.existsSync(latestBackupDir)) {
                    fs.rmSync(latestBackupDir, { recursive: true, force: true });
                }
                
                // Copy timestamped backup to latest
                fs.mkdirSync(latestBackupDir, { recursive: true });
                for (const file of fs.readdirSync(timestampedBackupDir)) {
                    fs.copyFileSync(
                        path.join(timestampedBackupDir, file),
                        path.join(latestBackupDir, file)
                    );
                }

                // Create enhanced backup metadata with integrity information
                const backupMetadata = {
                    timestamp: new Date().toISOString(),
                    sessionId: this.sessionId,
                    credentialFilesBackedUp: copiedFiles,
                    credentialFilesValidated: validatedFiles,
                    credentialFiles: credentialFiles,
                    allAuthFiles: authFiles,
                    sessionState: {
                        isConnected: this.isConnected,
                        hasUser: !!(this.socket && this.socket.user),
                        socketState: this.socket?.readyState,
                        isAuthenticating: this.isAuthenticating,
                        lastActivity: this.lastActivity
                    },
                    integrityCheck: integrityCheck.details,
                    backupType: 'credential_files_only_verified',
                    note: 'Only validated credential files are backed up for optimal performance and reliability',
                    createdBy: 'BaileysSession.createSessionBackup',
                    backupVersion: '2.0' // Mark enhanced backup version
                };

                fs.writeFileSync(
                    path.join(timestampedBackupDir, 'backup_metadata.json'),
                    JSON.stringify(backupMetadata, null, 2)
                );

                fs.writeFileSync(
                    path.join(latestBackupDir, 'backup_metadata.json'),
                    JSON.stringify(backupMetadata, null, 2)
                );

                this.lastBackupTime = Date.now();
                this.backupRetryCount = 0; // Reset retry count on success

                logger.session(this.sessionId, 'Verified credential backup created successfully', {
                    credentialFilesBackedUp: copiedFiles,
                    credentialFilesValidated: validatedFiles,
                    totalAuthFiles: authFiles.length,
                    backupDir: timestampedBackupDir,
                    timestamp: backupMetadata.timestamp,
                    integrityVerified: true,
                    note: 'Only validated credential files backed up (enhanced security)'
                });

                // Clean up old backups (keep last 5 backups)
                this.cleanupOldBackups();

                return true;
            } else {
                logger.warn('No valid credential files were backed up', { 
                    sessionId: this.sessionId,
                    availableFiles: authFiles,
                    credentialFiles: credentialFiles,
                    copiedFiles: copiedFiles,
                    validatedFiles: validatedFiles,
                    reason: 'All credential files failed validation'
                });
                
                // Remove empty backup directory
                if (fs.existsSync(timestampedBackupDir)) {
                    fs.rmSync(timestampedBackupDir, { recursive: true, force: true });
                }
                
                return false;
            }

        } catch (error) {
            this.backupRetryCount++;
            logger.error('Error creating verified credential backup', { 
                sessionId: this.sessionId, 
                error: error.message,
                retryCount: this.backupRetryCount
            });

            // Disable backup temporarily if too many failures
            if (this.backupRetryCount >= this.maxBackupRetries) {
                logger.warn('Too many backup failures, temporarily disabling backup', { 
                    sessionId: this.sessionId,
                    retryCount: this.backupRetryCount 
                });
                setTimeout(() => {
                    this.backupRetryCount = 0;
                    logger.session(this.sessionId, 'Re-enabling backup system after cooldown');
                }, 30000); // Re-enable after 30 seconds
            }

            return false;
        }
    }

    // NEW: Comprehensive pre-backup integrity and stability verification
    async performPreBackupIntegrityCheck() {
        try {
            const checks = {
                sessionStable: false,
                authValid: false,
                credentialsVerified: false,
                socketHealthy: false,
                noActiveErrors: false
            };

            let reason = '';
            let score = 0;

            // 1. Session Stability Check
            if (this.isConnected && this.socket && this.socket.user && !this.isConnecting && !this.isDestroying) {
                // Check session has been stable for at least 30 seconds
                const sessionStableDuration = Date.now() - this.lastActivity;
                const minStableDuration = 30000; // 30 seconds
                
                if (sessionStableDuration >= minStableDuration || this.lastActivity === 0) {
                    checks.sessionStable = true;
                    score += 25;
                } else {
                    reason = `Session not stable enough (${Math.round(sessionStableDuration / 1000)}s < ${minStableDuration / 1000}s required)`;
                }
            } else {
                reason = 'Session not connected or in transitional state';
            }

            // 2. Authentication State Validation
            if (!this.isAuthenticating && !this.qrCodeScanned && !this.preventQRRegeneration) {
                checks.authValid = true;
                score += 20;
            } else {
                if (!reason) reason = 'Session in authentication/QR state - not stable for backup';
            }

            // 3. Socket Health Check
            if (this.socket) {
                const socketState = this.socket.readyState;
                if (socketState === 1) { // OPEN and stable
                    checks.socketHealthy = true;
                    score += 20;
                } else {
                    if (!reason) reason = `Socket not in healthy state (readyState: ${socketState})`;
                }
            } else {
                if (!reason) reason = 'No active socket connection';
            }

            // 4. Error State Check  
            if (this.streamConflictCount === 0 && this.retryCount === 0) {
                checks.noActiveErrors = true;
                score += 15;
            } else {
                if (!reason) reason = `Active errors detected (conflicts: ${this.streamConflictCount}, retries: ${this.retryCount})`;
            }

            // 5. Credential File Validation
            const authValidation = await this.validateAuthFiles();
            if (authValidation.valid) {
                checks.credentialsVerified = true;
                score += 20;
            } else {
                if (!reason) reason = `Auth files invalid: ${authValidation.reason}`;
            }

            // Calculate overall integrity score
            const integrityScore = score; // Out of 100
            const minRequiredScore = 70; // Require at least 70% integrity
            const passed = integrityScore >= minRequiredScore;

            if (!passed && !reason) {
                reason = `Integrity score too low: ${integrityScore}% (minimum: ${minRequiredScore}%)`;
            }

            return {
                passed: passed,
                reason: reason,
                details: {
                    ...checks,
                    integrityScore: integrityScore,
                    minRequiredScore: minRequiredScore,
                    sessionStableDuration: this.lastActivity ? Date.now() - this.lastActivity : 0,
                    socketState: this.socket?.readyState,
                    streamConflicts: this.streamConflictCount,
                    retryCount: this.retryCount
                }
            };

        } catch (error) {
            return {
                passed: false,
                reason: `Integrity check failed: ${error.message}`,
                details: { error: error.message }
            };
        }
    }

    // NEW: Enhanced credential file integrity validation
    async validateCredentialFileIntegrity(filePath, fileName) {
        try {
            // Check file exists and is readable
            if (!fs.existsSync(filePath)) {
                return {
                    valid: false,
                    reason: 'File does not exist',
                    details: { fileName }
                };
            }

            // Read file content
            const fileContent = fs.readFileSync(filePath);
            const fileSize = fileContent.length;

            // Check for empty file
            if (fileSize === 0) {
                return {
                    valid: false,
                    reason: 'File is empty',
                    details: { fileName, fileSize }
                };
            }

            // Check minimum file size (creds.json should be substantial)
            const minFileSize = 100; // Minimum 100 bytes for a valid creds file
            if (fileSize < minFileSize) {
                return {
                    valid: false,
                    reason: `File too small (${fileSize} bytes < ${minFileSize} required)`,
                    details: { fileName, fileSize }
                };
            }

            // Parse and validate JSON structure
            let credData;
            try {
                credData = JSON.parse(fileContent.toString());
            } catch (jsonError) {
                return {
                    valid: false,
                    reason: `Invalid JSON: ${jsonError.message}`,
                    details: { fileName, fileSize, jsonError: jsonError.message }
                };
            }

            // Comprehensive Baileys credential validation
            const validationChecks = {
                hasNoiseKey: !!credData.noiseKey,
                hasPairingKey: !!credData.pairingEphemeralKeyPair,
                hasSignedIdentityKey: !!credData.signedIdentityKey,
                hasRegistrationId: !!credData.registrationId,
                hasIdentityKey: !!credData.identityKey,
                hasPreKeys: !!credData.preKeys,
                hasSignedPreKey: !!credData.signedPreKey
            };

            // Required fields for basic functionality
            const requiredFields = ['noiseKey', 'pairingEphemeralKeyPair', 'signedIdentityKey', 'registrationId'];
            const missingFields = requiredFields.filter(field => !credData[field]);

            if (missingFields.length > 0) {
                return {
                    valid: false,
                    reason: `Missing required fields: ${missingFields.join(', ')}`,
                    details: { 
                        fileName, 
                        fileSize, 
                        missingFields,
                        ...validationChecks 
                    }
                };
            }

            // Validate key formats and lengths
            try {
                // Noise key should be a Buffer/Uint8Array representation
                if (typeof credData.noiseKey !== 'object' || !credData.noiseKey.data) {
                    return {
                        valid: false,
                        reason: 'Invalid noiseKey format',
                        details: { fileName, noiseKeyType: typeof credData.noiseKey }
                    };
                }

                // Registration ID should be a number
                if (typeof credData.registrationId !== 'number' || credData.registrationId <= 0) {
                    return {
                        valid: false,
                        reason: 'Invalid registrationId',
                        details: { fileName, registrationId: credData.registrationId }
                    };
                }

                // Validate key pair structure
                if (!credData.pairingEphemeralKeyPair.private || !credData.pairingEphemeralKeyPair.public) {
                    return {
                        valid: false,
                        reason: 'Invalid pairingEphemeralKeyPair structure',
                        details: { fileName, keyPairKeys: Object.keys(credData.pairingEphemeralKeyPair) }
                    };
                }

            } catch (keyValidationError) {
                return {
                    valid: false,
                    reason: `Key validation failed: ${keyValidationError.message}`,
                    details: { fileName, keyValidationError: keyValidationError.message }
                };
            }

            // Calculate integrity score based on completeness
            let integrityScore = 0;
            const checkCount = Object.keys(validationChecks).length;
            const passedChecks = Object.values(validationChecks).filter(Boolean).length;
            integrityScore = Math.round((passedChecks / checkCount) * 100);

            // File is valid if it has all required fields and reasonable integrity
            const minIntegrityScore = 60; // Require at least 60% of checks to pass
            const isValid = integrityScore >= minIntegrityScore;

            return {
                valid: isValid,
                reason: isValid ? 'File validation passed' : `Integrity score too low: ${integrityScore}%`,
                details: {
                    fileName,
                    fileSize,
                    integrityScore,
                    minIntegrityScore,
                    passedChecks,
                    totalChecks: checkCount,
                    ...validationChecks
                }
            };

        } catch (error) {
            return {
                valid: false,
                reason: `Validation error: ${error.message}`,
                details: { fileName, error: error.message }
            };
        }
    }

    // NEW: Enhanced backup restoration system with sequential fallback
    async restoreSessionFromBackupSequential() {
        if (this.isRestoring) {
            logger.warn('Restore already in progress, skipping', { sessionId: this.sessionId });
            return false;
        }

        this.isRestoring = true;

        try {
            logger.session(this.sessionId, 'Attempting sequential credential restoration from backups');

            // Get all available backups sorted by date (newest first)
            const backupDirs = [];
            
            // Add latest backup if it exists
            const latestBackupDir = path.join(this.backupDir, 'latest');
            if (fs.existsSync(latestBackupDir)) {
                backupDirs.push({ path: latestBackupDir, name: 'latest' });
            }

            // Add timestamped backups
            if (fs.existsSync(this.backupDir)) {
                const timestampedBackups = fs.readdirSync(this.backupDir)
                    .filter(dir => dir.startsWith('backup_') && dir !== 'latest')
                    .map(dir => ({
                        name: dir,
                        path: path.join(this.backupDir, dir),
                        timestamp: dir.replace('backup_', '').replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z')
                    }))
                    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)); // Newest first

                backupDirs.push(...timestampedBackups);
            }

            if (backupDirs.length === 0) {
                logger.warn('No backups found for sequential restoration', { sessionId: this.sessionId });
                return false;
            }

            logger.session(this.sessionId, `Found ${backupDirs.length} backup(s) for sequential restoration`);

            // Try each backup sequentially until one works
            for (let i = 0; i < backupDirs.length; i++) {
                const backup = backupDirs[i];
                logger.session(this.sessionId, `Attempting restore from backup ${i + 1}/${backupDirs.length}: ${backup.name}`);

                try {
                    const restored = await this.restoreFromSpecificBackup(backup.path, backup.name);
                    if (restored) {
                        logger.session(this.sessionId, `Successfully restored from backup: ${backup.name}`);
                        return true;
                    } else {
                        logger.warn(`Backup restoration failed: ${backup.name}`, { sessionId: this.sessionId });
                    }
                } catch (backupError) {
                    logger.warn(`Error restoring from backup: ${backup.name}`, { 
                        sessionId: this.sessionId, 
                        error: backupError.message 
                    });
                }
            }

            logger.error('All backup restoration attempts failed', { 
                sessionId: this.sessionId,
                totalBackupsAttempted: backupDirs.length
            });
            return false;

        } catch (error) {
            logger.error('Error in sequential backup restoration', { 
                sessionId: this.sessionId, 
                error: error.message 
            });
            return false;
        } finally {
            this.isRestoring = false;
        }
    }

    // NEW: Restore from a specific backup directory
    async restoreFromSpecificBackup(backupDirPath, backupName) {
        try {
            // Verify backup metadata
            const metadataPath = path.join(backupDirPath, 'backup_metadata.json');
            if (fs.existsSync(metadataPath)) {
                try {
                    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
                    const backupAge = Date.now() - new Date(metadata.timestamp).getTime();
                    
                    if (backupAge > this.maxBackupAge) {
                        logger.warn(`Backup too old: ${backupName}`, { 
                            sessionId: this.sessionId,
                            backupAge: Math.round(backupAge / (1000 * 60 * 60)) + ' hours'
                        });
                        return false;
                    }

                    logger.session(this.sessionId, `Backup metadata verified: ${backupName}`, {
                        backupTimestamp: metadata.timestamp,
                        credentialFilesBackedUp: metadata.credentialFilesBackedUp || metadata.filesBackedUp,
                        backupAge: Math.round(backupAge / (1000 * 60)) + ' minutes'
                    });
                } catch (metadataError) {
                    logger.warn(`Invalid backup metadata: ${backupName}, proceeding anyway`, { 
                        sessionId: this.sessionId, 
                        error: metadataError.message 
                    });
                }
            }

            // List backup files (only credential files)
            const backupFiles = fs.readdirSync(backupDirPath).filter(file => 
                !file.endsWith('_metadata.json') && file.includes('creds') && file.endsWith('.json')
            );

            if (backupFiles.length === 0) {
                logger.warn(`No credential files in backup: ${backupName}`, { sessionId: this.sessionId });
                return false;
            }

            // Create pre-restore backup of current files
            if (fs.existsSync(this.authDir)) {
                const currentFiles = fs.readdirSync(this.authDir);
                if (currentFiles.length > 0) {
                    const preRestoreBackupDir = path.join(this.backupDir, `pre_restore_${Date.now()}_${backupName}`);
                    fs.mkdirSync(preRestoreBackupDir, { recursive: true });
                    
                    for (const file of currentFiles) {
                        try {
                            fs.copyFileSync(
                                path.join(this.authDir, file),
                                path.join(preRestoreBackupDir, file)
                            );
                        } catch (copyError) {
                            logger.warn('Error backing up current file before restore', {
                                sessionId: this.sessionId,
                                file,
                                error: copyError.message
                            });
                        }
                    }
                    logger.session(this.sessionId, `Current auth files backed up before restore: ${backupName}`);
                }
            }

            // Ensure auth directory exists
            if (!fs.existsSync(this.authDir)) {
                fs.mkdirSync(this.authDir, { recursive: true });
            }

            // Restore credential files from backup
            let restoredFiles = 0;
            for (const file of backupFiles) {
                const backupPath = path.join(backupDirPath, file);
                const authPath = path.join(this.authDir, file);
                
                try {
                    // Verify backup credential file before restoring
                    const backupContent = fs.readFileSync(backupPath);
                    if (backupContent.length === 0) {
                        logger.warn(`Skipping empty backup credential file: ${file}`, { sessionId: this.sessionId });
                        continue;
                    }

                    // Validate credential file structure
                    try {
                        const credData = JSON.parse(backupContent.toString());
                        
                        // Validate that this is a proper Baileys credential file
                        if (!credData.noiseKey || !credData.pairingEphemeralKeyPair) {
                            logger.warn(`Skipping invalid backup credential file: ${file}`, { 
                                sessionId: this.sessionId, 
                                hasNoiseKey: !!credData.noiseKey,
                                hasPairingKey: !!credData.pairingEphemeralKeyPair
                            });
                            continue;
                        }
                        
                        logger.session(this.sessionId, `Backup credential file validated: ${file}`, {
                            hasNoiseKey: !!credData.noiseKey,
                            hasPairingKey: !!credData.pairingEphemeralKeyPair,
                            hasSignedIdentityKey: !!credData.signedIdentityKey,
                            hasRegistrationId: !!credData.registrationId
                        });
                        
                    } catch (jsonError) {
                        logger.warn(`Skipping corrupted backup credential file: ${file}`, { 
                            sessionId: this.sessionId, 
                            error: jsonError.message 
                        });
                        continue;
                    }

                    // Restore credential file
                    fs.copyFileSync(backupPath, authPath);
                    restoredFiles++;
                    logger.session(this.sessionId, `Restored credential file: ${file} from ${backupName}`);
                } catch (fileError) {
                    logger.error(`Error restoring credential file: ${file} from ${backupName}`, { 
                        sessionId: this.sessionId, 
                        error: fileError.message 
                    });
                }
            }

            if (restoredFiles > 0) {
                logger.session(this.sessionId, `Credential files restored from ${backupName}`, {
                    credentialFilesRestored: restoredFiles,
                    totalBackupFiles: backupFiles.length,
                    backupSource: backupName
                });

                // Reset authentication state and force re-initialization
                this.authState = null;
                this.saveCreds = null;
                this.isInitialized = false;
                this.clearAuthenticationState();

                return true;
            } else {
                logger.warn(`No credential files were restored from ${backupName}`, { 
                    sessionId: this.sessionId,
                    availableBackupFiles: backupFiles
                });
                return false;
            }

        } catch (error) {
            logger.error(`Error restoring from specific backup: ${backupName}`, { 
                sessionId: this.sessionId, 
                error: error.message 
            });
            return false;
        }
    }

    // NEW: Enhanced authentication file validation
    async validateAuthFiles() {
        try {
            if (!fs.existsSync(this.authDir)) {
                return { valid: false, reason: 'Auth directory does not exist' };
            }

            const authFiles = fs.readdirSync(this.authDir);
            const credentialFiles = authFiles.filter(file => 
                file.includes('creds') && file.endsWith('.json')
            );

            if (credentialFiles.length === 0) {
                return { valid: false, reason: 'No credential files found' };
            }

            // Validate primary credential file
            for (const file of credentialFiles) {
                const filePath = path.join(this.authDir, file);
                try {
                    const fileContent = fs.readFileSync(filePath);
                    if (fileContent.length === 0) {
                        return { valid: false, reason: `Credential file is empty: ${file}` };
                    }

                    const credData = JSON.parse(fileContent.toString());
                    
                    // Check for required Baileys credential fields
                    if (!credData.noiseKey) {
                        return { valid: false, reason: `Missing noiseKey in ${file}` };
                    }
                    if (!credData.pairingEphemeralKeyPair) {
                        return { valid: false, reason: `Missing pairingEphemeralKeyPair in ${file}` };
                    }
                    if (!credData.signedIdentityKey) {
                        return { valid: false, reason: `Missing signedIdentityKey in ${file}` };
                    }
                    if (!credData.registrationId) {
                        return { valid: false, reason: `Missing registrationId in ${file}` };
                    }

                    // File is valid
                    logger.session(this.sessionId, `Auth file validation passed: ${file}`);
                    return { 
                        valid: true, 
                        file: file,
                        hasNoiseKey: !!credData.noiseKey,
                        hasPairingKey: !!credData.pairingEphemeralKeyPair,
                        hasSignedIdentityKey: !!credData.signedIdentityKey,
                        hasRegistrationId: !!credData.registrationId
                    };

                } catch (parseError) {
                    return { valid: false, reason: `Corrupted credential file: ${file} - ${parseError.message}` };
                }
            }

            return { valid: false, reason: 'No valid credential files found' };

        } catch (error) {
            return { valid: false, reason: `Auth validation error: ${error.message}` };
        }
    }

    // NEW: Check if session needs backup or restore
    async checkSessionHealth() {
        try {
            // Skip if backup is disabled or restoring
            if (!this.backupEnabled || this.isRestoring) {
                return;
            }

            const now = Date.now();

            // ENHANCED: Check if session is connected, stable, and healthy before creating backup
            if (this.isConnected && this.socket && this.socket.user) {
                // Additional stability checks before backup
                const isSessionStable = !this.isConnecting && 
                                       !this.isDestroying && 
                                       !this.isAuthenticating && 
                                       this.socket.readyState === 1; // WebSocket OPEN state

                if (isSessionStable) {
                    // Create/update backup if needed and session is stable
                    const shouldBackup = !this.lastBackupTime || 
                                       (now - this.lastBackupTime) > this.backupInterval;

                    if (shouldBackup) {
                        logger.session(this.sessionId, 'Performing periodic backup check for stable session');
                        await this.createSessionBackup();
                    }
                } else {
                    logger.session(this.sessionId, 'Session connected but not stable enough for backup', {
                        isConnecting: this.isConnecting,
                        isDestroying: this.isDestroying,
                        isAuthenticating: this.isAuthenticating,
                        socketState: this.socket?.readyState
                    });
                }
            } else {
                // ENHANCED: Session is not connected - comprehensive health check
                logger.session(this.sessionId, 'Session health check: disconnected state detected');

                // Validate current auth files
                const authValidation = await this.validateAuthFiles();
                
                if (!authValidation.valid) {
                    logger.session(this.sessionId, `Auth files invalid: ${authValidation.reason}`);
                    
                    // Check if we have valid backups available
                    const hasValidBackup = fs.existsSync(path.join(this.backupDir, 'latest')) ||
                                         (fs.existsSync(this.backupDir) && 
                                          fs.readdirSync(this.backupDir).some(dir => dir.startsWith('backup_')));

                    if (hasValidBackup && !this.isConnecting) {
                        logger.session(this.sessionId, 'Invalid auth files detected, attempting sequential backup restoration');
                        const restored = await this.restoreSessionFromBackupSequential();
                        
                        if (restored) {
                            console.log(`🔄 Credential files restored from backup for ${this.sessionId.substring(0, 8)}...`);
                            logger.session(this.sessionId, 'Session successfully restored from backup');
                            
                            // Attempt to reconnect after successful restore
                            setTimeout(() => {
                                if (!this.isConnecting && !this.isConnected) {
                                    logger.session(this.sessionId, 'Attempting reconnection after backup restoration');
                                    this.connect().catch(error => {
                                        logger.error('Reconnection after restore failed', {
                                            sessionId: this.sessionId,
                                            error: error.message
                                        });
                                        
                                        // If connection fails, try one more time after delay
                                        setTimeout(() => {
                                            logger.session(this.sessionId, 'Final reconnection attempt after restore');
                                            this.connect().catch(finalError => {
                                                logger.error('Final reconnection after restore failed', {
                                                    sessionId: this.sessionId,
                                                    error: finalError.message
                                                });
                                            });
                                        }, 5000);
                                    });
                                }
                            }, 2000);
                        } else {
                            logger.error('Failed to restore session from any available backup', { 
                                sessionId: this.sessionId,
                                reason: authValidation.reason
                            });
                        }
                    } else if (!hasValidBackup) {
                        logger.warn('No backups available for restoration', { 
                            sessionId: this.sessionId,
                            reason: authValidation.reason
                        });
                    }
                } else {
                    logger.session(this.sessionId, 'Auth files are valid but session disconnected');
                    
                    // If auth files are valid but session is disconnected, try gentle reconnection
                    if (!this.isConnecting) {
                        logger.session(this.sessionId, 'Attempting gentle reconnection with valid auth files');
                        setTimeout(() => {
                            if (!this.isConnecting && !this.isConnected) {
                                this.connect().catch(error => {
                                    logger.error('Gentle reconnection failed', {
                                        sessionId: this.sessionId,
                                        error: error.message
                                    });
                                });
                            }
                        }, 3000);
                    }
                }
            }

        } catch (error) {
            logger.error('Error in enhanced session health check', { 
                sessionId: this.sessionId, 
                error: error.message 
            });
        }
    }

    // Method to set QR display preferences
    setQRDisplayMode(displayInTerminal = true, isAPIRequest = false) {
        this.displayQRInTerminal = displayInTerminal;
        this.isAPIRequest = isAPIRequest;
    }

    // Method to enable/disable automatic connection
    setAutoConnect(autoConnect = true) {
        this.autoConnect = autoConnect;
    }

    // Initialize session without connecting (lazy initialization)
    async initializeWithoutConnection() {
        try {
            logger.session(this.sessionId, 'Initializing Baileys session (lazy mode)');
            
            // NEW: Check if auth files exist, if not try to restore from backup
            if (!fs.existsSync(this.authDir) || fs.readdirSync(this.authDir).length === 0) {
                logger.session(this.sessionId, 'No auth files found, checking for backup');
                
                const hasBackup = fs.existsSync(path.join(this.backupDir, 'latest')) &&
                                fs.readdirSync(path.join(this.backupDir, 'latest')).length > 0;
                
                if (hasBackup) {
                    logger.session(this.sessionId, 'Backup found, attempting restore before initialization');
                    const restored = await this.restoreSessionFromBackupSequential();
                    if (restored) {
                        console.log(`🔄 Credential files restored from backup for ${this.sessionId.substring(0, 8)}...`);
                        logger.session(this.sessionId, 'Session successfully restored from backup');
                    } else {
                        logger.warn('Failed to restore session from backup', { sessionId: this.sessionId });
                    }
                }
            }
            
            // Load authentication state from auth subdirectory
            const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
            this.authState = state;
            this.saveCreds = saveCreds;
            this.isInitialized = true;

            logger.session(this.sessionId, 'Baileys session initialized successfully (lazy mode)');
            return true;
        } catch (error) {
            logger.error('Failed to initialize Baileys session (lazy mode)', { sessionId: this.sessionId, error: error.message });
            
            // NEW: If initialization fails, try to restore from backup as last resort
            if (!this.isRestoring) {
                logger.session(this.sessionId, 'Initialization failed, attempting backup restore as last resort');
                try {
                    const restored = await this.restoreSessionFromBackupSequential();
                    if (restored) {
                        logger.session(this.sessionId, 'Backup restore successful, retrying initialization');
                        // Retry initialization after successful restore
                        const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
                        this.authState = state;
                        this.saveCreds = saveCreds;
                        this.isInitialized = true;
                        logger.session(this.sessionId, 'Session initialized successfully after backup restore');
                        return true;
                    }
                } catch (restoreError) {
                    logger.error('Backup restore also failed', { 
                        sessionId: this.sessionId, 
                        restoreError: restoreError.message 
                    });
                }
            }
            
            throw error;
        }
    }

    // Connect to WhatsApp (creates socket and starts connection)
    async connect() {
        // CRITICAL: Prevent multiple concurrent connections
        if (this.isConnecting) {
            logger.session(this.sessionId, 'Connection already in progress, waiting for existing connection');
            if (this.connectionPromise) {
                return await this.connectionPromise;
            }
            // If no connection promise but isConnecting is true, wait a bit and retry
            await new Promise(resolve => setTimeout(resolve, 1000));
            return await this.connect();
        }
        
        // CRITICAL: Check if session is being destroyed
        if (this.isDestroying) {
            throw new Error('Session is being destroyed, cannot connect');
        }
        
        // CRITICAL: Check for socket creation lock
        if (this.socketCreateLock) {
            logger.session(this.sessionId, 'Socket creation locked, waiting...');
            let waitCount = 0;
            while (this.socketCreateLock && waitCount < 50) { // Max 5 seconds wait
                await new Promise(resolve => setTimeout(resolve, 100));
                waitCount++;
            }
            if (this.socketCreateLock) {
                throw new Error('Socket creation timeout - another process may be creating socket');
            }
        }
        
        this.isConnecting = true;
        this.socketCreateLock = true;
        
        // Create and store connection promise to prevent multiple connections
        this.connectionPromise = this._performConnection();
        
        try {
            const result = await this.connectionPromise;
            return result;
        } finally {
            this.isConnecting = false;
            this.socketCreateLock = false;
            this.connectionPromise = null;
        }
    }
    
    // Internal method to perform the actual connection
    async _performConnection() {
        try {
            if (!this.isInitialized) {
                await this.initializeWithoutConnection();
            }

            // ENHANCED: More aggressive socket cleanup before creating new one
            if (this.socket) {
                logger.session(this.sessionId, 'Destroying existing socket before creating new one', {
                    socketExists: !!this.socket,
                    socketReadyState: this.socket.readyState,
                    hasUser: !!this.socket.user
                });
                
                try {
                    // Clear all event listeners first to prevent race conditions
                    if (this.socket.ev) {
                        this.socket.ev.removeAllListeners();
                    }
                    
                    // CRITICAL FIX: Enhanced socket state checking and error handling
                    const socketReadyState = this.socket.readyState;
                    logger.session(this.sessionId, 'Socket cleanup - current state', {
                        readyState: socketReadyState,
                        stateNames: ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'],
                        currentStateName: ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][socketReadyState] || 'UNKNOWN'
                    });
                    
                    // Only attempt to close if socket is in a closeable state
                    if (typeof socketReadyState !== 'undefined') {
                        // WebSocket readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
                        if (socketReadyState === 0 || socketReadyState === 1) {
                            // Socket is CONNECTING or OPEN - safe to close
                            try {
                                logger.session(this.sessionId, 'Closing socket via close() method', { readyState: socketReadyState });
                                this.socket.close();
                            } catch (closeError) {
                                logger.warn('Error during socket.close()', { 
                                    sessionId: this.sessionId, 
                                    error: closeError.message,
                                    readyState: socketReadyState
                                });
                                // Try alternative cleanup method
                                try {
                                    logger.session(this.sessionId, 'Attempting socket.end() as fallback');
                                    this.socket.end();
                                } catch (endError) {
                                    logger.warn('Error during socket.end() fallback', { 
                                        sessionId: this.sessionId, 
                                        error: endError.message 
                                    });
                                }
                            }
                        } else if (socketReadyState === 2) {
                            // Socket is CLOSING - wait for it to close naturally
                            logger.session(this.sessionId, 'Socket already closing, waiting for completion');
                            let waitCount = 0;
                            while (this.socket.readyState === 2 && waitCount < 10) { // Max 1 second wait
                                await new Promise(resolve => setTimeout(resolve, 100));
                                waitCount++;
                            }
                            logger.session(this.sessionId, 'Socket close wait completed', { 
                                finalReadyState: this.socket.readyState,
                                waitTime: waitCount * 100 + 'ms'
                            });
                        } else if (socketReadyState === 3) {
                            // Socket is already CLOSED - no action needed
                            logger.session(this.sessionId, 'Socket already closed, no cleanup needed');
                        }
                    } else {
                        // Socket doesn't have readyState - try gentle cleanup
                        logger.session(this.sessionId, 'Socket without readyState, attempting gentle cleanup');
                        try {
                            // CRITICAL FIX: Enhanced gentle cleanup with state checking in _performConnection
                            if (this.socket && typeof this.socket.end === 'function') {
                                // Check if socket has internal state that would indicate it's safe to end
                                const hasInternalState = this.socket._socket || this.socket.readyState !== undefined;
                                
                                if (hasInternalState) {
                                    logger.session(this.sessionId, 'Socket has internal state, attempting end()');
                                    this.socket.end();
                                } else {
                                    logger.session(this.sessionId, 'Socket lacks internal state, skipping end() to prevent crash');
                                }
                            } else if (this.socket && typeof this.socket.close === 'function') {
                                // Try close as alternative
                                const hasInternalState = this.socket._socket || this.socket.readyState !== undefined;
                                
                                if (hasInternalState) {
                                    logger.session(this.sessionId, 'Socket has internal state, attempting close()');
                                    this.socket.close();
                                } else {
                                    logger.session(this.sessionId, 'Socket lacks internal state, skipping close() to prevent crash');
                                }
                            } else {
                                logger.session(this.sessionId, 'Socket lacks cleanup methods, skipping');
                            }
                        } catch (gentleCleanupError) {
                            logger.warn('Error during gentle socket cleanup', { 
                                sessionId: this.sessionId, 
                                error: gentleCleanupError.message,
                                errorType: gentleCleanupError.constructor.name
                            });
                        }
                    }
                    
                    // Add delay to ensure cleanup completion
                    await new Promise(resolve => setTimeout(resolve, 500));
                    
                } catch (cleanupError) {
                    // Comprehensive error logging but don't let it crash the process
                    logger.error('Socket cleanup failed - continuing with new socket creation', { 
                        sessionId: this.sessionId, 
                        error: cleanupError.message,
                        errorType: cleanupError.constructor.name,
                        socketExists: !!this.socket,
                        socketReadyState: this.socket?.readyState
                    });
                }
                
                // Always clear the socket reference regardless of cleanup success
                this.socket = null;
            }

            logger.session(this.sessionId, 'Creating WhatsApp socket and connecting');
            
            // Create WhatsApp socket
            this.socket = makeWASocket({
                auth: this.authState,
                logger: {
                    level: 'silent',
                    trace: () => {},
                    debug: () => {},
                    info: () => {},
                    warn: () => {},
                    error: () => {},
                    fatal: () => {},
                    child: () => ({
                        level: 'silent',
                        trace: () => {},
                        debug: () => {},
                        info: () => {},
                        warn: () => {},
                        error: () => {},
                        fatal: () => {}
                    })
                },
                browser: ['WhatsApp API', 'Chrome', '1.0.0'],
                generateHighQualityLinkPreview: true,
                markOnlineOnConnect: false,
                // ENHANCED: Connection options for better stability and conflict prevention
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 60000,
                keepAliveIntervalMs: 30000, // Increased from 10s to 30s
                // Reduce memory usage
                shouldSyncHistoryMessage: () => false,
                shouldIgnoreJid: jid => isJidBroadcast(jid) || isJidStatusBroadcast(jid) || isJidNewsletter(jid),
                // CRITICAL: Add connection conflict prevention
                printQRInTerminal: false, // Prevent terminal QR conflicts
                qrTimeout: 20000, // 20 second QR timeout
                // Add socket options for stability
                socketConfig: {
                    timeout: 60000
                }
            });

            this.setupEventHandlers();
            
            logger.session(this.sessionId, 'WhatsApp socket created and connection started');
            return true;
        } catch (error) {
            logger.error('Failed to connect Baileys session', { sessionId: this.sessionId, error: error.message });
            throw error;
        }
    }

    async initialize() {
        // Check if we should auto-connect or just do lazy initialization
        if (this.autoConnect) {
            return await this.connect();
        } else {
            return await this.initializeWithoutConnection();
        }
    }

    setupEventHandlers() {
        // Add error handler for the socket
        this.socket.ev.on('connection.update', async (update) => {
            try {
                const { connection, lastDisconnect, qr } = update;
                
                // Log socket state changes for debugging
                if (this.socket && this.socket.readyState !== undefined) {
                    const stateNames = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
                    const stateName = stateNames[this.socket.readyState] || 'UNKNOWN';
                    logger.session(this.sessionId, `Socket readyState: ${this.socket.readyState} (${stateName})`, {
                        connection,
                        hasQR: !!qr
                    });
                }
                
                if (qr) {
                    try {
                        // Check if we should prevent QR regeneration during authentication
                        if (this.preventQRRegeneration && this.qrCodeData) {
                            logger.session(this.sessionId, 'QR regeneration prevented - authentication in progress', {
                                isAuthenticating: this.isAuthenticating,
                                qrCodeScanned: this.qrCodeScanned,
                                authStartTime: this.authenticationStartTime
                            });
                            return; // Don't generate new QR during authentication
                        }
                        
                        this.qrCodeString = qr; // Store original QR string for terminal display
                        this.qrCodeData = await QRCode.toDataURL(qr);
                        this.qrCodeTimestamp = Date.now(); // Track when QR was generated for expiry
                        this.lastQRCodeGenerated = qr; // Store for comparison
                        
                        // NEW: Start authentication tracking immediately when QR is generated
                        this.isAuthenticating = false; // Reset but will be set if scanned
                        this.qrCodeScanned = false; // Reset but will be set if scanned  
                        this.authenticationStartTime = Date.now(); // Track QR generation time
                        this.preventQRRegeneration = false; // Reset
                        
                        logger.session(this.sessionId, 'QR code generated', {
                            socketState: this.socket?.readyState,
                            displayMode: this.displayQRInTerminal,
                            isAPIRequest: this.isAPIRequest,
                            qrTimestamp: this.qrCodeTimestamp
                        });
                        
                        // NEW: Set up early authentication detection
                        // If stream error occurs within 30 seconds of QR generation, likely user scanned
                        setTimeout(() => {
                            // If we're still not connected and QR was generated recently, assume it might be scanned
                            if (!this.isConnected && this.qrCodeData && 
                                (Date.now() - this.qrCodeTimestamp < 30000)) {
                                logger.session(this.sessionId, 'QR may have been scanned - enabling early auth detection', {
                                    qrAge: Date.now() - this.qrCodeTimestamp,
                                    socketState: this.socket?.readyState
                                });
                                // Enable protection in case of stream error
                                this.isAuthenticating = true;
                                this.preventQRRegeneration = true;
                            }
                        }, 5000); // Check after 5 seconds
                        
                        // NEW: Authentication timeout mechanism to prevent stuck authentication
                        setTimeout(() => {
                            // Check if authentication is stuck after 60 seconds
                            if (this.isAuthenticating && !this.isConnected && this.qrCodeTimestamp) {
                                const authDuration = Date.now() - this.qrCodeTimestamp;
                                
                                if (authDuration > 60000) { // 60 seconds timeout
                                    logger.session(this.sessionId, 'Authentication timeout - forcing reset', {
                                        authDuration: authDuration,
                                        qrAge: authDuration,
                                        socketExists: !!this.socket,
                                        socketState: this.socket?.readyState,
                                        reason: 'Authentication stuck for > 60s'
                                    });
                                    
                                    // Force reset authentication state
                                    this.clearAuthenticationState();
                                    
                                    // Try to restart the socket completely
                                    if (this.socket) {
                                        try {
                                            // CRITICAL FIX: Safe socket cleanup in auth timeout
                                            const socketReadyState = this.socket.readyState;
                                            logger.session(this.sessionId, 'Auth timeout socket cleanup', {
                                                readyState: socketReadyState,
                                                stateNames: ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'],
                                                currentStateName: ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][socketReadyState] || 'UNKNOWN'
                                            });
                                            
                                            if (typeof socketReadyState !== 'undefined') {
                                                if (socketReadyState === 0 || socketReadyState === 1) {
                                                    // Socket is CONNECTING or OPEN - safe to close
                                                    this.socket.close();
                                                } else if (socketReadyState === 2) {
                                                    // Socket is CLOSING - wait briefly
                                                    logger.session(this.sessionId, 'Auth timeout: socket already closing');
                                                } else if (socketReadyState === 3) {
                                                    // Socket is already CLOSED
                                                    logger.session(this.sessionId, 'Auth timeout: socket already closed');
                                                }
                                            } else {
                                                // Socket without readyState - try gentle cleanup
                                                // CRITICAL FIX: Enhanced gentle cleanup with state checking in auth timeout
                                                if (this.socket && typeof this.socket.end === 'function') {
                                                    // Check if socket has internal state that would indicate it's safe to end
                                                    const hasInternalState = this.socket._socket || this.socket.readyState !== undefined;
                                                    
                                                    if (hasInternalState) {
                                                        logger.session(this.sessionId, 'Auth timeout: Socket has internal state, attempting end()');
                                                        this.socket.end();
                                                    } else {
                                                        logger.session(this.sessionId, 'Auth timeout: Socket lacks internal state, skipping end() to prevent crash');
                                                    }
                                                } else if (this.socket && typeof this.socket.close === 'function') {
                                                    // Try close as alternative
                                                    const hasInternalState = this.socket._socket || this.socket.readyState !== undefined;
                                                    
                                                    if (hasInternalState) {
                                                        logger.session(this.sessionId, 'Auth timeout: Socket has internal state, attempting close()');
                                                        this.socket.close();
                                                    } else {
                                                        logger.session(this.sessionId, 'Auth timeout: Socket lacks internal state, skipping close() to prevent crash');
                                                    }
                                                } else {
                                                    logger.session(this.sessionId, 'Auth timeout: Socket lacks cleanup methods, skipping');
                                                }
                                            }
                                        } catch (authTimeoutError) {
                                            logger.warn('Error during auth timeout socket cleanup', {
                                                sessionId: this.sessionId,
                                                error: authTimeoutError.message,
                                                socketExists: !!this.socket,
                                                socketReadyState: this.socket?.readyState
                                            });
                                        }
                                        this.socket = null;
                                    }
                                    
                                    // Clear QR data to force fresh start on next request
                                    this.qrCodeData = null;
                                    this.qrCodeString = null;
                                    this.qrCodeTimestamp = null;
                                    
                                    logger.session(this.sessionId, 'Authentication reset completed - ready for fresh QR');
                                }
                            }
                        }, 65000); // Check after 65 seconds
                        
                        // Only display QR in terminal if explicitly requested
                        if (this.displayQRInTerminal) {
                            // Enhanced QR code display in terminal with LARGE size
                            const displayTitle = this.isAPIRequest ? 
                                '🌐 API QR CODE REQUEST - SCAN WITH YOUR PHONE' : 
                                '📱 WHATSAPP QR CODE - SCAN WITH YOUR PHONE';
                            
                            console.log('\n' + '='.repeat(80));
                            console.log(displayTitle);
                            console.log(`🔗 Session ID: ${this.sessionId.substring(0, 8)}...`);
                            console.log(`🔌 Socket State: ${this.socket?.readyState} (${['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][this.socket?.readyState] || 'UNKNOWN'})`);
                            if (this.isAPIRequest) {
                                console.log(`📡 API Requested: ${new Date().toLocaleTimeString()}`);
                            }
                            console.log('⚠️  DO NOT SCAN MULTIPLE TIMES - Wait for connection!');
                            console.log('='.repeat(80));
                            
                            // Display large QR code in terminal
                            QRCode.toString(qr, { 
                                type: 'terminal',
                                width: 60,           // Make it wider
                                margin: 2,           // Add margin
                                small: false         // Use full block characters for better visibility
                            }, (err, qrTerminal) => {
                                if (!err && qrTerminal) {
                                    console.log(qrTerminal);
                                } else if (err) {
                                    logger.error('Error generating terminal QR', { sessionId: this.sessionId, error: err.message });
                                }
                            });
                            
                            console.log('📋 QR Code is displayed above this message');
                            console.log('⏱️  QR Code expires in ~20 seconds');
                            console.log('🚨 SCAN ONLY ONCE - Multiple scans will fail!');
                            if (!this.isAPIRequest) {
                                console.log('🔄 A new QR will generate automatically if needed');
                            }
                            console.log('='.repeat(80) + '\n');
                        } else {
                            logger.session(this.sessionId, 'QR code generated (terminal display disabled)');
                        }
                        
                    } catch (error) {
                        logger.error('Failed to generate QR code', { sessionId: this.sessionId, error: error.message });
                    }
                }

                if (connection === 'close') {
                    const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    
                    logger.session(this.sessionId, 'Connection closed', { 
                        reason: statusCode,
                        shouldReconnect,
                        error: lastDisconnect?.error?.message,
                        socketState: this.socket?.readyState,
                        isAuthenticating: this.isAuthenticating,
                        qrCodeScanned: this.qrCodeScanned
                    });

                    this.isConnected = false;
                    await this.updateSessionStatus('disconnected').catch(err => {
                        logger.error('Error updating session status to disconnected', { sessionId: this.sessionId, error: err.message });
                    });

                    // Enhanced disconnect handling with authentication state preservation
                    if (statusCode === DisconnectReason.loggedOut) {
                        logger.session(this.sessionId, 'Session logged out - analyzing reason and attempting recovery');
                        
                        // CRITICAL FIX: Track consecutive logout attempts to detect invalid credentials
                        if (!this.consecutiveLogoutAttempts) {
                            this.consecutiveLogoutAttempts = 0;
                        }
                        this.consecutiveLogoutAttempts++;
                        
                        logger.session(this.sessionId, `Logout attempt ${this.consecutiveLogoutAttempts}`, {
                            totalAttempts: this.consecutiveLogoutAttempts,
                            lastActivity: this.lastActivity,
                            socketState: this.socket?.readyState
                        });
                        
                        // ENHANCED: If we have multiple consecutive logout attempts, credentials are likely invalid
                        if (this.consecutiveLogoutAttempts >= 3) {
                            logger.session(this.sessionId, 'Multiple consecutive logout attempts detected - credentials likely invalid on WhatsApp servers');
                            
                            // Force complete session reset - clear all auth data
                            try {
                                // Clear local auth files
                                if (fs.existsSync(this.authDir)) {
                                    const authFiles = fs.readdirSync(this.authDir);
                                    for (const file of authFiles) {
                                        try {
                                            fs.unlinkSync(path.join(this.authDir, file));
                                            logger.session(this.sessionId, `Cleared invalid auth file: ${file}`);
                                        } catch (unlinkError) {
                                            logger.warn('Error clearing auth file', {
                                                sessionId: this.sessionId,
                                                file,
                                                error: unlinkError.message
                                            });
                                        }
                                    }
                                }
                                
                                // Reset authentication state
                                this.authState = null;
                                this.saveCreds = null;
                                this.isInitialized = false;
                                this.clearAuthenticationState();
                                this.consecutiveLogoutAttempts = 0;
                                this.retryCount = 0;
                                
                                // Update status to require fresh QR scan
                                await this.updateSessionStatus('requires_qr').catch(() => {});
                                
                                console.log(`🔄 Session ${this.sessionId.substring(0, 8)}... reset - QR scan required`);
                                logger.session(this.sessionId, 'Session completely reset due to invalid credentials - requires fresh QR scan');
                                
                                return; // Don't attempt any more restoration
                                
                            } catch (resetError) {
                                logger.error('Error during forced session reset', {
                                    sessionId: this.sessionId,
                                    error: resetError.message
                                });
                            }
                        }
                        
                        // CRITICAL FIX: Try backup restoration but with validation
                        try {
                            // First validate current auth files
                            const authValidation = await this.validateAuthFiles();
                            
                            if (!authValidation.valid) {
                                logger.session(this.sessionId, `Auth files corrupted after logout: ${authValidation.reason}`);
                                
                                // Check if we have backups available
                                const hasValidBackup = fs.existsSync(path.join(this.backupDir, 'latest')) ||
                                                     (fs.existsSync(this.backupDir) && 
                                                      fs.readdirSync(this.backupDir).some(dir => dir.startsWith('backup_')));

                                if (hasValidBackup) {
                                    logger.session(this.sessionId, 'Attempting backup restoration after logout');
                                    const restored = await this.restoreSessionFromBackupSequential();
                                    
                                    if (restored) {
                                        console.log(`🔄 Session restored from backup after logout: ${this.sessionId.substring(0, 8)}...`);
                                        logger.session(this.sessionId, 'Backup restoration successful - attempting reconnection');
                                        
                                        // Reset consecutive attempts counter on successful restore
                                        this.consecutiveLogoutAttempts = 0;
                                        this.retryCount = 0;
                                        
                                        // Wait before attempting reconnection to avoid immediate 401
                                        setTimeout(() => {
                                            if (!this.isConnecting) {
                                                this.connect().catch(error => {
                                                    logger.error('Reconnection after backup restoration failed', {
                                                        sessionId: this.sessionId,
                                                        error: error.message
                                                    });
                                                    
                                                    // If reconnection fails immediately with 401, mark credentials as invalid
                                                    if (error.message.includes('401') || error.message.includes('loggedOut')) {
                                                        this.consecutiveLogoutAttempts++;
                                                        logger.session(this.sessionId, 'Immediate 401 after restore - backup may contain invalid credentials');
                                                    }
                                                });
                                            }
                                        }, 5000); // Wait 5 seconds before reconnecting
                                        
                                        return; // Don't proceed to logged_out status
                                    } else {
                                        logger.error('Backup restoration failed after logout', { 
                                            sessionId: this.sessionId 
                                        });
                                    }
                                } else {
                                    logger.warn('No backups available for restoration after logout', { 
                                        sessionId: this.sessionId 
                                    });
                                }
                            } else {
                                logger.session(this.sessionId, 'Auth files appear valid despite logout - testing with limited reconnection');
                                
                                // ENHANCED: Limited reconnection attempts for apparently valid auth files
                                if (this.consecutiveLogoutAttempts <= 2) {
                                    this.retryCount = 0;
                                    
                                    // Wait longer before retry to avoid hitting rate limits
                                    const retryDelay = Math.min(3000 * this.consecutiveLogoutAttempts, 10000);
                                    
                                    setTimeout(() => {
                                        if (!this.isConnecting) {
                                            logger.session(this.sessionId, `Testing reconnection attempt ${this.consecutiveLogoutAttempts} with ${retryDelay}ms delay`);
                                            this.connect().catch(error => {
                                                logger.error('Test reconnection after logout failed', {
                                                    sessionId: this.sessionId,
                                                    error: error.message,
                                                    attempt: this.consecutiveLogoutAttempts
                                                });
                                            });
                                        }
                                    }, retryDelay);
                                    
                                    return; // Don't proceed to logged_out immediately
                                } else {
                                    logger.session(this.sessionId, 'Multiple reconnection attempts failed - auth files likely invalid despite appearing valid');
                                }
                            }
                            
                        } catch (restoreError) {
                            logger.error('Error during backup restoration attempt after logout', {
                                sessionId: this.sessionId,
                                error: restoreError.message
                            });
                        }
                        
                        // Mark as logged out only after all attempts fail
                        logger.session(this.sessionId, 'All recovery attempts exhausted - marking as logged out');
                        await this.updateSessionStatus('logged_out').catch(() => {});
                        this.clearAuthenticationState();
                    } else if (statusCode === DisconnectReason.restartRequired) {
                        logger.session(this.sessionId, 'WhatsApp restart required, attempting reconnection');
                        
                        // ENHANCED: Auto-detect authentication based on timing
                        const qrAge = this.qrCodeTimestamp ? Date.now() - this.qrCodeTimestamp : null;
                        const recentQRGenerated = qrAge && qrAge < 30000; // QR generated within last 30 seconds
                        
                        // CRITICAL: Preserve authentication state during restart
                        if (this.isAuthenticating || this.qrCodeScanned || recentQRGenerated) {
                            if (recentQRGenerated && !this.isAuthenticating) {
                                logger.session(this.sessionId, 'STREAM ERROR detected shortly after QR generation - AUTO-DETECTING authentication', {
                                    qrAge: qrAge,
                                    timeFromQR: `${Math.round(qrAge / 1000)}s`,
                                    autoDetected: true
                                });
                                // Auto-set authentication flags based on timing
                                this.isAuthenticating = true;
                                this.qrCodeScanned = true;
                            }
                            
                            logger.session(this.sessionId, 'PRESERVING authentication state during restart', {
                                isAuthenticating: this.isAuthenticating,
                                qrCodeScanned: this.qrCodeScanned,
                                hasQRData: !!this.qrCodeData,
                                qrAge: qrAge,
                                autoDetected: recentQRGenerated,
                                authDuration: this.authenticationStartTime ? Date.now() - this.authenticationStartTime : null
                            });
                            
                            // Set flag to prevent QR regeneration
                            this.preventQRRegeneration = true;
                            
                        } else {
                            logger.session(this.sessionId, 'No authentication in progress detected', {
                                qrAge: qrAge,
                                hasQRData: !!this.qrCodeData,
                                recentQR: recentQRGenerated
                            });
                        }
                        
                        this.retryCount = 0; // Reset retry count for restart scenarios
                        
                        // CRITICAL: Add delay and prevent multiple reconnection attempts
                        if (!this.isConnecting) {
                            setTimeout(() => {
                                // Enhanced reconnection for authentication scenarios
                                if (this.isAuthenticating || this.preventQRRegeneration) {
                                    logger.session(this.sessionId, 'Resuming authentication after stream error', {
                                        isAuthenticating: this.isAuthenticating,
                                        qrAge: qrAge,
                                        autoDetected: recentQRGenerated
                                    });
                                    
                                    // For authentication scenarios, reconnect more aggressively
                                    this.connect().catch(error => {
                                        logger.error('Authentication resume connection failed', { 
                                            sessionId: this.sessionId, 
                                            error: error.message 
                                        });
                                        
                                        // If connection fails during authentication, try once more
                                        setTimeout(() => {
                                            this.connect().catch(finalError => {
                                                logger.error('Final authentication resume failed', {
                                                    sessionId: this.sessionId,
                                                    error: finalError.message
                                                });
                                                // Clear authentication state if all attempts fail
                                                this.clearAuthenticationState();
                                            });
                                        }, 3000);
                                    });
                                } else {
                                    // Normal initialization for non-authentication scenarios
                                    this.initialize().catch(error => {
                                        logger.error('Restart reconnection failed', { sessionId: this.sessionId, error: error.message });
                                    });
                                }
                            }, 2000);
                        } else {
                            logger.session(this.sessionId, 'Connection already in progress, skipping restart attempt');
                        }
                    } else if (statusCode === 440) {
                        // CRITICAL: Handle Stream Conflict (440) properly
                        this.streamConflictCount++;
                        this.lastStreamConflictTime = Date.now();
                        
                        logger.session(this.sessionId, `Stream conflict detected (${this.streamConflictCount}/${this.maxStreamConflicts})`, {
                            conflictCount: this.streamConflictCount,
                            lastConflictTime: this.lastStreamConflictTime,
                            error: lastDisconnect?.error?.message
                        });
                        
                        // If too many conflicts, force a longer cooldown and reset
                        if (this.streamConflictCount >= this.maxStreamConflicts) {
                            logger.session(this.sessionId, 'Maximum stream conflicts reached, forcing cooldown and reset');
                            
                            // Clear authentication state
                            this.clearAuthenticationState();
                            
                            // Destroy socket completely
                            if (this.socket) {
                                try {
                                    this.socket.ev.removeAllListeners();
                                    
                                    // CRITICAL FIX: Safe socket cleanup in stream conflict handling
                                    const socketReadyState = this.socket.readyState;
                                    
                                    if (typeof socketReadyState !== 'undefined') {
                                        if (socketReadyState === 0 || socketReadyState === 1) {
                                            // Socket is CONNECTING or OPEN - safe to end
                                            logger.session(this.sessionId, 'Stream conflict: Socket in safe state, calling end()');
                                            this.socket.end();
                                        } else {
                                            logger.session(this.sessionId, 'Stream conflict: Socket not in safe state, skipping end()', {
                                                readyState: socketReadyState,
                                                stateName: ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][socketReadyState] || 'UNKNOWN'
                                            });
                                        }
                                    } else {
                                        // Socket doesn't have readyState - check for internal state
                                        const hasInternalState = this.socket._socket || this.socket.readyState !== undefined;
                                        
                                        if (hasInternalState) {
                                            logger.session(this.sessionId, 'Stream conflict: Socket has internal state, attempting end()');
                                            this.socket.end();
                                        } else {
                                            logger.session(this.sessionId, 'Stream conflict: Socket lacks internal state, skipping end() to prevent crash');
                                        }
                                    }
                                } catch (e) {
                                    // Ignore errors
                                    logger.warn('Error during stream conflict socket cleanup', {
                                        sessionId: this.sessionId,
                                        error: e.message
                                    });
                                }
                                this.socket = null;
                            }
                            
                            // Force cooldown
                            setTimeout(() => {
                                logger.session(this.sessionId, 'Stream conflict cooldown completed, resetting conflict count');
                                this.streamConflictCount = 0;
                                this.lastStreamConflictTime = null;
                            }, this.streamConflictCooldown);
                            
                            await this.updateSessionStatus('failed').catch(() => {});
                            return; // Don't attempt reconnection
                        }
                        
                        // For fewer conflicts, wait longer before reconnecting
                        const conflictDelay = Math.min(5000 * this.streamConflictCount, 30000); // 5s, 10s, 15s max
                        
                        if (!this.isConnecting) {
                            setTimeout(() => {
                                if (this.streamConflictCount < this.maxStreamConflicts) {
                                    logger.session(this.sessionId, `Attempting reconnection after stream conflict (delay: ${conflictDelay}ms)`);
                                    this.initialize().catch(error => {
                                        logger.error('Stream conflict reconnection failed', { sessionId: this.sessionId, error: error.message });
                                    });
                                }
                            }, conflictDelay);
                        }
                    } else if (statusCode === DisconnectReason.connectionClosed || 
                              statusCode === DisconnectReason.connectionLost ||
                              statusCode === DisconnectReason.timedOut) {
                        // Common network issues - preserve authentication state if active
                        if (this.isAuthenticating || this.qrCodeScanned) {
                            logger.session(this.sessionId, 'Network error during authentication - preserving state', {
                                isAuthenticating: this.isAuthenticating,
                                qrCodeScanned: this.qrCodeScanned
                            });
                            this.preventQRRegeneration = true;
                        }
                        
                        if (this.retryCount < this.maxRetries) {
                            this.retryCount++;
                            const backoffTime = Math.min(1000 * Math.pow(2, this.retryCount - 1), 30000); // Max 30 seconds
                            logger.session(this.sessionId, `Network disconnection, retrying in ${backoffTime}ms (${this.retryCount}/${this.maxRetries})`);
                            
                            setTimeout(() => {
                                this.initialize().catch(error => {
                                    logger.error('Network reconnection failed', { sessionId: this.sessionId, error: error.message });
                                });
                            }, backoffTime);
                        } else {
                            logger.session(this.sessionId, 'Max network retry attempts reached');
                            await this.updateSessionStatus('failed').catch(() => {});
                            this.clearAuthenticationState();
                        }
                    } else if (shouldReconnect && this.retryCount < this.maxRetries) {
                        // Preserve authentication state during general reconnections
                        if (this.isAuthenticating || this.qrCodeScanned) {
                            logger.session(this.sessionId, 'General error during authentication - preserving state');
                            this.preventQRRegeneration = true;
                        }
                        
                        this.retryCount++;
                        logger.session(this.sessionId, `Attempting reconnection (${this.retryCount}/${this.maxRetries})`);
                        setTimeout(() => {
                            this.initialize().catch(error => {
                                logger.error('Reconnection failed', { sessionId: this.sessionId, error: error.message });
                            });
                        }, 5000);
                    } else if (this.retryCount >= this.maxRetries) {
                        logger.session(this.sessionId, 'Max retry attempts reached, stopping reconnection');
                        await this.updateSessionStatus('failed').catch(() => {});
                        this.clearAuthenticationState();
                    }
                } else if (connection === 'open') {
                    this.isConnected = true;
                    this.retryCount = 0;
                    
                    // SUCCESS: Clear all authentication state
                    this.clearAuthenticationState();
                    this.qrCodeData = null;
                    this.qrCodeString = null; // Clear QR string when connected
                    this.qrCodeTimestamp = null; // Clear QR timestamp when connected
                    
                    // CRITICAL: Reset consecutive logout attempts on successful connection
                    this.consecutiveLogoutAttempts = 0;
                    
                    console.log('\n' + '🎉'.repeat(20));
                    console.log('✅ WHATSAPP SESSION CONNECTED SUCCESSFULLY!');
                    console.log(`📱 Session ID: ${this.sessionId.substring(0, 8)}...`);
                    console.log('🚀 Ready to send and receive messages');
                    console.log('🔄 Auto-refresh monitoring active');
                    console.log('🎉'.repeat(20) + '\n');
                    
                    logger.session(this.sessionId, 'Session connected successfully');
                    await this.updateSessionStatus('connected').catch(err => {
                        logger.error('Error updating session status to connected', { sessionId: this.sessionId, error: err.message });
                    });

                    // NEW: Create initial backup on successful connection
                    setTimeout(async () => {
                        try {
                            logger.session(this.sessionId, 'Creating initial backup after successful connection');
                            const backupCreated = await this.createSessionBackup();
                            if (backupCreated) {
                                console.log(`💾 Credential backup created for ${this.sessionId.substring(0, 8)}...`);
                            }
                        } catch (backupError) {
                            logger.error('Error creating initial backup', { 
                                sessionId: this.sessionId, 
                                error: backupError.message 
                            });
                        }
                    }, 5000); // Wait 5 seconds after connection to ensure stability
                } else if (connection === 'connecting') {
                    console.log(`\n🔄 Connecting to WhatsApp... (Session: ${this.sessionId.substring(0, 8)}...)\n`);
                    logger.session(this.sessionId, 'Connecting to WhatsApp...');
                    
                    // CRITICAL: Detect if this is authentication in progress
                    if (this.qrCodeData && !this.isConnected) {
                        logger.session(this.sessionId, 'AUTHENTICATION IN PROGRESS detected - marking state', {
                            hasQRData: !!this.qrCodeData,
                            qrAge: this.qrCodeTimestamp ? Date.now() - this.qrCodeTimestamp : null
                        });
                        
                        this.isAuthenticating = true;
                        this.qrCodeScanned = true;
                        this.authenticationStartTime = Date.now();
                        this.preventQRRegeneration = true;
                    }
                    
                    await this.updateSessionStatus('connecting').catch(err => {
                        logger.error('Error updating session status to connecting', { sessionId: this.sessionId, error: err.message });
                    });
                }
            } catch (error) {
                logger.error('Error in connection.update handler', { sessionId: this.sessionId, error: error.message, stack: error.stack });
            }
        });

        // Enhanced error handling for socket events
        this.socket.ev.on('messaging.update', (update) => {
            try {
                // Handle message updates if needed
                logger.session(this.sessionId, 'Message update received', { update: update.length || 'unknown' });
            } catch (error) {
                logger.error('Error in messaging.update handler', { sessionId: this.sessionId, error: error.message });
            }
        });

        // Add socket error handler
        this.socket.ev.on('socket.error', (error) => {
            logger.error('Socket error occurred', { sessionId: this.sessionId, error: error.message });
        });

        // Credentials update with error handling
        this.socket.ev.on('creds.update', async () => {
            try {
                if (this.saveCreds) {
                    await this.saveCreds();
                }
            } catch (error) {
                logger.error('Error saving credentials', { sessionId: this.sessionId, error: error.message });
            }
        });

        // Message handling
        this.socket.ev.on('messages.upsert', async (messageInfo) => {
            try {
                const { messages, type } = messageInfo;
                
                if (type === 'notify' && Array.isArray(messages)) {
                    for (let i = 0; i < messages.length; i++) {
                        const message = messages[i];
                        
                        try {
                            // Keep all the filtering logic but remove debug logging
                            if (message?.key) {
                                const hasMessage = !!message;
                                const hasKey = !!message.key;
                                const notBroadcast = !isJidBroadcast(message.key.remoteJid);
                                const notStatusBroadcast = !isJidStatusBroadcast(message.key.remoteJid);
                                const notNewsletter = !isJidNewsletter(message.key.remoteJid);
                                const notGroup = !message.key.remoteJid?.endsWith('@g.us'); // Exclude group messages
                                
                                const shouldProcess = hasMessage && hasKey && notBroadcast && notStatusBroadcast && notNewsletter && notGroup;
                                
                                if (shouldProcess) {
                                    await this.handleIncomingMessage(message);
                                }
                            }
                        } catch (messageError) {
                            logger.error('Error handling individual message', { 
                                sessionId: this.sessionId, 
                                messageId: message?.key?.id,
                                error: messageError.message 
                            });
                        }
                    }
                }
                
            } catch (error) {
                logger.error('Error handling incoming message batch', { sessionId: this.sessionId, error: error.message });
            }
        });

        // Remove extensive debug logging for event listener setup
        
        // Add a heartbeat to check if the session is still alive
        // CRITICAL: Clear existing heartbeat to prevent multiple timers
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        
        this.heartbeatInterval = setInterval(() => {
            // Only log heartbeat if session is not being destroyed
            if (!this.isDestroying) {
                console.log(`💓 Session Heartbeat [${this.sessionId}]:`, {
                    connected: this.isConnected,
                    socketExists: !!this.socket,
                    socketReadyState: this.socket?.readyState,
                    hasUser: !!this.socket?.user,
                    timestamp: new Date().toISOString()
                });

                // NEW: Enhanced heartbeat with session health check and backup
                this.checkSessionHealth().catch(error => {
                    logger.error('Error in heartbeat session health check', { 
                        sessionId: this.sessionId, 
                        error: error.message 
                    });
                });
            }
        }, 30000); // Every 30 seconds
        
        // CRITICAL: Fix destroy method to prevent multiple definitions
        // Only override destroy method once
        if (!this._destroyMethodOverridden) {
            const originalDestroy = this.destroy.bind(this);
            this.destroy = async () => {
                console.log(`🧹 Cleaning up heartbeat for session: ${this.sessionId}`);
                this.isDestroying = true; // Set destroying flag
                
                if (this.heartbeatInterval) {
                    clearInterval(this.heartbeatInterval);
                    this.heartbeatInterval = null;
                }
                
                // NEW: Backup system cleanup
                this.backupEnabled = false; // Disable backup system
                this.isRestoring = false; // Clear restore flag
                this.lastBackupTime = null; // Clear backup timestamp
                this.backupRetryCount = 0; // Reset backup retry count
                
                return await originalDestroy();
            };
            this._destroyMethodOverridden = true;
        }

        // Group updates
        this.socket.ev.on('groups.update', (updates) => {
            try {
                if (Array.isArray(updates)) {
                    logger.session(this.sessionId, 'Groups updated', { count: updates.length });
                }
            } catch (error) {
                logger.error('Error handling groups update', { sessionId: this.sessionId, error: error.message });
            }
        });

        // Contacts update
        this.socket.ev.on('contacts.update', (updates) => {
            try {
                if (Array.isArray(updates)) {
                    logger.session(this.sessionId, 'Contacts updated', { count: updates.length });
                }
            } catch (error) {
                logger.error('Error handling contacts update', { sessionId: this.sessionId, error: error.message });
            }
        });

        // Add generic error handlers for the socket
        this.socket.ev.on('connection.error', (error) => {
            logger.error('Socket connection error', { sessionId: this.sessionId, error: error?.message || 'Unknown error' });
        });

        // Handle any other unhandled socket events
        this.socket.ev.on('error', (error) => {
            logger.error('Socket error', { sessionId: this.sessionId, error: error?.message || 'Unknown error' });
        });

        // Handle process errors to prevent crashes - but only set once per process
        if (!global.processListenersSet) {
            process.on('unhandledRejection', (reason, promise) => {
                logger.error('Unhandled Rejection', { 
                    reason: reason?.message || reason, 
                    stack: reason?.stack,
                    name: reason?.name,
                    code: reason?.code,
                    promise: promise?.toString() || 'Unknown promise'
                });
            });

            process.on('uncaughtException', (error) => {
                logger.error('Uncaught Exception', { 
                    error: error?.message || 'Unknown error',
                    stack: error?.stack,
                    name: error?.name,
                    code: error?.code
                });
            });

            // Add warning handler
            process.on('warning', (warning) => {
                logger.warn('Process Warning', {
                    name: warning.name,
                    message: warning.message,
                    stack: warning.stack
                });
            });

            // Mark that process listeners are set
            global.processListenersSet = true;
        }
    }

    async handleIncomingMessage(message) {
        try {
            // Check message direction first
            const isIncoming = !message.key.fromMe;
            const isOutgoing = message.key.fromMe;
            
            if (!message || !message.key) {
                logger.warn('Invalid message received', { sessionId: this.sessionId });
                return;
            }

            // Detect app type from message structure (keep logic, remove detailed logging)
            let appType = 'unknown';
            let deviceInfo = {};
            
            if (message.verifiedBizName) {
                appType = 'WhatsApp Business (Verified)';
            } else if (message.bizPrivacyStatus) {
                appType = 'WhatsApp Business';
            } else if (message.deviceSentMeta || message.deviceInfo) {
                appType = 'WhatsApp Business';
            } else {
                appType = 'Regular WhatsApp';
            }
            
            // Extract device and app information if available
            if (message.deviceSentMeta) {
                deviceInfo.deviceSentMeta = message.deviceSentMeta;
            }
            if (message.userReceipt) {
                deviceInfo.userReceipt = message.userReceipt;
            }

            // Extract message content
            const extractedContent = this.extractMessageContent(message);
            
            // SIMPLIFIED LOGGING: Only log incoming messages with session ID and content
            if (isIncoming) {
                console.log(`📥 [${this.sessionId}] Incoming: ${extractedContent.content || extractedContent.type}`);
            }

            const sessionData = await this.database.getSession(this.sessionId);
            
            // Only process webhooks for INCOMING messages
            if (isIncoming && sessionData && sessionData.webhook_status && sessionData.webhook_url) {
                const messageData = {
                    sessionId: this.sessionId,
                    messageId: message.key.id,
                    remoteJid: message.key.remoteJid,
                    fromMe: message.key.fromMe,
                    timestamp: message.messageTimestamp,
                    message: extractedContent,
                    participant: message.key.participant || null,
                    pushName: message.pushName || null,
                    appType: appType,
                    deviceInfo: deviceInfo,
                    messageMetadata: {
                        verifiedBizName: message.verifiedBizName,
                        bizPrivacyStatus: message.bizPrivacyStatus,
                        messageStubType: message.messageStubType,
                        messageStubParameters: message.messageStubParameters,
                        quotedMessage: message.message?.extendedTextMessage?.contextInfo?.quotedMessage ? true : false,
                        mentions: message.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
                    }
                };

                try {
                    const webhookResult = await this.webhookManager.sendWebhook(sessionData.webhook_url, messageData);
                    // SIMPLIFIED WEBHOOK LOGGING: Just log success with response
                    console.log(`✅ Webhook sent successfully - Status: ${webhookResult.status}`);
                } catch (webhookError) {
                    logger.error('Error sending webhook for message', { 
                        sessionId: this.sessionId, 
                        messageId: message.key.id,
                        error: webhookError.message,
                        appType: appType
                    });
                }
            }

            // Auto-read functionality (only for incoming messages)
            if (isIncoming && sessionData && sessionData.auto_read) {
                try {
                    await this.markMessageAsRead(message.key);
                } catch (readError) {
                    logger.error('Error marking message as read', { 
                        sessionId: this.sessionId, 
                        messageId: message.key.id,
                        error: readError.message,
                        appType: appType
                    });
                }
            }
            
        } catch (error) {
            logger.error('Error processing message', { 
                sessionId: this.sessionId, 
                messageId: message?.key?.id,
                error: error.message 
            });
        }
    }

    extractMessageContent(message) {
        const messageContent = message.message;
        
        if (messageContent?.conversation) {
            return { type: 'text', content: messageContent.conversation };
        } else if (messageContent?.extendedTextMessage) {
            return { type: 'text', content: messageContent.extendedTextMessage.text };
        } else if (messageContent?.imageMessage) {
            return { type: 'image', caption: messageContent.imageMessage.caption };
        } else if (messageContent?.videoMessage) {
            return { type: 'video', caption: messageContent.videoMessage.caption };
        } else if (messageContent?.audioMessage) {
            return { type: 'audio' };
        } else if (messageContent?.documentMessage) {
            return { type: 'document', fileName: messageContent.documentMessage.fileName };
        } else if (messageContent?.contactMessage) {
            return { type: 'contact', displayName: messageContent.contactMessage.displayName };
        }
        
        return { type: 'unknown', raw: messageContent };
    }

    // Utility function to format phone number or group ID as WhatsApp JID
    formatAsWhatsAppJID(receiverId) {
        // If already formatted with proper WhatsApp domain, return as is
        if (receiverId.endsWith('@g.us') || receiverId.endsWith('@s.whatsapp.net')) {
            return receiverId;
        }
        
        // If it contains @ but not the proper WhatsApp domains, extract the ID part
        if (receiverId.includes('@')) {
            receiverId = receiverId.split('@')[0];
        }
        
        // Determine if it's a group ID or individual phone number
        let formattedJID;
        
        // Group IDs are typically longer than 15 characters and contain hyphens or are numeric with specific patterns
        // Examples: "120363168346132205", "1234567890-1234567890", etc.
        if (receiverId.length > 15 && (receiverId.includes('-') || /^\d{18,}$/.test(receiverId))) {
            // This appears to be a group ID
            formattedJID = receiverId + '@g.us';
        } else if (/^\d{8,15}$/.test(receiverId)) {
            // This appears to be an individual phone number (8-15 digits)
            formattedJID = receiverId + '@s.whatsapp.net';
        } else {
            // For any other format, try to clean and determine
            const cleanId = receiverId.replace(/[^\d\-]/g, ''); // Keep digits and hyphens
            
            if (cleanId.length > 15 && cleanId.includes('-')) {
                // Likely a group ID with hyphens
                formattedJID = cleanId + '@g.us';
            } else if (cleanId.length >= 8) {
                // Likely a phone number
                const cleanNumber = cleanId.replace(/[^\d]/g, ''); // Remove all non-digits for phone numbers
                formattedJID = cleanNumber + '@s.whatsapp.net';
            } else {
                // Default to individual chat if uncertain
                formattedJID = receiverId + '@s.whatsapp.net';
            }
        }
        
        return formattedJID;
    }

    // Check if a phone number is registered on WhatsApp
    async isNumberRegisteredOnWhatsApp(receiverId) {
        if (!this.isConnected) {
            throw new Error('Session not connected');
        }

        try {
            // Format the receiverId as a proper WhatsApp JID
            const formattedJID = this.formatAsWhatsAppJID(receiverId);
            
            // Skip validation for group chats - groups are always "valid" if they exist
            if (formattedJID.includes('@g.us')) {
                logger.session(this.sessionId, 'Group chat detected, skipping validation', { groupId: formattedJID });
                return {
                    isRegistered: true,
                    jid: formattedJID,
                    isGroup: true,
                    validationSkipped: true
                };
            }

            // Use onWhatsApp method to check if individual number is registered
            const [result] = await this.socket.onWhatsApp(formattedJID);
            
            if (result && result.exists) {
                logger.session(this.sessionId, 'Number validation: registered', { phoneNumber: formattedJID });
                return {
                    isRegistered: true,
                    jid: result.jid || formattedJID,
                    isGroup: false
                };
            } else {
                logger.session(this.sessionId, 'Number validation: not registered', { phoneNumber: formattedJID });
                return {
                    isRegistered: false,
                    jid: formattedJID,
                    isGroup: false
                };
            }
        } catch (error) {
            logger.error('Error validating WhatsApp number', { 
                sessionId: this.sessionId, 
                receiverId, 
                error: error.message 
            });
            
            // If validation fails, assume number is valid to avoid blocking legitimate sends
            // This could happen due to network issues or rate limiting
            const formattedJID = this.formatAsWhatsAppJID(receiverId);
            return {
                isRegistered: true,
                jid: formattedJID,
                isGroup: formattedJID.includes('@g.us'),
                validationFailed: true,
                error: error.message
            };
        }
    }

    async sendTextMessage(receiverId, messageText) {
        if (!this.isConnected) {
            throw new Error('Session not connected');
        }

        try {
            // Validate if the number is registered on WhatsApp
            const validation = await this.isNumberRegisteredOnWhatsApp(receiverId);
            
            if (!validation.isRegistered && !validation.validationFailed) {
                throw new Error(`Phone number ${receiverId} is not registered on WhatsApp`);
            }

            // Use the validated JID for sending
            const result = await this.socket.sendMessage(validation.jid, { text: messageText });
            
            logger.session(this.sessionId, 'Text message sent', { 
                receiverId: validation.jid,
                isGroup: validation.isGroup,
                validationPassed: validation.isRegistered
            });
            
            return {
                ...result,
                validationResult: validation
            };
        } catch (error) {
            logger.error('Failed to send text message', { sessionId: this.sessionId, receiverId, error: error.message });
            throw error;
        }
    }

    async sendMediaMessage(receiverId, mediaBuffer, mediaType, caption = '', fileName = null) {
        if (!this.isConnected) {
            throw new Error('Session not connected');
        }

        try {
            // Validate if the number is registered on WhatsApp
            const validation = await this.isNumberRegisteredOnWhatsApp(receiverId);
            
            if (!validation.isRegistered && !validation.validationFailed) {
                throw new Error(`Phone number ${receiverId} is not registered on WhatsApp`);
            }

            const messageOptions = { caption };
            
            if (mediaType.startsWith('image/')) {
                messageOptions.image = mediaBuffer;
            } else if (mediaType.startsWith('video/')) {
                messageOptions.video = mediaBuffer;
            } else if (mediaType.startsWith('audio/')) {
                messageOptions.audio = mediaBuffer;
                messageOptions.mimetype = mediaType;
            } else {
                messageOptions.document = mediaBuffer;
                messageOptions.mimetype = mediaType;
                // Use provided filename or fallback to generic filename
                messageOptions.fileName = fileName || `document.${mediaType.split('/')[1]}`;
            }

            // Use the validated JID for sending
            const result = await this.socket.sendMessage(validation.jid, messageOptions);
            
            logger.session(this.sessionId, 'Media message sent', { 
                receiverId: validation.jid, 
                mediaType,
                fileName: messageOptions.fileName,
                isGroup: validation.isGroup,
                validationPassed: validation.isRegistered
            });
            
            return {
                ...result,
                validationResult: validation
            };
        } catch (error) {
            logger.error('Failed to send media message', { sessionId: this.sessionId, receiverId, error: error.message });
            throw error;
        }
    }

    async markMessageAsRead(messageKey) {
        try {
            await this.socket.readMessages([messageKey]);
            logger.session(this.sessionId, 'Message marked as read', { messageId: messageKey.id });
        } catch (error) {
            logger.error('Failed to mark message as read', { sessionId: this.sessionId, error: error.message });
        }
    }

    async getGroups() {
        if (!this.isConnected) {
            throw new Error('Session not connected');
        }

        try {
            const groups = await this.socket.groupFetchAllParticipating();
            const groupList = Object.values(groups).map(group => ({
                id: group.id,
                subject: group.subject,
                owner: group.owner,
                desc: group.desc,
                participants: group.participants.length,
                creation: group.creation,
                subjectOwner: group.subjectOwner,
                subjectTime: group.subjectTime
            }));

            logger.session(this.sessionId, 'Groups fetched', { count: groupList.length });
            return groupList;
        } catch (error) {
            logger.error('Failed to fetch groups', { sessionId: this.sessionId, error: error.message });
            throw error;
        }
    }

    async getContacts() {
        if (!this.isConnected) {
            throw new Error('Session not connected');
        }

        try {
            const contacts = this.socket.store?.contacts || {};
            const contactList = Object.values(contacts).map(contact => ({
                id: contact.id,
                name: contact.name,
                notify: contact.notify,
                verifiedName: contact.verifiedName,
                imgUrl: contact.imgUrl,
                status: contact.status
            }));

            logger.session(this.sessionId, 'Contacts fetched', { count: contactList.length });
            return contactList;
        } catch (error) {
            logger.error('Failed to fetch contacts', { sessionId: this.sessionId, error: error.message });
            throw error;
        }
    }

    async updateSessionStatus(status) {
        try {
            await this.database.updateSessionStatus(this.sessionId, status);
        } catch (error) {
            logger.error('Failed to update session status', { sessionId: this.sessionId, status, error: error.message });
        }
    }

    getQRCode() {
        return this.qrCodeData;
    }

    getQRString() {
        return this.qrCodeString;
    }

    isSessionConnected() {
        return this.isConnected && this.socket && !!this.socket.user;
    }

    // Method to check if session has authentication data
    hasAuthData() {
        return this.authState && this.authState.creds && this.authState.creds.noiseKey;
    }

    // Method to get session connection info
    getConnectionInfo() {
        return {
            isConnected: this.isConnected,
            hasAuthData: this.hasAuthData(),
            hasSocket: !!this.socket,
            hasUser: !!(this.socket && this.socket.user),
            retryCount: this.retryCount,
            maxRetries: this.maxRetries,
            sessionId: this.sessionId
        };
    }

    async logout() {
        try {
            if (this.socket && this.isConnected) {
                // Send logout signal to WhatsApp
                await this.socket.logout();
                logger.session(this.sessionId, 'Session logout signal sent');
            }
            this.isConnected = false;
            await this.updateSessionStatus('logged_out');
            logger.session(this.sessionId, 'Session logged out successfully');
        } catch (error) {
            logger.error('Error during logout', { sessionId: this.sessionId, error: error.message });
            throw error;
        }
    }

    async destroy() {
        try {
            // CRITICAL: Set destroying flag immediately
            this.isDestroying = true;
            
            // Clear authentication state
            this.clearAuthenticationState();
            
            // Clear heartbeat interval
            if (this.heartbeatInterval) {
                clearInterval(this.heartbeatInterval);
                this.heartbeatInterval = null;
            }
            
            // ENHANCED: More thorough socket cleanup
            if (this.socket) {
                try {
                    // Check socket state before attempting to close
                    const socketReadyState = this.socket.readyState;
                    logger.session(this.sessionId, 'Destroying socket - current state', {
                        readyState: socketReadyState,
                        hasUser: !!this.socket.user,
                        stateNames: ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'],
                        currentStateName: ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][socketReadyState] || 'UNKNOWN'
                    });
                    
                    // Remove all event listeners first to prevent race conditions
                    if (this.socket.ev) {
                        this.socket.ev.removeAllListeners();
                    }
                    
                    // CRITICAL FIX: Enhanced socket state checking for destroy
                    if (typeof socketReadyState !== 'undefined') {
                        // WebSocket readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
                        if (socketReadyState === 0 || socketReadyState === 1) {
                            // Socket is CONNECTING or OPEN - safe to close
                            try {
                                logger.session(this.sessionId, 'Destroying socket via close() method', { readyState: socketReadyState });
                                this.socket.close();
                            } catch (closeError) {
                                logger.warn('Error during destroy socket.close()', { 
                                    sessionId: this.sessionId, 
                                    error: closeError.message,
                                    readyState: socketReadyState
                                });
                                // Try alternative cleanup method
                                try {
                                    logger.session(this.sessionId, 'Attempting socket.end() as destroy fallback');
                                    this.socket.end();
                                } catch (endError) {
                                    logger.warn('Error during destroy socket.end() fallback', { 
                                        sessionId: this.sessionId, 
                                        error: endError.message 
                                    });
                                }
                            }
                        } else if (socketReadyState === 2) {
                            // Socket is CLOSING - wait for it to close naturally
                            logger.session(this.sessionId, 'Socket already closing during destroy, waiting for completion');
                            let waitCount = 0;
                            while (this.socket.readyState === 2 && waitCount < 10) { // Max 1 second wait
                                await new Promise(resolve => setTimeout(resolve, 100));
                                waitCount++;
                            }
                            logger.session(this.sessionId, 'Destroy socket close wait completed', { 
                                finalReadyState: this.socket.readyState,
                                waitTime: waitCount * 100 + 'ms'
                            });
                        } else if (socketReadyState === 3) {
                            // Socket is already CLOSED - no action needed
                            logger.session(this.sessionId, 'Socket already closed during destroy, no cleanup needed');
                        }
                    } else {
                        // Socket doesn't have readyState - try gentle cleanup
                        logger.session(this.sessionId, 'Socket without readyState during destroy, attempting gentle cleanup');
                        try {
                            // CRITICAL FIX: Enhanced gentle cleanup with state checking
                            if (this.socket && typeof this.socket.end === 'function') {
                                // Check if socket has internal state that would indicate it's safe to end
                                const hasInternalState = this.socket._socket || this.socket.readyState !== undefined;
                                
                                if (hasInternalState) {
                                    logger.session(this.sessionId, 'Socket has internal state, attempting end()');
                                    this.socket.end();
                                } else {
                                    logger.session(this.sessionId, 'Socket lacks internal state, skipping end() to prevent crash');
                                }
                            } else if (this.socket && typeof this.socket.close === 'function') {
                                // Try close as alternative
                                const hasInternalState = this.socket._socket || this.socket.readyState !== undefined;
                                
                                if (hasInternalState) {
                                    logger.session(this.sessionId, 'Socket has internal state, attempting close()');
                                    this.socket.close();
                                } else {
                                    logger.session(this.sessionId, 'Socket lacks internal state, skipping close() to prevent crash');
                                }
                            } else {
                                logger.session(this.sessionId, 'Socket lacks end() and close() methods, skipping cleanup');
                            }
                        } catch (gentleCleanupError) {
                            logger.warn('Error during gentle socket cleanup in destroy', { 
                                sessionId: this.sessionId, 
                                error: gentleCleanupError.message,
                                errorType: gentleCleanupError.constructor.name
                            });
                        }
                    }
                    
                    // Wait a bit for cleanup to complete
                    await new Promise(resolve => setTimeout(resolve, 500));
                    
                } catch (socketError) {
                    // Comprehensive error logging but don't let it crash the process
                    logger.error('Socket cleanup failed during destroy - continuing', { 
                        sessionId: this.sessionId, 
                        error: socketError.message,
                        errorType: socketError.constructor.name,
                        socketExists: !!this.socket,
                        socketReadyState: this.socket?.readyState
                    });
                }
                
                // Always clear the socket reference regardless of cleanup success
                this.socket = null;
            }
            
            // Reset connection flags
            this.isConnected = false;
            this.isConnecting = false;
            this.socketCreateLock = false;
            this.connectionPromise = null;
            
            // Reset stream conflict tracking
            this.streamConflictCount = 0;
            this.lastStreamConflictTime = null;
            
            // Clear QR data
            this.qrCodeData = null;
            this.qrCodeString = null;
            this.qrCodeTimestamp = null;
            
            await this.updateSessionStatus('disconnected');
            logger.session(this.sessionId, 'Session destroyed successfully');
        } catch (error) {
            logger.error('Error destroying session', { sessionId: this.sessionId, error: error.message });
            // Don't throw the error - destruction should be resilient
        } finally {
            this.isDestroying = false; // Reset flag
        }
    }

    clearAuthenticationState() {
        this.isAuthenticating = false;
        this.qrCodeScanned = false;
        this.authenticationStartTime = null;
        this.preventQRRegeneration = false;
    }

    // NEW: Public methods for backup management
    async createManualBackup() {
        logger.session(this.sessionId, 'Manual backup requested');
        return await this.createSessionBackup();
    }

    async restoreFromBackup() {
        logger.session(this.sessionId, 'Manual restore requested');
        return await this.restoreSessionFromBackupSequential();
    }

    // Get backup status and information
    getBackupInfo() {
        const latestBackupDir = path.join(this.backupDir, 'latest');
        const hasBackup = fs.existsSync(latestBackupDir);
        
        let backupInfo = {
            hasBackup: hasBackup,
            backupEnabled: this.backupEnabled,
            lastBackupTime: this.lastBackupTime,
            backupInterval: this.backupInterval,
            isRestoring: this.isRestoring
        };

        if (hasBackup) {
            try {
                const metadataPath = path.join(latestBackupDir, 'backup_metadata.json');
                if (fs.existsSync(metadataPath)) {
                    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
                    backupInfo.backupMetadata = metadata;
                    backupInfo.backupAge = Date.now() - new Date(metadata.timestamp).getTime();
                }
                
                const backupFiles = fs.readdirSync(latestBackupDir).filter(file => 
                    !file.endsWith('_metadata.json')
                );
                backupInfo.backupFileCount = backupFiles.length;
                backupInfo.backupFiles = backupFiles;
            } catch (error) {
                backupInfo.backupError = error.message;
            }
        }

        return backupInfo;
    }

    // Enable or disable backup system
    setBackupEnabled(enabled) {
        this.backupEnabled = enabled;
        logger.session(this.sessionId, `Backup system ${enabled ? 'enabled' : 'disabled'}`);
    }

    // NEW: Clean up old backup files
    cleanupOldBackups() {
        try {
            const backupDirs = fs.readdirSync(this.backupDir)
                .filter(dir => dir.startsWith('backup_') && dir !== 'latest')
                .map(dir => ({
                    name: dir,
                    path: path.join(this.backupDir, dir),
                    stats: fs.statSync(path.join(this.backupDir, dir))
                }))
                .sort((a, b) => b.stats.mtime - a.stats.mtime); // Sort by modification time (newest first)

            // Keep only the 5 most recent backups
            const maxBackups = 5;
            if (backupDirs.length > maxBackups) {
                const toDelete = backupDirs.slice(maxBackups);
                
                for (const backup of toDelete) {
                    try {
                        fs.rmSync(backup.path, { recursive: true, force: true });
                        logger.session(this.sessionId, `Cleaned up old backup: ${backup.name}`);
                    } catch (deleteError) {
                        logger.warn('Error deleting old backup', {
                            sessionId: this.sessionId,
                            backup: backup.name,
                            error: deleteError.message
                        });
                    }
                }

                logger.session(this.sessionId, `Backup cleanup completed, removed ${toDelete.length} old backups`);
            }

        } catch (error) {
            logger.warn('Error during backup cleanup', { 
                sessionId: this.sessionId, 
                error: error.message 
            });
        }
    }

    // BACKWARD COMPATIBILITY: Keep original method name for API compatibility
    async restoreSessionFromBackup() {
        logger.session(this.sessionId, 'Legacy restore method called - using sequential restoration');
        return await this.restoreSessionFromBackupSequential();
    }
}

module.exports = BaileysSession; 