FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y unzip && rm -rf /var/lib/apt/lists/*
COPY deal-standalone.zip /tmp/deal.zip
RUN unzip -o /tmp/deal.zip -d /app && rm /tmp/deal.zip
RUN npm install
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
