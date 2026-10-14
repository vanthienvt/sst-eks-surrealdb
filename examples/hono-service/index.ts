import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { Surreal } from "surrealdb";

const app = new Hono();
const db = new Surreal();

let isConnected = false;

async function ensureConnection() {
  if (isConnected) return;
  const url = process.env.SURREALDB_URL || "http://127.0.0.1:8000/rpc";
  const namespace = process.env.SURREALDB_NS || "production";
  const database = process.env.SURREALDB_DB || "main";
  const username = process.env.SURREALDB_USER || "root";
  const password = process.env.SURREALDB_PASS || "root";

  await db.connect(url);
  if (process.env.SURREALDB_AUTH !== "false") {
    await db.signin({ username, password });
  }
  await db.use({ namespace, database });
  isConnected = true;
  console.log(`[HonoService] Connected to SurrealDB on TiKV at ${url}`);
}

app.get("/health", async (c) => {
  try {
    await ensureConnection();
    return c.json({
      status: "ok",
      engine: "surrealdb-tikv",
      endpoint: process.env.SURREALDB_URL || "http://127.0.0.1:8000/rpc",
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return c.json({ status: "degraded", error: error?.message }, 503);
  }
});

app.post("/users", async (c) => {
  try {
    await ensureConnection();
    const body = await c.req.json();
    const created = await db.create("user", {
      ...body,
      createdAt: new Date().toISOString(),
    });
    return c.json({ ok: true, data: created }, 201);
  } catch (error: any) {
    return c.json({ ok: false, error: error?.message || "Failed to create user" }, 500);
  }
});

app.get("/users", async (c) => {
  try {
    await ensureConnection();
    const users = await db.select("user");
    return c.json({ ok: true, count: Array.isArray(users) ? users.length : 0, data: users });
  } catch (error: any) {
    return c.json({ ok: false, error: error?.message || "Failed to fetch users" }, 500);
  }
});

export const handler = handle(app);
export default app;