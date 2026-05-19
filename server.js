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
  cors: {
    origin: "https://aerograph-site.vercel.app", // Твой фронтенд на Vercel
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket'], // Обязательно добавь это
  pingTimeout: 60000,
  pingInterval: 25000
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

async function addUserToList(user) {
  let users = await getKV('all_users') ||[];
  users.push({ id: user.id, username: user.username, email: user.email, avatar: user.avatar });
  await setKV('all_users', users);
}

async function updateChatIndex(chatId, message, senderId, targetId) {
  let chats = await getKV('chats_index') || {};
  if (!chats[chatId]) chats[chatId] = { lastMessage: '', lastTime: '', unreadCount: {} };
  
  chats[chatId].lastMessage = message.text;
  chats[chatId].lastTime = message.time;
  
  const count = chats[chatId].unreadCount[targetId] || 0;
  chats[chatId].unreadCount[targetId] = count + 1;
  
  await setKV('chats_index', chats);
  io.emit('chat_updated', { chatId, ...chats[chatId] }); 
}

// --- API РОУТЫ ---
app.post('/api/register', async (req, res) => {
  const { username, email, password, avatar } = req.body;
  const existingUser = await getKV(`user:${email}`);
  if (existingUser) return res.status(400).json({ error: 'Пользователь уже существует' });
  const newUser = { id: Date.now().toString(), username, email, password, avatar: avatar || '👤' };
  await setKV(`user:${email}`, newUser);
  await addUserToList(newUser);
  res.json({ message: 'Успех', user: newUser });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await getKV(`user:${email}`);
  if (!user || user.password !== password) return res.status(401).json({ error: 'Неверные данные' });
  res.json({ message: 'Вход', user });
});

app.get('/api/users', async (req, res) => {
  const users = await getKV('all_users') ||[];
  res.json(users);
});

app.get('/api/messages/:chatId', async (req, res) => {
  const history = await getKV(`messages:${req.params.chatId}`) ||[];
  res.json(history);
});

app.get('/api/chats-index', async (req, res) => {
  const index = await getKV('chats_index') || {};
  res.json(index);
});

// --- WEBSOCKETS ---
io.on('connection', (socket) => {
  socket.on('ping', () => socket.emit('pong')); // Отвечаем на пинг
  
  socket.on('join_chat', (chatId) => socket.join(chatId));

  socket.on('send_message', async (data) => {
    const message = { id: Date.now().toString(), ...data };
    let chatHistory = await getKV(`messages:${data.chatId}`) ||[];
    chatHistory.push(message);
    await setKV(`messages:${data.chatId}`, chatHistory);

    const ids = data.chatId.split('_');
    const targetId = ids.find(id => id !== data.senderId);
    await updateChatIndex(data.chatId, message, data.senderId, targetId);

    io.to(data.chatId).emit('receive_message', message);
  });

  socket.on('mark_read', async ({ chatId, userId }) => {
    let chats = await getKV('chats_index') || {};
    if (chats[chatId] && chats[chatId].unreadCount) {
      chats[chatId].unreadCount[userId] = 0;
      await setKV('chats_index', chats);
      io.emit('chat_updated', { chatId, ...chats[chatId] });
    }
  });

  socket.on('user_connected', (userId) => {
    socket.userId = userId;
    io.emit('status_change', { userId, status: 'online' });
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      io.emit('status_change', { userId: socket.userId, status: 'offline' });
    }
  });
});

const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, () => console.log(`Сервер запущен на ${PORT}`));
