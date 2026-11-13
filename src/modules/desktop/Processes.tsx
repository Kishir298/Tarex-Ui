import { ContextMenu,ContextMenuTrigger,ContextMenuContent,ContextMenuItem } from "@/components/ui/context-menu";
import { AlertDialog,AlertDialogContent,AlertDialogHeader,AlertDialogTitle,AlertDialogDescription,AlertDialogFooter,AlertDialogCancel,AlertDialogAction } from "@/components/ui/alert-dialog";
import { bytes,type SystemSnapshot } from "@/modules/desktop/model";
import { invoke } from "@tauri-apps/api/core";
import { useEffect,useState } from "react";
import { toast } from "sonner";
type Process=SystemSnapshot["processes"][number];
type Suspended={pid:number;started:number;name:string};
export function Processes({processes,refresh}:{processes:Process[];refresh:()=>void}){
  const [suspended,setSuspended]=useState<Suspended[]>([]);
  const [killing,setKilling]=useState<Process|null>(null);
  const [busy,setBusy]=useState(false);
  useEffect(()=>{let alive=true;void invoke<Suspended[]>("suspended_processes").then(value=>{if(alive)setSuspended(value??[]);}).catch(()=>{});return()=>{alive=false;};},[processes]);
  const control=async(process:Suspended,action:"kill"|"suspend"|"resume")=>{
    if(busy)return;setBusy(true);
    try{setSuspended(await invoke<Suspended[]>("control_process",{pid:process.pid,started:process.started,action}));setKilling(null);refresh();}catch(e){toast.error(String(e));}finally{setBusy(false);}
  };
  return <>
    <table className="tarex-processes"><thead><tr><th>PID</th><th>NAME</th><th>CPU</th></tr></thead><tbody>{processes.map(process=><ContextMenu key={`${process.pid}-${process.started}`}><ContextMenuTrigger asChild><tr tabIndex={0} title={`${process.name}\nPID ${process.pid}\nCPU ${process.cpu.toFixed(1)}%\nMemory ${bytes(process.memory)}`}><td>{process.pid}</td><td>{process.name}</td><td>{process.cpu.toFixed(1)}%</td></tr></ContextMenuTrigger><ContextMenuContent className="rounded-sm border border-border"><ContextMenuItem disabled={busy||suspended.some(p=>p.pid===process.pid)} onSelect={()=>void control(process,"suspend")}>Suspend {process.name}</ContextMenuItem><ContextMenuItem variant="destructive" disabled={busy} onSelect={()=>setKilling(process)}>Kill {process.name}</ContextMenuItem></ContextMenuContent></ContextMenu>)}</tbody></table>
    {suspended.length>0&&<section className="tarex-suspended" aria-label="Suspended processes"><div className="tarex-rule"><span>SUSPENDED</span><span>{suspended.length}</span></div>{suspended.map(process=><div key={`${process.pid}-${process.started}`} title={`${process.name} / PID ${process.pid}`}><span>{process.pid} {process.name}</span><button type="button" disabled={busy} onClick={()=>void control(process,"resume")}>Unsuspend</button></div>)}</section>}
    <AlertDialog open={!!killing} onOpenChange={open=>{if(!open&&!busy)setKilling(null);}}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Kill {killing?.name}?</AlertDialogTitle><AlertDialogDescription>End process {killing?.pid} immediately? Unsaved work in that process may be lost.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={e=>{e.preventDefault();if(killing)void control(killing,"kill");}}>Kill process</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>;
}
