import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;
const memoryKV = new Map();

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

// ==================== СТАТУСЫ ПОЛЬЗОВАТЕЛЕЙ ====================
const userStatus = new Map(); // userId → { online, lastSeen }

// Обновление статуса
function updateUserStatus(userId, online) {
  userStatus.set(userId, {
    online,
    lastSeen: new Date().toISOString()
  });
  
  // Рассылаем обновление всем подключенным
  io.emit('user_status_update', { 
    userId, 
    online, 
    lastSeen: userStatus.get(userId).lastSeen 
  });
}

// ==================== API ====================

app.post('/api/register', async (req, res) => {
  const { username, email, password, avatar } = req.body;
  const existingUser = await getKV(`user:${email}`);
 
  if (existingUser) return res.status(400).json({ error: 'Пользователь с таким email уже существует' });

  const newUser = {
    id: Date.now().toString(),
    username,
    email,
    password,
    avatar: avatar || '👤'
  };

  await setKV(`user:${email}`, newUser);
  await addUserToList(newUser);
  
  res.json({ message: 'Успешная регистрация', user: newUser });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await getKV(`user:${email}`);
 
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }

  updateUserStatus(user.id, true); // помечаем как онлайн

  res.json({ message: 'Успешный вход', user });
});

app.get('/api/users', async (req, res) => {
  const users = await getKV('all_users') || [];
  res.json(users);
});

// Новый эндпоинт для статусов
app.get('/api/users/status', (req, res) => {
  const statuses = {};
  userStatus.forEach((status, userId) => {
    statuses[userId] = status;
  });
  res.json(statuses);
});

// Keep-alive пинг
app.post('/api/ping', (req, res) => {
  const { userId } = req.body;
  if (userId) updateUserStatus(userId, true);
  res.sendStatus(200);
});

app.get('/api/messages/:chatId', async (req, res) => {
  const history = await getKV(`messages:${req.params.chatId}`) || [];
  res.json(history);
});

async function addUserToList(user) {
  let users = await getKV('all_users') || [];
  if (!users.find(u => u.id === user.id)) {
    users.push({ 
      id: user.id, 
      username: user.username, 
      email: user.email, 
      avatar: user.avatar 
    });
    await setKV('all_users', users);
  }
}

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
  console.log('Пользователь подключился:', socket.id);

  socket.on('join_chat', (chatId) => {
    socket.join(chatId);
  });

  socket.on('send_message', async (data) => {
    const message = { 
      id: Date.now().toString(), 
      ...data,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
   
    let chatHistory = await getKV(`messages:${data.chatId}`) || [];
    chatHistory.push(message);
    await setKV(`messages:${data.chatId}`, chatHistory);

    io.to(data.chatId).emit('receive_message', message);
  });

  socket.on('disconnect', () => {
    console.log('Пользователь отключился');
  });
});

const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, () => {
  console.log(`🚀 Сервер успешно запущен на порту ${PORT}`);
});
