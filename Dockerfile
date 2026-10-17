FROM node:22-alpine
WORKDIR /app
# Only the app itself; personal exports (*.json) are excluded by .dockerignore.
COPY index.html app.js parser.js fog.js countries.js airports.js tcc.js cities.js towns.js immich.mjs server.mjs ./
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
