// =============================================================================
// services/telegram.js
// Métodos puros para interação com a API de Bots do Telegram (HTTP).
// NENHUM framework de terceiros (Telegraf, etc.) — apenas axios.
//
// Merge de:
//   - axios.create() com baseURL e keep-alive (antigo)
//   - Retry com backoff exponencial (novo)
//   - extractPayload(), requestContact(), editMessageText() (antigo)
//   - setWebhook() com secret_token (novo)
//   - disable_web_page_preview (antigo)
// =============================================================================

import axios from 'axios';
import config from '../config/index.js';

// ---------------------------------------------------------------------------
// Cliente HTTP reutilizável (keep-alive, timeout)
// ---------------------------------------------------------------------------
const telegramClient = axios.create({
  baseURL: config.telegram.apiBaseUrl,
  timeout: 10_000,
  headers: { 'Content-Type': 'application/json' },
});

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 300;

// ---------------------------------------------------------------------------
// Helper: chamada com retry simples
// ---------------------------------------------------------------------------
async function callWithRetry(method, payload) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      const { data } = await telegramClient.post(method, payload);

      if (!data.ok) {
        throw new Error(`Telegram API error [${method}]: ${data.description}`);
      }
      return data.result;
    } catch (err) {
      lastError = err;
      // Retry apenas para erros de rede ou 5xx — não para 4xx/BAD_REQUEST
      const isRetryable = axios.isAxiosError(err) && err.code !== 'BAD_REQUEST'
        && !err.response?.status?.toString().startsWith('4');
      if (attempt <= MAX_RETRIES && isRetryable) {
        await new Promise(r => setTimeout(r, RETRY_BASE_DELAY_MS * attempt));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// 1. Enviar mensagem de texto
// ---------------------------------------------------------------------------

/**
 * Envia uma mensagem de texto para um chat do Telegram.
 * @param {number|string} chatId
 * @param {string} text - Texto no formato HTML ou puro
 * @param {object} [opts={}]
 * @param {string} [opts.parseMode='HTML'] - 'HTML' | 'MarkdownV2' | null
 * @param {object} [opts.replyMarkup] - Objeto reply_markup (inline_keyboard ou reply_keyboard)
 * @returns {Promise<object>}
 */
export async function sendMessage(chatId, text, opts = {}) {
  const { parseMode = 'HTML', replyMarkup = null } = opts;

  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };

  if (parseMode) payload.parse_mode = parseMode;
  if (replyMarkup) payload.reply_markup = replyMarkup;

  return callWithRetry('/sendMessage', payload);
}

// ---------------------------------------------------------------------------
// 2. Enviar mensagem com teclado inline (botões)
// ---------------------------------------------------------------------------

/**
 * Envia uma mensagem com botões inline (inline_keyboard).
 * @param {number|string} chatId
 * @param {string} text
 * @param {Array<Array<{text: string, callback_data: string}>>} buttons
 * @param {object} [opts={}]
 * @returns {Promise<object>}
 */
export async function sendInlineKeyboard(chatId, text, buttons, opts = {}) {
  return sendMessage(chatId, text, {
    ...opts,
    replyMarkup: { inline_keyboard: buttons },
  });
}

// ---------------------------------------------------------------------------
// 3. Responder callback_query
// ---------------------------------------------------------------------------

/**
 * Responde a um callback_query do Telegram (remove o loading do botão).
 * @param {string} callbackQueryId
 * @param {object} [opts={}]
 * @param {string} [opts.text=''] - Texto de toast/alert
 * @param {boolean} [opts.showAlert=false] - Se true, mostra popup em vez de toast
 * @returns {Promise<object>}
 */
export async function answerCallbackQuery(callbackQueryId, opts = {}) {
  const { text = '', showAlert = false } = opts;
  const payload = { callback_query_id: callbackQueryId };
  if (text) {
    payload.text = text;
    payload.show_alert = showAlert;
  }
  return callWithRetry('/answerCallbackQuery', payload);
}

// ---------------------------------------------------------------------------
// 4. Editar mensagem existente
// ---------------------------------------------------------------------------

/**
 * Edita o texto e/ou teclado de uma mensagem já enviada.
 * @param {number|string} chatId
 * @param {number} messageId
 * @param {string} newText
 * @param {Array} [buttons=null] - Novo teclado inline (ou null para manter)
 * @returns {Promise<object>}
 */
export async function editMessageText(chatId, messageId, newText, buttons = null) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text: newText,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (buttons) payload.reply_markup = { inline_keyboard: buttons };

  return callWithRetry('/editMessageText', payload);
}

// ---------------------------------------------------------------------------
// 5. Solicitar contato do usuário (botão nativo do Telegram)
// ---------------------------------------------------------------------------

/**
 * Envia uma mensagem com botão que solicita o contato do usuário.
 * O Telegram exibe um botão nativo "Compartilhar meu número".
 * @param {number|string} chatId
 * @param {string} prompt - Texto explicativo
 * @returns {Promise<object>}
 */
export async function requestContact(chatId, prompt) {
  return sendMessage(chatId, prompt, {
    replyMarkup: {
      keyboard: [
        [{ text: 'Compartilhar meu numero', request_contact: true }],
      ],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
    parseMode: 'HTML',
  });
}

// ---------------------------------------------------------------------------
// 6. Remover teclado customizado
// ---------------------------------------------------------------------------

/**
 * Remove o teclado customizado (reply keyboard) da tela do usuário.
 * @param {number|string} chatId
 * @param {string} [text='Teclado recolhido.']
 * @returns {Promise<object>}
 */
export async function removeKeyboard(chatId, text = 'Teclado recolhido.') {
  return sendMessage(chatId, text, {
    replyMarkup: { remove_keyboard: true },
    parseMode: 'HTML',
  });
}

// ---------------------------------------------------------------------------
// 7. Configurar Webhook
// ---------------------------------------------------------------------------

/**
 * Configura o webhook do bot no Telegram.
 * @param {string} webhookUrl - URL pública que receberá os updates
 * @param {string} [secretToken] - Token para validar a origem do webhook
 * @returns {Promise<object>}
 */
export async function setWebhook(webhookUrl, secretToken) {
  const payload = { url: webhookUrl };
  if (secretToken) payload.secret_token = secretToken;
  return callWithRetry('/setWebhook', payload);
}

/**
 * Remove o webhook ativo (útil para modo polling em dev).
 * @returns {Promise<object>}
 */
export async function deleteWebhook() {
  return callWithRetry('/deleteWebhook', {});
}

// ---------------------------------------------------------------------------
// 8. Extrair informações do payload do Telegram
// ---------------------------------------------------------------------------

/**
 * Extrai o objeto de chat, texto, contato e callback do payload recebido
 * via webhook. Lida com mensagens de texto, contatos compartilhados
 * e callback_queries.
 *
 * @param {object} body - Corpo completo do webhook do Telegram
 * @returns {{ chatId: number|null, text: string|null, contact: object|null,
 *             callbackQueryId: string|null, callbackData: string|null,
 *             messageId: number|null, firstName: string, lastName: string,
 *             username: string }}
 */
export function extractPayload(body) {
  // Callback query (botão inline pressionado)
  if (body.callback_query) {
    const cb = body.callback_query;
    return {
      chatId:          cb.message?.chat?.id ?? cb.from?.id ?? null,
      text:            null,
      contact:         null,
      callbackQueryId: cb.id || null,
      callbackData:    cb.data || null,
      messageId:       cb.message?.message_id || null,
      firstName:       cb.from?.first_name || '',
      lastName:        cb.from?.last_name || '',
      username:        cb.from?.username || '',
    };
  }

  // Mensagem normal (texto, contato, etc.)
  if (body.message) {
    const msg = body.message;
    return {
      chatId:          msg.chat?.id ?? null,
      text:            msg.text || null,
      contact:         msg.contact || null,
      callbackQueryId: null,
      callbackData:    null,
      messageId:       msg.message_id || null,
      firstName:       msg.from?.first_name || '',
      lastName:        msg.from?.last_name || '',
      username:        msg.from?.username || '',
    };
  }

  // Payload não reconhecido
  return {
    chatId: null, text: null, contact: null,
    callbackQueryId: null, callbackData: null, messageId: null,
    firstName: '', lastName: '', username: '',
  };
}
