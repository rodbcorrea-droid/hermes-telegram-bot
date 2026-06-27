// =============================================================================
// services/bitrix24.js
// Integração com a API REST do Bitrix24: CRM, Open Channels, Mensagens.
//
// Todos os métodos utilizam o padrão de Webhook REST do Bitrix24:
//   POST https://{domain}/rest/{user_id}/{webhook_token}/{method}.json
//
// Merge de:
//   - Busca por CPF e telefone (antigo)
//   - Busca de Leads (antigo)
//   - assignChatToOperator() (antigo)
//   - notifyOperator() via im.notify (antigo)
//   - getAvailableSlots() + getBookingLink() (antigo)
//   - pingBitrix24() (antigo)
//   - unwrapResult() com validação de erro (antigo)
//   - executeHandoff() consolidado (novo)
//   - Sufixo .json nos endpoints (antigo)
// =============================================================================

import axios from 'axios';
import config from '../config/index.js';

// ---------------------------------------------------------------------------
// Cliente HTTP reutilizável para o Bitrix24
// ---------------------------------------------------------------------------
const bxClient = axios.create({
  baseURL: config.bitrix24.restBaseUrl,
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
});

// ---------------------------------------------------------------------------
// Helper: valida resposta da API Bitrix24 e extrai result
// ---------------------------------------------------------------------------

/**
 * Verifica se a resposta da API Bitrix24 contém erro e lança exceção amigável.
 * @param {object} responseData - Axios response.data
 * @param {string} operation - Nome da operação (para logging)
 * @returns {*} response.data.result
 */
function unwrapResult(responseData, operation) {
  const { result, error } = responseData;
  if (error) {
    const err = new Error(
      `[Bitrix24] Erro em ${operation}: ${error.error_name} — ${error.error_description}`
    );
    err.bxError = error;
    throw err;
  }
  return result;
}

// =============================================================================
// 1. CRM — Busca de Contatos
// =============================================================================

/**
 * Busca contatos no CRM por CPF e/ou telefone (OR lógico).
 * O CPF é buscado no campo personalizado UF_CRM_CPF.
 *
 * @param {object} filters
 * @param {string} [filters.cpf] - CPF do cliente (apenas dígitos)
 * @param {string} [filters.phone] - Telefone do cliente
 * @returns {Promise<Array<object>>} Lista de contatos encontrados
 */
export async function findContactByCpfOrPhone({ cpf, phone } = {}) {
  const filter = { LOGIC: 'OR' };
  let idx = 0;

  if (cpf) {
    filter[`=${idx}`] = { 'UF_CRM_CPF': cpf };
    idx++;
  }

  if (phone) {
    const cleanPhone = phone.replace(/\D/g, '');
    filter[`=${idx}`] = {
      'PHONE': cleanPhone.length > 8 ? cleanPhone.slice(-9) : cleanPhone,
    };
    idx++;
  }

  const { data } = await bxClient.post('/crm.contact.list.json', {
    filter,
    select: ['ID', 'NAME', 'LAST_NAME', 'PHONE', 'UF_CRM_CPF', 'EMAIL'],
  });

  const result = unwrapResult(data, 'crm.contact.list');
  return Array.isArray(result) ? result : [];
}

// =============================================================================
// 2. CRM — Busca de Leads
// =============================================================================

/**
 * Busca leads no CRM por CPF e/ou telefone.
 * @param {object} filters
 * @param {string} [filters.cpf]
 * @param {string} [filters.phone]
 * @returns {Promise<Array<object>>}
 */
export async function findLeadByCpfOrPhone({ cpf, phone } = {}) {
  const filter = { LOGIC: 'OR' };
  let idx = 0;

  if (cpf) {
    filter[`=${idx}`] = { 'UF_CRM_CPF': cpf };
    idx++;
  }

  if (phone) {
    const cleanPhone = phone.replace(/\D/g, '');
    filter[`=${idx}`] = {
      'PHONE': cleanPhone.length > 8 ? cleanPhone.slice(-9) : cleanPhone,
    };
    idx++;
  }

  const { data } = await bxClient.post('/crm.lead.list.json', {
    filter,
    select: ['ID', 'NAME', 'LAST_NAME', 'PHONE', 'UF_CRM_CPF', 'STATUS_ID'],
  });

  const result = unwrapResult(data, 'crm.lead.list');
  return Array.isArray(result) ? result : [];
}

// =============================================================================
// 3. CRM — Criar novo Lead
// =============================================================================

/**
 * Cria um novo Lead no funil inicial.
 * @param {object} leadData
 * @param {string} leadData.name - Nome completo do lead
 * @param {string} [leadData.phone] - Telefone
 * @param {string} [leadData.cpf] - CPF
 * @returns {Promise<number>} ID do Lead criado
 */
export async function createLead({ name, phone, cpf } = {}) {
  const fields = {
    TITLE: name || 'Lead via Telegram',
    NAME: name || 'Cliente Telegram',
    SOURCE_ID: 'TELEGRAM',
    SOURCE_DESCRIPTION: 'Captado via Bot Hermes (Telegram)',
    OPENED: 'Y',
  };

  if (phone) fields.PHONE = [{ VALUE: phone, VALUE_TYPE: 'MOBILE' }];
  if (cpf)   fields.UF_CRM_CPF = cpf;

  const { data } = await bxClient.post('/crm.lead.add.json', { fields });
  return unwrapResult(data, 'crm.lead.add');
}

// =============================================================================
// 4. CRM — Criar Contato + Negócio (combo completo)
// =============================================================================

/**
 * Cria um Contato e um Negócio vinculado no CRM.
 * @param {object} contactData
 * @param {string} contactData.name
 * @param {string} [contactData.phone]
 * @param {string} [contactData.cpf]
 * @returns {Promise<{contactId: number, dealId: number}>}
 */
export async function createContactAndDeal({ name, phone, cpf } = {}) {
  // 4a. Criar Contato
  const contactFields = {
    NAME: name || 'Cliente Telegram',
    SOURCE_ID: 'TELEGRAM',
    SOURCE_DESCRIPTION: 'Captado via Bot Hermes (Telegram)',
    OPENED: 'Y',
  };
  if (phone) contactFields.PHONE = [{ VALUE: phone, VALUE_TYPE: 'MOBILE' }];
  if (cpf)   contactFields.UF_CRM_CPF = cpf;

  const { data: contactDataResp } = await bxClient.post('/crm.contact.add.json', {
    fields: contactFields,
  });
  const contactId = unwrapResult(contactDataResp, 'crm.contact.add');

  // 4b. Criar Negócio vinculado ao Contato
  const dealFields = {
    TITLE: `Atendimento Telegram — ${name || 'Novo Cliente'}`,
    CONTACT_ID: contactId,
    CATEGORY_ID: 0,
    STAGE_ID: 'NEW',
    SOURCE_ID: 'TELEGRAM',
    SOURCE_DESCRIPTION: 'Oportunidade iniciada via Bot Hermes (Telegram)',
    OPENED: 'Y',
  };

  const { data: dealData } = await bxClient.post('/crm.deal.add.json', {
    fields: dealFields,
  });
  const dealId = unwrapResult(dealData, 'crm.deal.add');

  return { contactId, dealId };
}

// =============================================================================
// 5. CRM — Buscar Negócios/Processos por Contato
// =============================================================================

/**
 * Retorna os negócios (processos) vinculados a um contato.
 * @param {number} contactId
 * @returns {Promise<Array<object>>}
 */
export async function getDealsByContact(contactId) {
  const { data } = await bxClient.post('/crm.deal.list.json', {
    filter: { CONTACT_ID: contactId },
    select: ['ID', 'TITLE', 'STAGE_ID', 'DATE_CREATE', 'DATE_MODIFY', 'OPPORTUNITY'],
  });
  return unwrapResult(data, 'crm.deal.list') || [];
}

// =============================================================================
// 6. CRM — Formatar estágio do Deal para exibição
// =============================================================================

/**
 * Mapeia os IDs de estágio padrão do Bitrix24 para textos amigáveis.
 * @param {string} stageId
 * @returns {string}
 */
export function formatDealStage(stageId) {
  const STAGE_MAP = {
    'NEW':                 'Novo — aguardando analise',
    'PREPARATION':         'Em preparacao',
    'PREPAYMENT_INVOICE':  'Aguardando pagamento',
    'EXECUTING':           'Em andamento',
    'FINAL_INVOICE':       'Fatura final',
    'WON':                 'Concluido com sucesso',
    'LOSE':                'Encerrado sem exito',
    'APOLOGY':             'Suspenso temporariamente',
  };
  return STAGE_MAP[stageId] || `Estagio: ${stageId}`;
}

// =============================================================================
// 7. CRM — Registrar Atividade "Chamada Solicitada"
// =============================================================================

/**
 * Cria uma atividade do tipo "Chamada" com prioridade alta no CRM.
 * @param {object} params
 * @param {number} params.ownerId - ID do responsável (ex: Alice)
 * @param {number} [params.contactId] - ID do contato
 * @param {number} [params.dealId] - ID do negócio
 * @param {string} [params.phone] - Telefone para callback
 * @returns {Promise<object>}
 */
export async function createCallActivity({ ownerId, contactId, dealId, phone } = {}) {
  const fields = {
    OWNER_ID: ownerId,
    TYPE_ID: 2,                      // 2 = Chamada (Call)
    SUBJECT: 'Solicitacao de Chamada — Cliente Telegram',
    DESCRIPTION: `Cliente solicitou receber uma ligacao via Bot Hermes (Telegram).\n` +
      (phone ? `Telefone informado: ${phone}` : 'Telefone: verificar cadastro do contato.') +
      `\nPrioridade: ALTA.`,
    PRIORITY: 1,                     // 1 = Alta
    DIRECTION: 2,                    // 2 = Saida (nos ligamos para o cliente)
    COMPLETED: 'N',
    COMMUNICATIONS: phone ? [{ VALUE: phone, TYPE: 'PHONE' }] : [],
  };

  if (contactId) fields.OWNER_CONTACT_ID = contactId;
  if (dealId)    fields.OWNER_DEAL_ID = dealId;

  const { data } = await bxClient.post('/crm.activity.add.json', { fields });
  return unwrapResult(data, 'crm.activity.add');
}

// =============================================================================
// 8. Open Channels — Mensagem Oculta/Whisper
// =============================================================================

/**
 * Envia uma mensagem PRIVADA (whisper) no chat do Open Channel do Bitrix24.
 * Esta mensagem NAO aparece para o cliente final, apenas para os operadores.
 *
 * @param {object} params
 * @param {number|string} params.dialogId - ID do dialogo/canal aberto
 * @param {string} params.message - Conteudo do resumo
 * @returns {Promise<object>}
 */
export async function sendWhisperMessage({ dialogId, message } = {}) {
  const { data } = await bxClient.post('/im.message.add.json', {
    DIALOG_ID: dialogId,
    MESSAGE:   message,
    SYSTEM:    'Y',
    PARAMS:    { CLASS: 'hidden' },
  });
  return unwrapResult(data, 'im.message.add (whisper)');
}

// =============================================================================
// 9. Open Channels — Notificação interna para operador Alice
// =============================================================================

/**
 * Dispara uma notificacao no chat interno do Bitrix24 (IM) alertando a
 * operadora Alice sobre um novo atendimento transferido.
 *
 * @param {object} params
 * @param {number} params.operatorId - ID do usuario Alice no Bitrix24
 * @param {string} params.clientName - Nome do cliente
 * @param {string} [params.clientCpf] - CPF do cliente
 * @param {string} [params.summary] - Breve resumo da conversa
 * @returns {Promise<object>}
 */
export async function notifyOperator({ operatorId, clientName, clientCpf, summary } = {}) {
  const message = [
    `Atencao Alice: Um novo cliente complexo foi transferido do Telegram para o seu Canal Aberto. Verifique o historico.`,
    ``,
    `Cliente: ${clientName || 'Nao identificado'}`,
    clientCpf ? `CPF: ${clientCpf}` : '',
    ``,
    summary ? `Resumo da conversa com Hermes:\n${summary}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const { data } = await bxClient.post('/im.notify.json', {
    to: operatorId,
    message,
    type: 'SYSTEM',
  });
  return unwrapResult(data, 'im.notify');
}

// =============================================================================
// 10. Open Channels — Transferir chat para operador específico
// =============================================================================

/**
 * Atribui o chat de um Canal Aberto a um operador específico (Alice).
 * Utiliza imopenlines.operator.transfer para transferir a sessão.
 *
 * @param {object} params
 * @param {number|string} params.chatId - ID do chat no Open Channel
 * @param {number} params.operatorId - ID do operador Alice
 * @returns {Promise<object>}
 */
export async function assignChatToOperator({ chatId, operatorId } = {}) {
  const { data } = await bxClient.post('/imopenlines.operator.transfer.json', {
    CHAT_ID: chatId,
    TRANSFER_ID: operatorId,
  });
  return unwrapResult(data, 'imopenlines.operator.transfer');
}

// =============================================================================
// 11. Protocolo de Transbordo (Handoff) consolidado
// =============================================================================

/**
 * Executa o protocolo completo de transbordo para Open Channels:
 *   1. Envia resumo gerado pela IA como whisper (oculto).
 *   2. Notifica Alice via im.notify.
 *   3. Tenta transferir o chat automaticamente para Alice.
 *
 * @param {object} params
 * @param {string} params.summary - Resumo gerado pela IA Hermes
 * @param {string} params.clientName - Nome do cliente
 * @param {string} [params.clientCpf] - CPF do cliente
 * @param {string} [params.dialogId] - ID do diálogo no Open Channel
 * @returns {Promise<{whisper: object, notification: object, transfer: object|null}>}
 */
export async function executeHandoff({ summary, clientName, clientCpf, dialogId } = {}) {
  const operatorId = config.bitrix24.operatorAliceId;
  const targetDialog = dialogId || `chat${Date.now()}`;

  // 1) Whisper message — resumo oculto para o operador
  const whisper = await sendWhisperMessage({
    dialogId: targetDialog,
    message: `Resumo Hermes (oculto) — Cliente: ${clientName}\n` +
      (clientCpf ? `CPF: ${clientCpf}\n` : '') +
      `\n${summary}\n\nGerado automaticamente em ${new Date().toLocaleString('pt-BR')}`,
  });

  // 2) Notificação interna para Alice
  const notification = await notifyOperator({
    operatorId,
    clientName,
    clientCpf,
    summary,
  });

  // 3) Tentar transferir o chat para Alice (best-effort)
  let transfer = null;
  try {
    transfer = await assignChatToOperator({
      chatId: targetDialog,
      operatorId,
    });
  } catch (transferErr) {
    // A transferência pode falhar se o chat ainda não existir no Open Channel
    // Alice receberá a notificação e poderá puxar o chat manualmente
    console.log('[Handoff] Transferencia automatica indisponivel:', transferErr.message);
  }

  return { whisper, notification, transfer };
}

// =============================================================================
// 12. Agendamento — Resource Booking
// =============================================================================

/**
 * Retorna os slots disponíveis para agendamento via Resource Booking.
 * @param {object} [params]
 * @param {string} [params.from] - Data inicial (YYYY-MM-DD)
 * @param {string} [params.to] - Data final (YYYY-MM-DD)
 * @returns {Promise<Array<object>>} Slots disponíveis
 */
export async function getAvailableSlots({ from, to } = {}) {
  const resourceId = 1; // ID do recurso — parametrizar conforme CRM

  const { data } = await bxClient.post('/resourcebooking.resource.list.json', {
    filter: { ID: resourceId },
  });

  const resources = unwrapResult(data, 'resourcebooking.resource.list');
  return resources || [];
}

/**
 * Retorna o link de agendamento. Usa BOOKING_URL do .env se configurado,
 * senão gera o link nativo do Bitrix24 Resource Booking.
 * @returns {string}
 */
export function getBookingLink() {
  if (config.booking.url) return config.booking.url;
  return `https://${config.bitrix24.domain}/pub/booking/`;
}

// =============================================================================
// 13. Health Check — conectividade com o Bitrix24
// =============================================================================

/**
 * Verifica se a API do Bitrix24 está acessível.
 * @returns {Promise<boolean>}
 */
export async function pingBitrix24() {
  try {
    const { data } = await bxClient.post('/app.info.json', {});
    return !!data.result;
  } catch {
    return false;
  }
}
