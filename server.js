// server.js
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*", // В проде лучше указать URL твоего фронтенда
    methods: ["GET", "POST"]
  }
});

// Подключение к KV базе (Redis на Render)
// Если REDIS_URL нет, используем временную заглушку в памяти (Map)
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;
const memoryKV = new Map();

// Вспомогательные функции для работы с KV
async function setKV(key, value) {
  if (redis) await redis.set(key, JSON.stringify(value));
  else memoryKV.set(key, JSON.stringify(value));
}

async function getKV(key) {
  if (redis) {
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  }
  const data = memoryKV.get(key);
  return data ? JSON.parse(data) : null;
}

// 1. API Регистрации
app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  const existingUser = await getKV(`user:${email}`);
  
  if (existingUser) return res.status(400).json({ error: 'Пользователь уже существует' });

  const newUser = { id: Date.now(), username, email, password };
  await setKV(`user:${email}`, newUser);
  res.json({ message: 'Успешная регистрация', user: newUser });
});

// 2. API Логина
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await getKV(`user:${email}`);
  
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Неверные данные' });
  }
  res.json({ message: 'Успешный вход', user });
});

// 3. WebSockets для сообщений
io.on('connection', (socket) => {
  console.log('Пользователь подключился:', socket.id);

  // Присоединение к чату
  socket.on('join_chat', (chatId) => {
    socket.join(chatId);
    console.log(`User joined chat ${chatId}`);
  });

  // Отправка сообщения
  socket.on('send_message', async (data) => {
    // data = { chatId, text, senderId, time }
    const message = { id: Date.now(), ...data };
    
    // Сохраняем в KV базу
    let chatHistory = await getKV(`messages:${data.chatId}`) || [];
    chatHistory.push(message);
    await setKV(`messages:${data.chatId}`, chatHistory);

    // Рассылаем всем в комнате
    io.to(data.chatId).emit('receive_message', message);
  });

  socket.on('disconnect', () => {
    console.log('Пользователь отключился:', socket.id);
  });
});

const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});