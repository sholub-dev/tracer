import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../db/driver.js";
import { withSessionTools } from "./chat-tools.js";

const db = {} as Db;
const provider = { execute_nrql: {} };

test("ask_user is in the tool set of every session", () => {
  assert.ok("ask_user" in withSessionTools(provider, db, "s"));
});
