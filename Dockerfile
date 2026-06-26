FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY instructions ./instructions
COPY sample_output.json README.md app.js ./

ENV NODE_ENV=production
ENV PORT=8000

EXPOSE 8000

CMD ["npm", "start"]
