// =============================================================================
// config/index.js
// Carregamento centralizado das variáveis de ambiente com validação.
// Falha rápido se variáveis obrigatórias estiverem ausentes.
// =============================================================================

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// Carrega .env da raiz do projeto
dotenv.config({ path: resolve(__dirname, '..', '.env') });

// ---------------------------------------------------------------------------
// Helpers de leitura
// ---------------------------------------------------------------------------

/**
 * Lê variável obrigatória. Lança erro se ausente.
 * @param {string} key
 * @returns {string}
 */
const required = (key) => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`[CONFIG] Variável de ambiente obrigatória ausente: ${key}`);
  }
  return value;
};

/**
 * Lê variável opcional com fallback.
 * @param {string} key
 * @param {string} [fallback='']
 * @returns {string}
 */
const optional = (key, fallback = '') => process.env[key] || fallback;

// ---------------------------------------------------------------------------
// Configuração exportada (congelada para evitar mutação acidental)
// ---------------------------------------------------------------------------

const config = Object.freeze({
  // -- Servidor
  port:    parseInt(optional('PORT', '3000'), 10),
  nodeEnv: optional('NODE_ENV', 'development'),

  // -- Telegram
  telegram: {
    botToken:       required('TELEGRAM_BOT_TOKEN'),
    webhookUrl:     optional('TELEGRAM_WEBHOOK_URL', ''),
    webhookSecret:  optional('TELEGRAM_WEBHOOK_SECRET', ''),
    /**
     * Retorna a URL base da Bot API do Telegram.
     * @returns {string}
     */
    get apiBaseUrl() {
      return `https://api.telegram.org/bot${this.botToken}`;
    },
  },

  // -- Bitrix24
  bitrix24: {
    domain:         required('BITRIX24_DOMAIN'),
    userId:         required('BITRIX24_USER_ID'),
    webhookToken:   required('BITRIX24_WEBHOOK_TOKEN'),
    openChannelId:  parseInt(optional('BITRIX24_OPEN_CHANNEL_ID', '1'), 10),
    operatorAliceId: parseInt(optional('BITRIX24_OPERATOR_ALICE_ID', '1'), 10),
    /**
     * Retorna a URL base da API REST do Bitrix24 (webhook).
     * Formato: https://{domain}/rest/{userId}/{webhookToken}
     * @returns {string}
     */
    get restBaseUrl() {
      return `https://${this.domain}/rest/${this.userId}/${this.webhookToken}`;
    },
  },

  // -- Hermes IA
  hermesAI: {
    provider: optional('HERMES_AI_PROVIDER', 'openai'),
    apiKey:   optional('HERMES_AI_API_KEY', ''),
    model:    optional('HERMES_AI_MODEL', 'gpt-4o-mini'),
    baseUrl:  optional('HERMES_AI_BASE_URL', ''),
  },

  // -- Contingência
  fallback: {
    phone: optional('FALLBACK_PHONE', '(65) 99679-4931'),
  },

  // -- Agendamento
  booking: {
    url: optional('BOOKING_URL', ''),
  },
});

export default config;
