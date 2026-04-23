import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import chatHandler from './api/chat.js';
import metaHandler from './api/meta.js';
import ga4Handler from './api/ga4.js';
import googleAdsHandler from './api/google-ads.js';
import ecommerceHandler from './api/ecommerce.js';
import monthlyHandler from './api/monthly.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.static(join(__dirname, 'public')));

app.post('/api/chat', chatHandler);
app.post('/api/meta', metaHandler);
app.post('/api/ga4', ga4Handler);
app.post('/api/google-ads', googleAdsHandler);
app.post('/api/ecommerce', ecommerceHandler);
app.post('/api/monthly', monthlyHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
