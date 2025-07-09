FROM node:20-alpine AS base

WORKDIR /usr/src/app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci --only=production

# Install curl required for healthcheck (Alpine)
RUN apk add --no-cache curl

# Copy application code
COPY index.js .
COPY src/ ./src/

# Expose the port the app runs on
EXPOSE 8080

# Define the command to run the app
CMD ["node", "--experimental-wasm-memory64", "index.js"] 