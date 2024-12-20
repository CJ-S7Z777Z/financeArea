// server.js
require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const Redis = require('ioredis');

const app = express();
const port = process.env.PORT || 3000;

// Инициализация Redis
const redis = new Redis(process.env.REDIS_URL);

// Инициализация бота
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Обработка команды /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();

    // Проверяем, существует ли пользователь в Redis
    const userExists = await redis.exists(`user:${userId}`);

    if (!userExists) {
        // Если пользователь новый, инициализируем его данные
        await redis.hmset(`user:${userId}`, {
            balance: 0,
            premium: 0,
            language: msg.from.language_code || 'en',
            account_age: Math.floor(Math.random() * 56) + 45, // от 45 до 100
            bonus: Math.floor(Math.random() * 101) + 75 // от 75 до 175
        });
    }

    // Отправка приветственного сообщения с кнопкой для открытия мини-приложения
    const welcomeMessage = 'Привет! Добро пожаловать в Crow Cage.\nЭто мини-приложение для управления вашим аккаунтом.';
    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{
                    text: 'Открыть мини-приложение',
                    web_app: { url: `${process.env.APP_URL}/` }
                }]
            ]
        }
    };

    bot.sendMessage(chatId, welcomeMessage, opts);
});

// Маршруты для мини-приложения
app.use(express.static('public'));

// Маршрут для получения данных пользователя
app.get('/api/user/:id', async (req, res) => {
    const userId = req.params.id;
    const userData = await redis.hgetall(`user:${userId}`);
    if (Object.keys(userData).length === 0) {
        return res.status(404).json({ error: 'User not found' });
    }
    res.json(userData);
});

// Маршрут для обновления пользователя после подсчета
app.post('/api/user/:id', express.json(), async (req, res) => {
    const userId = req.params.id;
    const { balance } = req.body;
    await redis.hset(`user:${userId}`, 'balance', balance);
    res.json({ success: true });
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
