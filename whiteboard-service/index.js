const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { MongoClient, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: 'http://localhost:5173', methods: ['GET', 'POST', 'PATCH', 'DELETE'] }
});

app.use(cors());
app.use(express.json());

const JWT_SECRET = 'temp_secret';
const MONGO_URI = 'mongodb+srv://josh:febuary24@whiteboard.b8ugc30.mongodb.net/?retryWrites=true&w=majority&appName=Whiteboard';
const client = new MongoClient(MONGO_URI);

let whiteboards, drawEvents;

client.connect().then(() => {
  const db = client.db('whiteboard');
  whiteboards = db.collection('whiteboards');
  drawEvents = db.collection('drawEvents');

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('No token'));
    try {
      socket.user = jwt.verify(token, JWT_SECRET);
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    socket.on('joinWhiteboard', async (whiteboardId) => {
      socket.join(whiteboardId);
      const events = await drawEvents.find({ whiteboardId }).toArray();
      // Send all strokes with userId
      events.forEach(({ _id, points, color, width, userId }) => {
        socket.emit('drawStroke', { _id, points, color, width, userId });
      });

      // Drawing a new stroke
      socket.on('drawStroke', async ({ points, color = 'black', width = 2 }) => {
        const userId = socket.user.userId;
        const result = await drawEvents.insertOne({ points, color, width, whiteboardId, userId });
        io.to(whiteboardId).emit('drawStroke', {
          _id: result.insertedId,
          points,
          color,
          width,
          userId
        });
      });

      // Per-user undo (removes only the last stroke by this user)
      socket.on('undoStroke', async ({ whiteboardId }) => {
        const userId = socket.user.userId;
        const lastStroke = await drawEvents.find({ whiteboardId, userId }).sort({ _id: -1 }).limit(1).toArray();
        if (lastStroke.length > 0) {
          await drawEvents.deleteOne({ _id: lastStroke[0]._id });
          io.to(whiteboardId).emit('removeStroke', { _id: lastStroke[0]._id });
        }
      });

      // Clear board for everyone
      socket.on('clearBoard', async ({ whiteboardId }) => {
        await drawEvents.deleteMany({ whiteboardId });
        io.to(whiteboardId).emit('clearBoard');
      });
    });
  });

  console.log('Whiteboard service connected to MongoDB');
});

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

app.get('/whiteboards', authMiddleware, async (req, res) => {
  const boards = await whiteboards.find({ userId: req.user.userId }).toArray();
  res.json(boards);
});

app.post('/whiteboards', authMiddleware, async (req, res) => {
  const { name } = req.body;
  const result = await whiteboards.insertOne({ name, userId: req.user.userId });
  res.json({ _id: result.insertedId, name });
});

app.patch('/whiteboards/:id', authMiddleware, async (req, res) => {
  const whiteboardId = req.params.id;
  const userId = req.user.userId;
  const { name } = req.body;

  console.log('PATCH /whiteboards/:id called with:', whiteboardId, userId);

  if (!name) {
    return res.status(400).json({ error: 'New name is required' });
  }

  try {
    const result = await whiteboards.updateOne(
      { _id: new ObjectId(whiteboardId), userId },
      { $set: { name } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Whiteboard not found or unauthorized' });
    }

    res.json({ success: true, message: 'Whiteboard renamed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/whiteboards/:id', authMiddleware, async (req, res) => {
  const whiteboardId = req.params.id;
  const userId = req.user.userId;
  
  try {
    // Ensure the whiteboard belongs to the requesting user
    const result = await whiteboards.deleteOne({ _id: new ObjectId(whiteboardId), userId });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Whiteboard not found or unauthorized' });
    }

    // Remove associated draw events
    await drawEvents.deleteMany({ whiteboardId });

    res.json({ success: true, message: 'Whiteboard deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});


server.listen(4000, () => {
  console.log('Whiteboard service running on port 4000');
});