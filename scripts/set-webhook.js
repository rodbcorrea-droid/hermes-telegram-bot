#!/usr/bin/env node
// =============================================================================
// scripts/set-webhook.js
// Script utilitário para configurar o webhook do Telegram Bot.
// Executar: npm run set-webhook
// =============================================================================

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// Carrega .env da raiz do projeto
dotenv.config({ path: resolve(__dirname, '..', '.env') });

import * as telegram from '../services/telegram.js';

const WEBHOOK_URL  = process.env.TELEGRAM_WEBHOOK_URL;
const SECRET_TOKEN = process.env.TELEGRAM_WEBHOOK_SECRET;

if (!WEBHOOK_URL) {
  console.error('[ERRO] TELEGRAM_WEBHOOK_URL nao definido no .env');
  process.exit(1);
}

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('[ERRO] TELEGRAM_BOT_TOKEN nao definido no .env');
  process.exit(1);
}

(async () => {
  try {
    console.log(`[Webhook] Configurando: ${WEBHOOK_URL}`);
    const result = await telegram.setWebhook(WEBHOOK_URL, SECRET_TOKEN);
    console.log('[Webhook] Resultado:', JSON.stringify(result, null, 2));
    console.log('[Webhook] Configuracao concluida com sucesso.');
  } catch (err) {
    console.error('[Webhook] Falha ao configurar:', err.message);
    process.exit(1);
  }
})();
