const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { MongoClient, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST", "PATCH", "DELETE"],
  },
});

app.use(cors());
app.use(express.json());

const JWT_SECRET = "temp_secret";
const MONGO_URI =
  "mongodb+srv://josh:febuary24@whiteboard.b8ugc30.mongodb.net/?retryWrites=true&w=majority&appName=Whiteboard";
const client = new MongoClient(MONGO_URI);

let whiteboards, drawEvents;

client.connect().then(() => {
  const db = client.db("whiteboard");
  whiteboards = db.collection("whiteboards");
  drawEvents = db.collection("drawEvents");
  comments = db.collection("comments");

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      // Guest user
      socket.user = { userId: socket.id, isGuest: true };
      return next();
    }
    try {
      socket.user = jwt.verify(token, JWT_SECRET);
      socket.user.isGuest = false;
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", (socket) => {
    socket.on("joinWhiteboard", async (whiteboardId) => {
      socket.join(whiteboardId);
      const events = await drawEvents.find({ whiteboardId }).toArray();
      // Send all strokes with userId
      events.forEach((event) => {
        if (event.type === "text") {
          socket.emit("addTextBox", event);
        } else {
          socket.emit("drawStroke", event);
        }
      });

      // Drawing a new stroke
      // Drawing a new stroke (pen or eraser)
      socket.on(
        "drawStroke",
        async ({ points, color = "black", width = 2 }) => {
          const userId = socket.user.userId;
          const result = await drawEvents.insertOne({
            type: "stroke",
            points,
            color,
            width,
            whiteboardId,
            userId,
          });
          io.to(whiteboardId).emit("drawStroke", {
            _id: result.insertedId,
            type: "stroke",
            points,
            color,
            width,
            userId,
          });
          await whiteboards.updateOne(
            { _id: new ObjectId(whiteboardId) },
            {
              $set: { updatedAt: new Date() },
              $addToSet: { editors: userId }, // <-- add this line
            }
          );
        }
      );

      // Add a text box
      socket.on(
        "addTextBox",
        async ({ x, y, width, height, text, color, fontSize }) => {
          const userId = socket.user.userId;
          const result = await drawEvents.insertOne({
            type: "text",
            x,
            y,
            width,
            height,
            text,
            color,
            fontSize,
            whiteboardId,
            userId,
          });
          io.to(whiteboardId).emit("addTextBox", {
            _id: result.insertedId,
            type: "text",
            x,
            y,
            width,
            height,
            text,
            color,
            fontSize,
            userId,
          });
          await whiteboards.updateOne(
            { _id: new ObjectId(whiteboardId) },
            {
              $set: { updatedAt: new Date() },
              $addToSet: { editors: userId }, // <-- add this line
            }
          );
        }
      );

      socket.on(
        "updateTextBox",
        async ({
          _id,
          x,
          y,
          width,
          height,
          text,
          color,
          fontSize,
          whiteboardId,
        }) => {
          const result = await drawEvents.updateOne(
            { _id: new ObjectId(_id), whiteboardId },
            { $set: { x, y, width, height, text, color, fontSize } }
          );
          if (result.matchedCount > 0) {
            io.to(whiteboardId).emit("updateTextBox", {
              _id,
              x,
              y,
              width,
              height,
              text,
              color,
              fontSize,
            });
          }
        }
      );

      // Remove a text box
      socket.on("removeTextBox", async ({ _id, whiteboardId }) => {
        const userId = socket.user.userId;
        const result = await drawEvents.deleteOne({
          _id: new ObjectId(_id),
          whiteboardId,
          userId,
        });
        if (result.deletedCount > 0) {
          io.to(whiteboardId).emit("removeTextBox", { _id });
        }
      });

      // Per-user undo (removes only the last stroke by this user)
      socket.on("undoStroke", async ({ whiteboardId }) => {
        const userId = socket.user.userId;
        const lastStroke = await drawEvents
          .find({ whiteboardId, userId })
          .sort({ _id: -1 })
          .limit(1)
          .toArray();
        if (lastStroke.length > 0) {
          await drawEvents.deleteOne({ _id: lastStroke[0]._id });
          io.to(whiteboardId).emit("removeStroke", { _id: lastStroke[0]._id });
        }
      });

      // Clear board for everyone
      socket.on("clearBoard", async ({ whiteboardId }) => {
        await drawEvents.deleteMany({ whiteboardId });
        io.to(whiteboardId).emit("clearBoard");
      });
    });
  });

  console.log("Whiteboard service connected to MongoDB");
});

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

app.get("/whiteboards", authMiddleware, async (req, res) => {
  const userId = req.user.userId;
  const boards = await whiteboards
    .find({
      $or: [{ userId }, { editors: userId }],
    })
    .sort({ updatedAt: -1 })
    .toArray();

  res.json(boards);
});

app.post("/whiteboards", authMiddleware, async (req, res) => {
  const { name } = req.body;
  const now = new Date();
  const whiteboard = {
    name,
    userId: req.user.userId,
    createdAt: now,
    updatedAt: now,
  };
  const result = await whiteboards.insertOne(whiteboard);
  res.json({ _id: result.insertedId, ...whiteboard });
});

app.patch("/whiteboards/:id", authMiddleware, async (req, res) => {
  const whiteboardId = req.params.id;
  const userId = req.user.userId;
  const { name } = req.body;

  console.log("PATCH /whiteboards/:id called with:", whiteboardId, userId);

  if (!name) {
    return res.status(400).json({ error: "New name is required" });
  }

  try {
    const result = await whiteboards.updateOne(
      { _id: new ObjectId(whiteboardId), userId },
      { $set: { name, updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      return res
        .status(404)
        .json({ error: "Whiteboard not found or unauthorized" });
    }

    res.json({ success: true, message: "Whiteboard renamed" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/whiteboards/:id", authMiddleware, async (req, res) => {
  const whiteboardId = req.params.id;
  const userId = req.user.userId;

  try {
    // Ensure the whiteboard belongs to the requesting user
    const result = await whiteboards.deleteOne({
      _id: new ObjectId(whiteboardId),
      userId,
    });

    if (result.deletedCount === 0) {
      return res
        .status(404)
        .json({ error: "Whiteboard not found or unauthorized" });
    }

    // Remove associated draw events
    await drawEvents.deleteMany({ whiteboardId });

    res.json({ success: true, message: "Whiteboard deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/whiteboards/:id/comments", authMiddleware, async (req, res) => {
  const whiteboardId = req.params.id;
  const result = await comments
    .find({ whiteboardId })
    .sort({ createdAt: 1 })
    .toArray();
  res.json(result);
});

app.post("/whiteboards/:id/comments", authMiddleware, async (req, res) => {
  const whiteboardId = req.params.id;
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "No comment text" });

  // Fetch the user from the users collection
  const users = client.db("whiteboard").collection("users");
  const user = await users.findOne({ _id: new ObjectId(req.user.userId) });
  const userName = user?.username || user?.name || "Anonymous";

  const comment = {
    whiteboardId,
    userId: req.user.userId,
    userName,
    text,
    createdAt: new Date(),
  };
  const result = await comments.insertOne(comment);
  res.json({ ...comment, _id: result.insertedId });
  io.to(whiteboardId).emit("newComment", {
    ...comment,
    _id: result.insertedId,
  });
});

app.delete(
  "/whiteboards/:id/comments/:commentId",
  authMiddleware,
  async (req, res) => {
    const { id: whiteboardId, commentId } = req.params;
    const userId = req.user.userId;
    const result = await comments.deleteOne({
      _id: new ObjectId(commentId),
      whiteboardId,
      userId,
    });
    if (result.deletedCount === 0) {
      return res
        .status(404)
        .json({ error: "Comment not found or unauthorized" });
    }
    res.json({ success: true });
    io.to(whiteboardId).emit("deleteComment", { _id: commentId });
  }
);

server.listen(4000, () => {
  console.log("Whiteboard service running on port 4000");
});
