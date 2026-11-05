import type { BlockMode } from "@/modules/terminal/block/lib/modeMachine";
import {
  clearGhosttySession,
  changeGhosttyDirectory,
  dispatchGhosttyKey,
  disposeGhosttySession,
  focusGhosttySession,
  ghosttyFocusedLeaf,
  ghosttyDraftForLeaf,
  insertGhosttyCommandDraft,
  ghosttyLeafHasForegroundProcess,
  ghosttyLeafIdForPty,
  ghosttyCwdForLeaf,
  ghosttyPtyIdForLeaf,
  ghosttySelectionForLeaf,
  hasGhosttySession,
  interruptGhosttySession,
  pasteIntoGhosttySession,
  respawnGhosttySession,
  submitToGhosttySession,
  whenGhosttySessionReady,
  writeToGhosttySession,
} from "@/modules/terminal/ghostty/useGhosttyTerminalSession";
import {
  disposeGhosttyBlocks,
  ensureGhosttyBlocks,
  ghosttyBlocks,
} from "@/modules/terminal/ghostty/ghosttyBlockSessions";
export type { WatermarkState } from "@/modules/terminal/ghostty/ghosttyBlockSessions";
import type { WatermarkState } from "@/modules/terminal/ghostty/ghosttyBlockSessions";

export async function whenSessionReady(
  leafId: number,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(0, deadline - Date.now());
    if (hasGhosttySession(leafId)) {
      await withTimeout(whenGhosttySessionReady(leafId), remaining);
      return;
    }
    await delay(Math.min(10, remaining));
  }
}

export function changeSessionDirectory(leafId: number, path: string, windows: boolean): Promise<void> {
  return changeGhosttyDirectory(leafId, path, windows);
}

export function writeToSession(leafId: number, data: string): boolean {
  return writeToGhosttySession(leafId, data);
}

export function submitToLeaf(leafId: number, text: string): void {
  submitToGhosttySession(leafId, text);
}

export function interruptLeaf(leafId: number): void {
  interruptGhosttySession(leafId);
}

export function pasteIntoSession(leafId: number, text: string): boolean {
  return pasteIntoGhosttySession(leafId, text);
}

export function leafCwd(leafId: number): string | null {
  return ghosttyCwdForLeaf(leafId);
}

export function navigateFocusedBlocks(direction: -1 | 1): boolean {
  const leaf = ghosttyFocusedLeaf();
  return (
    leaf !== null &&
    (ghosttyBlocks(leaf)?.controller?.navigate(direction) ?? false)
  );
}

export function clearLeafBlockSelection(leafId: number): boolean {
  return ghosttyBlocks(leafId)?.controller?.clearSelection() ?? false;
}

export function leafGridSelection(leafId: number): string | null {
  return ghosttySelectionForLeaf(leafId);
}

export function getLeafBlockMode(leafId: number): BlockMode {
  return ghosttyBlocks(leafId)?.getMode() ?? "plain";
}

export function subscribeLeafBlockMode(
  leafId: number,
  callback: () => void,
): () => void {
  return ensureGhosttyBlocks(leafId).subscribeMode(callback);
}

export function setLeafInputFocus(
  leafId: number,
  callback: (() => void) | null,
): void {
  const state = callback ? ensureGhosttyBlocks(leafId) : ghosttyBlocks(leafId);
  if (state) state.focus = callback;
}

export function setLeafInputPaste(
  leafId: number,
  paste: ((text: string) => void) | null,
): void {
  const state = paste ? ensureGhosttyBlocks(leafId) : ghosttyBlocks(leafId);
  if (state) state.paste = paste;
}

export function setLeafInputKeyDown(
  leafId: number,
  handler: ((event: KeyboardEvent) => boolean) | null,
): void {
  const state = handler ? ensureGhosttyBlocks(leafId) : ghosttyBlocks(leafId);
  if (state) state.keyDown = handler;
}

export function setLeafSuggestionAccept(leafId:number,accept:((run:boolean)=>boolean)|null):void {
  const state=accept?ensureGhosttyBlocks(leafId):ghosttyBlocks(leafId);
  if(state)state.acceptSuggestion=accept;
}

export function acceptTerminalSuggestion(leafId:number,run:boolean):boolean {
  const state=ghosttyBlocks(leafId);
  return state?.getMode()==="prompt" ? state.acceptSuggestion?.(run)??false:false;
}

export function dispatchTerminalKey(leafId:number,event:KeyboardEvent,text:string):boolean {
  return dispatchGhosttyKey(leafId,event,text);
}

export function focusLeafInput(leafId: number): void {
  focusGhosttySession(leafId);
}

export function getLeafDraft(leafId: number): string {
  return ghosttyDraftForLeaf(leafId);
}

export function insertCommandDraft(leafId: number, text: string, isCurrent: () => boolean): Promise<void> {
  return insertGhosttyCommandDraft(leafId, text, isCurrent);
}

export function setLeafDraft(leafId: number, text: string): void {
  const state = ghosttyBlocks(leafId);
  if (state) state.draft = text;
}

export function setLeafInputActivity(leafId: number, active: boolean): void {
  const blocks = ghosttyBlocks(leafId);
  if (!blocks || blocks.inputActive === active) return;
  blocks.inputActive = active;
  blocks.changed();
}

export function blockWatermarkState(leafId: number): WatermarkState {
  return ghosttyBlocks(leafId)?.watermark() ?? "hidden";
}

export function clearFocusedTerminal(): boolean {
  const ghosttyLeaf = ghosttyFocusedLeaf();
  if (ghosttyLeaf !== null) return clearGhosttySession(ghosttyLeaf);
  return false;
}

export function leafIdForPty(ptyId: number): number | null {
  return ghosttyLeafIdForPty(ptyId);
}

export function ptyIdForLeaf(leafId: number): number | null {
  return ghosttyPtyIdForLeaf(leafId);
}

export async function respawnSession(
  leafId: number,
  cwd?: string,
): Promise<void> {
  await respawnGhosttySession(leafId, cwd);
}

export async function leafHasForegroundProcess(
  leafId: number,
): Promise<boolean> {
  return ghosttyLeafHasForegroundProcess(leafId);
}

export function disposeSession(leafId: number): void {
  disposeGhosttySession(leafId);
  disposeGhosttyBlocks(leafId);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
