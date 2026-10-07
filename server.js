import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import mysql from "mysql2/promise";
import { v2 as cloudinary } from "cloudinary";

const app  = express();
const PORT = process.env.PORT || 4000;

// ─── CORS ─────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  "https://aavkarfoundation.ngo-india.org",
  "https://www.aavkarfoundation.ngo-india.org",
  "http://localhost:5173",
  "http://localhost:5175",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5175",
  ...(process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map(s => s.trim())
    : []),
];

const corsOptions = {
  origin: (origin, cb) => {
    // origin undefined = Postman / server-to-server / same-origin
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    console.warn("⚠️ CORS blocked origin:", origin);
    return cb(null, false);
  },
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // preflight
app.use(express.json());

// ─── MySQL ────────────────────────────────────────────────────
const db = mysql.createPool({
  host:     process.env.DB_HOST || "localhost",
  port:     process.env.DB_PORT || 3306,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS gallery_photos (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      url        TEXT NOT NULL,
      public_id  VARCHAR(255),
      caption    VARCHAR(255),
      tag        VARCHAR(100),
      size       VARCHAR(20) DEFAULT 'wide',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// ─── Cloudinary ───────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const FOLDER = "aavkar-gallery";

const uploadToCloudinary = (buffer) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: FOLDER, resource_type: "image" },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });

// URL se public_id nikalo (fallback, agar DB me public_id na ho)
const extractPublicId = (url) => {
  try {
    const afterUpload = url.split("/upload/")[1];
    if (!afterUpload) return null;
    const noVersion = afterUpload.replace(/^v\d+\//, "");
    return noVersion.replace(/\.[^/.]+$/, "");
  } catch {
    return null;
  }
};

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "aavkar2024";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// ─── Health Check ─────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Aavkar Foundation API running ✅" });
});

// ─── Verify Password ──────────────────────────────────────────
app.post("/api/verify-password", (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true });
  } else {
    res.json({ success: false, message: "Incorrect password" });
  }
});

// ─── Get All Photos ───────────────────────────────────────────
app.get("/api/photos", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id, url, caption, tag, size FROM gallery_photos ORDER BY created_at DESC, id DESC"
    );

    const photos = rows.map(p => ({
      id:      p.id,
      url:     p.url,
      caption: p.caption,
      tag:     p.tag,
      size:    p.size || "wide",
    }));

    res.json({ success: true, photos });
  } catch (err) {
    console.error("GET /api/photos:", err.message);
    res.json({ success: false, message: err.message });
  }
});

// ─── Upload Photo ─────────────────────────────────────────────
app.post("/api/upload", upload.single("file"), async (req, res) => {
  const { password, caption, tag } = req.body || {};

  if (password !== ADMIN_PASSWORD)
    return res.json({ success: false, message: "Incorrect password" });
  if (!req.file)
    return res.json({ success: false, message: "No file provided" });

  try {
    const result = await uploadToCloudinary(req.file.buffer);

    const [insert] = await db.query(
      "INSERT INTO gallery_photos (url, public_id, caption, tag, size) VALUES (?, ?, ?, ?, ?)",
      [result.secure_url, result.public_id, caption || null, tag || null, "wide"]
    );

    res.json({
      success: true,
      photo: {
        id:      insert.insertId,
        url:     result.secure_url,
        caption: caption || null,
        tag:     tag || null,
        size:    "wide",
      },
    });
  } catch (err) {
    console.error("POST /api/upload:", err.message);
    res.json({ success: false, message: err.message });
  }
});

// ─── Delete Photo (DB + Cloudinary dono) ──────────────────────
app.delete("/api/photos/:id", async (req, res) => {
  const { password } = req.body || {};
  const { id }       = req.params;

  if (password !== ADMIN_PASSWORD)
    return res.json({ success: false, message: "Incorrect password" });

  try {
    const [rows] = await db.query(
      "SELECT url, public_id FROM gallery_photos WHERE id = ?",
      [id]
    );

    if (!rows.length)
      return res.json({ success: false, message: "Photo not found" });

    const publicId = rows[0].public_id || extractPublicId(rows[0].url);

    // 1) Cloudinary se delete
    if (publicId) {
      const result = await cloudinary.uploader.destroy(publicId, {
        resource_type: "image",
        invalidate: true,
      });

      // "ok" = delete ho gayi, "not found" = pehle se nahi thi (DB se hatana theek hai)
      if (result.result !== "ok" && result.result !== "not found") {
        return res.json({
          success: false,
          message: `Cloudinary delete failed: ${result.result}`,
        });
      }
    }

    // 2) MySQL se delete
    await db.query("DELETE FROM gallery_photos WHERE id = ?", [id]);

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/photos/:id:", err.message);
    res.json({ success: false, message: err.message });
  }
});

// ─── Error handler (multer file-too-large etc.) ───────────────
// CORS ke baad hai, isliye error response me bhi CORS headers jayenge
app.use((err, req, res, next) => {
  console.error("Server error:", err.message);
  if (err.code === "LIMIT_FILE_SIZE")
    return res.json({ success: false, message: "File 10MB se badi hai." });
  res.status(500).json({ success: false, message: err.message || "Server error" });
});

// ─── Start ────────────────────────────────────────────────────
// DB fail ho to bhi server chalta rahe (warna proxy 503 deta hai aur browser me CORS error dikhta hai)
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`   MySQL DB: ${process.env.DB_NAME}`);
});

initDb()
  .then(() => console.log("✅ MySQL connected, table ready"))
  .catch(err => console.error("❌ DB init failed:", err.message));