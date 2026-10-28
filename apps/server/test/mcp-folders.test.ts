/**
 * 資料夾 PR-3d（plan docs/superpowers/plans/2026-10-28-folders-pr3d.md）的資料夾 MCP 工具。
 * T5：LF＝`list_folders`、RO＝`read_note_outline` 的 `folder`。T6–T8 在本檔續寫。
 * 比對對象是同一人 cookie 的 REST（`GET /api/folders`，同一個可見性述詞）。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { FolderListDto, TokenScope } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { groupMembers } from "../src/db/schema.js";
import { folderPathCost } from "../src/mcp/folder-fields.js";
import { BAD_CURSOR_MESSAGE } from "../src/mcp/keyset-cursor.js";
import { MCP_FOLDER_PAGE_MAX, MCP_LIST_WIRE_BUDGET, escapedLength } from "../src/mcp/limits.js";
import { outlineFolderFor } from "../src/mcp/tools/read-note-outline.js";
import { wireCost } from "../src/mcp/wire-budget.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { seedFolder, seedFolderChain, seedPlacement, setNoteFolder } from "./folder-helpers.js";
import { seedGroup, seedNote, seedRole, seedShare, seedUser } from "./group-helpers.js";
import { buildCollabTestApp } from "./helpers.js";
import { callTool, restFolder, type McpAuth, type ToolCallResult } from "./mcp-folder-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";

const R: TokenScope = "notes:read";
const FM2 = "No group with that id among your groups where your role can read notes.";

type FolderOut = {
  id: string;
  name: string;
  nameTruncated?: true;
  parentId: string | null;
  space: { kind: "personal" } | { kind: "shared" } | { kind: "group"; groupId: string; groupName: string; groupNameTruncated?: true };
  path: string[];
  pathTruncated?: true;
};
type ListFoldersOut = { folders: FolderOut[]; nextCursor: string | null; pageCutShort?: true };

const tokenOf = async (db: Db, userId: string, scope: TokenScope = R): Promise<McpAuth> => ({ token: (await seedTokenForUser(db, userId, scope)).token });

function ok(r: ToolCallResult): Record<string, unknown> {
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
  return r.structuredContent!;
}
/** 一頁；斷 payload ≤ 預算。 */
async function listPage(app: FastifyInstance, auth: McpAuth, args: Record<string, unknown> = {}): Promise<ListFoldersOut> {
  const out = ok(await callTool(app, auth, "list_folders", args)) as unknown as ListFoldersOut;
  expect(wireCost(out)).toBeLessThanOrEqual(MCP_LIST_WIRE_BUDGET);
  return out;
}
/** 翻到 nextCursor 為 null；`between` 在每頁之後呼叫一次（翻頁期間造資料用）。 */
async function listAll(app: FastifyInstance, auth: McpAuth, args: Record<string, unknown> = {}, between?: (i: number) => Promise<void>): Promise<ListFoldersOut[]> {
  const pages: ListFoldersOut[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i += 1) {
    const page = await listPage(app, auth, cursor === undefined ? args : { ...args, cursor });
    pages.push(page);
    if (page.nextCursor === null) return pages;
    cursor = page.nextCursor;
    if (between) await between(i);
  }
  throw new Error("list_folders 翻了 20 頁還沒到底");
}
async function restFolderIds(app: FastifyInstance, userId: string): Promise<string[]> {
  const res = await restFolder(app, userId, "GET", "/api/folders");
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as FolderListDto).folders.map(f => f.id);
}
/** `noRead`（自訂角色全 false）成員（plan H7）。 */
async function addNoReadMember(db: Db, groupId: string, userId: string): Promise<void> {
  const roleId = await seedRole(db, groupId, "noRead", {});
  await db.insert(groupMembers).values({ groupId, userId, roleId });
}

describe("LF1 三種空間", () => {
  it("個人、can_read 群組、自己的 shared 都列得到；別人的與 noRead 群組的列不到；path 末段＝名稱；space 三形逐字；id 集合＝REST；唯讀憑證可用", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const other = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "LF1 Group", [{ userId: me.id, role: "member" }]);
    const hidden = await seedGroup(ctx.db, "LF1 Hidden", [{ userId: other.id, role: "admin" }]);
    await addNoReadMember(ctx.db, hidden.id, me.id);
    const [pa, pb] = await seedFolderChain(ctx.db, { personal: me.id }, ["P1", "P2"]);
    const gf = await seedFolder(ctx.db, { group: g.id }, { name: "G1" });
    const sf = await seedFolder(ctx.db, { shared: me.id }, { name: "S1" });
    await seedFolder(ctx.db, { personal: other.id }, { name: "theirs" });
    await seedFolder(ctx.db, { shared: other.id }, { name: "their shared" });
    await seedFolder(ctx.db, { group: hidden.id }, { name: "hidden" });

    const pages = await listAll(ctx.app, await tokenOf(ctx.db, me.id, R));
    const items = pages.flatMap(p => p.folders);
    const byId = new Map(items.map(f => [f.id, f]));
    expect([...byId.keys()].sort()).toEqual([pa!, pb!, gf.id, sf.id].sort());
    expect([...byId.keys()].sort()).toEqual((await restFolderIds(ctx.app, me.id)).sort());
    for (const f of items) expect(f.path.at(-1)).toBe(f.name);
    expect(byId.get(pb!)).toEqual({ id: pb, name: "P2", parentId: pa, space: { kind: "personal" }, path: ["P1", "P2"] });
    expect(byId.get(sf.id)).toEqual({ id: sf.id, name: "S1", parentId: null, space: { kind: "shared" }, path: ["S1"] });
    expect(byId.get(gf.id)).toEqual({ id: gf.id, name: "G1", parentId: null, space: { kind: "group", groupId: g.id, groupName: "LF1 Group" }, path: ["G1"] });
  });
});

describe("LF2 group_id", () => {
  it("只列該群組；非成員、noRead 群組、隨機 uuid → 三者逐欄相同（group_not_found＋FM2）；大寫 group_id 與小寫相同", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const other = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "LF2", [{ userId: me.id, role: "member" }]);
    const outside = await seedGroup(ctx.db, "LF2 out", [{ userId: other.id, role: "admin" }]);
    const noRead = await seedGroup(ctx.db, "LF2 noRead", [{ userId: other.id, role: "admin" }]);
    await addNoReadMember(ctx.db, noRead.id, me.id);
    const gf = await seedFolder(ctx.db, { group: g.id }, { name: "in" });
    await seedFolder(ctx.db, { personal: me.id }, { name: "mine" });
    await seedFolder(ctx.db, { group: outside.id }, { name: "out" });
    await seedFolder(ctx.db, { group: noRead.id }, { name: "no" });
    const auth = await tokenOf(ctx.db, me.id);

    const only = await listPage(ctx.app, auth, { group_id: g.id });
    expect(only.folders.map(f => f.id)).toEqual([gf.id]);
    expect(await listPage(ctx.app, auth, { group_id: g.id.toUpperCase() })).toEqual(only);

    const errs = [];
    for (const groupId of [outside.id, noRead.id, randomUUID()]) errs.push(await callTool(ctx.app, auth, "list_folders", { group_id: groupId }));
    expect(errs[0]!.isError).toBe(true);
    expect(errs[0]!.structuredContent).toEqual({ code: "group_not_found", message: FM2 });
    expect(errs[1]).toEqual(errs[0]);
    expect(errs[2]).toEqual(errs[0]);
  });
});

describe("LF3 翻頁", () => {
  const seedMany = (db: Db, kind: "personal" | "shared", ownerId: string, n: number, tag: string) =>
    db.$client.query(
      `insert into folders (kind, owner_id, name, created_by) select $1, $2::uuid, $4 || g, $2::uuid from generate_series(1, $3::int) g`,
      [kind, ownerId, n, tag],
    );

  it("121 個（三種空間混）→ 50／50／21、最後 nextCursor null、無 pageCutShort、每頁 ≤ 預算、id 集合＝REST 不重複；翻頁期間新建一個 → 不報錯、不重複", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "LF3", [{ userId: me.id, role: "member" }]);
    await seedMany(ctx.db, "personal", me.id, 60, "p");
    await seedMany(ctx.db, "shared", me.id, 31, "s");
    await ctx.db.$client.query(
      `insert into folders (kind, group_id, name, created_by) select 'group', $1::uuid, 'g' || g, $2::uuid from generate_series(1, 30) g`,
      [g.id, me.id],
    );
    const auth = await tokenOf(ctx.db, me.id);

    const pages = await listAll(ctx.app, auth);
    expect(pages.map(p => p.folders.length)).toEqual([MCP_FOLDER_PAGE_MAX, MCP_FOLDER_PAGE_MAX, 21]);
    expect(pages.every(p => !("pageCutShort" in p))).toBe(true);
    const ids = pages.flatMap(p => p.folders.map(f => f.id));
    expect(new Set(ids).size).toBe(121);
    expect([...ids].sort()).toEqual((await restFolderIds(ctx.app, me.id)).sort());

    const during = await listAll(ctx.app, auth, {}, async i => {
      if (i === 0) await seedFolder(ctx.db, { personal: me.id }, { name: "made while paging" });
    });
    const ids2 = during.flatMap(p => p.folders.map(f => f.id));
    expect(new Set(ids2).size).toBe(ids2.length);
    expect(ids2.length === 121 || ids2.length === 122).toBe(true);
  });
});

describe("LF3b 換頁點落在同種空間的兩個群組之間（T5 審查 I1）", () => {
  it("兩個群組各 40 個＋個人 30 個 → 50／50／10；第一頁兩個群組都有；翻完 id 集合＝REST、不重複", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const g1 = await seedGroup(ctx.db, "LF3b-1", [{ userId: me.id, role: "member" }]);
    const g2 = await seedGroup(ctx.db, "LF3b-2", [{ userId: me.id, role: "member" }]);
    for (const g of [g1, g2]) {
      await ctx.db.$client.query(
        `insert into folders (kind, group_id, name, created_by) select 'group', $1::uuid, 'g' || g, $2::uuid from generate_series(1, 40) g`,
        [g.id, me.id],
      );
    }
    await ctx.db.$client.query(
      `insert into folders (kind, owner_id, name, created_by) select 'personal', $1::uuid, 'p' || g, $1::uuid from generate_series(1, 30) g`,
      [me.id],
    );
    const pages = await listAll(ctx.app, await tokenOf(ctx.db, me.id));
    expect(pages.map(p => p.folders.length)).toEqual([MCP_FOLDER_PAGE_MAX, MCP_FOLDER_PAGE_MAX, 10]);
    const firstGroups = new Set(pages[0]!.folders.map(f => (f.space.kind === "group" ? f.space.groupId : f.space.kind)));
    expect(firstGroups).toEqual(new Set([g1.id, g2.id])); // 前提：換頁點落在兩個群組之間
    const ids = pages.flatMap(p => p.folders.map(f => f.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual((await restFolderIds(ctx.app, me.id)).sort());
  });
});

describe("LF4 截斷", () => {
  it("名稱 80 個 \"、群組名 67＋13、八層 27 個 \"（丟段）、五層 [33,40,40,40,41]（截段）→ 各自的旗標、各欄在上限內；一般資料沒有任何旗標鍵", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "LF4", [{ userId: me.id, role: "member" }]);
    await ctx.db.$client.query(`update groups set name = $2 where id = $1`, [g.id, `${'"'.repeat(67)}${String.fromCharCode(1).repeat(13)}`]);
    const quotes = await seedFolder(ctx.db, { personal: me.id }, { name: '"'.repeat(80) });
    const gf = await seedFolder(ctx.db, { group: g.id }, { name: "G" });
    const eight = await seedFolderChain(ctx.db, { shared: me.id }, Array.from({ length: 8 }, () => '"'.repeat(27)));
    const five = await seedFolderChain(ctx.db, { personal: me.id }, [33, 40, 40, 40, 41].map(n => '"'.repeat(n)));
    const plain = await seedFolder(ctx.db, { personal: me.id }, { name: "plain" });

    const byId = new Map((await listAll(ctx.app, await tokenOf(ctx.db, me.id))).flatMap(p => p.folders).map(f => [f.id, f]));
    const q = byId.get(quotes.id)!;
    expect([q.name, q.nameTruncated]).toEqual(['"'.repeat(40), true]);
    expect(escapedLength(q.name)).toBeLessThanOrEqual(80);
    const gs = byId.get(gf.id)!.space as { groupName: string; groupNameTruncated?: true };
    expect(gs.groupNameTruncated).toBe(true);
    expect(escapedLength(gs.groupName)).toBeLessThanOrEqual(200);
    const e = byId.get(eight.at(-1)!)!;
    expect([e.path.length, e.pathTruncated]).toEqual([7, true]);
    expect(folderPathCost(e.path)).toBeLessThanOrEqual(400);
    const f5 = byId.get(five.at(-1)!)!;
    expect(f5.path).toEqual([33, 40, 40, 40, 40].map(n => '"'.repeat(n)));
    expect(f5.pathTruncated).toBe(true);
    expect(folderPathCost(f5.path)).toBe(400);
    const p = byId.get(plain.id)!;
    expect(Object.keys(p)).toEqual(["id", "name", "parentId", "space", "path"]);
    expect(Object.keys(byId.get(gf.id)!)).toEqual(["id", "name", "parentId", "space", "path"]);
  });
});

describe("LF5 壞游標", () => {
  it("\"x\"、list_notes 發的游標、f| 之後夾 NUL、kind 不合法、id 不是 UUID → invalid_body＋BAD_CURSOR_MESSAGE", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    await seedNote(ctx.db, { ownerId: me.id }, { title: "a" });
    await seedNote(ctx.db, { ownerId: me.id }, { title: "b" });
    await seedFolder(ctx.db, { personal: me.id }, { name: "F" });
    const auth = await tokenOf(ctx.db, me.id);
    const notesCursor = ok(await callTool(ctx.app, auth, "list_notes", { limit: 1 })).nextCursor as string;
    expect(notesCursor).not.toBeNull();
    const enc = (s: string) => Buffer.from(s, "utf8").toString("base64url");
    const u = randomUUID();
    const bad: Array<[string, string]> = [
      ["x", "x"],
      ["list_notes", notesCursor],
      ["NUL", enc(`f|personal${String.fromCharCode(0)}|${u}|${u}`)],
      ["kind", enc(`f|bogus|${u}|${u}`)],
      ["id", enc(`f|personal|${u}|zzz`)],
    ];
    for (const [label, cursor] of bad) {
      const r = await callTool(ctx.app, auth, "list_folders", { cursor });
      expect(r.isError, label).toBe(true);
      expect(r.structuredContent, label).toEqual({ code: "invalid_body", message: BAD_CURSOR_MESSAGE });
    }
    expect((await listPage(ctx.app, auth)).folders).toHaveLength(1);
  });
});

describe("LF6 描述與 annotations", () => {
  it("description 逐字＝D-LF、不提 fewer when；annotations 逐字 { readOnlyHint: true }", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const res = await mcpPost(ctx.app, rpc("tools/list"), await tokenOf(ctx.db, me.id));
    const tool = (res.json().result.tools as Array<{ name: string; description: string; annotations?: unknown }>).find(t => t.name === "list_folders")!;
    expect(tool.description).toBe(
      "List the folders you can see: your personal folders, the folders of your groups where your role can read notes, and your folders for notes others shared with you, which only you can see. " +
        "Each folder has its `space` and its `path` — the folder names from the top level down, ending with its own; a long path is cut from the top, with `pathTruncated`. " +
        "Pass `group_id` to list one group's folders. Folders come grouped by space, not in tree order; use `parentId` to see the tree. " +
        `Up to ${MCP_FOLDER_PAGE_MAX} per call: pass \`nextCursor\` back as \`cursor\` for the next page, until it is null. ` +
        "Paging reads live data, not a snapshot, so a folder created while you page may not appear. " +
        "Each note in list_notes and search_notes carries, as `folder`, the folder it is filed in for you.",
    );
    expect(tool.description).not.toContain("fewer when");
    expect(tool.annotations).toEqual({ readOnlyHint: true });
  });
});

describe("LF7 describe 字串（T5 審查 M1）", () => {
  it("tools/list 上 list_folders 的 group_id／cursor／folders 與 read_note_outline 的 folder 說明逐字", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const res = await mcpPost(ctx.app, rpc("tools/list"), await tokenOf(ctx.db, me.id));
    type Props = Record<string, { description?: string }>;
    type Tool = { name: string; inputSchema: { properties: Props }; outputSchema: { properties: Props } };
    const tools = res.json().result.tools as Tool[];
    const lf = tools.find(t => t.name === "list_folders")!;
    const ro = tools.find(t => t.name === "read_note_outline")!;
    expect(lf.inputSchema.properties.group_id!.description).toBe(
      "The id of one of your groups, to list only its folders. A group's id is the `id` in the `owner` of its notes in list_notes or search_notes, or the `groupId` in a folder's `space`.",
    );
    expect(lf.inputSchema.properties.cursor!.description).toBe("Opaque cursor from a previous call's `nextCursor`. Omit it to start at the first page.");
    expect(lf.outputSchema.properties.folders!.description).toBe("This page of folders, grouped by space.");
    expect(ro.outputSchema.properties.folder!.description).toBe(
      "Where this note is filed for you, with the folder names from the top level down, or null at the top level; for a note shared with you, where you filed it, not where its owner did. Long paths are cut from the top, with `pathTruncated`.",
    );
  });
});

describe("RO1 read_note_outline 的 folder", () => {
  type OutlineOut = { folder: { id: string; path: string[]; pathTruncated?: true } | null };
  const outlineOf = async (app: FastifyInstance, auth: McpAuth, noteId: string) =>
    ok(await callTool(app, auth, "read_note_outline", { note_id: noteId })) as unknown as OutlineOut;

  it("個人、群組、根層；被分享者看不到擁有者的資料夾（自己放置後是自己的路徑）；八層鏈 → pathTruncated", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const b = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "RO1", [{ userId: me.id, role: "member" }]);
    const pool = ctx.db.$client;
    const [, pf] = await seedFolderChain(ctx.db, { personal: me.id }, ["A", "SECRET-ro1"]);
    const gf = await seedFolder(ctx.db, { group: g.id }, { name: "GF" });
    const eight = await seedFolderChain(ctx.db, { personal: me.id }, Array.from({ length: 8 }, () => '"'.repeat(27)));
    const np = await seedNote(ctx.db, { ownerId: me.id }, { title: "ro1 p" });
    const ng = await seedNote(ctx.db, { groupId: g.id }, { title: "ro1 g" });
    const nr = await seedNote(ctx.db, { ownerId: me.id }, { title: "ro1 r" });
    const n8 = await seedNote(ctx.db, { ownerId: me.id }, { title: "ro1 8" });
    await setNoteFolder(pool, np.id, pf!);
    await setNoteFolder(pool, ng.id, gf.id);
    await setNoteFolder(pool, n8.id, eight.at(-1)!);
    await seedShare(ctx.db, np.id, b.id, "viewer");
    const auth = await tokenOf(ctx.db, me.id);

    expect((await outlineOf(ctx.app, auth, np.id)).folder).toEqual({ id: pf, path: ["A", "SECRET-ro1"] });
    expect((await outlineOf(ctx.app, auth, ng.id)).folder).toEqual({ id: gf.id, path: ["GF"] });
    expect((await outlineOf(ctx.app, auth, nr.id)).folder).toBeNull();
    const deep = (await outlineOf(ctx.app, auth, n8.id)).folder!;
    expect([deep.id, deep.path.length, deep.pathTruncated]).toEqual([eight.at(-1), 7, true]);

    const bAuth = await tokenOf(ctx.db, b.id);
    const raw = await mcpPost(ctx.app, rpc("tools/call", { name: "read_note_outline", arguments: { note_id: np.id } }), bAuth);
    expect(raw.body).not.toContain("SECRET-ro1");
    expect(raw.body).not.toContain(pf!);
    expect((await outlineOf(ctx.app, bAuth, np.id)).folder).toBeNull();
    const mine = await seedFolder(ctx.db, { shared: b.id }, { name: "Mine" });
    await seedPlacement(pool, b.id, np.id, mine.id);
    expect((await outlineOf(ctx.app, bAuth, np.id)).folder).toEqual({ id: mine.id, path: ["Mine"] });
  });
});

describe("RO2 資料夾在兩句之間被刪", () => {
  // 誠實缺口：HTTP 上造不出（沒有縫；FK SET NULL 也讓活筆記不會指向不存在的資料夾）。這裡直呼 outlineFolderFor，
  // 以替身 db 讓第二句（loadFolderPath）落空——owner 的筆記不查放置，第一句不碰 db。
  it("viewerFolderIdFor 有 id、loadFolderPath 回 null → folder: null（不 throw）", async () => {
    const userId = randomUUID();
    const stub = { execute: async () => ({ rows: [] }) } as unknown as Db;
    expect(await outlineFolderFor(stub, { id: randomUUID(), ownerId: userId, groupId: null, folderId: randomUUID() }, userId)).toBeNull();
  });
});
