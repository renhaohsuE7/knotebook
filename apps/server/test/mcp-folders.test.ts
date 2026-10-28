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
import { listVisibleFoldersPage } from "../src/folders/queries.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { folderPathCost } from "../src/mcp/folder-fields.js";
import { BAD_CURSOR_MESSAGE } from "../src/mcp/keyset-cursor.js";
import { MCP_FOLDER_PAGE_MAX, MCP_LIST_WIRE_BUDGET, escapedLength } from "../src/mcp/limits.js";
import type { McpToolCtx } from "../src/mcp/context.js";
import { folderReply } from "../src/mcp/tools/create-folder.js";
import { outlineFolderFor } from "../src/mcp/tools/read-note-outline.js";
import { wireCost } from "../src/mcp/wire-budget.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { seedFolder, seedFolderChain, seedPlacement, setNoteFolder } from "./folder-helpers.js";
import { seedGroup, seedNote, seedRole, seedShare, seedUser } from "./group-helpers.js";
import { buildCollabTestApp } from "./helpers.js";
import { callTool, restFolder, type McpAuth, type ToolCallResult } from "./mcp-folder-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { sixRoleScene } from "./trash-helpers.js";

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

describe("FR folderReply 重讀落空（T6 審查 M1）", () => {
  // 建立／改名／搬移成功後、重讀之前被刪的毫秒級視窗在 HTTP 上造不出；直呼 export 的 folderReply、給真 db 與隨機 uuid 就走到落空分支。
  it("真 db＋隨機 uuid → not_found＋FM1（不回半套的資料夾）", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const r = (await folderReply({ db: ctx.db, userId: me.id } as unknown as McpToolCtx, randomUUID())) as ToolCallResult;
    expect([r.isError, r.structuredContent]).toEqual([true, { code: "not_found", message: FM1 }]);
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

// ───────────────────────── 資料夾 PR-3d T6：create_folder／rename_folder／move_folder ─────────────────────────

const RW: TokenScope = "notes:read notes:write";
const FM1 =
  "No folder with that id that you can use here. For example, it may not exist, may have been deleted, or may be someone else's or in a group whose notes your role can't read; list_folders shows the folders you can see.";
const FM3 = "Your role in that group can't change its folders — creating, renaming, moving and deleting them needs a role that can edit notes — so nothing was changed.";
const FM4 = "That folder name contains a character that can't be stored (a NUL or an unpaired surrogate), so nothing was changed.";
const FM5 = "Folder names can't contain line breaks, tabs, or other control or text-direction characters, so nothing was changed.";
const FM6 = "Folder names must be 1 to 80 characters once surrounding whitespace is removed, so nothing was changed.";
const FM7 = "There is already a folder with that name in that place — names that differ only in letter case can count as the same — so nothing was changed.";
const FM8 = "That would put a folder more than 5 levels deep (a top-level folder is level 1), so nothing was changed.";
const FM9 = "A folder can't be moved into itself or into one of its own subfolders, so nothing was changed.";
const FM10 = "That space already has the most folders it can hold (1000), so the folder was not created.";
const FM11 = "The server was busy, so nothing was changed. Try again in a moment.";
const FM17 =
  "A folder can only move within its own space — among your personal folders, within one group, or among your folders for notes shared with you — so nothing was changed. Pass `parent_id: null` to move it to the top level of its space.";
const FM20 = "Pass at most one of `parent_id`, `group_id` and `shared: true`, so nothing was created.";
const RATE = "Too many note writes right now. Wait a moment before writing again.";

const folderCount = async (db: Db): Promise<number> => (await db.$client.query<{ n: number }>(`select count(*)::int n from folders`)).rows[0]!.n;
const folderOf = async (db: Db, id: string) =>
  (await db.$client.query<{ name: string; parent_id: string | null }>(`select name, parent_id from folders where id = $1`, [id])).rows[0];
async function made(app: FastifyInstance, auth: McpAuth, name: string, args: unknown): Promise<FolderOut> {
  return (ok(await callTool(app, auth, name, args)) as { folder: FolderOut }).folder;
}
function err(r: ToolCallResult, code: string, message: string): void {
  expect(r.isError, JSON.stringify(r.structuredContent)).toBe(true);
  expect(r.structuredContent).toEqual({ code, message });
}
/** 剩幾次（耗盡它）。 */
function remaining(l: FixedWindowLimiter, key: string): number {
  let n = 0;
  while (n <= 1000 && l.consume(key)) n += 1;
  return n;
}
const busyErr = () => Object.assign(new Error("serialization"), { code: "40001" });

describe("LP listVisibleFoldersPage 的 ids（T5 審查 N2）", () => {
  it("ids 空陣列 → 不發錯、0 列；ids 只回該資料夾", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const f = await seedFolder(ctx.db, { personal: me.id }, { name: "only" });
    await seedFolder(ctx.db, { personal: me.id }, { name: "other" });
    expect((await listVisibleFoldersPage(ctx.db, me.id, { ids: [], limit: 10, after: null })).rows).toEqual([]);
    expect((await listVisibleFoldersPage(ctx.db, me.id, { ids: [f.id], limit: 10, after: null })).rows.map(r => r.access.folder.id)).toEqual([f.id]);
  });
});

describe("CF1 create_folder 的四種位置", () => {
  it("不給 → 個人根層；parent_id（含 shared 父層）→ 子資料夾；group_id（含大寫）→ 群組根層；shared: true → shared 根層；shared: false＋group_id → 群組根層", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "CF1", [{ userId: me.id, role: "member" }]);
    const auth = await tokenOf(ctx.db, me.id, RW);

    const a = await made(ctx.app, auth, "create_folder", { name: "A" });
    expect(a).toEqual({ id: a.id, name: "A", parentId: null, space: { kind: "personal" }, path: ["A"] });
    const b = await made(ctx.app, auth, "create_folder", { name: "B", parent_id: a.id.toUpperCase() });
    expect([b.parentId, b.path, b.space]).toEqual([a.id, ["A", "B"], { kind: "personal" }]);
    const s = await made(ctx.app, auth, "create_folder", { name: "S", shared: true });
    expect([s.space, s.parentId]).toEqual([{ kind: "shared" }, null]);
    const s2 = await made(ctx.app, auth, "create_folder", { name: "S2", parent_id: s.id });
    expect([s2.space, s2.path]).toEqual([{ kind: "shared" }, ["S", "S2"]]);
    const g1 = await made(ctx.app, auth, "create_folder", { name: "G1", group_id: g.id });
    expect(g1.space).toEqual({ kind: "group", groupId: g.id, groupName: "CF1" });
    const g2 = await made(ctx.app, auth, "create_folder", { name: "G2", group_id: g.id.toUpperCase() });
    expect(g2.space).toEqual({ kind: "group", groupId: g.id, groupName: "CF1" });
    const g3 = await made(ctx.app, auth, "create_folder", { name: "G3", shared: false, group_id: g.id });
    expect([g3.space.kind, g3.parentId]).toEqual(["group", null]);
  });

  it("位置參數兩個以上 → invalid_body＋FM20、名稱不合法 → FM6；DB 無新列；tokenWrite 已扣（scope 在兩者之前）而 edit 桶未扣", async () => {
    const tokenWrite = new FixedWindowLimiter({ limit: 50, windowMs: 600_000 });
    const edit = new FixedWindowLimiter({ limit: 50, windowMs: 600_000 });
    const ctx = await buildCollabTestApp({ limiters: { tokenWrite, edit } });
    const me = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "CF1b", [{ userId: me.id, role: "member" }]);
    const f = await seedFolder(ctx.db, { personal: me.id }, { name: "P" });
    const auth = await tokenOf(ctx.db, me.id, RW);
    const before = await folderCount(ctx.db);
    for (const args of [{ name: "x", parent_id: f.id, group_id: g.id }, { name: "x", group_id: g.id, shared: true }, { name: "x", parent_id: f.id, shared: true }]) {
      err(await callTool(ctx.app, auth, "create_folder", args), "invalid_body", FM20);
    }
    // 名稱不合法也在 scope（tokenWrite 扣點）之後才判（T6 審查 M2）。
    err(await callTool(ctx.app, auth, "create_folder", { name: "   " }), "invalid_body", FM6);
    expect(await folderCount(ctx.db)).toBe(before);
    expect(remaining(tokenWrite, `token:${me.id}`)).toBe(46);
    expect(remaining(edit, me.id)).toBe(50);
  });
});

describe("CF2 名稱", () => {
  it("NUL、落單代理 → FM4；字中換行 → FM5；81 個字、只有空白 → FM6；尾端換行修掉後成功；NFC 等價與大小寫不同的同名 → FM7；回應 name 是 NFC", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const auth = await tokenOf(ctx.db, me.id, RW);
    const cases: Array<[string, string]> = [
      [`a${String.fromCharCode(0)}b`, FM4],
      [`a${String.fromCharCode(0xd800)}b`, FM4],
      [`a${String.fromCharCode(10)}b`, FM5],
      ["x".repeat(81), FM6],
      ["   ", FM6],
    ];
    for (const [name, message] of cases) err(await callTool(ctx.app, auth, "create_folder", { name }), "invalid_body", message);
    expect((await made(ctx.app, auth, "create_folder", { name: `trail${String.fromCharCode(10)}` })).name).toBe("trail");
    const composed = await made(ctx.app, auth, "create_folder", { name: `Caf${String.fromCharCode(0x65, 0x301)}` });
    expect(composed.name).toBe(`Caf${String.fromCharCode(0xe9)}`);
    err(await callTool(ctx.app, auth, "create_folder", { name: `Caf${String.fromCharCode(0xe9)}` }), "conflict", FM7);
    await made(ctx.app, auth, "create_folder", { name: "Proj" });
    err(await callTool(ctx.app, auth, "create_folder", { name: "proj" }), "conflict", FM7);
  });
});

describe("CF3 群組根層看不到", () => {
  it("非成員、noRead、隨機 uuid、交易前群組被刪 → 四者逐欄相同（group_not_found＋FM2）；readOnly → forbidden＋FM3", async () => {
    let doomed: string | null = null;
    const ctx = await buildCollabTestApp({
      groupTestHook: async (point, hctx) => {
        if (point === "folder-authorized" && hctx.groupId !== undefined && hctx.groupId === doomed) {
          await ctx.db.$client.query(`delete from groups where id = $1`, [doomed]);
        }
      },
    });
    const s = await sixRoleScene(ctx.db);
    const me = s.member;
    const other = await seedUser(ctx.db);
    const outside = await seedGroup(ctx.db, "CF3 out", [{ userId: other.id, role: "admin" }]);
    const noRead = await seedGroup(ctx.db, "CF3 noRead", [{ userId: other.id, role: "admin" }]);
    await addNoReadMember(ctx.db, noRead.id, me.id);
    const gone = await seedGroup(ctx.db, "CF3 gone", [{ userId: me.id, role: "member" }]);
    const auth = await tokenOf(ctx.db, me.id, RW);
    const results: ToolCallResult[] = [];
    for (const gid of [outside.id, noRead.id, randomUUID()]) results.push(await callTool(ctx.app, auth, "create_folder", { name: "x", group_id: gid }));
    doomed = gone.id;
    results.push(await callTool(ctx.app, auth, "create_folder", { name: "x", group_id: gone.id }));
    err(results[0]!, "group_not_found", FM2);
    for (const r of results.slice(1)) expect(r).toEqual(results[0]);
    err(await callTool(ctx.app, await tokenOf(ctx.db, s.readOnly.id, RW), "create_folder", { name: "x", group_id: s.groupId }), "forbidden", FM3);
  });
});

describe("CF4 上限", () => {
  it("第 6 層 → conflict＋FM8；空間已有 1000 個 → conflict＋FM10", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const auth = await tokenOf(ctx.db, me.id, RW);
    const chain = await seedFolderChain(ctx.db, { personal: me.id }, ["1", "2", "3", "4", "5"]);
    err(await callTool(ctx.app, auth, "create_folder", { name: "6", parent_id: chain.at(-1)! }), "conflict", FM8);
    await ctx.db.$client.query(
      `insert into folders (kind, owner_id, name, created_by) select 'shared', $1::uuid, 'f' || g, $1::uuid from generate_series(1, 1000) g`,
      [me.id],
    );
    err(await callTool(ctx.app, auth, "create_folder", { name: "one more", shared: true }), "conflict", FM10);
  });
});

describe("RF1 rename_folder", () => {
  it("改名成功、path 末段是新名、筆記 updated_at／slug 不變；看不到與隨機 uuid 逐欄相同（FM1）；readOnly → FM3；撞名 → FM7", async () => {
    const ctx = await buildCollabTestApp();
    const s = await sixRoleScene(ctx.db);
    const me = s.member;
    const other = await seedUser(ctx.db);
    const [top, f] = await seedFolderChain(ctx.db, { personal: me.id }, ["Top", "Old"]);
    await seedFolder(ctx.db, { personal: me.id }, { name: "Taken", parentId: top });
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "rf1" });
    await setNoteFolder(ctx.db.$client, n.id, f!);
    const noteBefore = (await ctx.db.$client.query(`select updated_at::text u, slug from notes where id = $1`, [n.id])).rows[0];
    const auth = await tokenOf(ctx.db, me.id, RW);

    const renamed = await made(ctx.app, auth, "rename_folder", { folder_id: f!, name: "New" });
    expect([renamed.name, renamed.path]).toEqual(["New", ["Top", "New"]]);
    expect((await ctx.db.$client.query(`select updated_at::text u, slug from notes where id = $1`, [n.id])).rows[0]).toEqual(noteBefore);

    const theirs = await seedFolder(ctx.db, { personal: other.id }, { name: "theirs" });
    const a = await callTool(ctx.app, auth, "rename_folder", { folder_id: theirs.id, name: "x" });
    const b = await callTool(ctx.app, auth, "rename_folder", { folder_id: randomUUID(), name: "x" });
    err(a, "not_found", FM1);
    expect(b).toEqual(a);
    const gf = await seedFolder(ctx.db, { group: s.groupId }, { name: "GF" });
    err(await callTool(ctx.app, await tokenOf(ctx.db, s.readOnly.id, RW), "rename_folder", { folder_id: gf.id, name: "x" }), "forbidden", FM3);
    err(await callTool(ctx.app, auth, "rename_folder", { folder_id: f!, name: "taken" }), "conflict", FM7);
  });
});

describe("MF1 move_folder", () => {
  it("同空間搬移、parent_id null 回根層、搬到原父層成功且 DB 不變；看不到（含跨空間）與隨機 uuid 逐欄相同；看得到但跨空間 → FM17；搬進子孫 → FM9；太深 → FM8", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const other = await seedUser(ctx.db);
    const auth = await tokenOf(ctx.db, me.id, RW);
    const [p, c] = await seedFolderChain(ctx.db, { personal: me.id }, ["P", "C"]);
    const q = await seedFolder(ctx.db, { personal: me.id }, { name: "Q" });

    expect((await made(ctx.app, auth, "move_folder", { folder_id: c!, parent_id: q.id })).path).toEqual(["Q", "C"]);
    expect((await made(ctx.app, auth, "move_folder", { folder_id: c!, parent_id: null })).path).toEqual(["C"]);
    expect((await made(ctx.app, auth, "move_folder", { folder_id: c!, parent_id: null })).parentId).toBeNull();
    expect(await folderOf(ctx.db, c!)).toEqual({ name: "C", parent_id: null });

    const theirs = await seedFolder(ctx.db, { personal: other.id }, { name: "theirs" });
    const hidden = await callTool(ctx.app, auth, "move_folder", { folder_id: c!, parent_id: theirs.id });
    err(hidden, "not_found", FM1); // 看不到＋跨空間：先判可見性（§5.5 入口順序）
    expect(await callTool(ctx.app, auth, "move_folder", { folder_id: c!, parent_id: randomUUID() })).toEqual(hidden);
    const mine = await seedFolder(ctx.db, { shared: me.id }, { name: "mine shared" });
    err(await callTool(ctx.app, auth, "move_folder", { folder_id: c!, parent_id: mine.id }), "invalid_body", FM17);
    const [, kid] = await seedFolderChain(ctx.db, { personal: me.id }, ["X1", "X2"], { parentId: p! });
    err(await callTool(ctx.app, auth, "move_folder", { folder_id: p!, parent_id: kid! }), "conflict", FM9);
    const deep = await seedFolderChain(ctx.db, { personal: me.id }, ["d1", "d2", "d3"]);
    // p 的子樹高度 3（P › X1 › X2）＋放在第 3 層之下 → 第 6 層
    err(await callTool(ctx.app, auth, "move_folder", { folder_id: p!, parent_id: deep.at(-1)! }), "conflict", FM8);
    expect(await folderOf(ctx.db, p!)).toEqual({ name: "P", parent_id: null });
  });
});

describe("KF-W 交易內重判", () => {
  it("取完結構鎖後拿掉 editOnly 的 can_edit → 三支都 forbidden＋FM3、DB 不變", async () => {
    let roleToStrip: string | null = null;
    const ctx = await buildCollabTestApp({
      groupTestHook: async point => {
        if (point === "folder-structure-locked" && roleToStrip !== null) {
          await ctx.db.$client.query(`update group_roles set can_edit = false where id = $1`, [roleToStrip]);
        }
      },
    });
    const s = await sixRoleScene(ctx.db);
    const role = (await ctx.db.$client.query<{ role_id: string }>(`select role_id from group_members where group_id = $1 and user_id = $2`, [s.groupId, s.editOnly.id])).rows[0]!.role_id;
    const [gp, gc] = await seedFolderChain(ctx.db, { group: s.groupId }, ["GP", "GC"]);
    const auth = await tokenOf(ctx.db, s.editOnly.id, RW);
    const before = await folderCount(ctx.db);
    const calls: Array<[string, Record<string, unknown>]> = [
      ["create_folder", { name: "new", group_id: s.groupId }],
      ["rename_folder", { folder_id: gc!, name: "renamed" }],
      ["move_folder", { folder_id: gc!, parent_id: null }],
    ];
    for (const [name, args] of calls) {
      await ctx.db.$client.query(`update group_roles set can_edit = true where id = $1`, [role]);
      roleToStrip = role;
      err(await callTool(ctx.app, auth, name, args), "forbidden", FM3);
      roleToStrip = null;
    }
    expect(await folderCount(ctx.db)).toBe(before);
    expect(await folderOf(ctx.db, gc!)).toEqual({ name: "GC", parent_id: gp });
  });
});

describe("BZ-W 可重試錯誤", () => {
  it("結構鎖之後丟 40001 → 三支都 server_busy＋FM11、DB 不變", async () => {
    const ctx = await buildCollabTestApp({
      groupTestHook: async point => {
        if (point === "folder-structure-locked") throw busyErr();
      },
    });
    const me = await seedUser(ctx.db);
    const [p, c] = await seedFolderChain(ctx.db, { personal: me.id }, ["P", "C"]);
    const auth = await tokenOf(ctx.db, me.id, RW);
    const before = await folderCount(ctx.db);
    err(await callTool(ctx.app, auth, "create_folder", { name: "new" }), "server_busy", FM11);
    err(await callTool(ctx.app, auth, "rename_folder", { folder_id: c!, name: "x" }), "server_busy", FM11);
    err(await callTool(ctx.app, auth, "move_folder", { folder_id: c!, parent_id: null }), "server_busy", FM11);
    expect(await folderCount(ctx.db)).toBe(before);
    expect(await folderOf(ctx.db, c!)).toEqual({ name: "C", parent_id: p });
  });
});

describe("ED-W 桶", () => {
  it("edit 桶 0 → too_many_requests、DB 不變；同設定下看不到的資料夾 → not_found（授權在扣桶之前）", async () => {
    const ctx = await buildCollabTestApp({ limiters: { edit: new FixedWindowLimiter({ limit: 0, windowMs: 600_000 }) } });
    const me = await seedUser(ctx.db);
    const f = await seedFolder(ctx.db, { personal: me.id }, { name: "F" });
    const auth = await tokenOf(ctx.db, me.id, RW);
    const before = await folderCount(ctx.db);
    err(await callTool(ctx.app, auth, "create_folder", { name: "new" }), "too_many_requests", RATE);
    err(await callTool(ctx.app, auth, "rename_folder", { folder_id: f.id, name: "x" }), "too_many_requests", RATE);
    err(await callTool(ctx.app, auth, "rename_folder", { folder_id: randomUUID(), name: "x" }), "not_found", FM1);
    expect(await folderCount(ctx.db)).toBe(before);
    expect((await folderOf(ctx.db, f.id))!.name).toBe("F");
  });

  it("tokenWrite 桶 0（讀寫 token）→ create／rename／move 三支都 too_many_requests、DB 不變", async () => {
    const ctx = await buildCollabTestApp({ limiters: { tokenWrite: new FixedWindowLimiter({ limit: 0, windowMs: 600_000 }) } });
    const me = await seedUser(ctx.db);
    const [p, c] = await seedFolderChain(ctx.db, { personal: me.id }, ["P", "C"]);
    const auth = await tokenOf(ctx.db, me.id, RW);
    const before = await folderCount(ctx.db);
    const calls: Array<[string, Record<string, unknown>]> = [
      ["create_folder", { name: "new" }],
      ["rename_folder", { folder_id: c!, name: "renamed" }],
      ["move_folder", { folder_id: c!, parent_id: null }],
    ];
    for (const [name, args] of calls) {
      const r = await callTool(ctx.app, auth, name, args);
      expect([name, r.isError, r.structuredContent?.code]).toEqual([name, true, "too_many_requests"]);
    }
    expect(await folderCount(ctx.db)).toBe(before);
    expect(await folderOf(ctx.db, c!)).toEqual({ name: "C", parent_id: p });
  });
});

describe("PX-W REST／MCP 同一份 fixture（§5.6 第二張表：建／改名／搬資料夾）", () => {
  it("sixRoleScene＋noRead × {建群組根層、建子資料夾、改名、搬移}：REST 與 MCP 的結果對映表逐格相同", async () => {
    const ctx = await buildCollabTestApp();
    const s = await sixRoleScene(ctx.db);
    const noRead = await seedUser(ctx.db);
    await addNoReadMember(ctx.db, s.groupId, noRead.id);
    const [gp, gm] = await seedFolderChain(ctx.db, { group: s.groupId }, ["PX-P", "PX-M"]);
    const users = { admin: s.admin, member: s.member, editDelete: s.editDelete, deleteOnly: s.deleteOnly, editOnly: s.editOnly, readOnly: s.readOnly, outsider: s.outsider, noRead };
    const restCat = (status: number, body: { error?: { code?: string } }) =>
      status === 200 || status === 201 ? "ok" : status === 403 ? "forbidden" : status === 404 ? (body.error?.code === "group_not_found" ? "group_not_found" : "not_found") : `rest-${status}`;
    const mcpCat = (r: ToolCallResult) => (r.isError ? String(r.structuredContent?.code) : "ok");
    const rest: Record<string, string[]> = {};
    const mcp: Record<string, string[]> = {};
    for (const [label, u] of Object.entries(users)) {
      const auth = await tokenOf(ctx.db, u.id, RW);
      const r1 = await restFolder(ctx.app, u.id, "POST", "/api/folders", { name: `root-${label}-rest`, space: { kind: "group", groupId: s.groupId } });
      const r2 = await restFolder(ctx.app, u.id, "POST", "/api/folders", { name: `sub-${label}-rest`, parentId: gp });
      const r3 = await restFolder(ctx.app, u.id, "PATCH", `/api/folders/${gm}`, { name: `ren-${label}-rest` });
      const r4 = await restFolder(ctx.app, u.id, "PATCH", `/api/folders/${gm}`, { parentId: gp });
      rest[label] = [r1, r2, r3, r4].map(r => restCat(r.statusCode, r.json() as { error?: { code?: string } }));
      mcp[label] = [
        await callTool(ctx.app, auth, "create_folder", { name: `root-${label}-mcp`, group_id: s.groupId }),
        await callTool(ctx.app, auth, "create_folder", { name: `sub-${label}-mcp`, parent_id: gp }),
        await callTool(ctx.app, auth, "rename_folder", { folder_id: gm, name: `ren-${label}-mcp` }),
        await callTool(ctx.app, auth, "move_folder", { folder_id: gm, parent_id: gp }),
      ].map(mcpCat);
    }
    expect(mcp).toEqual(rest);
    // 前提：表不是全同一格（真的分出了能管／不能管／看不到）
    expect(rest.member).toEqual(["ok", "ok", "ok", "ok"]);
    expect(rest.readOnly).toEqual(["forbidden", "forbidden", "forbidden", "forbidden"]);
    expect(rest.outsider).toEqual(["group_not_found", "not_found", "not_found", "not_found"]);
  });
});
