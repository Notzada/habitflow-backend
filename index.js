// ============================================
// NEXORAFLOW BACKEND
// Telegram Bot + Gemini AI + Supabase
// Sistema Híbrido: Regex (comandos simples) + IA (mensagens complexas)
// ============================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const GEMINI_KEY     = process.env.GEMINI_KEY;
const WEBHOOK_URL    = process.env.WEBHOOK_URL;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const genAI    = new GoogleGenerativeAI(GEMINI_KEY);
const model    = genAI.getGenerativeModel({ model: 'gemini-flash-latest' });

// ============================================
// TELEGRAM: registrar webhook
// ============================================
async function registerWebhook() {
  const url  = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${WEBHOOK_URL}/webhook`;
  const res  = await fetch(url);
  const data = await res.json();
  console.log('Webhook registrado:', data.ok ? '✅' : '❌', data.description || '');
}

// ============================================
// CAMADA 1 — REGEX: comandos simples e diretos
// Resolve sem consumir nenhuma chamada de IA.
// ============================================

const CATEGORY_MAP = {
  Alimentação: [
    /almo[çc]o/i, /janta/i, /caf[eé]/i, /restaurante/i, /lanche/i,
    /pizza/i, /hamburguer/i, /ifood/i, /rappi/i, /mercado/i, /supermercado/i,
    /padaria/i, /a[çc]ougue/i, /hortifruti/i, /feira/i, /delivery/i,
  ],
  Transporte: [
    /uber/i, /99/i, /taxi/i, /t[áa]xi/i, /[oô]nibus/i, /metro/i,
    /metr[ôo]/i, /gasolina/i, /combust[ií]vel/i, /estacionamento/i,
    /ped[áa]gio/i, /passagem/i, /bilhete/i, /brt/i,
  ],
  Saúde: [
    /farm[áa]cia/i, /rem[eé]dio/i, /medica(mento)?/i, /m[eé]dico/i,
    /consulta/i, /exame/i, /plano de sa[úu]de/i, /hospital/i, /cl[ií]nica/i,
    /dentista/i, /psic[oó]logo/i, /suplemento/i,
  ],
  Lazer: [
    /cinema/i, /teatro/i, /show/i, /bar/i, /balada/i, /festa/i,
    /netflix/i, /spotify/i, /steam/i, /jogo/i, /game/i, /viagem/i,
    /hotel/i, /passeio/i, /ingresso/i,
  ],
  Casa: [
    /aluguel/i, /condom[ií]nio/i, /conta de luz/i, /conta de [áa]gua/i,
    /internet/i, /telefone/i, /g[áa]s/i, /limpeza/i, /reforma/i,
  ],
  Educação: [
    /curso/i, /faculdade/i, /escola/i, /livro/i, /apostila/i,
    /mensalidade/i, /matr[ií]cula/i, /udemy/i, /alura/i,
  ],
  Roupas: [
    /roupa/i, /camisa/i, /cal[çc]a/i, /t[êe]nis/i, /sapato/i,
    /vestido/i, /jaqueta/i, /zara/i, /renner/i, /riachuelo/i,
  ],
};

const HABIT_KEYWORDS = [
  { regex: /academia|treino|muscula[çc][ãa]o|exerc[ií]cio|gym/i,  name: 'Academia',    emoji: '💪' },
  { regex: /medita[çc][ãa]o|meditei|mindfulness/i,                 name: 'Meditação',   emoji: '🧘' },
  { regex: /leitura|li um livro|li \d+ p[áa]ginas|lendo/i,         name: 'Leitura',     emoji: '📚' },
  { regex: /bebi [12][\.,]?\d*\s*l(itros)?|[áa]gua.*dia|hidrat/i, name: 'Água 2L',     emoji: '💧' },
  { regex: /dormi cedo|dormir cedo|cama cedo/i,                     name: 'Dormir cedo', emoji: '😴' },
  { regex: /corri|corrida|running/i,                                name: 'Corrida',     emoji: '🏃' },
];

const QUERY_KEYWORDS = [
  { regex: /quanto gastei (essa|esta) semana|gastos da semana|resumo da semana/i, question: 'gastos' },
  { regex: /quanto gastei (esse|este) m[eê]s|gastos do m[eê]s|resumo do m[eê]s/i, question: 'mes' },
  { regex: /gastos de hoje|gastei hoje|quanto gastei hoje/i,                       question: 'hoje' },
  { regex: /meus h[áa]bitos|h[áa]bitos de hoje|fiz hoje/i,                        question: 'habitos' },
  { regex: /minhas metas|ver metas|metas financeiras/i,                            question: 'metas' },
  { regex: /resumo|relat[oó]rio|como estou/i,                                      question: 'gastos' },
  { regex: /\/gastos/i,                                                             question: 'gastos' },
  { regex: /\/habitos|\/hábitos/i,                                                 question: 'habitos' },
  { regex: /\/metas/i,                                                              question: 'metas' },
];

// "gastei 20 com almoço" / "paguei 50 reais de uber" / "comprei remédio por 45"
const EXPENSE_REGEX     = /(?:gastei|paguei|comprei|custou|cobrou|desembolsei|gasto de|gasto com)\s+(?:r\$\s*)?(\d+[\.,]?\d*)\s*(?:reais?|r\$)?\s*(?:(?:com|de|no?|na|em|por|pelo?|pela)\s+(.+))?/i;
const EXPENSE_REGEX_ALT = /(?:r\$\s*)?(\d+[\.,]?\d*)\s*(?:reais?)?\s*(?:de|no?|na|em|com)\s+(.+)/i;

const TASK_REGEX = /(?:preciso|lembrar de|n[ãa]o esquecer de|anota[r]?|add tarefa|tarefa:|todo:)\s+(.+)/i;

function detectCategory(text) {
  for (const [cat, patterns] of Object.entries(CATEGORY_MAP)) {
    if (patterns.some(p => p.test(text))) return cat;
  }
  return 'Outros';
}

function tryRegex(text) {
  const t = text.trim();

  // QUERY
  for (const { regex, question } of QUERY_KEYWORDS) {
    if (regex.test(t)) {
      console.log('⚡ [REGEX] query →', question);
      return { type: 'query', data: { question }, reply: null, _source: 'regex' };
    }
  }

  // HÁBITO — precisa de verbo de conclusão para não confundir com gasto
  for (const { regex, name, emoji } of HABIT_KEYWORDS) {
    if (/fiz|fui|completei|terminei|realizei|pratiquei|treinei|li|corri|bebi|meditei/i.test(t) && regex.test(t)) {
      console.log('⚡ [REGEX] habit →', name);
      return {
        type: 'habit',
        data: { name, emoji },
        reply: `${emoji} *${name}* registrado! Continue assim! 💪`,
        _source: 'regex'
      };
    }
  }

  // GASTO
  let match = EXPENSE_REGEX.exec(t) || EXPENSE_REGEX_ALT.exec(t);
  if (match) {
    const amount      = parseFloat(match[1].replace(',', '.'));
    const description = (match[2] || t).trim().replace(/\.$/, '');
    const category    = detectCategory(description + ' ' + t);
    console.log('⚡ [REGEX] expense →', { amount, description, category });
    return {
      type: 'expense',
      data: { description, amount, category },
      reply: `💸 *R$${amount.toFixed(2)}* em *${description}* registrado! (${category})`,
      _source: 'regex'
    };
  }

  // TAREFA
  const taskMatch = TASK_REGEX.exec(t);
  if (taskMatch) {
    const taskText = taskMatch[1].trim();
    console.log('⚡ [REGEX] task →', taskText);
    return {
      type: 'task',
      data: { text: taskText, tag: 'Geral' },
      reply: `📋 Tarefa adicionada: *${taskText}*`,
      _source: 'regex'
    };
  }

  return null; // cai para IA
}

// ============================================
// CAMADA 2 — GEMINI: mensagens complexas/ambíguas
// Só chamado quando o Regex não resolveu.
// ============================================
async function interpretWithAI(text) {
  console.log('🤖 [GEMINI] chamando IA para:', text);

  const prompt = `
Você é um assistente de finanças e hábitos pessoais.
Analise a mensagem abaixo e retorne APENAS um JSON válido (sem markdown, sem explicação).

Mensagem: "${text}"

Categorias de gastos válidas: Alimentação, Transporte, Lazer, Saúde, Casa, Educação, Roupas, Outros

Retorne um JSON com EXATAMENTE este formato:
{
  "type": "expense" | "habit" | "task" | "query" | "unknown",
  "data": {
    "description": "descrição",
    "amount": 0.0,
    "category": "Alimentação",
    "name": "nome do hábito",
    "text": "descrição da tarefa",
    "tag": "Pessoal",
    "question": "gastos" | "mes" | "hoje" | "habitos" | "metas"
  },
  "reply": "mensagem amigável de confirmação em português"
}
`;

  try {
    const result = await model.generateContent(prompt);
    const raw    = result.response.text().trim();
    const clean  = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    parsed._source = 'ai';
    return parsed;
  } catch (e) {
    console.error('Erro Gemini:', e.message);
    return {
      type: 'unknown', data: {},
      reply: 'Não entendi. Tente: "gastei 50 no almoço" ou "fiz academia hoje".',
      _source: 'ai_error'
    };
  }
}

async function interpretMessage(text) {
  const fast = tryRegex(text);
  if (fast) return fast;
  return interpretWithAI(text);
}

// ============================================
// SUPABASE: salvar
// ============================================
async function saveExpense({ description, amount, category }) {
  const { error } = await supabase.from('expenses').insert([{
    description, amount: parseFloat(amount), category: category || 'Outros', source: 'telegram'
  }]);
  if (error) console.error('ERRO AO SALVAR GASTO:', error);
  else console.log('✅ Gasto salvo:', description, amount);
}

async function saveHabitLog(habitName) {
  const { data: habits } = await supabase.from('habits').select('id, name').ilike('name', `%${habitName}%`).limit(1);
  if (!habits || habits.length === 0) {
    const { data: newHabit } = await supabase.from('habits').insert({ name: habitName, emoji: '✅' }).select().single();
    if (newHabit) await supabase.from('habit_logs').insert({ habit_id: newHabit.id, source: 'telegram' });
    return;
  }
  await supabase.from('habit_logs').upsert({
    habit_id: habits[0].id,
    done_at:  new Date().toISOString().split('T')[0],
    source:   'telegram'
  }, { onConflict: 'habit_id,done_at' });
}

async function saveTask({ text, tag }) {
  await supabase.from('tasks').insert({ text, tag: tag || 'Geral' });
}

// ============================================
// SUPABASE: consultas
// ============================================
async function getWeeklyExpenses() {
  const from = new Date(); from.setDate(from.getDate() - 7);
  const { data } = await supabase.from('expenses').select('description, amount, category, created_at').gte('created_at', from.toISOString()).order('created_at', { ascending: false });
  if (!data || !data.length) return 'Nenhum gasto registrado essa semana.';
  const total = data.reduce((s, e) => s + parseFloat(e.amount), 0);
  const bycat = data.reduce((acc, e) => { acc[e.category] = (acc[e.category] || 0) + parseFloat(e.amount); return acc; }, {});
  const cats  = Object.entries(bycat).sort((a, b) => b[1] - a[1]).map(([c, v]) => `  • ${c}: R$${v.toFixed(2)}`).join('\n');
  return `📊 *Gastos esta semana:*\nTotal: R$${total.toFixed(2)}\n\n${cats}`;
}

async function getMonthlyExpenses() {
  const first = new Date(); first.setDate(1); first.setHours(0, 0, 0, 0);
  const { data } = await supabase.from('expenses').select('amount').gte('created_at', first.toISOString());
  if (!data || !data.length) return 'Nenhum gasto este mês ainda.';
  const total = data.reduce((s, e) => s + parseFloat(e.amount), 0);
  return `💰 Total do mês: *R$${total.toFixed(2)}* (${data.length} transações)`;
}

async function getTodayExpenses() {
  const today = new Date().toISOString().split('T')[0];
  const { data } = await supabase.from('expenses').select('description, amount, category').gte('created_at', today + 'T00:00:00').order('created_at', { ascending: false });
  if (!data || !data.length) return 'Nenhum gasto registrado hoje ainda.';
  const total = data.reduce((s, e) => s + parseFloat(e.amount), 0);
  const list  = data.map(e => `  • ${e.description}: R$${parseFloat(e.amount).toFixed(2)}`).join('\n');
  return `🌅 *Gastos de hoje:*\nTotal: R$${total.toFixed(2)}\n\n${list}`;
}

async function getTodayHabits() {
  const today = new Date().toISOString().split('T')[0];
  const { data } = await supabase.from('habit_logs').select('habits(name, emoji)').eq('done_at', today);
  if (!data || !data.length) return 'Nenhum hábito registrado hoje ainda. 💪';
  return `🌟 *Hábitos de hoje:*\n${data.map(l => `  ✅ ${l.habits.emoji} ${l.habits.name}`).join('\n')}`;
}

async function getGoals() {
  const { data } = await supabase.from('goals').select('*');
  if (!data || !data.length) return 'Nenhuma meta cadastrada.';
  const list = data.map(g => {
    const pct = Math.round((g.current / g.target) * 100);
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    return `🎯 *${g.name}*\n  ${bar} ${pct}%\n  R$${g.current} / R$${g.target}`;
  }).join('\n\n');
  return `📈 *Suas metas:*\n\n${list}`;
}

// ============================================
// TELEGRAM: enviar mensagem
// ============================================
async function sendTelegram(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
  });
}

// ============================================
// ROTA PRINCIPAL: webhook do Telegram
// ============================================
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const message = req.body?.message;
  if (!message?.text) return;

  const chatId = message.chat.id;
  const text   = message.text;
  console.log(`📨 [${chatId}] ${text}`);

  if (text === '/start') {
    return sendTelegram(chatId,
      `👋 *Olá! Sou o bot do NexoraFlow!*\n\n` +
      `Você pode me mandar mensagens como:\n\n` +
      `💸 "gastei 45 reais no almoço"\n` +
      `💸 "paguei 120 de uber"\n` +
      `✅ "fiz academia hoje"\n` +
      `📋 "preciso comprar remédio"\n` +
      `📊 "quanto gastei essa semana?"\n` +
      `📊 "quanto gastei esse mês?"\n` +
      `📊 "gastos de hoje"\n` +
      `🎯 "minhas metas"\n\n` +
      `Atalhos rápidos: /gastos /habitos /metas\n\n` +
      `Tudo aparece no seu dashboard em tempo real! 🚀`
    );
  }

  // ⚡ Sistema híbrido: Regex primeiro, IA como fallback
  const interpreted = await interpretMessage(text);
  const tag = interpreted._source === 'regex' ? '⚡ [REGEX]' : '🤖 [AI]';
  console.log(`${tag} Resultado:`, JSON.stringify(interpreted));

  let reply = interpreted.reply || 'Mensagem processada!';

  switch (interpreted.type) {
    case 'expense':
      await saveExpense(interpreted.data);
      break;
    case 'habit':
      await saveHabitLog(interpreted.data.name);
      break;
    case 'task':
      await saveTask(interpreted.data);
      break;
    case 'query': {
      const q = interpreted.data.question;
      if      (q === 'gastos' || q === 'resumo')   reply = await getWeeklyExpenses();
      else if (q === 'mes'    || q === 'mês')       reply = await getMonthlyExpenses();
      else if (q === 'hoje')                        reply = await getTodayExpenses();
      else if (q === 'habitos' || q === 'hábitos')  reply = await getTodayHabits();
      else if (q === 'metas')                       reply = await getGoals();
      else                                          reply = await getWeeklyExpenses();
      break;
    }
    default:
      reply = '🤔 Não entendi. Tente: "gastei 50 no mercado" ou "fiz academia hoje".';
  }

  await sendTelegram(chatId, reply);
});

// ============================================
// ROTA DE SAÚDE
// ============================================
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'NexoraFlow Bot', timestamp: new Date().toISOString() });
});

// ============================================
// INICIALIZAÇÃO
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 NexoraFlow Bot rodando na porta ${PORT}`);
  if (WEBHOOK_URL) await registerWebhook();
});
