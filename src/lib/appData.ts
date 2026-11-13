import { invoke } from "@tauri-apps/api/core";

export type LegacyImportSummary = {
  imported: boolean;
  source: string | null;
  files: string[];
  notice: string | null;
  error: string | null;
};

type StoragePaths = {
  data: string;
  config: string;
  local_data: string;
  import_summary?: LegacyImportSummary;
  credentials_available?: boolean;
};

const storage = await invoke<StoragePaths>("shared_storage_paths").catch(
  () => null,
);

export function appDataFile(name: string): string {
  return storage?.data
    ? `${storage.data.replace(/[\\/]+$/, "")}/${name}`
    : name;
}

export const sharedConfigDirectory = storage?.config ?? null;
export const legacyImportSummary = storage?.import_summary ?? null;
export const legacyCredentialsAvailable =
  storage?.credentials_available ?? false;
