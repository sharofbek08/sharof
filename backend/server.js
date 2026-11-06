import dotenv from "dotenv";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const frontendDist = join(rootDir, "frontend", "dist");
dotenv.config({ path: join(rootDir, ".env") });
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
const LOCKED_TEXT = "[locked]";

if (!DATABASE_URL) throw new Error("DATABASE_URL ni .env faylida sozlang.");
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET kamida 32 belgidan iborat bo‘lishi kerak.");
}

const pool = new Pool({ connectionString: DATABASE_URL });
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "128kb" }));

function createToken(ownerId) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sub: ownerId,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
  })).toString("base64url");
  const message = `${header}.${payload}`;
  const signature = createHmac("sha256", JWT_SECRET).update(message).digest("base64url");
  return `${message}.${signature}`;
}

function verifyToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerPart, payloadPart, signaturePart] = parts;
  const message = `${headerPart}.${payloadPart}`;
  const expected = createHmac("sha256", JWT_SECRET).update(message).digest();
  let provided;
  try {
    provided = Buffer.from(signaturePart, "base64url");
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  try {
    const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    if (header.alg !== "HS256" || typeof payload.sub !== "string") return null;
    if (!Number.isInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return { ownerId: payload.sub };
  } catch {
    return null;
  }
}

function requireSession(req, res, next) {
  const authorization = req.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const session = token ? verifyToken(token) : null;
  if (!session) return res.status(401).json({ error: "Sessiya yaroqsiz. Sahifani yangilang." });
  req.ownerId = session.ownerId;
  next();
}

function validateEntryFields(body, { creating = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Yozuv ma’lumotlari noto‘g‘ri.";
  }

  if (creating || Object.hasOwn(body, "type")) {
    if (body.type !== "poem" && body.type !== "quote") return "Yozuv turi noto‘g‘ri.";
  }
  if (creating || Object.hasOwn(body, "text")) {
    if (typeof body.text !== "string" || body.text.trim().length < 1 || body.text.length > 3000) {
      return "Matn 1–3000 belgidan iborat bo‘lsin.";
    }
  }
  if (Object.hasOwn(body, "author") && body.author !== null
    && (typeof body.author !== "string" || body.author.length > 100)) {
    return "Muallif nomi 100 belgidan oshmasin.";
  }
  if (Object.hasOwn(body, "tags") && body.tags !== null) {
    if (!Array.isArray(body.tags) || body.tags.length > 8
      || body.tags.some((tag) => typeof tag !== "string" || tag.length > 40)) {
      return "Teglar ro‘yxati noto‘g‘ri.";
    }
  }
  if (Object.hasOwn(body, "favorite") && typeof body.favorite !== "boolean") {
    return "Sevimli holati noto‘g‘ri.";
  }
  if (Object.hasOwn(body, "encryption") && body.encryption !== null) {
    const encryption = body.encryption;
    if (!encryption || typeof encryption !== "object"
      || encryption.version !== 1 || encryption.iterations !== 310000
      || typeof encryption.salt !== "string" || typeof encryption.iv !== "string"
      || typeof encryption.ciphertext !== "string"
      || body.text !== LOCKED_TEXT) {
      return "Shifrlangan yozuv ma’lumotlari noto‘g‘ri.";
    }
  }
  if (body.encryption && (body.author || body.tags)) {
    return "Himoyalangan yozuvning muallifi va teglari ochiq saqlanmasligi kerak.";
  }
  return null;
}

function mapEntry(row) {
  return {
    id: row.id,
    type: row.type,
    text: row.text,
    author: row.author,
    tags: row.tags,
    favorite: row.favorite,
    createdAt: row.created_at.toISOString(),
    ownerId: row.owner_id,
    encryption: row.encryption
  };
}

app.get("/api/health", async (_req, res, next) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "postgres" });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/anonymous", (_req, res) => {
  const ownerId = randomUUID();
  res.status(201).json({ token: createToken(ownerId), ownerId });
});

app.get("/api/entries", requireSession, async (_req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM entries ORDER BY created_at DESC, id ASC");
    res.json(rows.map(mapEntry));
  } catch (error) {
    next(error);
  }
});

app.post("/api/entries", requireSession, async (req, res, next) => {
  const validationError = validateEntryFields(req.body, { creating: true });
  if (validationError) return res.status(400).json({ error: validationError });

  const id = typeof req.body.id === "string" && req.body.id.length <= 100
    ? req.body.id
    : randomUUID();
  const createdAt = req.body.createdAt && !Number.isNaN(Date.parse(req.body.createdAt))
    ? new Date(req.body.createdAt)
    : new Date();

  try {
    const { rows } = await pool.query(
      `INSERT INTO entries (id, type, text, author, tags, favorite, created_at, owner_id, encryption)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        id,
        req.body.type,
        req.body.text,
        req.body.author ?? null,
        req.body.tags ?? null,
        req.body.favorite ?? false,
        createdAt,
        req.ownerId,
        req.body.encryption ?? null
      ]
    );
    res.status(201).json(mapEntry(rows[0]));
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "Bu yozuv IDsi oldin ishlatilgan." });
    next(error);
  }
});

app.patch("/api/entries/:id", requireSession, async (req, res, next) => {
  const validationError = validateEntryFields(req.body);
  if (validationError) return res.status(400).json({ error: validationError });

  const columns = {
    type: "type",
    text: "text",
    author: "author",
    tags: "tags",
    favorite: "favorite",
    encryption: "encryption"
  };
  const updates = Object.entries(columns)
    .filter(([field]) => Object.hasOwn(req.body, field))
    .map(([field, column]) => [column, req.body[field] ?? null]);
  if (!updates.length) return res.status(400).json({ error: "Yangilanadigan maydon topilmadi." });

  const assignments = updates.map(([column], index) => `${column} = $${index + 1}`);
  assignments.push("updated_at = NOW()");
  const values = updates.map(([, value]) => value);
  values.push(req.params.id, req.ownerId);

  try {
    const { rows } = await pool.query(
      `UPDATE entries SET ${assignments.join(", ")}
       WHERE id = $${values.length - 1} AND owner_id = $${values.length}
       RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: "Yozuv topilmadi yoki sizga tegishli emas." });
    res.json(mapEntry(rows[0]));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/entries/:id", requireSession, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM entries WHERE id = $1 AND owner_id = $2",
      [req.params.id, req.ownerId]
    );
    if (!rowCount) return res.status(404).json({ error: "Yozuv topilmadi yoki sizga tegishli emas." });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

if (existsSync(frontendDist)) app.use(express.static(frontendDist));
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api")) return next();
  const indexPath = join(frontendDist, "index.html");
  if (existsSync(indexPath)) return res.sendFile(indexPath);
  next();
});

app.use((error, _req, res, _next) => {
  console.error("API xatosi:", error);
  res.status(500).json({ error: "Serverda xatolik yuz berdi." });
});

async function start() {
  const schema = await readFile(join(__dirname, "schema.sql"), "utf8");
  await pool.query(schema);
  const server = app.listen(PORT, "127.0.0.1", () => {
    console.log(`Backend: http://127.0.0.1:${PORT}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      server.close(async () => {
        await pool.end();
        process.exit(0);
      });
    });
  }
}

start().catch(async (error) => {
  console.error("Backend ishga tushmadi:", error.message);
  await pool.end();
  process.exit(1);
});
