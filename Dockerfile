FROM apify/actor-node-playwright-chrome:18

COPY package*.json ./
RUN npm install --quiet
COPY . ./

CMD npm start
