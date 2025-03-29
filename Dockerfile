# ---------- Builder Stage ----------
    FROM node:22.12-alpine AS builder

    # Copy entire project; the prepare script may need all files.
    COPY . /app
    WORKDIR /app
    
    # Install all dependencies with caching support.
    RUN --mount=type=cache,target=/root/.npm npm install
    
    # Install production dependencies with caching (ignoring scripts & dev deps)
    RUN --mount=type=cache,target=/root/.npm-production npm ci --ignore-scripts --omit-dev
    
    # Build the TypeScript source.
    RUN npm run build
    
    # ---------- Release Stage ----------
    FROM node:22-alpine AS release
    
    WORKDIR /app
    
    # Copy built files and package metadata from the builder stage.
    COPY --from=builder /app/dist /app/dist
    COPY --from=builder /app/package.json /app/package.json
    COPY --from=builder /app/package-lock.json /app/package-lock.json
    
    # Set production environment variable.
    ENV HUBSPOT_ACCESS_TOKEN=dummy_access_token
ENV SHARED_CONTACT_ID=dummy_contact_id
    ENV NODE_ENV=production
    
    # Re-install production dependencies.
    RUN npm ci --ignore-scripts --omit-dev
    
    # Use the compiled index.js as the entrypoint.
    ENTRYPOINT ["node", "dist/index.js"]
    