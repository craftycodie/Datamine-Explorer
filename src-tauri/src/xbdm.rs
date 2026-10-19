// The debug output of an Xbox 360 dev or test kit, read from its debug monitor (XBDM, TCP port 730).
// A link asks the console its name and running title, then turns the connection into a notification
// channel, on which everything the title prints arrives as `debugstr` lines. Each link reports through
// `datamine-explorer://xbdm` events; what the lines mean is up to the explorer.
#![allow(non_camel_case_types)]

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const XBDM_EVENT: &str = "datamine-explorer://xbdm";
const XBDM_PORT: u16 = 730;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REPLY_TIMEOUT: Duration = Duration::from_secs(5);
// A console can be quiet for a long time. After this long with nothing, it is asked, on a connection of its
// own, whether it is still there; only one that does not answer ends the link.
const QUIET_CHECK: Duration = Duration::from_secs(30);
// The console connects nowhere: with `reverse` the notifications come back on this same connection.
const NOTIFY_COMMAND: &str = "notify reconnectport=7301 reverse";

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum e_xbdm_event {
    // connected: the console's name and the title it runs
    Hello { link: u32, name: String, title: String },
    // one whole line of debug output
    Line { link: u32, thread: u32, text: String },
    // another title started
    Title { link: u32, title: String },
    Closed { link: u32, error: String },
}

// The links that are running (from the moment they are asked for), their connections once made, and the
// ones let go of, which end without a word.
#[derive(Default)]
pub struct XbdmState {
    running: Mutex<HashSet<u32>>,
    links: Mutex<HashMap<u32, TcpStream>>,
    closing: Mutex<HashSet<u32>>,
}

// A connection and the reader of its replies. The reader has a handle of its own (try_clone), and on
// Windows a read timeout is the handle's, so both are given it.
fn opened(host: &str) -> Result<(TcpStream, BufReader<TcpStream>), String> {
    let stream = connect(host)?;
    let reading = stream.try_clone().map_err(|error| error.to_string())?;
    reading.set_read_timeout(Some(REPLY_TIMEOUT)).map_err(|error| error.to_string())?;
    Ok((stream, BufReader::new(reading)))
}

// `host` is an address or name, with or without the port.
fn connect(host: &str) -> Result<TcpStream, String> {
    let addresses = if host.contains(':') { host.to_socket_addrs() } else { (host, XBDM_PORT).to_socket_addrs() };
    let address = addresses
        .map_err(|error| format!("cannot find {host}: {error}"))?
        .next()
        .ok_or_else(|| format!("cannot find {host}"))?;
    let stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT).map_err(|error| format!("cannot reach {address}: {error}"))?;
    stream.set_read_timeout(Some(REPLY_TIMEOUT)).map_err(|error| error.to_string())?;
    Ok(stream)
}

// One line of a reply, without its CRLF; XBDM speaks bytes, read as Latin-1.
fn line_read(reader: &mut BufReader<TcpStream>) -> Result<String, String> {
    let mut bytes = Vec::new();
    let read = reader.read_until(b'\n', &mut bytes).map_err(|error| error.to_string())?;
    if read == 0 {
        return Err("the console closed the connection".to_owned());
    }
    while matches!(bytes.last(), Some(b'\n' | b'\r')) {
        bytes.pop();
    }
    Ok(bytes.iter().map(|&b| b as char).collect())
}

// Sends a command and gives its reply: the status line, and the lines of a multiline (202) one.
fn command(stream: &mut TcpStream, reader: &mut BufReader<TcpStream>, text: &str) -> Result<(String, Vec<String>), String> {
    stream.write_all(format!("{text}\r\n").as_bytes()).map_err(|error| error.to_string())?;
    let status = line_read(reader)?;
    let mut lines = Vec::new();
    if status.starts_with("202") {
        loop {
            let line = line_read(reader)?;
            if line == "." {
                break;
            }
            lines.push(line);
        }
    }
    Ok((status, lines))
}

// The text after `key=` in a reply line, quoted or not.
fn field(line: &str, key: &str) -> Option<String> {
    let start = line.find(&format!("{key}="))? + key.len() + 1;
    let rest = &line[start..];
    if let Some(quoted) = rest.strip_prefix('"') {
        return quoted.find('"').map(|end| quoted[..end].to_owned());
    }
    Some(rest.split(' ').next().unwrap_or("").to_owned())
}

// "\Device\Harddisk0\Partition1\Games\Halo 3\default.xex" is named by its folder and file: "Halo 3\default.xex".
pub fn title_name(path: &str) -> String {
    let parts: Vec<&str> = path.split('\\').filter(|part| !part.is_empty()).collect();
    parts[parts.len().saturating_sub(2)..].join("\\")
}

// The title the console runs, asked on a connection of its own.
fn title_query(host: &str) -> Result<String, String> {
    let (mut stream, mut reader) = opened(host)?;
    line_read(&mut reader)?;
    let (_, lines) = command(&mut stream, &mut reader, "xbeinfo running")?;
    let _ = stream.write_all(b"bye\r\n");
    Ok(lines.iter().find_map(|line| field(line, "name")).map(|path| title_name(&path)).unwrap_or_default())
}

// A debug output notification: the thread, whether the text ends a line, and the text.
pub fn debugstr_parse(line: &str) -> Option<(u32, bool, String)> {
    let rest = line.strip_prefix("debugstr ")?;
    let at = rest.find("string=")?;
    let (head, text) = (&rest[..at], &rest[at + "string=".len()..]);
    let thread = field(head, "thread").and_then(|value| u32::from_str_radix(value.trim_start_matches("0x"), 16).ok()).unwrap_or(0);
    let ends = head.split(' ').any(|flag| flag == "lf" || flag == "cr" || flag == "crlf");
    Some((thread, ends, text.to_owned()))
}

fn run(app: &AppHandle, link: u32, host: &str, state: &XbdmState) -> Result<(), String> {
    let (mut stream, mut reader) = opened(host)?;
    state.links.lock().unwrap().insert(link, stream.try_clone().map_err(|error| error.to_string())?);
    if state.closing.lock().unwrap().contains(&link) {
        return Ok(());
    }
    let banner = line_read(&mut reader)?;
    if !banner.starts_with("201") {
        return Err(format!("{host} is not an Xbox debug monitor: {banner}"));
    }
    let (status, _) = command(&mut stream, &mut reader, "dbgname")?;
    let name = status.trim_start_matches("200-").trim().to_owned();
    let (_, lines) = command(&mut stream, &mut reader, "xbeinfo running")?;
    let mut title = lines.iter().find_map(|line| field(line, "name")).map(|path| title_name(&path)).unwrap_or_default();
    let (status, _) = command(&mut stream, &mut reader, NOTIFY_COMMAND)?;
    if !status.starts_with("205") {
        return Err(format!("{host} refused a notification channel: {status}"));
    }
    let _ = app.emit(XBDM_EVENT, e_xbdm_event::Hello { link, name, title: title.clone() });
    // the notifications come when they come: a quiet console is not a dead one
    reader.get_ref().set_read_timeout(Some(QUIET_CHECK)).map_err(|error| error.to_string())?;
    // text of each thread that has not ended its line yet
    let mut partial: HashMap<u32, String> = HashMap::new();
    let mut rebooting = false;
    // the bytes of the line being read, which a quiet spell may cut in two
    let mut bytes = Vec::new();
    loop {
        match reader.read_until(b'\n', &mut bytes) {
            Ok(0) => return Err("the console closed the connection".to_owned()),
            Ok(_) if bytes.last() == Some(&b'\n') => {}
            Ok(_) => continue,
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                // quiet: still there? Asking for the title also catches a title change missed in a reboot.
                let next = title_query(host).map_err(|_| "the console stopped answering".to_owned())?;
                if next != title {
                    title = next;
                    let _ = app.emit(XBDM_EVENT, e_xbdm_event::Title { link, title: title.clone() });
                }
                continue;
            }
            Err(error) => return Err(error.to_string()),
        }
        while matches!(bytes.last(), Some(b'\n' | b'\r')) {
            bytes.pop();
        }
        let line: String = bytes.iter().map(|&b| b as char).collect();
        bytes.clear();
        if let Some((thread, ends, text)) = debugstr_parse(&line) {
            let pending = partial.entry(thread).or_default();
            pending.push_str(&text);
            if ends {
                let text = std::mem::take(pending);
                let _ = app.emit(XBDM_EVENT, e_xbdm_event::Line { link, thread, text });
            }
        } else if line.starts_with("execution rebooting") {
            rebooting = true;
        } else if line.starts_with("execution started") && rebooting {
            rebooting = false;
            if let Ok(next) = title_query(host) {
                if next != title {
                    title = next;
                    let _ = app.emit(XBDM_EVENT, e_xbdm_event::Title { link, title: title.clone() });
                }
            }
        }
    }
}

// Opens a link to the console at `host` on a thread of its own. `link` is the explorer's name for it.
#[tauri::command]
pub fn xbdm_open(link: u32, host: String, app: AppHandle, state: tauri::State<XbdmState>) {
    // a link of this number from before is not this one
    state.closing.lock().unwrap().remove(&link);
    state.running.lock().unwrap().insert(link);
    std::thread::spawn(move || {
        let state = tauri::Manager::state::<XbdmState>(&app);
        let error = run(&app, link, &host, &state).err().unwrap_or_default();
        state.links.lock().unwrap().remove(&link);
        state.running.lock().unwrap().remove(&link);
        if !state.closing.lock().unwrap().remove(&link) {
            let _ = app.emit(XBDM_EVENT, e_xbdm_event::Closed { link, error });
        }
    });
}

#[tauri::command]
pub fn xbdm_close(link: u32, state: tauri::State<XbdmState>) {
    // one that has ended already is not marked, or a later link of its number would end at once
    if !state.running.lock().unwrap().contains(&link) {
        return;
    }
    state.closing.lock().unwrap().insert(link);
    if let Some(stream) = state.links.lock().unwrap().get(&link) {
        let _ = stream.shutdown(Shutdown::Both);
    }
}

// Lets go of every link: the page that opened them is gone (it was reloaded) and nothing else holds them.
#[tauri::command]
pub fn xbdm_close_all(state: tauri::State<XbdmState>) {
    let running = state.running.lock().unwrap();
    let links = state.links.lock().unwrap();
    let mut closing = state.closing.lock().unwrap();
    // the ones still connecting end as soon as they are connected
    for link in running.iter() {
        closing.insert(*link);
        if let Some(stream) = links.get(link) {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_strings_and_titles_are_read() {
        let line = "debugstr thread=0xf9000004 lf string=networking:online:lsp: token=11, server acquired";
        assert_eq!(debugstr_parse(line), Some((0xf900_0004, true, "networking:online:lsp: token=11, server acquired".to_owned())));
        // no lf: the text carries on in the next one
        assert_eq!(debugstr_parse("debugstr thread=0x1 string=part one "), Some((1, false, "part one ".to_owned())));
        assert_eq!(debugstr_parse("execution started"), None);
        assert_eq!(title_name("\\Device\\Harddisk0\\Partition1\\Games\\Halo 3 Epsilong\\epsilon.xex"), "Halo 3 Epsilong\\epsilon.xex");
        assert_eq!(field("timestamp=0x0 name=\"\\Device\\Mass0\\a b\\default.xex\"", "name").as_deref(), Some("\\Device\\Mass0\\a b\\default.xex"));
    }
}
