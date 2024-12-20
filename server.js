
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const ExcelJS = require('exceljs');
const redis = require('redis');

// Замените на ваш токен
const TELEGRAM_TOKEN = '7846183336:AAH6T3A_ajUutR-OMBwxiZSrRxja-B4XQKM';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 5000;

// Подключение к Redis
const redisClient = redis.createClient({
  url: 'redis://default:nIDlbuPAytksZEJFEtGtLisaTkzCXCAa@autorack.proxy.rlwy.net:57349' // Убедись, что URL соответствует твоему Redis-серверу
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));

(async () => {
  try {
    await redisClient.connect();
    console.log('Подключено к Redis');
  } catch (err) {
    console.error('Ошибка подключения к Redis:', err);
  }
})();

app.use(bodyParser.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Функция для добавления транзакции
async function addTransaction(type, amount, description) {
  const id = Date.now();
  const date = new Date().toISOString();
  const transactionKey = `transaction:${id}`;
  const commentsKey = `transaction:${id}:comments`;

  // Добавление транзакции как хеш
  await redisClient.hSet(transactionKey, {
    id: id.toString(), // Хранить ID как строку
    type,
    amount,
    description,
    date
  });

  // Добавление ID транзакции в соответствующий список
  await redisClient.rPush(type, id.toString());

  return { id, type, amount, description, date };
}

// Функция для получения всех транзакций
async function getAllTransactions() {
  // Получение всех доходов
  const incomeIds = await redisClient.lRange('income', 0, -1);
  const incomePromises = incomeIds.map(id => redisClient.hGetAll(`transaction:${id}`));
  const incomes = await Promise.all(incomePromises);

  // Получение всех расходов
  const expenseIds = await redisClient.lRange('expense', 0, -1);
  const expensePromises = expenseIds.map(id => redisClient.hGetAll(`transaction:${id}`));
  const expenses = await Promise.all(expensePromises);

  // Для каждой транзакции получаем комментарии
  const allTransactions = [...incomes, ...expenses];
  for (let tx of allTransactions) {
    if (tx && tx.id) { // Проверка наличия транзакции
      const comments = await redisClient.lRange(`transaction:${tx.id}:comments`, 0, -1);
      tx.comments = comments.map(comment => JSON.parse(comment));
    }
  }

  return { income: incomes.filter(tx => tx.id), expenses: expenses.filter(tx => tx.id) };
}

// Функция для добавления комментария
async function addComment(id, type, name, comment) {
  const transactionKey = `transaction:${id}`;
  const tx = await redisClient.hGetAll(transactionKey);

  if (!tx || Object.keys(tx).length === 0) {
    return { success: false, message: 'Запись не найдена.' };
  }

  const commentObj = {
    name,
    comment,
    date: new Date().toISOString()
  };

  await redisClient.rPush(`transaction:${id}:comments`, JSON.stringify(commentObj));

  return { success: true, comment: commentObj };
}

// Обработка сообщений бота
bot.onText(/\/add (income|expense) (\d+)\s*(.*)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const type = match[1].toLowerCase();
  const amount = parseFloat(match[2]);
  const description = match[3] || 'Без описания';

  if (isNaN(amount) || amount <= 0) {
    bot.sendMessage(chatId, 'Пожалуйста, введите корректную сумму.');
    return;
  }

  if (!['income', 'expense'].includes(type)) {
    bot.sendMessage(chatId, 'Тип должен быть либо income (доход), либо expense (расход).');
    return;
  }

  try {
    const transaction = await addTransaction(type, amount, description);
    bot.sendMessage(chatId, `${type === 'income' ? 'Доход' : 'Расход'} добавлен: ${amount} руб. - ${description}`);

    const data = await getAllTransactions();
    io.emit('update', data);
  } catch (err) {
    console.error('Ошибка при добавлении транзакции:', err);
    bot.sendMessage(chatId, 'Произошла ошибка при добавлении транзакции.');
  }
});

// API для получения данных
app.get('/api/data', async (req, res) => {
  try {
    const data = await getAllTransactions();
    res.json(data);
  } catch (err) {
    console.error('Ошибка при получении данных:', err);
    res.status(500).json({ message: 'Ошибка при получении данных.' });
  }
});

// API для добавления комментария
app.post('/api/comments', async (req, res) => {
  const { id, type, name, comment } = req.body;

  console.log('Получен запрос на добавление комментария:', req.body);

  if (!id || !type || !name || !comment) {
    console.log('Недостаточно данных для добавления комментария.');
    return res.status(400).json({ message: 'Недостаточно данных для добавления комментария.' });
  }

  console.log(`Ищем в коллекции ${type} запись с id: ${id}`);

  try {
    const result = await addComment(id, type, name, comment);

    if (!result.success) {
      console.log(`Запись не найдена. ID: ${id}, Type: ${type}`);
      return res.status(404).json({ message: 'Запись не найдена.' });
    }

    console.log('Добавлен комментарий:', result.comment);

    const data = await getAllTransactions();
    io.emit('update', data);

    res.status(201).json({ message: 'Комментарий добавлен.', comment: result.comment });
  } catch (err) {
    console.error('Ошибка при добавлении комментария:', err);
    res.status(500).json({ message: 'Произошла ошибка при добавлении комментария.' });
  }
});

// API для экспорта данных в Excel
app.get('/api/export', async (req, res) => {
  try {
    const data = await getAllTransactions();
    const workbook = new ExcelJS.Workbook();

    // Создание листа для доходов
    const incomeSheet = workbook.addWorksheet('Доходы');
    incomeSheet.columns = [
      { header: 'ID', key: 'id', width: 15 },
      { header: 'Сумма (руб.)', key: 'amount', width: 15 },
      { header: 'Описание', key: 'description', width: 30 },
      { header: 'Дата', key: 'date', width: 25 },
      { header: 'Комментарии', key: 'comments', width: 50 }
    ];

    for (let entry of data.income) {
      incomeSheet.addRow({
        id: entry.id,
        amount: entry.amount,
        description: entry.description,
        date: new Date(entry.date).toLocaleString(),
        comments: entry.comments.map(c => `${c.name}: ${c.comment}`).join('\n')
      });
    }

    // Создание листа для расходов
    const expensesSheet = workbook.addWorksheet('Расходы');
    expensesSheet.columns = [
      { header: 'ID', key: 'id', width: 15 },
      { header: 'Сумма (руб.)', key: 'amount', width: 15 },
      { header: 'Описание', key: 'description', width: 30 },
      { header: 'Дата', key: 'date', width: 25 },
      { header: 'Комментарии', key: 'comments', width: 50 }
    ];

    for (let entry of data.expenses) {
      expensesSheet.addRow({
        id: entry.id,
        amount: entry.amount,
        description: entry.description,
        date: new Date(entry.date).toLocaleString(),
        comments: entry.comments.map(c => `${c.name}: ${c.comment}`).join('\n')
      });
    }

    // Настройка заголовка ответа
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=FinanceData.xlsx');

    // Отправка файла
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Ошибка при экспорте данных в Excel:', err);
    res.status(500).json({ message: 'Ошибка при экспорте данных в Excel.' });
  }
});

// Запуск WebSocket соединения
io.on('connection', (socket) => {
  console.log('Новый клиент подключен');

  socket.on('disconnect', () => {
    console.log('Клиент отключен');
  });
});

// Запуск сервера
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
