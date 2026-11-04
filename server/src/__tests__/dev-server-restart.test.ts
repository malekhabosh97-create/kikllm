import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";

const mockReadPersistedDevServerStatus = vi.hoisted(() => vi.fn());
const mockWriteDevServerRestartRequest = vi.hoisted(() => vi.fn(() => true));
const mockRemoveDevServerRestartRequest = vi.hoisted(() => vi.fn());
const mockWriteHotRestartIntent = vi.hoisted(() => vi.fn(async () => ({ lockFile: "dummy.lock" })));
const mockRemoveHotRestartIntent = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../dev-server-status.js", () => ({
  readPersistedDevServerStatus: mockReadPersistedDevServerStatus,
  writeDevServerRestartRequest: mockWriteDevServerRestartRequest,
  removeDevServerRestartRequest: mockRemoveDevServerRestartRequest,
  toDevServerHealthStatus: vi.fn(),
}));

vi.mock("../services/hot-restart.js", () => ({
  writeHotRestartIntent: mockWriteHotRestartIntent,
  removeHotRestartIntent: mockRemoveHotRestartIntent,
}));

function createTestDb(): Db {
  return {
    execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    })),
  } as unknown as Db;
}

function createApp(db = createTestDb()) {
  const app = express();
  app.use(express.json());
  app.use(
    "/health",
    healthRoutes(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: true,
    }),
  );
  return app;
}

describe("POST /health/dev-server/restart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when supervisor status is unavailable", async () => {
    mockReadPersistedDevServerStatus.mockReturnValue(null);
    const app = createApp();

    const res = await request(app).post("/health/dev-server/restart");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "dev_server_supervisor_unavailable" });
  });

  it("returns 200 already_fresh when dev server is clean and force is not set", async () => {
    mockReadPersistedDevServerStatus.mockReturnValue({
      dirty: false,
      changedPathCount: 0,
      pendingMigrations: [],
    });
    const app = createApp();

    const res = await request(app).post("/health/dev-server/restart");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "already_fresh",
      restartRequired: false,
    });
    expect(mockWriteDevServerRestartRequest).not.toHaveBeenCalled();
  });

  it("accepts forced restart with 202 restart_requested when force: true in body", async () => {
    mockReadPersistedDevServerStatus.mockReturnValue({
      dirty: false,
      changedPathCount: 0,
      pendingMigrations: [],
    });
    const app = createApp();

    const res = await request(app)
      .post("/health/dev-server/restart")
      .send({ force: true });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "restart_requested",
      mode: "hot",
    });
    expect(res.body.requestId).toBeDefined();
    expect(mockWriteDevServerRestartRequest).toHaveBeenCalledTimes(1);
  });

  it("accepts forced restart with 202 restart_requested when ?force=true in query", async () => {
    mockReadPersistedDevServerStatus.mockReturnValue({
      dirty: false,
      changedPathCount: 0,
      pendingMigrations: [],
    });
    const app = createApp();

    const res = await request(app).post("/health/dev-server/restart?force=true");

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "restart_requested",
      mode: "hot",
    });
    expect(mockWriteDevServerRestartRequest).toHaveBeenCalledTimes(1);
  });

  it("accepts restart with 202 restart_requested when backend changes exist without force", async () => {
    mockReadPersistedDevServerStatus.mockReturnValue({
      dirty: true,
      changedPathCount: 2,
      pendingMigrations: [],
    });
    const app = createApp();

    const res = await request(app).post("/health/dev-server/restart");

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "restart_requested",
      mode: "hot",
    });
    expect(mockWriteDevServerRestartRequest).toHaveBeenCalledTimes(1);
  });
});
