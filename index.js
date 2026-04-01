// ============================================
// HABITFLOW BACKEND
// Telegram Bot + Gemini AI + Supabase
// ============================================



const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

// --- Configurações (variáveis de ambiente) ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const GEMINI_KEY     = process.env.GEMINI_KEY;
const WEBHOOK_URL    = process.env.WEBHOOK_URL; // URL do seu Render.com

// --- Clientes ---
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const genAI    = new GoogleGenerativeAI(GEMINI_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-flash-latest' });

// ============================================
// TELEGRAM: registrar webhook automaticamente
// ============================================
async function registerWebhook() {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${WEBHOOK_URL}/webhook`;
  const res  = await fetch(url);
  const data = await res.json();
  console.log('Webhook registrado:', data.ok ? '✅' : '❌', data.description || '');
}

// ============================================
// GEMINI: interpreta a mensagem do usuário
// ============================================
async function interpretMessage(text) {
  const prompt = `
Você é um assistente de finanças e hábitos pessoais. 
Analise a mensagem abaixo e retorne APENAS um JSON válido (sem markdown, sem explicação).

Mensagem: "${text}"

Categorias de gastos válidas: Alimentação, Transporte, Lazer, Saúde, Casa, Educação, Roupas, Outros

Retorne um JSON com EXATAMENTE este formato:
{
  "type": "expense" | "habit" | "task" | "query" | "unknown",
  "data": {
    // Para expense:
    "description": "descrição do gasto",
    "amount": 99.90,
    "category": "Alimentação",

    // Para habit:
    "name": "nome do hábito que foi feito",

    // Para task:
    "text": "descrição da tarefa",
    "tag": "Pessoal",

    // Para query:
    "question": "resumo" | "gastos" | "habitos" | "metas"
  },
  "reply": "mensagem amigável de confirmação em português"
}
`;

  try {
    const result = await model.generateContent(prompt);
    const raw    = result.response.text().trim();
    const clean  = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('Erro Gemini:', e.message);
    return { type: 'unknown', data: {}, reply: 'Não entendi sua mensagem. Tente: "gastei 50 reais no almoço" ou "fiz academia hoje".' };
  }
}

// ============================================
// SUPABASE: salvar os dados
// ============================================
async function saveExpense({ description, amount, category }) {
  const { error } = await supabase.from('expenses').insert({
    description,
    amount: parseFloat(amount),
    category: category || 'Outros',
    source: 'telegram'
  });
  if (error) console.error('Erro ao salvar gasto:', error.message);
}

async function saveHabitLog(habitName) {
  // Busca o hábito pelo nome (case insensitive)
  const { data: habits } = await supabase
    .from('habits')
    .select('id, name')
    .ilike('name', `%${habitName}%`)
    .limit(1);

  if (!habits || habits.length === 0) {
    // Cria o hábito se não existir
    const { data: newHabit } = await supabase
      .from('habits')
      .insert({ name: habitName, emoji: '✅' })
      .select()
      .single();
    if (newHabit) {
      await supabase.from('habit_logs').insert({ habit_id: newHabit.id, source: 'telegram' });
    }
    return;
  }

  await supabase.from('habit_logs').upsert({
    habit_id: habits[0].id,
    done_at: new Date().toISOString().split('T')[0],
    source: 'telegram'
  }, { onConflict: 'habit_id,done_at' });
}

async function saveTask({ text, tag }) {
  await supabase.from('tasks').insert({ text, tag: tag || 'Geral' });
}

// ============================================
// SUPABASE: consultas para responder o usuário
// ============================================
async function getWeeklyExpenses() {
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  const { data } = await supabase
    .from('expenses')
    .select('description, amount, category, created_at')
    .gte('created_at', weekAgo.toISOString())
    .order('created_at', { ascending: false });

  if (!data || data.length === 0) return 'Nenhum gasto registrado essa semana.';

  const total = data.reduce((s, e) => s + parseFloat(e.amount), 0);
  const bycat = data.reduce((acc, e) => {
    acc[e.category] = (acc[e.category] || 0) + parseFloat(e.amount);
    return acc;
  }, {});

  const cats = Object.entries(bycat)
    .sort((a, b) => b[1] - a[1])
    .map(([c, v]) => `  • ${c}: R$${v.toFixed(2)}`)
    .join('\n');

  return `📊 *Gastos esta semana:*\nTotal: R$${total.toFixed(2)}\n\n${cats}`;
}

async function getMonthlyExpenses() {
  const firstDay = new Date();
  firstDay.setDate(1);
  firstDay.setHours(0, 0, 0, 0);

  const { data } = await supabase
    .from('expenses')
    .select('amount, category')
    .gte('created_at', firstDay.toISOString());

  if (!data || data.length === 0) return 'Nenhum gasto este mês ainda.';

  const total = data.reduce((s, e) => s + parseFloat(e.amount), 0);
  return `💰 Total do mês: *R$${total.toFixed(2)}* (${data.length} transações)`;
}

async function getTodayHabits() {
  const today = new Date().toISOString().split('T')[0];
  const { data } = await supabase
    .from('habit_logs')
    .select('habits(name, emoji)')
    .eq('done_at', today);

  if (!data || data.length === 0) return 'Nenhum hábito registrado hoje ainda. 💪';

  const list = data.map(l => `  ✅ ${l.habits.emoji} ${l.habits.name}`).join('\n');
  return `🌟 *Hábitos de hoje:*\n${list}`;
}

async function getGoals() {
  const { data } = await supabase.from('goals').select('*');
  if (!data || data.length === 0) return 'Nenhuma meta cadastrada.';

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
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown'
    })
  });
}

// ============================================
// ROTA PRINCIPAL: webhook do Telegram
// ============================================
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responde logo para o Telegram não reenviar

  const message = req.body?.message;
  if (!message?.text) return;

  const chatId = message.chat.id;
  const text   = message.text;

  console.log(`📨 [${chatId}] ${text}`);

  // Comando /start
  if (text === '/start') {
    return sendTelegram(chatId,
      `👋 *Olá! Sou o bot do HabitFlow!*\n\n` +
      `Você pode me mandar mensagens como:\n\n` +
      `💸 "gastei 45 reais no almoço"\n` +
      `💸 "paguei 120 de uber"\n` +
      `✅ "fiz academia hoje"\n` +
      `📋 "preciso comprar remédio"\n` +
      `📊 "resumo dos meus gastos"\n` +
      `📊 "quanto gastei essa semana?"\n` +
      `🎯 "minhas metas"\n\n` +
      `Tudo aparece no seu dashboard em tempo real! 🚀`
    );
  }

  // Interpreta a mensagem com Gemini
  const interpreted = await interpretMessage(text);
  console.log('🤖 Interpretado:', JSON.stringify(interpreted));

  let reply = interpreted.reply || 'Mensagem processada!';

  // Executa a ação
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

    case 'query':
      const q = interpreted.data.question;
      if (q === 'gastos' || q === 'resumo')    reply = await getWeeklyExpenses();
      else if (q === 'mes' || q === 'mês')      reply = await getMonthlyExpenses();
      else if (q === 'habitos' || q === 'hábitos') reply = await getTodayHabits();
      else if (q === 'metas')                   reply = await getGoals();
      else                                      reply = await getWeeklyExpenses();
      break;

    default:
      reply = '🤔 Não entendi. Tente: "gastei 50 no mercado" ou "fiz academia hoje".';
  }

  await sendTelegram(chatId, reply);
});

// ============================================
// ROTA DE SAÚDE (para o Render não dormir)
// ============================================
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'HabitFlow Bot', timestamp: new Date().toISOString() });
});


console.log("ANTES DE SALVAR:", interpreted.data);

const { data, error } = await supabase
  .from('expenses')
  .insert([{
    description: interpreted.data.description,
    amount: interpreted.data.amount,
    category: interpreted.data.category
  }]);

if (error) {
  console.log("ERRO AO SALVAR:", error);
} else {
  console.log("SALVO COM SUCESSO:", data);
}
// ============================================
// INICIALIZAÇÃO
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 HabitFlow Bot rodando na porta ${PORT}`);
  if (WEBHOOK_URL) await registerWebhook();
});
