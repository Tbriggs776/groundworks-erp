import { createClient } from "@supabase/supabase-js";
import { AppError } from "@/lib/errors";

/**
 * Private file storage: Supabase Storage, bucket `attachments`, reached only
 * by the server with the service role key (the bucket has no policies, so
 * the browser's keys can't list or read it). Files are served to people
 * through /files/<id> after the app's own access checks.
 *
 * FILE_STORAGE=memory keeps files in this process instead (tests only; never
 * in production).
 */

export const BUCKET = "attachments";

const memory = new Map<string, { bytes: Buffer; contentType: string }>();
const inMemory = () => process.env.FILE_STORAGE === "memory" && process.env.NODE_ENV !== "production";

export function storageConfigured(): boolean {
  return inMemory() || Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function bucket() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new AppError("invalid_state", "File storage isn't set up: SUPABASE_SERVICE_ROLE_KEY is missing.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }).storage.from(BUCKET);
}

const unavailable = (what: string, detail?: string) =>
  new AppError("upstream_error", `Couldn't ${what} the file in storage. Try again in a minute.${detail ? ` (${detail})` : ""}`);

export async function putFile(path: string, bytes: Buffer, contentType: string): Promise<void> {
  if (inMemory()) {
    memory.set(path, { bytes, contentType });
    return;
  }
  const { error } = await bucket().upload(path, bytes, { contentType, upsert: false });
  if (error) throw unavailable("save", error.message);
}

export async function getFile(path: string): Promise<Buffer> {
  if (inMemory()) {
    const f = memory.get(path);
    if (!f) throw new AppError("not_found", "That file is missing from storage.");
    return f.bytes;
  }
  const { data, error } = await bucket().download(path);
  if (error || !data) throw unavailable("read", error?.message);
  return Buffer.from(await data.arrayBuffer());
}

/** Best effort: a file left behind in storage is harmless, a failed delete shouldn't undo the rest. */
export async function removeFile(path: string): Promise<void> {
  if (inMemory()) {
    memory.delete(path);
    return;
  }
  await bucket()
    .remove([path])
    .catch(() => undefined);
}

/** Tests: how many files the memory store holds. */
export const memoryFileCount = () => memory.size;
