# docker build --build-arg PRODUCT=agentfuse -t agentfuse .
FROM node:22-alpine
ARG PRODUCT=agentfuse
ENV PRODUCT=${PRODUCT} NODE_OPTIONS=--no-warnings=ExperimentalWarning
WORKDIR /app
COPY package.json ./
COPY packages ./packages
RUN npm install --omit=dev --ignore-scripts && mkdir -p /app/data
VOLUME ["/app/data"]
CMD node packages/${PRODUCT}/src/server.js
