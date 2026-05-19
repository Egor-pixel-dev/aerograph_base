import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
// Увеличиваем лимит, чтобы аватарки (base64) нормально загружались
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

// Добавляем пользователя в глобальный список контактов
async function addUserToList(user) {
  let users = await getKV('all_users') || [];
  // Сохраняем без пароля
  users.push({ id: user.id, username: user.username, email: user.email, avatar: user.avatar });
  await setKV('all_users', users);
}

// 1. API Регистрации
app.post('/api/register', async (req, res) => {
  const { username, email, password, avatar } = req.body;
  const existingUser = await getKV(`user:${email}`);
  
  if (existingUser) return res.status(400).json({ error: 'Пользователь с таким email уже существует' });

  const newUser = { 
    id: Date.now().toString(), // Уникальный ID
    username, 
    email, 
    password, 
    avatar: avatar || '👤' 
  };
  
  await setKV(`user:${email}`, newUser);
  await addUserToList(newUser);
  res.json({ message: 'Успешная регистрация', user: newUser });
});

// 2. API Логина
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await getKV(`user:${email}`);
  
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }
  res.json({ message: 'Успешный вход', user });
});

// 3. API Получения списка всех пользователей
app.get('/api/users', async (req, res) => {
  const users = await getKV('all_users') || [];
  res.json(users);
});

// 4. API Получения истории переписки
app.get('/api/messages/:chatId', async (req, res) => {
  const history = await getKV(`messages:${req.params.chatId}`) || [];
  res.json(history);
});

// WebSockets
io.on('connection', (socket) => {
  socket.on('join_chat', (chatId) => {
    socket.join(chatId);
  });

  socket.on('send_message', async (data) => {
    const message = { id: Date.now().toString(), ...data };
    
    let chatHistory = await getKV(`messages:${data.chatId}`) || [];
    chatHistory.push(message);
    await setKV(`messages:${data.chatId}`, chatHistory);

    io.to(data.chatId).emit('receive_message', message);
  });
});

// Храним, кто онлайн: { userId: true }
const onlineUsers = new Set();

io.on('connection', (socket) => {
  // Юзер сообщает, что он зашел
  socket.on('user_connected', (userId) => {
    onlineUsers.add(userId);
    socket.userId = userId; // Запоминаем ID юзера прямо в сокете
    io.emit('status_change', { userId, status: 'online' });
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      onlineUsers.delete(socket.userId);
      io.emit('status_change', { userId: socket.userId, status: 'offline' });
    }
  });
});

const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
