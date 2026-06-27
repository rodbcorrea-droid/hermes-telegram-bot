// =============================================================================
// server.js — Hermes Bot (Versão Unificada)
// Servidor Express que recebe webhooks do Telegram, orquestra a máquina
// de estados da conversa e integra com o CRM Bitrix24.
//
// Brandão Correa Assessoria Jurídica — 2026
//
// Merge de:
//   - 7 estados granulares + coleta de nome + contato (antigo)
//   - helmet + rate-limit (antigo)
//   - Lock por chatId (novo)
//   - Webhook secret token validation (novo)
//   - Webhook Bitrix24 reverso (antigo)
//   - Health check com ping Bitrix24 (antigo)
//   - Tom resolutivo sem emojis excessivos ou desculpas (novo)
//   - Resposta 200 imediata ao Telegram (ambos)
// =============================================================================

import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import config from './config/index.js';

// -- Serviços internos
import * as telegram from './services/telegram.js';
import * as bitrix24 from './services/bitrix24.js';
import * as hermesAI from './services/hermesAI.js';

// -- Gerenciamento de sessão (máquina de estados)
import {
  State,
  getSession,
  updateSession,
  appendHistory,
  deleteSession,
  activeSessionCount,
  processWithLock,
} from './middleware/session.js';

// =============================================================================
// Constantes
// =============================================================================

// Callback data dos botões do menu principal
const CALLBACK = Object.freeze({
  MENU_STATUS:       'MENU_STATUS',
  MENU_AGENDAMENTO:  'MENU_AGENDAMENTO',
  MENU_CHAMADA:      'MENU_CHAMADA',
  MENU_FALAR_EQUIPE: 'MENU_FALAR_EQUIPE',
  MENU_VOLTAR:       'MENU_VOLTAR',
  CONFIRM_CPF:       'CONFIRM_CPF',
});

// Telefone de contingência (fallback)
const FALLBACK_PHONE = config.fallback.phone;

// =============================================================================
// Configuração do Express
// =============================================================================

const app = express();

// -- Segurança básica
app.use(helmet());

// -- Rate limiting: protege o webhook contra abusos
const webhookLimiter = rateLimit({
  windowMs:       60 * 1000,  // 1 minuto
  max:            60,         // máximo 60 requisições por minuto por IP
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Muitas requisicoes. Aguarde um momento.' },
});

// -- Parsing do corpo da requisição (JSON)
app.use(express.json());

// =============================================================================
// Middleware de logging básico
// =============================================================================

app.use((req, _res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// =============================================================================
// Rota: Health Check
// =============================================================================

app.get('/health', async (_req, res) => {
  const bxAlive = await bitrix24.pingBitrix24();
  res.json({
    status:         'ok',
    service:        'Hermes Bot',
    version:        '2.0.0',
    uptime:         process.uptime(),
    activeSessions: activeSessionCount(),
    bitrix24:       bxAlive ? 'connected' : 'unreachable',
    timestamp:      new Date().toISOString(),
  });
});

// =============================================================================
// Rota: Webhook do Telegram (ponto de entrada principal)
// =============================================================================

app.post('/webhook/telegram', webhookLimiter, (req, res) => {
  // -- Validação de segurança (token secreto)
  if (config.telegram.webhookSecret) {
    const headerToken = req.headers['x-telegram-bot-api-secret-token'];
    if (headerToken !== config.telegram.webhookSecret) {
      console.warn('[Webhook] Requisicao rejeitada — token de seguranca invalido.');
      return res.sendStatus(403);
    }
  }

  // -- Resposta imediata com 200 OK para o Telegram nao reenviar
  res.sendStatus(200);

  // -- Processamento assíncrono com catch global
  const update = req.body;
  const chatId = update?.message?.chat?.id || update?.callback_query?.message?.chat?.id;

  if (chatId) {
    processWithLock(chatId, () => handleTelegramUpdate(update)).catch((err) => {
      console.error('[FATAL] Erro nao tratado no processamento do update:', err);
      // Tentar notificar o usuário com mensagem de contingência
      telegram.sendMessage(chatId, contingencyMessage()).catch(() => {
        console.error('[FATAL] Falha ao enviar mensagem de contingencia.');
      });
    });
  } else {
    // Processar sem lock se não houver chatId (caso raro)
    handleTelegramUpdate(update).catch((err) => {
      console.error('[FATAL] Erro ao processar update sem chatId:', err);
    });
  }
});

// =============================================================================
// Rota: Webhook do Bitrix24 (eventos reversos do CRM)
// =============================================================================

app.post('/webhook/bitrix24', async (req, res) => {
  res.sendStatus(200);

  try {
    const event = req.body;
    console.log('[Bitrix24 Webhook] Evento recebido:', event?.event);

    // Eventos tratáveis:
    // - ONCRMDEALUPDATE: quando Alice atualiza um negócio, notificar cliente
    // - ONIMOPENLINESSESSIONSTART: nova sessão de Open Channel iniciada
    // - ONIMOPENLINESSESSIONFINISH: sessão finalizada

    if (event?.event === 'ONIMOPENLINESSESSIONFINISH') {
      console.log('[Bitrix24] Sessao de Open Channel finalizada.');
    }
  } catch (err) {
    console.error('[Server] Erro ao processar webhook do Bitrix24:', err.message);
  }
});

// =============================================================================
// Mensagem de contingência (fallback)
// =============================================================================

/**
 * Retorna a mensagem de contingência para falhas do Bitrix24.
 * Tom: puramente resolutivo, técnico, educado. Sem desculpas.
 * @returns {string}
 */
function contingencyMessage() {
  return (
    'Sistema de consultas em manutencao. ' +
    `Contate o telefone/WhatsApp de contingencia: ${FALLBACK_PHONE}.`
  );
}

// =============================================================================
// LÓGICA PRINCIPAL: Máquina de estados da conversa
// =============================================================================

/**
 * Roteador principal — recebe o payload do Telegram e decide a ação
 * com base no estado atual da sessão do chat.
 *
 * @param {object} body - Corpo completo do webhook do Telegram
 */
async function handleTelegramUpdate(body) {
  const extracted = telegram.extractPayload(body);
  const { chatId, text, contact, callbackData, callbackQueryId, messageId, firstName, lastName, username } = extracted;

  if (!chatId) {
    console.log('[Server] Payload sem chatId — ignorado.');
    return;
  }

  const session = getSession(chatId);

  // -- Registrar no histórico
  if (text) appendHistory(chatId, 'user', text);

  // -------------------------------------------------------------------
  // Roteamento: CALLBACK_QUERY (botão inline pressionado)
  // -------------------------------------------------------------------
  if (callbackData && callbackQueryId) {
    await telegram.answerCallbackQuery(callbackQueryId);
    await handleCallback(chatId, callbackData, messageId, session);
    return;
  }

  // -------------------------------------------------------------------
  // Roteamento: COMANDO /start (reinicia a conversa)
  // -------------------------------------------------------------------
  if (text === '/start' || text === '/restart') {
    await handleStart(chatId, firstName);
    return;
  }

  // -------------------------------------------------------------------
  // Roteamento: CONTATO COMPARTILHADO (botão nativo do Telegram)
  // -------------------------------------------------------------------
  if (contact && contact.phone_number) {
    await handleContactReceived(chatId, contact.phone_number, session);
    return;
  }

  // -------------------------------------------------------------------
  // Roteamento: baseado no ESTADO ATUAL da sessão
  // -------------------------------------------------------------------
  switch (session.state) {
    case State.IDLE:
      await handleIdle(chatId, text, firstName);
      break;

    case State.AWAITING_CPF:
      await handleAwaitingCpf(chatId, text, firstName, session);
      break;

    case State.AWAITING_NAME:
      await handleAwaitingName(chatId, text, session);
      break;

    case State.AUTHENTICATED:
      await handleAuthenticated(chatId, text, session);
      break;

    case State.AWAITING_STATUS_CPF:
      await handleStatusLookup(chatId, text, session);
      break;

    case State.AWAITING_CALLBACK_DETAILS:
      await handleCallbackDetails(chatId, text, session);
      break;

    case State.HANDOFF:
      await handleHandoffState(chatId, text);
      break;

    default:
      // Estado desconhecido — reinicia
      updateSession(chatId, State.IDLE);
      await handleIdle(chatId, text, firstName);
  }
}

// =============================================================================
// HANDLERS DE CALLBACK (botões inline)
// =============================================================================

/**
 * Processa cliques nos botões inline do menu.
 * NENHUMA ação é permitida sem autenticação prévia (CPF).
 */
async function handleCallback(chatId, callbackData, messageId, session) {
  // -- Verificação de autenticação: bloqueia ações sem CPF
  if (session.state === State.IDLE || session.state === State.AWAITING_CPF || session.state === State.AWAITING_NAME) {
    await telegram.sendMessage(
      chatId,
      'Por motivos de seguranca, precisamos validar seu CPF antes de prosseguir.\n' +
      'Por favor, informe seu CPF (apenas numeros):'
    );
    updateSession(chatId, State.AWAITING_CPF);
    return;
  }

  switch (callbackData) {
    case CALLBACK.MENU_STATUS:
      await promptForStatusCpf(chatId, session);
      break;

    case CALLBACK.MENU_AGENDAMENTO:
      await handleAgendamento(chatId, session);
      break;

    case CALLBACK.MENU_CHAMADA:
      await promptForCallbackDetails(chatId, session);
      break;

    case CALLBACK.MENU_FALAR_EQUIPE:
      await handleHandoff(chatId, session);
      break;

    case CALLBACK.MENU_VOLTAR:
      await showMainMenu(chatId, session);
      break;

    default:
      console.log(`[Server] Callback desconhecido: ${callbackData}`);
      await showMainMenu(chatId, session);
  }
}

// =============================================================================
// HANDLERS DE ESTADO
// =============================================================================

// ---------------------------------------------------------------------------
// FASE 1: Reconhecimento Inicial
// ---------------------------------------------------------------------------

/**
 * Estado IDLE — primeiro contato ou após /start.
 * Solicita o contato do Telegram e o CPF em paralelo.
 */
async function handleIdle(chatId, _text, firstName) {
  const greeting = firstName ? `Ola, ${firstName}!` : 'Ola!';

  await telegram.sendMessage(
    chatId,
    `${greeting} Bem-vindo(a) a <b>Brandao Correa Assessoria Juridica</b>.\n\n` +
    'Eu sou o <b>Hermes</b>, seu assistente virtual. Estou aqui para ajudar com:\n' +
    '- Consulta de processos\n' +
    '- Agendamento de horarios\n' +
    '- Solicitacao de chamadas\n' +
    '- Atendimento com nossa equipe\n\n' +
    'Para comecar, precisamos identificar voce.'
  );

  // Solicita o contato do usuário (botão nativo do Telegram)
  await telegram.requestContact(
    chatId,
    'Para prosseguir, compartilhe seu numero de telefone clicando no botao abaixo:'
  );

  // Também pergunta o CPF enquanto espera o contato
  await telegram.sendMessage(
    chatId,
    'Paralelamente, informe seu <b>CPF</b> (apenas numeros) para consultarmos seu cadastro:'
  );

  updateSession(chatId, State.AWAITING_CPF);
}

// ---------------------------------------------------------------------------
// FASE 1b: Recebimento do Contato do Telegram
// ---------------------------------------------------------------------------

/**
 * Chamado quando o usuário compartilha o contato via botão nativo.
 * Armazena o telefone e avança se o CPF já foi coletado.
 */
async function handleContactReceived(chatId, phoneNumber, session) {
  const cleanPhone = phoneNumber.replace(/\D/g, '');
  updateSession(chatId, session.state, { phone: cleanPhone });

  await telegram.removeKeyboard(chatId, 'Numero recebido. Obrigado.');

  // Se já temos CPF, tenta autenticar
  if (session.cpf) {
    await authenticateClient(chatId, session);
  }
  // Caso contrário, o fluxo AWAITING_CPF continua aguardando o CPF
}

// ---------------------------------------------------------------------------
// FASE 1c: Aguardando CPF
// ---------------------------------------------------------------------------

/**
 * Estado AWAITING_CPF — o usuário enviou (esperamos) um CPF.
 */
async function handleAwaitingCpf(chatId, text, firstName, session) {
  const cpfFromMessage = hermesAI.extractCpf(text);

  if (!cpfFromMessage || !hermesAI.isValidCpf(cpfFromMessage)) {
    await telegram.sendMessage(
      chatId,
      'Nao consegui identificar um CPF valido na sua mensagem.\n\n' +
      'Por favor, informe seu <b>CPF</b> com 11 digitos (ex: 123.456.789-00):'
    );
    return;
  }

  // CPF válido — armazenar e avançar
  updateSession(chatId, State.AWAITING_CPF, { cpf: cpfFromMessage });
  appendHistory(chatId, 'system', `CPF validado: ${cpfFromMessage}`);

  await telegram.sendMessage(chatId, 'CPF recebido. Consultando seu cadastro...');

  // Se já temos telefone, autentica; senão, solicita
  if (session.phone) {
    await authenticateClient(chatId, session);
  } else {
    await telegram.requestContact(
      chatId,
      'Agora, compartilhe seu <b>numero de telefone</b> para confirmarmos sua identidade:'
    );
  }
}

// ---------------------------------------------------------------------------
// FASE 1d: Aguardando Nome (para novos clientes)
// ---------------------------------------------------------------------------

/**
 * Estado AWAITING_NAME — cliente novo, precisamos do nome.
 * Após coletar o nome, cria o registro no CRM (Contato + Negócio ou Lead).
 */
async function handleAwaitingName(chatId, text, session) {
  const name = text.trim();
  if (name.length < 2) {
    await telegram.sendMessage(chatId, 'Por favor, informe seu <b>nome completo</b>:');
    return;
  }

  updateSession(chatId, State.AUTHENTICATED, { name });

  // Se é um cliente novo (_pendingCreate), cria o registro no CRM
  if (session._pendingCreate) {
    try {
      await telegram.sendMessage(chatId, 'Criando seu cadastro no sistema...');

      const { contactId, dealId } = await bitrix24.createContactAndDeal({
        name,
        phone: session.phone || undefined,
        cpf: session.cpf || undefined,
      });

      updateSession(chatId, State.AUTHENTICATED, {
        crmContactId: contactId,
        crmDealId: dealId,
        _pendingCreate: false,
      });

      await telegram.sendMessage(
        chatId,
        `Cadastro criado com sucesso, <b>${name}</b>!\n` +
        'Seu registro ja esta em nosso sistema juridico.'
      );
    } catch (err) {
      console.error('[CRM] Erro ao criar Contato+Negocio:', err.message);

      // Fallback: tenta criar apenas um Lead (mais simples)
      try {
        const leadId = await bitrix24.createLead({
          name,
          phone: session.phone || undefined,
          cpf: session.cpf || undefined,
        });

        updateSession(chatId, State.AUTHENTICATED, {
          crmContactId: leadId,
          _pendingCreate: false,
        });

        await telegram.sendMessage(
          chatId,
          `Cadastro criado, <b>${name}</b>! Nossa equipe entrara em contato em breve.`
        );
      } catch (leadErr) {
        console.error('[CRM] Erro ao criar Lead (fallback):', leadErr.message);
        await telegram.sendMessage(chatId, contingencyMessage());
        delete session._pendingCreate;
      }
    }
  } else {
    await telegram.sendMessage(
      chatId,
      `Obrigado, <b>${name}</b>! Seus dados estao confirmados.`
    );
  }

  await showMainMenu(chatId, getSession(chatId));
}

// ---------------------------------------------------------------------------
// FASE 1e: Autenticação contra o CRM
// ---------------------------------------------------------------------------

/**
 * Busca o cliente no CRM do Bitrix24 por CPF e telefone.
 * Se encontrado, autentica. Se não, cria novo registro.
 */
async function authenticateClient(chatId, session) {
  try {
    await telegram.sendMessage(chatId, 'Consultando nosso sistema...');

    // Busca em Contatos e Leads simultaneamente
    const [contacts, leads] = await Promise.all([
      bitrix24.findContactByCpfOrPhone({ cpf: session.cpf, phone: session.phone }),
      bitrix24.findLeadByCpfOrPhone({ cpf: session.cpf, phone: session.phone }),
    ]);

    const foundContact = contacts?.[0];
    const foundLead    = leads?.[0];

    if (foundContact) {
      // -- Cliente encontrado no CRM --
      const contactName =
        [foundContact.NAME, foundContact.LAST_NAME].filter(Boolean).join(' ') || 'Cliente';
      updateSession(chatId, State.AUTHENTICATED, {
        name: contactName,
        crmContactId: foundContact.ID,
      });

      await telegram.sendMessage(
        chatId,
        `<b>Identidade confirmada!</b>\nBem-vindo(a) de volta, ${contactName}.`
      );

      // Busca negócios vinculados para referência
      const deals = await bitrix24.getDealsByContact(foundContact.ID);
      if (deals.length > 0) {
        updateSession(chatId, State.AUTHENTICATED, { crmDealId: deals[0].ID });
      }

      await showMainMenu(chatId, getSession(chatId));
    } else if (foundLead) {
      // -- Lead encontrado --
      updateSession(chatId, State.AUTHENTICATED, {
        name: foundLead.NAME || foundLead.TITLE || 'Cliente',
        crmContactId: foundLead.ID,
      });

      await telegram.sendMessage(
        chatId,
        `<b>Cadastro localizado!</b>\nBem-vindo(a), ${foundLead.NAME || foundLead.TITLE || 'Cliente'}.`
      );
      await showMainMenu(chatId, getSession(chatId));
    } else {
      // -- Cliente NOVO: criar registro no CRM --
      await telegram.sendMessage(
        chatId,
        'Nao encontramos seu cadastro em nosso sistema. Vou criar seu registro agora.\n\n' +
        'Por favor, me informe seu <b>nome completo</b>:'
      );

      updateSession(chatId, State.AWAITING_NAME, {
        crmContactId: null,
        crmDealId: null,
      });

      // Marca para criar CRM após coletar nome
      session._pendingCreate = true;
    }
  } catch (err) {
    console.error('[Auth] Erro ao consultar CRM:', err.message);
    await telegram.sendMessage(chatId, contingencyMessage());
  }
}

// =============================================================================
// FASE 2: Menu Principal e Interações Autenticadas
// =============================================================================

/**
 * Estado AUTHENTICATED — processa texto livre via IA e encaminha.
 */
async function handleAuthenticated(chatId, text, session) {
  const { intent, confidence } = await hermesAI.classifyIntent(text, session.history || []);

  console.log(`[HermesAI] Intencao: ${intent} (confianca: ${(confidence * 100).toFixed(0)}%)`);

  switch (intent) {
    case hermesAI.Intent.STATUS_PROCESSO:
      await promptForStatusCpf(chatId, session);
      break;

    case hermesAI.Intent.AGENDAMENTO:
      await handleAgendamento(chatId, session);
      break;

    case hermesAI.Intent.SOLICITAR_CHAMADA:
      await promptForCallbackDetails(chatId, session);
      break;

    case hermesAI.Intent.FALAR_EQUIPE:
    case hermesAI.Intent.DUVIDA_COMPLEXA:
      await handleHandoff(chatId, session);
      break;

    case hermesAI.Intent.SAUDACAO:
      await telegram.sendMessage(
        chatId,
        `Ola novamente, <b>${session.name || 'cliente'}</b>! Como posso ajudar?`
      );
      await showMainMenu(chatId, session);
      break;

    case hermesAI.Intent.MENU_PRINCIPAL:
      await showMainMenu(chatId, session);
      break;

    case hermesAI.Intent.FORNECER_CPF:
      await telegram.sendMessage(
        chatId,
        'Seu CPF ja foi registrado nesta conversa. Como posso ajudar?'
      );
      await showMainMenu(chatId, session);
      break;

    default:
      // Intenção não clara — oferece o menu
      await telegram.sendMessage(
        chatId,
        'Nao entendi exatamente o que voce precisa. Aqui estao as opcoes disponiveis:'
      );
      await showMainMenu(chatId, session);
  }
}

// ---------------------------------------------------------------------------
// Menu Principal (inline keyboard)
// ---------------------------------------------------------------------------

/**
 * Exibe o menu híbrido com botões inline.
 * O cliente pode clicar nos botões OU digitar em texto livre (interpretado pela IA).
 */
async function showMainMenu(chatId, session) {
  const name = session.name || 'Cliente';

  const buttons = [
    [{ text: 'Status do Processo', callback_data: CALLBACK.MENU_STATUS }],
    [{ text: 'Agendamento de Horario', callback_data: CALLBACK.MENU_AGENDAMENTO }],
    [{ text: 'Solicitar uma Chamada', callback_data: CALLBACK.MENU_CHAMADA }],
    [{ text: 'Falar com a Equipe', callback_data: CALLBACK.MENU_FALAR_EQUIPE }],
  ];

  await telegram.sendInlineKeyboard(
    chatId,
    `<b>Menu Principal</b> — ${name}, como posso ajudar?\n\n` +
    '<i>Voce pode clicar nos botoes abaixo ou digitar sua necessidade em texto livre:</i>',
    buttons
  );

  updateSession(chatId, State.AUTHENTICATED);
}

// =============================================================================
// OPÇÃO 1: Status do Processo
// =============================================================================

/**
 * Solicita o CPF para consulta de status.
 * Se já temos CPF na sessão e é o mesmo contato, usa direto.
 */
async function promptForStatusCpf(chatId, session) {
  // Se o contato já está autenticado e temos o contactId, buscar diretamente
  if (session.crmContactId) {
    await handleStatusLookupDirect(chatId, session);
    return;
  }

  updateSession(chatId, State.AWAITING_STATUS_CPF);

  await telegram.sendMessage(
    chatId,
    '<b>Consulta de Processo</b>\n\n' +
    'Por favor, informe o <b>CPF</b> associado ao processo que deseja consultar:'
  );
}

/**
 * Busca processos diretamente usando o contactId da sessão autenticada.
 */
async function handleStatusLookupDirect(chatId, session) {
  try {
    await telegram.sendMessage(chatId, 'Consultando processos...');

    const deals = await bitrix24.getDealsByContact(session.crmContactId);

    if (!deals || deals.length === 0) {
      await telegram.sendMessage(
        chatId,
        'Nao ha processos ativos vinculados ao seu cadastro no momento.\n\n' +
        'Se acredita que isso e um erro, utilize a opcao "Falar com a Equipe".'
      );
    } else {
      const dealList = deals
        .map((deal, i) => {
          const stage = bitrix24.formatDealStage(deal.STAGE_ID);
          const date = deal.DATE_CREATE
            ? new Date(deal.DATE_CREATE).toLocaleDateString('pt-BR')
            : 'N/D';
          const value = deal.OPPORTUNITY
            ? ` — Valor: R$ ${Number(deal.OPPORTUNITY).toLocaleString('pt-BR')}`
            : '';
          return `<b>${i + 1}.</b> ${deal.TITLE || 'Sem titulo'}\n` +
            `    Estagio: ${stage}${value}\n` +
            `    Abertura: ${date}`;
        })
        .join('\n\n');

      await telegram.sendMessage(
        chatId,
        `<b>Processos Encontrados</b>\n\n${dealList}\n\n` +
        '<i>Para mais detalhes, entre em contato com nossa equipe.</i>'
      );
    }

    updateSession(chatId, State.AUTHENTICATED);
    await showMainMenu(chatId, getSession(chatId));
  } catch (err) {
    console.error('[Status] Erro ao consultar processos:', err.message);
    await telegram.sendMessage(chatId, contingencyMessage());
    updateSession(chatId, State.AUTHENTICATED);
    await showMainMenu(chatId, getSession(chatId));
  }
}

/**
 * Busca os negócios/processos vinculados ao CPF informado (quando não autenticado com contactId).
 */
async function handleStatusLookup(chatId, text, session) {
  const cpf = hermesAI.extractCpf(text);

  if (!cpf) {
    await telegram.sendMessage(
      chatId,
      'Por favor, informe um <b>CPF valido</b> (11 digitos) para consulta:'
    );
    return;
  }

  try {
    await telegram.sendMessage(chatId, 'Consultando processos...');

    const contacts = await bitrix24.findContactByCpfOrPhone({ cpf });
    const contact = contacts?.[0];

    if (!contact) {
      await telegram.sendMessage(
        chatId,
        'Nao encontramos processos vinculados a este CPF.\n\n' +
        'Verifique se o numero esta correto ou entre em contato pelo telefone/WhatsApp: ' +
        `<b>${FALLBACK_PHONE}</b>.`
      );
      updateSession(chatId, State.AUTHENTICATED);
      await showMainMenu(chatId, getSession(chatId));
      return;
    }

    const deals = await bitrix24.getDealsByContact(contact.ID);

    if (!deals || deals.length === 0) {
      await telegram.sendMessage(
        chatId,
        'Nao ha processos ativos vinculados ao CPF informado no momento.\n\n' +
        'Se acredita que isso e um erro, utilize a opcao "Falar com a Equipe".'
      );
    } else {
      const dealList = deals
        .map((deal, i) => {
          const stage = bitrix24.formatDealStage(deal.STAGE_ID);
          const date = deal.DATE_CREATE
            ? new Date(deal.DATE_CREATE).toLocaleDateString('pt-BR')
            : 'N/D';
          return `<b>${i + 1}.</b> ${deal.TITLE || 'Sem titulo'}\n` +
            `    Estagio: ${stage}\n` +
            `    Abertura: ${date}`;
        })
        .join('\n\n');

      await telegram.sendMessage(
        chatId,
        `<b>Processos Encontrados</b>\n\n${dealList}`
      );
    }

    updateSession(chatId, State.AUTHENTICATED);
    await showMainMenu(chatId, getSession(chatId));
  } catch (err) {
    console.error('[Status] Erro ao consultar processos:', err.message);
    await telegram.sendMessage(chatId, contingencyMessage());
    updateSession(chatId, State.AUTHENTICATED);
    await showMainMenu(chatId, getSession(chatId));
  }
}

// =============================================================================
// OPÇÃO 2: Agendamento de Horário
// =============================================================================

/**
 * Exibe as opções de agendamento: link do Booking + slots disponíveis.
 */
async function handleAgendamento(chatId, session) {
  try {
    const bookingLink = bitrix24.getBookingLink();

    await telegram.sendMessage(
      chatId,
      '<b>Agendamento de Horario</b>\n\n' +
      `Para agendar uma consulta, acesse nossa agenda online:\n` +
      `<a href="${bookingLink}">Agenda Online — Brandao Correa</a>\n\n` +
      '<i>Ao clicar no link, voce podera escolher o melhor dia e horario disponivel.</i>'
    );

    // Tentar listar slots disponíveis (se Resource Booking estiver ativo)
    try {
      const slots = await bitrix24.getAvailableSlots();
      if (slots && slots.length > 0) {
        const slotInfo = slots
          .slice(0, 5)
          .map(s => `- ${s.NAME || 'Horario disponivel'}`)
          .join('\n');
        await telegram.sendMessage(
          chatId,
          `<b>Proximos horarios disponiveis:</b>\n${slotInfo}`
        );
      }
    } catch (_) {
      // Slots não disponíveis — o link de booking já foi enviado
    }
  } catch (err) {
    console.error('[Agendamento] Erro:', err.message);
    await telegram.sendMessage(
      chatId,
      'Sistema de agendamento em manutencao. ' +
      `Contate o telefone/WhatsApp de contingencia: ${FALLBACK_PHONE}.`
    );
  }

  await showMainMenu(chatId, session);
}

// =============================================================================
// OPÇÃO 3: Solicitar uma Chamada
// =============================================================================

/**
 * Pergunta detalhes sobre a chamada (telefone de contato, horário).
 */
async function promptForCallbackDetails(chatId, session) {
  // Se já temos telefone, podemos registrar direto
  if (session.phone) {
    await registerCallback(chatId, session.phone, 'Telefone do cadastro', session);
    return;
  }

  updateSession(chatId, State.AWAITING_CALLBACK_DETAILS);

  await telegram.sendMessage(
    chatId,
    '<b>Solicitacao de Chamada</b>\n\n' +
    'Por favor, informe:\n' +
    '- O <b>numero de telefone</b> para retorno\n' +
    '- Seu <b>melhor horario</b> para receber a ligacao\n\n' +
    '<i>Exemplo: "65 99679-4931, amanha entre 14h e 16h"</i>'
  );
}

/**
 * Processa os detalhes da chamada e registra a atividade no CRM.
 */
async function handleCallbackDetails(chatId, text, session) {
  // Extrai telefone do texto (formato comum brasileiro)
  const phoneMatch = text.match(/(\d{2}\s?\d{4,5}-?\d{4})/);
  const callbackPhone = phoneMatch ? phoneMatch[1] : session.phone || null;

  if (!callbackPhone) {
    await telegram.sendMessage(
      chatId,
      'Nao foi possivel identificar um telefone na sua mensagem.\n' +
      'Por favor, informe o numero para retorno (ex: 65 99999-8888):'
    );
    return;
  }

  await registerCallback(chatId, callbackPhone, text, session);
}

/**
 * Registra a atividade de chamada no CRM.
 */
async function registerCallback(chatId, phone, details, session) {
  try {
    await telegram.sendMessage(chatId, 'Registrando sua solicitacao de chamada...');

    await bitrix24.createCallActivity({
      ownerId:   config.bitrix24.operatorAliceId,
      contactId: session.crmContactId || undefined,
      dealId:    session.crmDealId || undefined,
      phone,
    });

    await telegram.sendMessage(
      chatId,
      '<b>Solicitacao registrada com sucesso!</b>\n\n' +
      `Nossa equipe entrara em contato pelo telefone <b>${phone}</b>.\n` +
      'Prioridade <b>Alta</b> — retornaremos o mais breve possivel, no horario comercial.'
    );
  } catch (err) {
    console.error('[Chamada] Erro ao registrar atividade:', err.message);
    await telegram.sendMessage(chatId, contingencyMessage());
  }

  updateSession(chatId, State.AUTHENTICATED);
  await showMainMenu(chatId, getSession(chatId));
}

// =============================================================================
// OPÇÃO 4: Falar com a Equipe (Transbordo / Handoff)
// =============================================================================

/**
 * Executa o protocolo de transbordo para a operadora Alice via Open Channels.
 *
 * Fluxo:
 * 1. Gera resumo da conversa (Hermes IA)
 * 2. Envia mensagem oculta (whisper) com o resumo para a Alice
 * 3. Notifica Alice via IM interno
 * 4. Tenta transferir o chat do Open Channel para Alice
 * 5. Informa o cliente que um humano assumirá
 */
async function handleHandoff(chatId, session) {
  try {
    await telegram.sendMessage(
      chatId,
      '<b>Transferindo para atendimento humano...</b>\n\n' +
      'Voce sera atendido(a) por nossa equipe em instantes. ' +
      'Enquanto isso, pode continuar descrevendo sua necessidade.'
    );

    updateSession(chatId, State.HANDOFF);

    // 1. Gerar resumo da conversa via Hermes IA
    const summary = await hermesAI.generateSummary(session.history || []);

    // 2, 3, 4. Protocolo de transbordo consolidado
    await bitrix24.executeHandoff({
      summary,
      clientName: session.name || 'Cliente nao identificado',
      clientCpf:  session.cpf  || undefined,
      dialogId:   `chat${chatId}`,
    });

    // 5. Mensagem final para o cliente
    await telegram.sendMessage(
      chatId,
      '<b>Voce esta na fila de atendimento humano.</b>\n\n' +
      'Nossa equipe ja foi notificada e entrara em contato em breve. ' +
      `Se preferir, tambem pode nos ligar: <b>${FALLBACK_PHONE}</b>.`
    );

    appendHistory(chatId, 'system', 'Handoff para Alice concluido.');
  } catch (err) {
    console.error('[Handoff] Erro no transbordo:', err.message);
    await telegram.sendMessage(
      chatId,
      'Nao foi possivel completar a transferencia automatica. ' +
      `Contate o telefone/WhatsApp de contingencia: <b>${FALLBACK_PHONE}</b>.`
    );
  }
}

// ---------------------------------------------------------------------------
// Estado HANDOFF — cliente já transferido
// ---------------------------------------------------------------------------

/**
 * Qualquer mensagem adicional no estado HANDOFF é informada.
 */
async function handleHandoffState(chatId, _text) {
  await telegram.sendMessage(
    chatId,
    'Voce esta na fila de atendimento humano. Nossa equipe ja foi notificada e ' +
    `entrara em contato em breve. Se for urgente, ligue para <b>${FALLBACK_PHONE}</b>.`
  );
}

// =============================================================================
// HANDLER: /start
// =============================================================================

/**
 * Reinicia a conversa — limpa o estado e volta ao IDLE.
 */
async function handleStart(chatId, firstName) {
  deleteSession(chatId);
  const session = getSession(chatId);
  await handleIdle(chatId, null, firstName);
}

// =============================================================================
// Inicialização do Servidor
// =============================================================================

const PORT = config.port;

app.listen(PORT, () => {
  console.log('');
  console.log('================================================');
  console.log('  Hermes Bot — Brandao Correa Assessoria');
  console.log('================================================');
  console.log(`  Servidor:  http://localhost:${PORT}`);
  console.log(`  Webhook:   http://localhost:${PORT}/webhook/telegram`);
  console.log(`  Health:    http://localhost:${PORT}/health`);
  console.log(`  Ambiente:  ${config.nodeEnv}`);
  console.log(`  Bitrix24:  ${config.bitrix24.domain}`);
  console.log(`  IA Ativa:  ${config.hermesAI.apiKey ? 'Sim' : 'Nao (regex fallback)'}`);
  console.log(`  Seguranca: ${config.telegram.webhookSecret ? 'Webhook token ativado' : 'Sem webhook token'}`);
  console.log('================================================');
  console.log('');
});

// =============================================================================
// Tratamento de erros não capturados
// =============================================================================

process.on('SIGTERM', () => {
  console.log('[Hermes] SIGTERM recebido. Encerrando graciosamente...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Hermes] SIGINT recebido. Encerrando graciosamente...');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Rejection:', reason);
});

export default app;
