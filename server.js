import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import routes from './src/routes.js';
import { restoreSessions } from './src/whatsapp.js';
import { pauseInterruptedCampaigns } from './src/campaigns.js';
import { ensureAdminUser } from './src/auth.js';
import { migrateTickets } from './src/departments.js';
import { pruneMenus } from './src/buttons.js';

ensureAdminUser();
migrateTickets();
pruneMenus();

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/api', routes);
app.use(express.static(path.resolve('public')));

const port = Number(process.env.PORT || 3000);
app.listen(port, async () => {
  console.log(`WA Marketing running at http://localhost:${port}`);
  pauseInterruptedCampaigns();
  await restoreSessions();
});
