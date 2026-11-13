use serde::Serialize;
use std::collections::BTreeMap;
#[cfg(not(windows))]
use tauri::Emitter;

#[derive(Serialize)]
pub struct KeyLegend { values: Vec<String>, dead: Vec<bool> }
#[derive(Serialize)]
pub struct KeyboardLayout { id:String, name:String, caps:bool, keys:BTreeMap<String,KeyLegend> }

const KEYS:&[(&str,u16,u32)]=&[
    ("Backquote",50,41),("Digit1",18,2),("Digit2",19,3),("Digit3",20,4),("Digit4",21,5),("Digit5",23,6),("Digit6",22,7),("Digit7",26,8),("Digit8",28,9),("Digit9",25,10),("Digit0",29,11),("Minus",27,12),("Equal",24,13),
    ("KeyQ",12,16),("KeyW",13,17),("KeyE",14,18),("KeyR",15,19),("KeyT",17,20),("KeyY",16,21),("KeyU",32,22),("KeyI",34,23),("KeyO",31,24),("KeyP",35,25),("BracketLeft",33,26),("BracketRight",30,27),("Backslash",42,43),
    ("KeyA",0,30),("KeyS",1,31),("KeyD",2,32),("KeyF",3,33),("KeyG",5,34),("KeyH",4,35),("KeyJ",38,36),("KeyK",40,37),("KeyL",37,38),("Semicolon",41,39),("Quote",39,40),
    ("KeyZ",6,44),("KeyX",7,45),("KeyC",8,46),("KeyV",9,47),("KeyB",11,48),("KeyN",45,49),("KeyM",46,50),("Comma",43,51),("Period",47,52),("Slash",44,53),
];

#[tauri::command]
pub async fn keyboard_layout(app:tauri::AppHandle)->Result<KeyboardLayout,String>{
    let (send,receive)=tokio::sync::oneshot::channel();
    app.run_on_main_thread(move||{let _=send.send(platform_layout());}).map_err(|e|e.to_string())?;
    receive.await.map_err(|e|e.to_string())?
}

#[cfg(target_os="macos")]
mod mac {
    use super::*;
    use std::{ffi::{c_char,c_void,CStr},ptr};
    type Ref=*const c_void;
    #[link(name="CoreGraphics",kind="framework")]
    unsafe extern "C" { fn CGEventSourceFlagsState(state:i32)->u64; }
    #[link(name="Carbon",kind="framework")]
    unsafe extern "C" {
        fn TISCopyCurrentKeyboardInputSource()->Ref;
        fn TISCopyCurrentKeyboardLayoutInputSource()->Ref;
        fn TISGetInputSourceProperty(source:Ref,property:Ref)->Ref;
        static kTISPropertyUnicodeKeyLayoutData:Ref;
        static kTISPropertyInputSourceID:Ref;
        static kTISPropertyLocalizedName:Ref;
        static kTISNotifySelectedKeyboardInputSourceChanged:Ref;
        fn LMGetKbdType()->u8;
        fn UCKeyTranslate(layout:Ref,key:u16,action:u16,modifiers:u32,keyboard_type:u32,options:u32,dead:*mut u32,max:u32,length:*mut u32,characters:*mut u16)->i32;
    }
    #[link(name="CoreFoundation",kind="framework")]
    unsafe extern "C" {
        fn CFRelease(value:Ref);
        fn CFDataGetBytePtr(value:Ref)->*const u8;
        fn CFStringGetCString(value:Ref,buffer:*mut c_char,size:isize,encoding:u32)->bool;
        fn CFNotificationCenterGetDistributedCenter()->Ref;
        fn CFNotificationCenterAddObserver(center:Ref,observer:Ref,callback:unsafe extern "C" fn(Ref,Ref,Ref,Ref,Ref),name:Ref,object:Ref,behavior:isize);
        fn CFNotificationCenterRemoveObserver(center:Ref,observer:Ref,name:Ref,object:Ref);
    }
    struct Source(Ref);
    impl Drop for Source {fn drop(&mut self){if !self.0.is_null(){unsafe{CFRelease(self.0)}}}}
    unsafe fn text(value:Ref)->String{
        let mut bytes=[0i8;512];
        if value.is_null()||!unsafe{CFStringGetCString(value,bytes.as_mut_ptr(),bytes.len() as isize,0x08000100)}{return String::new();}
        unsafe{CStr::from_ptr(bytes.as_ptr())}.to_string_lossy().into_owned()
    }
    pub fn layout()->Result<KeyboardLayout,String>{unsafe{
        let source=Source(TISCopyCurrentKeyboardInputSource());
        let layout=Source(TISCopyCurrentKeyboardLayoutInputSource());
        if source.0.is_null()||layout.0.is_null(){return Err("Keyboard layout unavailable".into());}
        let data=TISGetInputSourceProperty(layout.0,kTISPropertyUnicodeKeyLayoutData);
        if data.is_null(){return Err("This input method has no physical key map".into());}
        let keyboard=CFDataGetBytePtr(data).cast();
        let mut keys=BTreeMap::new();
        for &(code,key,_) in KEYS {
            let mut values=Vec::new();let mut dead_keys=Vec::new();
            for mask in 0..8u32{
                let modifiers=((mask&1)<<1)|((mask&2)<<1)|((mask&4)<<1);
                let mut dead=0;let mut length=0;let mut chars=[0u16;8];
                UCKeyTranslate(keyboard,key,0,modifiers,LMGetKbdType() as u32,0,&mut dead,8,&mut length,chars.as_mut_ptr());
                let is_dead=dead!=0;
                if is_dead{dead=0;UCKeyTranslate(keyboard,key,0,modifiers,LMGetKbdType() as u32,1,&mut dead,8,&mut length,chars.as_mut_ptr());}
                values.push(String::from_utf16_lossy(&chars[..length.min(8) as usize]));dead_keys.push(is_dead);
            }
            keys.insert(code.into(),KeyLegend{values,dead:dead_keys});
        }
        Ok(KeyboardLayout{id:text(TISGetInputSourceProperty(source.0,kTISPropertyInputSourceID)),name:text(TISGetInputSourceProperty(source.0,kTISPropertyLocalizedName)),caps:CGEventSourceFlagsState(0)&0x10000!=0,keys})
    }}
    pub struct Observer(usize);
    impl Drop for Observer{fn drop(&mut self){unsafe{let pointer=self.0 as Ref;CFNotificationCenterRemoveObserver(CFNotificationCenterGetDistributedCenter(),pointer,ptr::null(),ptr::null());drop(Box::from_raw(self.0 as *mut tauri::AppHandle));}}}
    unsafe extern "C" fn changed(_:Ref,observer:Ref,_:Ref,_:Ref,_:Ref){if let Some(app)=unsafe{(observer as *const tauri::AppHandle).as_ref()}{let _=app.emit("tarex:keyboard-layout-changed",());}}
    pub fn observe(app:&tauri::AppHandle)->Observer{unsafe{let pointer=Box::into_raw(Box::new(app.clone()));CFNotificationCenterAddObserver(CFNotificationCenterGetDistributedCenter(),pointer.cast(),changed,kTISNotifySelectedKeyboardInputSourceChanged,ptr::null(),4);Observer(pointer as usize)}}
}

#[cfg(target_os="macos")]
fn platform_layout()->Result<KeyboardLayout,String>{mac::layout()}

#[cfg(windows)]
fn platform_layout()->Result<KeyboardLayout,String>{
    use windows_sys::Win32::{UI::{Input::KeyboardAndMouse::*,WindowsAndMessaging::*},Globalization::LCIDToLocaleName};
    unsafe{
        let layout=GetKeyboardLayout(GetWindowThreadProcessId(GetForegroundWindow(),std::ptr::null_mut()));
        let mut locale=[0u16;85];let len=LCIDToLocaleName((layout as usize&0xffff) as u32,locale.as_mut_ptr(),85,0);
        let name=if len>0{String::from_utf16_lossy(&locale[..len as usize-1])}else{"System keyboard".into()};
        let mut keys=BTreeMap::new();
        for &(code,_,scan) in KEYS{
            let mut values=Vec::new();let mut dead=Vec::new();
            for mask in 0..8{
                let mut state=[0u8;256];
                if mask&1!=0{state[VK_SHIFT as usize]=128;}
                if mask&2!=0{state[VK_CAPITAL as usize]=1;}
                if mask&4!=0{state[VK_CONTROL as usize]=128;state[VK_MENU as usize]=128;state[VK_RMENU as usize]=128;}
                let mut chars=[0u16;8];let len=ToUnicodeEx(MapVirtualKeyExW(scan,MAPVK_VSC_TO_VK_EX,layout),scan,state.as_ptr(),chars.as_mut_ptr(),8,4,layout);
                values.push(String::from_utf16_lossy(&chars[..len.unsigned_abs().min(8) as usize]));dead.push(len<0);
            }
            keys.insert(code.into(),KeyLegend{values,dead});
        }
        Ok(KeyboardLayout{id:format!("windows-{:x}",layout as usize),name,caps:GetKeyState(VK_CAPITAL as i32)&1!=0,keys})
    }
}

#[cfg(target_os="linux")]
static GROUP:std::sync::atomic::AtomicU8=std::sync::atomic::AtomicU8::new(0);

#[cfg(target_os="linux")]
fn platform_layout()->Result<KeyboardLayout,String>{
    use gtk::gdk::{Keymap,ModifierType};
    let display=gtk::gdk::Display::default().ok_or("Keyboard display unavailable")?;
    let map=Keymap::for_display(&display).ok_or("Keyboard map unavailable")?;
    let native_group=((map.modifier_state()>>13)&3) as u8;
    let group=if native_group!=0{native_group}else{GROUP.load(std::sync::atomic::Ordering::Relaxed)} as i32;
    let mut keys=BTreeMap::new();
    for &(code,_,scan) in KEYS{
        let mut values=Vec::new();let mut dead=Vec::new();
        for mask in 0..8{
            let mut modifiers=ModifierType::empty();
            if mask&1!=0{modifiers|=ModifierType::SHIFT_MASK;}
            if mask&2!=0{modifiers|=ModifierType::LOCK_MASK;}
            if mask&4!=0{modifiers|=ModifierType::MOD5_MASK;}
            let key=map.translate_keyboard_state(scan+8,modifiers,group).map(|(key,_,_,_)|key).unwrap_or(0);
            let is_dead=(0xfe50..=0xfe6f).contains(&key);
            let text=if is_dead{["`","´","^","~","¯","˘","˙","¨","˚","˝","ˇ","¸","˛"].get((key-0xfe50) as usize).unwrap_or(&"").to_string()}else{gtk::gdk::keys::Key::from(key).to_unicode().map(|c|c.to_string()).unwrap_or_default()};
            values.push(text);dead.push(is_dead);
        }
        keys.insert(code.into(),KeyLegend{values,dead});
    }
    Ok(KeyboardLayout{id:format!("gdk-{group}"),name:format!("System layout {}",group+1),caps:map.is_caps_locked(),keys})
}

pub fn install(app:&tauri::AppHandle){
    #[cfg(target_os="macos")]
    { use tauri::Manager;app.manage(mac::observe(app)); }
    #[cfg(target_os="linux")]
    {use gtk::prelude::*;use tauri::Manager;
        if let Some(window)=app.get_webview_window("main") {let handle=app.clone();let _=window.with_webview(move|view|{
            let release=handle.clone();
            view.inner().connect_key_press_event(move|_,event|{let group=event.group();if GROUP.swap(group,std::sync::atomic::Ordering::Relaxed)!=group{let _=handle.emit("tarex:keyboard-layout-changed",());}gtk::glib::Propagation::Proceed});
            view.inner().connect_key_release_event(move|_,event|{let group=event.group();if GROUP.swap(group,std::sync::atomic::Ordering::Relaxed)!=group{let _=release.emit("tarex:keyboard-layout-changed",());}gtk::glib::Propagation::Proceed});
        });}
    }
    #[cfg(windows)]
    { let _=app; }
}
