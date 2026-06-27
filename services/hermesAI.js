// =============================================================================
// services/hermesAI.js
// Módulo de IA (Hermes NLP) — classificação de intenção via LLM e geração
// de resumos para handoff. Fallback robusto por regex quando sem LLM.
//
// Merge de:
//   - 9 intenções com confidence + reasoning (antigo)
//   - Suporte a OpenAI e Anthropic (antigo)
//   - response_format: json_object (antigo)
//   - Regex fallback robusto (antigo)
//   - extractCpf() e isValidCpf() (antigo)
//   - Resumo estruturado (antigo)
// =============================================================================

import axios from 'axios';
import config from '../config/index.js';

// ---------------------------------------------------------------------------
// Constantes de intenção reconhecidas pelo Hermes
// ---------------------------------------------------------------------------
export const Intent = Object.freeze({
  STATUS_PROCESSO: 'STATUS_PROCESSO',
  AGENDAMENTO:     'AGENDAMENTO',
  SOLICITAR_CHAMADA: 'SOLICITAR_CHAMADA',
  FALAR_EQUIPE:    'FALAR_EQUIPE',
  SAUDACAO:        'SAUDACAO',
  FORNECER_CPF:    'FORNECER_CPF',
  DUVIDA_COMPLEXA: 'DUVIDA_COMPLEXA',
  OUTRO:           'OUTRO',
  MENU_PRINCIPAL:  'MENU_PRINCIPAL',
});

// ---------------------------------------------------------------------------
// Prompt de sistema para classificação de intenção
// ---------------------------------------------------------------------------
const CLASSIFICATION_SYSTEM_PROMPT = `
Voce e o Hermes, assistente virtual da Brandao Correa Assessoria Juridica.
Sua tarefa e classificar a intencao do cliente com base na mensagem recebida.
Responda APENAS com um objeto JSON puro, sem markdown, sem texto adicional.

Intencoes possiveis:
- STATUS_PROCESSO: Cliente quer saber sobre o andamento/status de um processo ou negocio.
- AGENDAMENTO: Cliente quer agendar uma consulta, reuniao ou horario.
- SOLICITAR_CHAMADA: Cliente quer receber uma ligacao ou fazer uma chamada.
- FALAR_EQUIPE: Cliente quer falar com um atendente humano, advogado ou equipe.
- SAUDACAO: Apenas cumprimento inicial (oi, ola, bom dia, etc.).
- FORNECER_CPF: Cliente esta enviando um numero de CPF (formato XXX.XXX.XXX-XX ou apenas digitos).
- MENU_PRINCIPAL: Cliente quer voltar ao menu principal ou ver as opcoes.
- DUVIDA_COMPLEXA: Pergunta tecnica juridica ou duvida complexa que precisa de humano.
- OUTRO: Nenhuma das anteriores.

Regras:
- Se a mensagem contiver um numero com 11 digitos (pontuado ou nao), e FORNECER_CPF.
- Se o cliente demonstrar frustracao ou insistir em falar com pessoa, e FALAR_EQUIPE.
- Perguntas juridicas especificas sao DUVIDA_COMPLEXA.

Formato de resposta:
{"intent": "INTENCAO", "confidence": 0.0-1.0, "reasoning": "explicacao breve"}
`.trim();

// ---------------------------------------------------------------------------
// Prompt para geração de resumo de conversa (handoff)
// ---------------------------------------------------------------------------
const SUMMARY_SYSTEM_PROMPT = `
Voce e o Hermes, assistente virtual da Brandao Correa Assessoria Juridica.
Gere um resumo objetivo e profissional da conversa entre o cliente e o bot.
O resumo sera lido por um atendente humano (Alice) que assumira o caso.

Formato:
- Nome do cliente (se disponivel)
- CPF (se informado)
- Motivo do contato
- Principais duvidas ou solicitacoes
- O que ja foi resolvido automaticamente
- Pontos de atencao para o atendente

Seja conciso. Maximo 250 palavras. Tom profissional e direto.
`.trim();

// ---------------------------------------------------------------------------
// Build do cliente HTTP conforme o provedor
// ---------------------------------------------------------------------------
function buildAiClient() {
  const { provider, apiKey, baseUrl, model } = config.hermesAI;

  if (!apiKey) return null;

  let endpoint;
  let headers;

  switch (provider) {
    case 'anthropic':
      endpoint = baseUrl || 'https://api.anthropic.com/v1/messages';
      headers = {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      };
      break;
    case 'openai':
      endpoint = baseUrl || 'https://api.openai.com/v1/chat/completions';
      headers = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      };
      break;
    default:
      // Custom — assume OpenAI-compatible
      endpoint = baseUrl || 'https://api.openai.com/v1/chat/completions';
      headers = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      };
  }

  return { endpoint, headers, model, provider };
}

// =============================================================================
// 1. Classificação de intenção via LLM
// =============================================================================

/**
 * Analisa a mensagem do usuário e retorna a intenção classificada.
 * Se nenhuma chave de IA estiver configurada, usa fallback por regex.
 *
 * @param {string} userMessage - Texto livre enviado pelo cliente
 * @param {Array<object>} [history=[]] - Histórico recente (para contexto)
 * @returns {Promise<{intent: string, confidence: number, reasoning: string}>}
 */
export async function classifyIntent(userMessage, history = []) {
  const client = buildAiClient();

  if (!client) return regexClassify(userMessage);

  try {
    let response;

    if (client.provider === 'anthropic') {
      response = await classifyWithAnthropic(client, userMessage);
    } else {
      response = await classifyWithOpenAI(client, userMessage);
    }

    // Parse da resposta JSON da LLM
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        intent:     parsed.intent || Intent.OUTRO,
        confidence: parsed.confidence || 0.5,
        reasoning:  parsed.reasoning || '',
      };
    }

    return regexClassify(userMessage);
  } catch (err) {
    console.error('[HermesAI] Erro na classificacao via LLM:', err.message);
    return regexClassify(userMessage);
  }
}

// ---------------------------------------------------------------------------
// 1a. Classificação via OpenAI-compatible
// ---------------------------------------------------------------------------
async function classifyWithOpenAI(client, userMessage) {
  const { data } = await axios.post(
    client.endpoint,
    {
      model: client.model,
      messages: [
        { role: 'system', content: CLASSIFICATION_SYSTEM_PROMPT },
        { role: 'user',   content: userMessage },
      ],
      temperature: 0.1,
      max_tokens: 200,
      response_format: { type: 'json_object' },
    },
    { headers: client.headers, timeout: 8_000 }
  );
  return data.choices?.[0]?.message?.content || '';
}

// ---------------------------------------------------------------------------
// 1b. Classificação via Anthropic
// ---------------------------------------------------------------------------
async function classifyWithAnthropic(client, userMessage) {
  const { data } = await axios.post(
    client.endpoint,
    {
      model: client.model,
      system: CLASSIFICATION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      temperature: 0.1,
      max_tokens: 200,
    },
    { headers: client.headers, timeout: 8_000 }
  );
  return data.content?.[0]?.text || '';
}

// =============================================================================
// Fallback: Classificação baseada em regex (sem LLM)
// =============================================================================

/**
 * Classificador por regex. Robusto para os cenários comuns.
 * @param {string} message
 * @returns {{intent: string, confidence: number, reasoning: string}}
 */
function regexClassify(message) {
  const msg = message.toLowerCase().trim();

  // CPF: 11 dígitos com ou sem pontuação
  const cpfPattern = /\d{3}\.?\d{3}\.?\d{3}-?\d{2}/;
  if (cpfPattern.test(message)) {
    return { intent: Intent.FORNECER_CPF, confidence: 0.99, reasoning: 'Padrao de CPF detectado.' };
  }

  // Saudação
  const saudacaoPattern = /^(oi[!.\s]|ola[!.\s]|bom dia|boa tarde|boa noite|hey|e ai|hello|oi$|ola$)/;
  if (saudacaoPattern.test(msg)) {
    return { intent: Intent.SAUDACAO, confidence: 0.95, reasoning: 'Saudacao detectada.' };
  }

  // Falar com equipe / humano
  const falarEquipePattern =
    /(falar com (um )?(humano|atendente|advogado|pessoa|alguem|equipe|time)|atendimento humano|quero ser atendido|preciso de (um )?(humano|advogado|atendente)|transferencia|transbordo|chat ao vivo|live chat)/;
  if (falarEquipePattern.test(msg)) {
    return { intent: Intent.FALAR_EQUIPE, confidence: 0.9, reasoning: 'Cliente solicitou atendimento humano.' };
  }

  // Status do processo
  const statusPattern =
    /(status|andamento|processo|meu caso|minha acao|acao judicial|como (esta|anda)|previsao|prazo|atualizacao|onde esta)/;
  if (statusPattern.test(msg)) {
    return { intent: Intent.STATUS_PROCESSO, confidence: 0.85, reasoning: 'Cliente perguntando sobre andamento de processo.' };
  }

  // Agendamento
  const agendamentoPattern =
    /(agendar|agendamento|horario|data|marcar|consulta|reuniao|disponivel|quando posso|qual dia)/;
  if (agendamentoPattern.test(msg)) {
    return { intent: Intent.AGENDAMENTO, confidence: 0.85, reasoning: 'Cliente quer agendar horario.' };
  }

  // Solicitar chamada
  const chamadaPattern =
    /(ligar|ligacao|chamada|me liga|telefone|retornar|callback|receber (uma )?(ligacao|chamada))/;
  if (chamadaPattern.test(msg)) {
    return { intent: Intent.SOLICITAR_CHAMADA, confidence: 0.85, reasoning: 'Cliente solicitou chamada telefonica.' };
  }

  // Menu principal
  const menuPattern = /(menu|inicio|voltar|opcoes|principal)/;
  if (menuPattern.test(msg)) {
    return { intent: Intent.MENU_PRINCIPAL, confidence: 0.8, reasoning: 'Cliente quer o menu.' };
  }

  // Dúvida complexa: mais de 15 palavras sem categoria clara
  const wordCount = msg.split(/\s+/).length;
  if (wordCount > 15) {
    return { intent: Intent.DUVIDA_COMPLEXA, confidence: 0.6, reasoning: 'Mensagem longa sem intencao clara — possivel duvida complexa.' };
  }

  return { intent: Intent.OUTRO, confidence: 0.3, reasoning: 'Intencao nao identificada.' };
}

// =============================================================================
// 2. Geração de resumo da conversa para handoff
// =============================================================================

/**
 * Gera um resumo profissional da conversa para o operador humano.
 * @param {Array<{role: string, content: string, timestamp: number}>} history
 * @returns {Promise<string>}
 */
export async function generateSummary(history) {
  const client = buildAiClient();

  if (!client || history.length === 0) {
    return buildFallbackSummary(history);
  }

  const recentHistory = history.slice(-20);
  const transcript = recentHistory
    .map(h => `[${h.role === 'user' ? 'Cliente' : 'Hermes'}]: ${h.content}`)
    .join('\n');

  try {
    let summary;

    if (client.provider === 'anthropic') {
      const { data } = await axios.post(
        client.endpoint,
        {
          model: client.model,
          system: SUMMARY_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: `Transcricao da conversa:\n\n${transcript}\n\nGere o resumo para o atendente humano.` }],
          temperature: 0.3,
          max_tokens: 500,
        },
        { headers: client.headers, timeout: 10_000 }
      );
      summary = data.content?.[0]?.text || '';
    } else {
      const { data } = await axios.post(
        client.endpoint,
        {
          model: client.model,
          messages: [
            { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
            { role: 'user',   content: `Transcricao da conversa:\n\n${transcript}\n\nGere o resumo para o atendente humano.` },
          ],
          temperature: 0.3,
          max_tokens: 500,
        },
        { headers: client.headers, timeout: 10_000 }
      );
      summary = data.choices?.[0]?.message?.content || '';
    }

    return summary.trim() || buildFallbackSummary(history);
  } catch (err) {
    console.error('[HermesAI] Erro ao gerar resumo:', err.message);
    return buildFallbackSummary(history);
  }
}

// ---------------------------------------------------------------------------
// Fallback: resumo simples sem LLM
// ---------------------------------------------------------------------------
function buildFallbackSummary(history) {
  if (history.length === 0) return 'Conversa sem historico registrado.';

  const userMessages = history
    .filter(h => h.role === 'user')
    .map(h => h.content)
    .slice(-5);

  const topics = userMessages.join(' | ').substring(0, 300);

  return (
    `Cliente interagiu com o bot Hermes. ` +
    `Total de ${history.length} mensagens trocadas. ` +
    `Ultimas interacoes do cliente: "${topics}". ` +
    `Verificar historico completo no chat do Telegram.`
  );
}

// =============================================================================
// 3. Helper: detectar CPF em texto livre
// =============================================================================

/**
 * Extrai um número de CPF de uma string de texto.
 * @param {string} text
 * @returns {string|null} CPF (apenas dígitos) ou null
 */
export function extractCpf(text) {
  const match = text.match(/(\d{3}\.?\d{3}\.?\d{3}-?\d{2})/);
  if (match) return match[1].replace(/\D/g, '');
  return null;
}

// =============================================================================
// 4. Helper: validar CPF (dígitos verificadores)
// =============================================================================

/**
 * Valida um CPF brasileiro (formato e dígitos verificadores).
 * @param {string} cpf - CPF com ou sem pontuação
 * @returns {boolean}
 */
export function isValidCpf(cpf) {
  const digits = cpf.replace(/\D/g, '');
  if (digits.length !== 11) return false;
  if (/^(\d)\1+$/.test(digits)) return false;

  for (let verifierPos = 9; verifierPos <= 10; verifierPos++) {
    let sum = 0;
    for (let i = 0; i < verifierPos; i++) {
      sum += parseInt(digits[i], 10) * (verifierPos + 1 - i);
    }
    const checkDigit = ((sum * 10) % 11) % 10;
    if (checkDigit !== parseInt(digits[verifierPos], 10)) return false;
  }

  return true;
}
