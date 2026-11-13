import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { useComposer } from "@/modules/ai/lib/composer";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useUpdater } from "./useUpdater";

export function UpdaterDialog({
  beforeInstall,
}: {
  beforeInstall: () => Promise<void>;
}) {
  const { status, open, check, install, dismiss } = useUpdater();
  const composer = useComposer();
  const locked = status.kind === "installing";
  const downloading = status.kind === "downloading";
  const percent =
    downloading && status.contentLength
      ? Math.min(100, (status.downloaded / status.contentLength) * 100)
      : null;
  const guardedInstall = async () => {
    if (composer.isBusy)
      throw new Error("Wait for the AI task to finish before installing.");
    if (composer.value.trim() || composer.files.length)
      throw new Error("Send or clear the AI draft before installing.");
    await beforeInstall();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !locked) dismiss();
      }}
    >
      <DialogContent
        className="sm:max-w-[440px]"
        onInteractOutside={(event) => {
          if (locked) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (locked) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {status.kind === "ready"
              ? `Tarex UI ${status.version} is ready`
              : downloading
                ? "Downloading update"
                : status.kind === "checking"
                  ? "Checking for updates"
                  : locked
                    ? "Installing update"
                    : status.kind === "error"
                      ? "Update could not finish"
                      : status.kind === "manual"
                        ? "Package update"
                        : "Tarex UI is up to date"}
          </DialogTitle>
          <DialogDescription>
            {status.kind === "ready"
              ? "The download and its signature have been verified. Save your work and finish running commands before installing and restarting."
              : status.kind === "error"
                ? status.message
                : status.kind === "manual"
                  ? "Automatic updates are supported by the Linux AppImage. Install the latest DEB/RPM with your package manager."
                  : downloading
                    ? `${(status.downloaded / 1048576).toFixed(1)} MB downloaded${percent !== null ? ` (${percent.toFixed(0)}%)` : ""}`
                    : locked
                      ? "Tarex UI will restart when installation finishes."
                      : status.kind === "checking"
                        ? "Checking the signed release channel."
                        : "No newer release is available."}
          </DialogDescription>
        </DialogHeader>
        {downloading && <Progress value={percent ?? undefined} />}
        <DialogFooter>
          {!locked && (
            <Button variant="ghost" onClick={dismiss}>
              {downloading || status.kind === "ready" ? "Later" : "Close"}
            </Button>
          )}
          {status.kind === "ready" && (
            <Button onClick={() => void install(guardedInstall)}>
              Install &amp; restart
            </Button>
          )}
          {status.kind === "error" && (
            <Button onClick={() => void check({ manual: true })}>
              Try again
            </Button>
          )}
          {status.kind === "manual" && (
            <Button
              onClick={() =>
                void openUrl(
                  "https://github.com/Kishir298/Tarex-Ui/releases/latest",
                )
              }
            >
              Download package
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
