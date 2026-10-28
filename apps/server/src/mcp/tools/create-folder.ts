/**
 * 資料夾 PR-3d（folders spec §5.12、§5.7.1）`create_folder`。服務層（`folders/service.ts` 的 `createFolder`）負責入口順序、
 * 扣 `edit` 桶、縫、交易與重判；這裡只做 scope、名稱的英文預判、位置參數、錯誤映射與回應組裝。
 * 本檔另 export 三支資料夾寫入工具共用的兩件事：服務層 deps 與「成功後以 list_folders 的形重讀」。
 */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FOLDER_DEPTH_MAX, FOLDER_NAME_MAX, FOLDERS_PER_SPACE_MAX, type FolderSpaceDto } from "@knotebook/shared";
import { listVisibleFoldersPage } from "../../folders/queries.js";
import { normalizeFolderName } from "../../folders/names.js";
import { createFolder, type FolderServiceDeps } from "../../folders/service.js";
import { GROUP_ID } from "../../notes/schemas.js";
import { FOLDER_ID, folderForModel, folderForModelSchema } from "../folder-fields.js";
import {
  FOLDER_NOT_FOUND_MESSAGE,
  FOLDER_POSITION_AMBIGUOUS_MESSAGE,
  folderFailureToToolError,
  folderNameErrorMessage,
} from "../folder-messages.js";
import { toolError, toolResult } from "../tool-result.js";
import { requireWriteScope } from "../write-scope.js";
import type { McpToolCtx } from "../context.js";

/** D-CF（逐字照 plan「待確認字串」）。 */
export const CREATE_FOLDER_DESCRIPTION =
  "Create a folder: inside one you can see with `parent_id`, at the top level of one of your groups with `group_id`, " +
  "at the top level of your folders for notes others shared with you with `shared: true`, or at the top level of your personal folders " +
  "when you pass none of them. In a group, it needs a role that can edit notes. " +
  `A name is 1 to ${FOLDER_NAME_MAX} characters with no line breaks or other control characters, and can't repeat the name of a folder ` +
  "already in the same place (names that differ only in letter case can count as the same). " +
  `New folders go at most ${FOLDER_DEPTH_MAX} levels deep, and creating stops at ${FOLDERS_PER_SPACE_MAX} folders in one space. ` +
  "The reply is the new folder, in the shape list_folders returns.";

export const CF_NAME = `The folder's name: 1 to ${FOLDER_NAME_MAX} characters, with no line breaks or other control characters.`;
export const CF_PARENT = "The id of a folder you can see to create this one inside, from list_folders.";
export const CF_GROUP =
  "The id of one of your groups, to create the folder at the top level of its folders. A group's id is the `id` in the `owner` of its notes in list_notes or search_notes.";
export const CF_SHARED = "True to create the folder at the top level of your folders for notes others shared with you, which only you can see.";
/** 三支資料夾寫入工具的輸出說明。 */
export const FOLDER_REPLY_DESCRIBE = "The folder, in the same shape list_folders returns.";

/** 註冊為 `z.object(createFolderInput).strict()`。`name` 的 1000 只防超長輸入，真正的上限由服務層判（超過 → FM6）。 */
export const createFolderInput = {
  name: z.string().max(1000).describe(CF_NAME),
  parent_id: FOLDER_ID.optional().describe(CF_PARENT),
  group_id: GROUP_ID.optional().describe(CF_GROUP),
  shared: z.boolean().optional().describe(CF_SHARED),
};

export const folderReplyOutput = { folder: folderForModelSchema.describe(FOLDER_REPLY_DESCRIBE) };

export interface CreateFolderArgs {
  name: string;
  parent_id?: string;
  group_id?: string;
  shared?: boolean;
}

/** 三支資料夾寫入工具共用的服務層 deps（同 delete_note／restore_note 的組法）。 */
export function folderServiceDeps(ctx: McpToolCtx): FolderServiceDeps {
  return {
    db: ctx.db,
    collabHooks: ctx.collabHooks,
    storageLockTimeoutMs: ctx.storageLockTimeoutMs,
    groupTestHook: ctx.groupTestHook,
    limiters: { edit: ctx.limiters.edit },
  };
}

/**
 * 成功後以 list_folders 的形重讀那一個資料夾（帶路徑與群組名）。重讀落空＝commit 之後、重讀之前被刪的毫秒級競態
 * → `not_found`＋FM1（同 move_note_to_group 的重讀先例）。
 */
export async function folderReply(ctx: McpToolCtx, folderId: string): Promise<CallToolResult> {
  const page = await listVisibleFoldersPage(ctx.db, ctx.userId, { ids: [folderId], limit: 1, after: null });
  const row = page.rows[0];
  if (row === undefined) return toolError("not_found", FOLDER_NOT_FOUND_MESSAGE);
  return toolResult({ folder: folderForModel(row) });
}

export async function createFolderTool(args: CreateFolderArgs, ctx: McpToolCtx): Promise<CallToolResult> {
  const denied = requireWriteScope(ctx);
  if (denied) return denied;
  // 名稱先以同一支純函式預判，英文句依原因三選一（服務層會再算一次、結果相同）。
  const name = normalizeFolderName(args.name);
  if (!name.ok) return toolError("invalid_body", folderNameErrorMessage(name.reason));
  // 位置參數至多一個；`shared: false`＝沒給（模型常順手送 false）。
  const given = [args.parent_id !== undefined, args.group_id !== undefined, args.shared === true].filter(Boolean).length;
  if (given > 1) return toolError("invalid_body", FOLDER_POSITION_AMBIGUOUS_MESSAGE);
  let parent: { folderId: string } | { space: FolderSpaceDto };
  if (args.parent_id !== undefined) parent = { folderId: args.parent_id };
  else if (args.group_id !== undefined) parent = { space: { kind: "group", groupId: args.group_id.toLowerCase() } }; // GROUP_ID 不轉小寫（發現 33）
  else parent = { space: { kind: args.shared === true ? "shared" : "personal" } };

  const out = await createFolder(folderServiceDeps(ctx), { by: ctx.userId, name: args.name, parent });
  if (out.kind === "error") return folderFailureToToolError("create_folder", out);
  return folderReply(ctx, out.folder.id);
}
