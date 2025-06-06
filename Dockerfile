# Use Node.js 18 LTS Alpine image for smaller size
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install system dependencies required for Baileys and SQLite
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    sqlite \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    musl-dev \
    giflib-dev \
    pixman-dev \
    pangomm-dev \
    libjpeg-turbo-dev \
    freetype-dev

# Copy package.json and package-lock.json
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/

# Create necessary directories
RUN mkdir -p data sessions logs uploads

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=./data/whatsapp_sessions.db
ENV SESSION_STORAGE_PATH=./sessions
ENV MAX_CONCURRENT_SESSIONS=100
ENV LOG_LEVEL=info
ENV WEBHOOK_TIMEOUT=5000
ENV WEBHOOK_RETRY_ATTEMPTS=3

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Set user for security (optional, but recommended)
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001
RUN chown -R nodejs:nodejs /app
USER nodejs

# Start the application
CMD ["node", "src/server.js"] 