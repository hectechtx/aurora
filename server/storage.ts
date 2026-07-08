import type { Storage } from "./storage-types";

let _storage: Storage | null = null;

export async function setStorage(s: Storage): Promise<Storage> {
  _storage = s;
  await _storage.seedIfEmpty();
  return _storage;
}

export function getStorage(): Storage {
  if (!_storage) throw new Error("Storage not initialized — call setStorage() first");
  return _storage;
}
