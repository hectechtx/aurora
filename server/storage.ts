import type { Storage } from "./storage-types";

let _storage: Storage | null = null;

export async function setStorage(s: Storage): Promise<Storage> {
  _storage = s;
  await _storage.seedIfEmpty();
  // Auto-recovery of "orphaned" creation files is intentionally NOT run on
  // startup. It re-imported any file in the creations dir that lacked a DB
  // row as a placeholder "(recovered — original prompt was lost)" entry, which
  // repeatedly cluttered the Library with broken tiles (especially once the
  // data-dir split meant files and rows could legitimately diverge). The
  // owner asked for this to stop; genuine loss is rare and the Recycle Bin
  // already covers deletes. The method remains available for manual use.
  return _storage;
}

export function getStorage(): Storage {
  if (!_storage) throw new Error("Storage not initialized — call setStorage() first");
  return _storage;
}
