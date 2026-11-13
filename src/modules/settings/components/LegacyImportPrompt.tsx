import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  legacyCredentialsAvailable,
  legacyImportSummary,
} from "@/lib/appData";
import { clearCredentialCache } from "@/modules/ai/lib/keyring";
import { PROVIDERS } from "@/modules/ai/config";
import { emitKeysChanged } from "@/modules/settings/store";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const NOTICE_KEY = "tarex-legacy-import-notified";

export function LegacyImportPrompt() {
  const [open, setOpen] = useState(legacyCredentialsAvailable);
  const [busy, setBusy] = useState(false);
  const providerNames = PROVIDERS.filter((provider) => provider.keyringAccount)
    .map((provider) => provider.label)
    .join(", ");

  useEffect(() => {
    if (!legacyImportSummary?.imported) return;
    if (legacyImportSummary.error) return;
    try {
      if (window.localStorage.getItem(NOTICE_KEY)) return;
      window.localStorage.setItem(NOTICE_KEY, "1");
    } catch {
      return;
    }
    toast.info(legacyImportSummary.notice ?? "Imported your previous app data.", {
      duration: 12_000,
    });
  }, []);

  const finish = async (skip: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const count = await invoke<number>("legacy_import_credentials", { skip });
      if (!skip) {
        clearCredentialCache();
        await emitKeysChanged();
        toast.success(
          count === 1
            ? "Imported 1 API key. Review it in Settings → Models."
            : `Imported ${count} API keys. Review them in Settings → Models.`,
        );
      }
      setOpen(false);
    } catch (error) {
      toast.error(`Could not import API keys: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) void finish(true);
      }}
    >
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Import API keys from Terex?</DialogTitle>
          <DialogDescription>
            Tarex found API keys from a previous Terex or Terax installation.
            Keys are stored only in this app's keychain entry. Nothing is sent
            anywhere.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-xl border border-border/70 bg-muted/40 p-3 text-[12px] text-muted-foreground">
          Detected providers: {providerNames}. Custom endpoint keys are included
          when present.
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void finish(true)}
          >
            Not now
          </Button>
          <Button disabled={busy} onClick={() => void finish(false)}>
            {busy ? "Importing…" : "Import keys"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
