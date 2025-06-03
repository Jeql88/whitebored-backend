const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"]
  }
});

app.use(cors());

const MONGO_URI = 'mongodb+srv://josh:febuary24@whiteboard.b8ugc30.mongodb.net/?retryWrites=true&w=majority&appName=Whiteboard'
const client = new MongoClient(MONGO_URI);

let drawCollection;

async function connectDB() {
  await client.connect();
  const db = client.db('whiteboard');
  drawCollection = db.collection('drawEvents');
  console.log('Connected to MongoDB');
}
connectDB();

io.on('connection', async (socket) => {
  console.log('User connected:', socket.id);

  // Send all previous draw events to the new client
  if (drawCollection) {
    const events = await drawCollection.find().toArray();
    events.forEach(({ x, y }) => {
      socket.emit('draw', { x, y });
    });
  }

  socket.on('draw', async (data) => {
    socket.broadcast.emit('draw', data);
    if (drawCollection) {
      await drawCollection.insertOne(data);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

server.listen(4000, () => {
  console.log('Server is running on port 4000');
});