FROM node:25-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install && npm install -g @dotenvx/dotenvx

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Run the bot
CMD ["dotenvx", "run", "--", "npm", "start"]
