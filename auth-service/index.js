const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = 'temp_secret'; // Use env var in production
const MONGO_URI = 'mongodb+srv://josh:febuary24@whiteboard.b8ugc30.mongodb.net/?retryWrites=true&w=majority&appName=Whiteboard';
const client = new MongoClient(MONGO_URI);

let users;
client.connect().then(() => {
  users = client.db('whiteboard').collection('users');
  console.log('Auth service connected to MongoDB');
});

// Register
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (await users.findOne({ username })) return res.status(400).json({ error: 'User exists' });
  const hash = await bcrypt.hash(password, 10);
  await users.insertOne({ username, password: hash });
  res.json({ success: true });
});

// Login
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await users.findOne({ username });
  if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ userId: user._id, username }, JWT_SECRET, { expiresIn: '1d' });
  res.json({ token });
});

app.listen(4001, () => {
  console.log('Auth service running on port 4001');
});